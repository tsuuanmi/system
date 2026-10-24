/**
 * A worktree's setup (docs/design/agent-runtimes.md#a-worktrees-setup, ADR-0058): commands the
 * operator declares per repository (`worktreeSetup`), run in a workflow run's new worktree before
 * any agent run works in it, so the repository's checks can run there without a network (its
 * dependencies installed from what the host already holds). Each command is the policy's to allow
 * (`ctx.approvals`), as a Worker's `Bash` call is (exact argv): `forbid` refuses, `auto` and
 * `notify` run, and `ask` waits on one approval request per command, bound to the worktree and to
 * the setup's hash, used once. The commands run under the read confinement with the host read-only
 * but the worktree (and the private views the operator names), no network, and a bounded time. A
 * setup that is not allowed, or that fails, fails the run before anything reaches the agent, with
 * the cause named and recorded as a `gate` decision (INV-2, INV-13); a worktree is never worked in
 * until its setup has run under the definition loaded now.
 * @module @tsuuanmi/system-agent-workers/setup
 */
import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { childEnvironment, confinedCommand, proveConfinement } from '@tsuuanmi/system-agent-runtime-core'
import { type ApprovalRequest, type Approvals, type ArtifactRef, type AutonomyVerdict, SHELL_METACHARACTER } from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import type {} from '@tsuuanmi/system-event-log'
import { type ContentId, contentId, ensurePrivateDir } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type {} from '@tsuuanmi/system-store'
import { CHECKS } from './gate.ts'
import { repositoryKey } from './worktrees.ts'

/** A host directory the setup sees as a private, writable one of its own (a package store's index, say). */
export interface WorktreeSetupView {
  /** The host directory (absolute): the setup sees a fresh private directory at this path, removed when it ends. */
  path: string
  /** Files of the host directory copied into the private one first (names, not paths). One the host lacks is not copied. */
  copy?: string[]
  /** Paths inside the host directory (relative) bound back read-only into the private one: the content the setup reads, never changes. */
  readOnly?: string[]
}

/** The setup of one repository's worktrees (`worktreeSetup` of the row). */
export interface WorktreeSetupConfig {
  /** The repository (absolute): the workspace of the `worktreePerRun` Workers whose worktrees it sets up. */
  repository: string
  /** The commands, in order, each its words split on single spaces (never parsed by a shell), as the policy's commands list matches them. */
  commands: string[]
  views?: WorktreeSetupView[]
  /** The whole setup's deadline, in seconds (default 600). */
  timeoutSeconds?: number
}

/** A setup as loaded: every default filled in, its commands as argv, and the hash an approval binds to. */
export interface Setup {
  repository: string
  lines: string[]
  commands: string[][]
  views: Array<Required<WorktreeSetupView>>
  timeoutSeconds: number
  /** The content id of the whole definition: a change to any of it is another setup, asked about again. */
  hash: ContentId
}

/** `commandChars` is the policy's own bound on a commands-list line (`autonomy-policy@1.0`): every setup command can be listed there. */
export const SETUP_LIMITS = { commands: 16, commandChars: 200, views: 8, entries: 32, defaultTimeoutSeconds: 600, maxTimeoutSeconds: 3600, copyBytes: 1024 ** 3 } as const
/** How much of a failed command's output its run's error keeps (INV-9). */
const OUTPUT_TAIL = 1500
const RULE = { type: 'rule', id: 'agent-workers.worktree-setup', version: '1' } as const

/** The run's worktrees remember which setup ran in them, and each run the setup decision it started on. */
export const SETUP_MIGRATION = {
  version: 13,
  sql: `ALTER TABLE agent_worktrees ADD COLUMN setup_hash TEXT;
  ALTER TABLE agent_worktrees ADD COLUMN setup_decision TEXT;
  ALTER TABLE agent_runs ADD COLUMN setup_decision TEXT;`,
}

const fail = (message: string): never => {
  throw new ProviderError('config_error', `agent-workers.worktreeSetup: ${message}`)
}

/** Why a command line is not one the policy can match word for word, or undefined. */
export function lineProblem(line: unknown): string | undefined {
  if (typeof line !== 'string' || !line.length) return 'is empty'
  if (line.length > SETUP_LIMITS.commandChars) return `is longer than ${SETUP_LIMITS.commandChars} characters`
  const words = line.split(' ')
  const empty = words.indexOf('')
  if (empty >= 0) return `has an empty word ${empty + 1} (a doubled, leading, or trailing space); a command is words split on single spaces`
  const unsafe = words.findIndex((word) => SHELL_METACHARACTER.test(word))
  if (unsafe >= 0) return `has a shell metacharacter in word ${unsafe + 1}; a command is never parsed by a shell, and the policy forbids it`
  return undefined
}

/** A relative path inside a view: no `..`, `.`, or empty segment, never absolute. */
const RELATIVE = (path: unknown): boolean => typeof path === 'string' && !!path.length && !isAbsolute(path) && path.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..') && !path.includes('\0')

/**
 * The setups as loaded, by repository (resolved), checked at load: each names the workspace of a
 * `worktreePerRun` Worker, once; holds 1 to 16 commands a policy can match word for word; and names
 * views by absolute, distinct paths, with plain names to copy and relative paths to bind back.
 */
export function loadSetups(setups: readonly WorktreeSetupConfig[] | undefined, worktreeWorkspaces: readonly string[]): Map<string, Setup> {
  const loaded = new Map<string, Setup>()
  const workspaces = new Set(worktreeWorkspaces.map((w) => resolve(w)))
  for (const entry of setups ?? []) {
    if (typeof entry?.repository !== 'string' || !isAbsolute(entry.repository)) fail('repository must be an absolute path')
    const repository = resolve(entry.repository)
    if (loaded.has(repository)) fail(`${repository} has two setups; one repository has one`)
    if (!workspaces.has(repository)) fail(`${repository} is the workspace of no Worker with worktreePerRun, so its setup would never run`)
    const lines = entry.commands
    if (!Array.isArray(lines) || !lines.length || lines.length > SETUP_LIMITS.commands) fail(`${repository}: commands holds 1 to ${SETUP_LIMITS.commands} commands`)
    for (const [i, line] of lines.entries()) {
      const problem = lineProblem(line)
      if (problem) fail(`${repository}: command ${i + 1} ${problem}`)
    }
    const views = (entry.views ?? []).map((view, i): Required<WorktreeSetupView> => {
      if (typeof view?.path !== 'string' || !isAbsolute(view.path) || normalize(view.path) !== view.path || view.path === '/' || view.path.endsWith(sep)) {
        fail(`${repository}: view ${i + 1} needs an absolute, normalized path, not the root`)
      }
      const copy = view.copy ?? []
      const readOnly = view.readOnly ?? []
      if (!Array.isArray(copy) || copy.length > SETUP_LIMITS.entries || copy.some((name) => !RELATIVE(name) || name.includes('/'))) fail(`${repository}: view ${view.path} copies up to ${SETUP_LIMITS.entries} files, each a plain name`)
      if (!Array.isArray(readOnly) || readOnly.length > SETUP_LIMITS.entries || readOnly.some((path) => !RELATIVE(path))) fail(`${repository}: view ${view.path} binds back up to ${SETUP_LIMITS.entries} relative paths, none with . or ..`)
      if (new Set([...copy, ...readOnly]).size !== copy.length + readOnly.length) fail(`${repository}: view ${view.path} names a path twice`)
      return { path: view.path, copy: [...copy], readOnly: [...readOnly] }
    })
    if (views.length > SETUP_LIMITS.views) fail(`${repository}: at most ${SETUP_LIMITS.views} views`)
    const paths = views.map((v) => v.path)
    const nested = paths.find((p, i) => paths.some((q, j) => i !== j && (p === q || p.startsWith(q + sep))))
    if (nested) fail(`${repository}: the views ${nested} and another overlap; each is its own directory`)
    const timeoutSeconds = entry.timeoutSeconds ?? SETUP_LIMITS.defaultTimeoutSeconds
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > SETUP_LIMITS.maxTimeoutSeconds) fail(`${repository}: timeoutSeconds is 1 to ${SETUP_LIMITS.maxTimeoutSeconds}`)
    const definition = { repository, commands: [...lines], views, timeoutSeconds }
    loaded.set(repository, { ...definition, lines: [...lines], commands: lines.map((line) => line.split(' ')), hash: contentId(definition) })
  }
  return loaded
}

/** The run a setup is for: the agent run that needs the worktree, and who and what it is. */
export interface SetupRun {
  agentRun: string
  worker: string
  workflowRunId: string
  sessionId?: string | undefined
  classification: 'public' | 'operator-shared' | 'local-private'
  /** The worktree (its stored path) and the repository it belongs to (real path). */
  worktree: string
  repository: string
}

/** What a setup came to: the `gate` decision that records it, and, unless the run may start, why not. */
export interface SetupOutcome {
  decision: ContentId
  failure?: ProviderError
}

interface RequestRow { request_id: string; run_id: string; used_at: string | null }

/** A command the policy let run: on its own decision, or on an approval taken when the setup starts. */
type Allowed = { verdict: AutonomyVerdict; take?: { requestId: string; decision: ArtifactRef | undefined } }

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}
const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/** Refused before anything ran: the reason, and the decisions it rests on. */
class Refusal extends Error {
  constructor(message: string, readonly inputs: ArtifactRef[] = [], readonly detail: Record<string, unknown> = {}) {
    super(message)
  }
}

export class WorktreeSetups {
  private readonly queues = new Map<string, Promise<unknown>>()

  /** `runDir`: an owner-only directory (`<worktreeRoot>/.setup`) where each setup's private views are made, and removed after it. */
  constructor(private readonly ctx: Context, private readonly runDir: string) {}

  /**
   * Make sure `setup` has run in the run's worktree, once per worktree and definition: a worktree
   * whose stored setup is this one is ready (its decision returned again); otherwise the setup is
   * judged, run, and recorded. One setup at a time per worktree, so a second run of the workflow run
   * waits for the first's. Never throws for a refusal: its outcome names the decision and the
   * failure, so the run records both.
   */
  ensure(run: SetupRun, setup: Setup, signal: AbortSignal): Promise<SetupOutcome> {
    return this.exclusive(run.worktree, async () => {
      const row = this.ctx.store.db.prepare('SELECT setup_hash, setup_decision FROM agent_worktrees WHERE path = ? AND removed_at IS NULL').get(run.worktree) as { setup_hash: string | null; setup_decision: string | null } | undefined
      if (row?.setup_hash === setup.hash && row.setup_decision) return { decision: row.setup_decision as ContentId }
      if (!row) return this.refused(run, setup, new Refusal(`${run.worktree} is not a worktree of a run`))
      let allowed: Allowed[]
      try {
        allowed = await this.judge(run, setup)
      } catch (error) {
        if (error instanceof Refusal) return this.refused(run, setup, error)
        throw error
      }
      const inputs = [...new Set(allowed.flatMap((a) => [a.verdict.decision, ...(a.take?.decision ? [a.take.decision] : [])]))]
      // One approval, one setup: every approval it rests on is taken together, under the store's write lock.
      const takes = allowed.flatMap((a) => (a.take ? [a.take.requestId] : []))
      try {
        if (takes.length) {
          this.ctx.store.transaction((tx) => {
            const at = new Date().toISOString()
            const changed = takes.reduce((n, id) => n + Number(tx.prepare('UPDATE agent_tool_requests SET used_at = ?, used_by = ? WHERE request_id = ? AND used_at IS NULL').run(at, run.agentRun, id).changes), 0)
            if (changed !== takes.length) throw new Refusal(`an approval it rests on (${takes.join(', ')}) was used meanwhile; the next run asks again`, inputs)
          })
        }
      } catch (error) {
        if (error instanceof Refusal) return this.refused(run, setup, error)
        throw error
      }
      const pending = [...new Set(allowed.flatMap((a) => a.verdict.failedChecks ?? []))]
      try {
        await this.execute(run, setup, signal)
      } catch (error) {
        if (signal.aborted) throw error
        return this.refused(run, setup, error instanceof Refusal ? new Refusal(error.message, inputs, error.detail) : new Refusal((error as Error).message, inputs))
      }
      const decision = this.decide(run, setup, 'start', [`its setup ${setup.hash} ran: ${setup.commands.length} command(s), each allowed by the autonomy policy and exited 0, confined (the host read-only but the worktree, no network)${pending.length ? `; the checks ${pending.join(', ')} stay pending, bound when the run's result is accepted` : ''}`], inputs, pending.length ? { pendingChecks: pending } : {})
      this.ctx.store.transaction((db) => {
        db.prepare('UPDATE agent_worktrees SET setup_hash = ?, setup_decision = ? WHERE path = ? AND removed_at IS NULL').run(setup.hash, decision, run.worktree)
      })
      this.event(run, setup, 'ran', decision)
      this.ctx.logger.info(`agent Workers: the setup ${setup.hash} of ${run.worktree} ran (decision ${decision})`)
      return { decision }
    })
  }

  /**
   * Each command, judged by the policy as a `command` with its exact argv. `forbid` refuses the
   * setup; `auto` and `notify` let the command run; `ask` uses this worktree's approval of exactly
   * this command of exactly this setup when one is approved and unused, waits on it while it is
   * open, refuses when it was rejected, expired, or withdrawn (nothing new is queued), and otherwise
   * opens one. With no queue loaded, nothing runs (fail-closed rule 5).
   */
  private async judge(run: SetupRun, setup: Setup): Promise<Allowed[]> {
    const approvals = this.ctx.get('approvals')
    if (!approvals) throw new Refusal('no approval queue (ctx.approvals) is loaded, and no setup command runs without its autonomy decision')
    const allowed: Allowed[] = []
    const waiting: string[] = []
    const inputs: ArtifactRef[] = []
    for (const [i, argv] of setup.commands.entries()) {
      const n = i + 1
      const verdict = await approvals.check({ class: 'command', command: argv })
      inputs.push(verdict.decision)
      if (verdict.mode === 'forbid') throw new Refusal(`the autonomy policy forbids its command ${n} (${setup.lines[i]})${this.reasonOf(verdict)}`, inputs)
      if (verdict.mode === 'auto' || verdict.mode === 'notify') {
        const pending = verdict.failedChecks ?? []
        if (pending.some((c) => !CHECKS.includes(c))) throw new Refusal(`the autonomy policy left checks pending on its command ${n} that no rule can require (${pending.join(', ')})`, inputs)
        allowed.push({ verdict })
        continue
      }
      if (verdict.mode !== 'ask') throw new Refusal(`the autonomy policy gave its command ${n} a mode this source does not know (${String(verdict.mode)})`, inputs)
      const asked = await this.ask(approvals, run, setup, i, verdict, inputs)
      if ('waits' in asked) waiting.push(asked.waits)
      else allowed.push({ verdict, take: asked })
    }
    if (waiting.length) {
      throw new Refusal(`it waits for the operator's approval of ${waiting.length === 1 ? 'its command' : 'its commands'} (approval request ${waiting.join(', ')}); `
        + 'once approved, a later run of this workflow run sets the worktree up (system continue <runId>)', inputs, { requests: waiting })
    }
    return allowed
  }

  /** An `ask` on command `i`: the request this worktree opened for it under this setup, or a new one. */
  private async ask(approvals: Approvals, run: SetupRun, setup: Setup, i: number, verdict: AutonomyVerdict, inputs: ArtifactRef[]): Promise<{ requestId: string; decision: ArtifactRef | undefined } | { waits: string }> {
    const n = i + 1
    const scope = `worktree:${run.worktree}`
    const tool = `worktree-setup:${n}`
    const ref = `agent-worktree-setup:${repositoryKey(run.repository)}/${run.workflowRunId}:${n}`
    const prior = this.ctx.store.db.prepare('SELECT request_id, run_id, used_at FROM agent_tool_requests WHERE scope = ? AND tool = ? AND input_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(scope, tool, setup.hash) as RequestRow | undefined
    if (prior) {
      const request: ApprovalRequest | undefined = await approvals.get(prior.request_id)
      if (!request) throw new Refusal(`approval request ${prior.request_id} for its command ${n} cannot be read`, inputs)
      // INV-5: the request is for exactly this command of exactly this setup in this worktree.
      const other = request.subject.type !== 'content' ? 'subject type' : request.subject.ref !== ref ? 'subject ref' : request.subject.version !== setup.hash ? 'subject version'
        : request.action.class !== 'command' ? 'action class' : request.requester.component !== 'worker' ? 'requester component' : request.requester.runId !== prior.run_id ? 'requester run' : undefined
      if (other) throw new Refusal(`approval request ${request.requestId} is for another command than its command ${n} (its ${other} differs), so its verdict is not used`, inputs)
      if (request.state === 'rejected') {
        const how = request.resolution?.cause === 'verdict' ? 'rejected by the operator' : request.resolution?.cause === 'expired' ? 'unanswered when it expired' : 'withdrawn'
        throw new Refusal(`approval request ${request.requestId} for its command ${n} (${setup.lines[i]}) was ${how}, so this worktree's setup does not run; a new workflow run, or another setup, asks again`, inputs, { requests: [request.requestId] })
      }
      if (request.state !== 'approved') return { waits: request.requestId }
      if (prior.used_at === null) return { requestId: request.requestId, decision: request.resolution?.decision }
      // Its approval was used by an earlier setup of this worktree (which failed): it asks again.
    }
    const created = await approvals.request({
      subject: { type: 'content', ref, version: setup.hash },
      action: {
        class: 'command', summary: `Worktree setup of ${run.repository} for workflow run ${run.workflowRunId}, command ${n} of ${setup.commands.length}: ${setup.lines[i]}`.slice(0, 500),
        consequences: `Runs this exact command in the run's new worktree ${run.worktree}, before any agent works in it: the host read-only but the worktree${setup.views.length ? ` and ${setup.views.length} private view(s)` : ''}, no network, host state hidden, at most ${setup.timeoutSeconds} s. `
          + 'Approved: this worktree\'s setup runs it once, under exactly this setup. Rejected, or unanswered when the request expires: this worktree is never set up, and every run in it fails at start.',
      },
      requester: { component: 'worker', runId: run.agentRun, ...(run.sessionId ? { sessionId: run.sessionId } : {}) },
      verdict, command: setup.commands[i]!, classification: run.classification,
    })
    this.ctx.store.transaction((tx) => {
      tx.prepare('INSERT INTO agent_tool_requests (request_id, scope, tool, input_hash, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(created.requestId, scope, tool, setup.hash, run.agentRun, created.createdAt)
    })
    return { waits: created.requestId }
  }

  /** Run the commands in order, confined, within the setup's deadline. Throws a {@link Refusal} naming the cause. */
  private async execute(run: SetupRun, setup: Setup, signal: AbortSignal): Promise<void> {
    const worktree = real(run.worktree)
    if (!worktree) throw new Refusal(`its worktree ${run.worktree} cannot be read`)
    const confinement = this.ctx.agentRuntimes.confinement({ writable: [worktree] })
    const hidden = confinement.hide.map((h) => real(h)).filter((h): h is string => !!h)
    // A view shows the setup a private copy of host files: never of a path hidden from agents, nor over the worktree.
    for (const view of setup.views) {
      const path = real(view.path)
      if (!path || !statSync(path).isDirectory()) throw new Refusal(`its view ${view.path} is not a directory on this host`)
      if (path !== view.path) throw new Refusal(`its view ${view.path} is reached through a link (${path}); name the directory itself`)
      const exposed = hidden.find((h) => within(path, h) || within(h, path))
      if (exposed) throw new Refusal(`its view ${view.path} lies inside, or holds, ${exposed}, which is hidden from agents`)
      if (within(path, worktree) || within(worktree, path)) throw new Refusal(`its view ${view.path} overlaps the worktree ${worktree}`)
      for (const entry of view.readOnly) {
        const bound = real(join(path, entry))
        if (!bound) throw new Refusal(`its view ${view.path} binds back ${entry}, which does not exist on this host`)
        const leaks = hidden.find((h) => within(bound, h) || within(h, bound))
        if (leaks) throw new Refusal(`its view ${view.path} binds back ${entry}, which reaches ${leaks}, hidden from agents`)
      }
    }
    const proof = await proveConfinement(confinement)
    if (!proof.confined) throw new Refusal(`its commands cannot be confined on this host: ${proof.detail}`)
    ensurePrivateDir(this.runDir)
    const scratch = mkdtempSync(join(this.runDir, 'setup-'))
    try {
      const views = setup.views.flatMap((view, i) => {
        const dir = join(scratch, String(i))
        mkdirSync(dir, { mode: 0o700 })
        for (const name of view.copy) copyFile(join(view.path, name), join(dir, name))
        // Where each path bound back is mounted: a directory, or an empty file for a file.
        for (const entry of view.readOnly) {
          if (statSync(join(view.path, entry)).isDirectory()) mkdirSync(join(dir, entry), { recursive: true, mode: 0o700 })
          else {
            mkdirSync(dirname(join(dir, entry)), { recursive: true, mode: 0o700 })
            closeSync(openSync(join(dir, entry), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600))
          }
        }
        return [{ source: dir, path: view.path, writable: true }, ...view.readOnly.map((entry) => ({ source: join(view.path, entry), path: join(view.path, entry), writable: false }))]
      })
      const deadline = AbortSignal.timeout(setup.timeoutSeconds * 1000)
      const env = childEnvironment()
      for (const [i, argv] of setup.commands.entries()) {
        const command = confinedCommand(argv[0]!, argv.slice(1), confinement, { readOnly: true, network: false, chdir: worktree, views })
        const ended = await runBounded(command, env, AbortSignal.any([signal, deadline]))
        if (signal.aborted) throw signal.reason ?? new ProviderError('aborted', 'stopped')
        if (deadline.aborted) throw new Refusal(`its command ${i + 1} (${setup.lines[i]}) did not finish within the setup's ${setup.timeoutSeconds} s; it was stopped${tail(ended.output)}`, [], { command: i + 1, timedOut: true })
        if (ended.code !== 0) {
          throw new Refusal(`its command ${i + 1} (${setup.lines[i]}) ${ended.code === null ? `ended on signal ${ended.signal ?? 'unknown'}` : `exited with code ${ended.code}`}${tail(ended.output)}`, [], { command: i + 1, ...(ended.code !== null ? { exitCode: ended.code } : {}) })
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /** Record the refusal and say why the run does not start. */
  private refused(run: SetupRun, setup: Setup, refusal: Refusal): SetupOutcome {
    const why = `the setup of its worktree ${run.worktree} ${refusal.message.startsWith('it ') ? refusal.message.slice(3) : `did not complete: ${refusal.message}`}`
    const decision = this.decide(run, setup, 'refuse', [why], refusal.inputs, refusal.detail)
    this.event(run, setup, refusal.detail.requests ? 'waits' : 'refused', decision)
    return { decision, failure: new ProviderError('config_error', `${run.worker}: ${why} (decision ${decision}); nothing was run`) }
  }

  /** The `gate` decision of rule `agent-workers.worktree-setup` (INV-13): may the run start in its worktree? */
  private decide(run: SetupRun, setup: Setup, option: 'start' | 'refuse', reasons: string[], inputs: ArtifactRef[], detail: Record<string, unknown>): ContentId {
    return this.ctx.artifacts.recordDecision({
      decisionType: 'gate', question: `May ${run.worker}'s run ${run.agentRun} start in the worktree ${run.worktree} of workflow run ${run.workflowRunId}, which its repository's setup prepares?`.slice(0, 500),
      inputs: [...new Set(inputs)],
      candidates: [
        { option: 'start', selected: option === 'start', reasons: option === 'start' ? reasons : [`not start: ${reasons[0]}`] },
        { option: 'refuse', selected: option === 'refuse', reasons: option === 'refuse' ? reasons : ['not refuse: every setup command was allowed and exited 0'] },
      ],
      decider: RULE,
      outcome: { option, detail: { agentRun: run.agentRun, worker: run.worker, worktree: run.worktree, repository: run.repository, setup: setup.hash, commands: setup.commands.length, ...detail } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, runId: run.workflowRunId, classification: run.classification }).id as ContentId
  }

  private event(run: SetupRun, setup: Setup, outcome: 'ran' | 'refused' | 'waits', decision: ContentId): void {
    try {
      this.ctx.get('eventLog')?.append({
        type: 'agent-workers.worktree.setup', runId: run.workflowRunId, ...(run.sessionId ? { sessionId: run.sessionId } : {}), decision,
        data: { agentRun: run.agentRun, worker: run.worker, worktree: run.worktree, setup: setup.hash, outcome },
      })
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: the setup event of ${run.agentRun} was not appended: ${(error as Error).message}`)
    }
  }

  /** Why the policy forbids it, from the decision it recorded. */
  private reasonOf(verdict: AutonomyVerdict): string {
    const body = this.ctx.artifacts.get(verdict.decision)?.body as { candidates?: Array<{ selected?: boolean; reasons?: string[] }> } | undefined
    const reason = body?.candidates?.find((c) => c.selected)?.reasons?.[0]
    return reason ? `: ${reason}` : ''
  }

  /** Run `task` after every earlier one for `key`: one setup at a time per worktree. */
  private exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).then(task)
    const settled = result.then(() => undefined, () => undefined)
    this.queues.set(key, settled)
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key)
    })
    return result
  }
}

/** ` Its output ended: …`, the last part of what a command printed, when it printed anything. */
function tail(output: string): string {
  const text = output.trim()
  return text ? `. Its output ended: ${text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text}` : ''
}

/**
 * Copy one host file into a private view, never through a link: opened as itself (O_NOFOLLOW), a
 * plain file of at most {@link SETUP_LIMITS.copyBytes}, read through that descriptor. A file the
 * host does not have is not copied; anything else that cannot be copied refuses the setup.
 */
function copyFile(source: string, target: string): void {
  let fd: number
  try {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    throw new Refusal(`its view cannot copy ${source} (${code === 'ELOOP' ? 'a link' : code ?? (error as Error).message})`)
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Refusal(`its view cannot copy ${source}: not a plain file`)
    if (stat.size > SETUP_LIMITS.copyBytes) throw new Refusal(`its view cannot copy ${source}: ${stat.size} bytes, over ${SETUP_LIMITS.copyBytes}`)
    const out = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      const buffer = Buffer.alloc(1024 * 1024)
      let copied = 0
      for (;;) {
        const n = readSync(fd, buffer, 0, buffer.length, null)
        if (!n) break
        copied += n
        if (copied > SETUP_LIMITS.copyBytes) throw new Refusal(`its view cannot copy ${source}: it grew past ${SETUP_LIMITS.copyBytes} bytes`)
        writeSync(out, buffer, 0, n)
      }
    } finally {
      closeSync(out)
    }
  } finally {
    closeSync(fd)
  }
}

/** Run a confined command to its end, or until `signal` stops it (SIGKILL; bubblewrap takes its namespace with it). */
function runBounded(command: { command: string; args: string[] }, env: Record<string, string>, signal: AbortSignal): Promise<{ code: number | null; signal: string | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    let output = ''
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-64 * 1024)
    }
    const child = spawn(command.command, command.args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stop = (): void => {
      child.kill('SIGKILL')
    }
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.once('error', (error) => {
      signal.removeEventListener('abort', stop)
      reject(new Refusal(`its commands cannot start: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? `${command.command} is not installed` : error.message}`))
    })
    child.once('close', (code, killed) => {
      signal.removeEventListener('abort', stop)
      resolvePromise({ code, signal: killed, output })
    })
  })
}
