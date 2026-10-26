/**
 * A pilot in miniature for the `algorithm-development` template (PROP-0010 B8): the real workflow
 * engine, board, approval queue, resource ledger, digest provider, and `agents` Worker source with a
 * git worktree per workflow run, over a scratch repository. Only the agent runtime is scripted: it
 * asks its run's tool gate before every tool call, as a gating runtime does, and acts in the
 * workspace its run spec names. The report plugin's tests run their pilot on it too.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry, { type AgentRuntimeProvider, type RunResult, type RunSpec, type ToolVerdict } from '@tsuuanmi/system-agent-runtimes'
import AgentWorkers from '@tsuuanmi/system-agent-workers'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import type { ArtifactRef, BoardTask, Charter, TaskInput } from '@tsuuanmi/system-board-core'
import StoreDigests from '@tsuuanmi/system-digest'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import LocalLanding from '@tsuuanmi/system-landing-local'
import Leases from '@tsuuanmi/system-leases'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import StoreResources from '@tsuuanmi/system-resources'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import Workflow, { type RunView } from '@tsuuanmi/system-workflow'
import { vi } from 'vitest'
import * as SoftwareDevelopment from '../src/index.ts'

export const ORIGINAL = 'def add(a, b):\n    return a - b\n'
export const FIXED = 'def add(a, b):\n    return a + b\n'
/** The repository's validation command, listed on the policy's commands, so a run of it is judged a workspace write. */
export const TESTS = 'npm test'
/** What the author's scripted checks print, pasted into the dossier as evidence (T267). */
export const MEASURED = 'Tests: 3 passed, 0 failed'
/** The evidence entry the scripted developer appends: the command, its exit code, and the lines that hold the result. */
export const EVIDENCE = `$ ${TESTS}\nexit 0\n${MEASURED}`

/**
 * The bundle's studio policy (packages/system-bundle/cordis.patch.yml): reads run, workspace writes
 * run with tests and lint required at acceptance, everything else asks; with the repository's
 * validation command listed, as the pilot runbook has the operator add it.
 */
export const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio-default', version: 1, scope: 'studio',
  rules: [
    { actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto', requires: ['tests', 'lint'] },
    ...(['merge', 'command', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change'] as const).map((actionClass) => ({ actionClass, mode: 'ask' as const })),
  ],
  default: 'ask', commands: [TESTS], expiry: { defaultSeconds: 86_400, maxSeconds: 1_209_600 }, batch: { maxSize: 10, maxWaitSeconds: 3600 },
}

export const POOL = 'plan.agents'

/** A run's part in the template, from what its brief asks. */
export type Role = 'develop' | 'selfreview' | 'review' | 'verify' | 'fix' | 'digest'
const roleOf = (spec: RunSpec): Role => spec.prompt.includes('Digest the raw artifacts below') ? 'digest'
  // The review's verification (ADR-0075): a second reviewer, read-only too, that votes on its important findings.
  : spec.sandbox === 'read-only' && spec.prompt.includes('## Verify these findings') ? 'verify'
  : spec.sandbox === 'read-only' ? (spec.prompt.includes('You wrote this change in an earlier session') ? 'selfreview' : 'review')
    : spec.prompt.includes('Fix the blocking findings') ? 'fix' : 'develop'

export interface Script {
  /** How many reviews request changes with a blocking finding before one approves (default 0). */
  changes?: number
  /** How many of the author's own reviews request changes with an important finding before one approves (default 0). */
  selfChanges?: number
  /** Whether the developer appends the output of its checks to the dossier as evidence before it ends (default true; T267). */
  evidence?: boolean
  /** The text of that evidence entry (default {@link EVIDENCE}): what an author that pastes no real output would write instead. */
  evidenceText?: string
  /** Whether the runtime gives its runs the dossier tools, as host tools (default true). */
  hostTools?: boolean
  /** Whether the runtime proves its commands confined (default true). */
  executes?: boolean
  /**
   * Route by kind of work (ADR-0057): the writers by id, each with the kinds the operator gives it,
   * in place of the one `developer` given none; the reviewer and the digest Worker are given none.
   * docs/operations/examples/work-kinds.patch.yml gives its writer `[code, docs, tests]` and its
   * validator `[validation]`.
   */
  writers?: Record<string, string[]>
  /** The profile row's configuration (default none: the shipped kinds). */
  profile?: SoftwareDevelopment.Config
  /** How many reviews end on a broken session before one answers (default 0): T110a's review that reached its turn limit. */
  reviewFails?: number
  /** Whether the developer commits its change in its worktree, moving the worktree's HEAD off the commit the task writes (default false). */
  commits?: boolean
  /**
   * The repository's checks (T151): the command of each, as the operator configures them in its
   * worktree setup and lists them in the studio policy. The repository then holds {@link CHECK_FILES}.
   */
  checks?: { tests?: string; lint?: string }
  /** Review guides (T267) the repository holds under `docs/review/`, by file name, committed before any worktree is cut. */
  guides?: Record<string, string>
  /** Seconds a check may print nothing before it is reported as stalled (the setup's `checkStallSeconds`, T235). */
  checkStallSeconds?: number
}

/**
 * Check scripts the repository holds when a pilot configures checks: `tests.mjs` passes when add()
 * adds, `lint.mjs` always passes, and `lint-strict.mjs` fails (exit 2) on a calc.py with no header
 * comment, as a stricter lint rule would.
 */
export const CHECK_FILES: Record<string, string> = {
  'tests.mjs': "import { readFileSync } from 'node:fs'\nconst ok = readFileSync('calc.py', 'utf8').includes('a + b')\nconsole.log(ok ? 'tests: 3 passed' : 'tests: add() does not add')\nprocess.exit(ok ? 0 : 1)\n",
  'lint.mjs': "console.log('lint: clean')\n",
  'lint-strict.mjs': "import { readFileSync } from 'node:fs'\nif (!readFileSync('calc.py', 'utf8').startsWith('#')) { console.error('lint-strict: calc.py has no header comment'); process.exit(2) }\n",
  // A lint that prints, then nothing for 4 s, then passes: a check stalled for a while (T235).
  'lint-quiet.mjs': "console.log('lint-quiet: started')\nsetTimeout(() => process.exit(0), 4000)\n",
}
/** The worktree setup a pilot with checks configures: one command, listed in the policy. */
export const SETUP_COMMAND = 'true'

/** The scripted agent runtime: every run asks its gate before each tool call, then acts as its role does. */
export class PilotAgent implements AgentRuntimeProvider {
  readonly kind = 'scripted'
  readonly runs: Array<RunSpec & { role: Role }> = []
  readonly calls: Array<{ role: Role; tool: string; verdict: ToolVerdict }> = []
  /** What calc.py held in its worktree when each develop run started. */
  readonly found: string[] = []
  /** What the dossier tool answered each time the developer (or its fix) appended evidence. */
  readonly appended: Array<{ text: string; isError: boolean }> = []
  /** What `dossier_read` answered each self-review that tried it. */
  readonly selfReads: Array<{ text: string; isError: boolean }> = []
  /** What each self-review found when it read the files an earlier step was given in the worktree (`.system/`). */
  readonly selfFiles: Array<{ dossier: boolean; tasks: boolean }> = []
  private reviews = 0
  private selfReviews = 0
  private brokenReviews = 0
  constructor(readonly script: Script = {}) {}

  async probe() {
    return {
      available: true, detail: 'scripted 1.0', version: '1.0', sandboxes: ['read-only', 'workspace-write'] as Array<'read-only' | 'workspace-write'>,
      resume: true, executes: this.script.executes ?? true, readsConfined: true, gatesToolCalls: true, ...(this.script.hostTools === false ? {} : { hostTools: true }),
    }
  }

  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void): Promise<RunResult> {
    const role = roleOf(spec)
    this.runs.push({ ...spec, role })
    const n = this.runs.length
    const handle = spec.resume ?? `h-${n}`
    onHandle?.(handle)
    let made = 0
    /** Ask the gate: a deferred call stops the run; a denied one is told to the agent, which goes on without it. */
    const call = async (tool: string, input: Record<string, unknown>): Promise<boolean> => {
      const verdict = await spec.toolGate!({ tool, input, callId: `call-${n}-${++made}` }, signal)
      this.calls.push({ role, tool, verdict })
      if (verdict.decision === 'defer') throw new ProviderError('config_error', `scripted: stopped at ${tool} (approval request ${verdict.requestId})`)
      return verdict.decision === 'allow'
    }
    /** Append the checks' output to the task's dossier, as a writing step must before it ends (T267). */
    const verify = async (): Promise<void> => {
      if (this.script.evidence === false || !spec.hostTools?.length) return
      const tool = spec.hostTools.find((t) => t.name === 'dossier_append')!
      const entry = { kind: 'evidence', text: this.script.evidenceText ?? EVIDENCE }
      if (await call('mcp__system__dossier_append', entry)) this.appended.push(await tool.call(entry))
    }
    let text: string
    switch (role) {
      case 'develop':
        this.found.push(readFileSync(join(spec.workspace, 'calc.py'), 'utf8'))
        if (await call('Write', { file_path: join(spec.workspace, 'calc.py'), content: FIXED })) writeFileSync(join(spec.workspace, 'calc.py'), FIXED)
        if (this.script.commits) git(spec.workspace, 'commit', '-q', '-a', '-m', 'developer: add adds')
        // The author verifies before anyone reviews it: it shows the checks' output in the task's dossier (T267).
        await verify()
        text = 'Hypothesis: add() returns the difference, so the tests that sum fail. Changed calc.py; criterion a1 should now be met.'
        break
      case 'fix':
        if (await call('Write', { file_path: join(spec.workspace, 'test_calc.py'), content: 'assert True\n' })) writeFileSync(join(spec.workspace, 'test_calc.py'), 'assert True\n')
        // The fix shows the checks' output for the fixed tree, as the step it fixes did (T267).
        await verify()
        text = 'Added test_calc.py, the test the review asked for.'
        break
      case 'selfreview': {
        await call('Read', { file_path: join(spec.workspace, 'calc.py') })
        // It tries to read what its author wrote in the dossier: the engine refuses it (T267).
        const read = spec.hostTools?.find((t) => t.name === 'dossier_read')
        if (read && await call('mcp__system__dossier_read', {})) this.selfReads.push(await read.call({}))
        // And the files the author's step was given in the shared worktree, looked for directly on disk,
        // as a read inside the workspace would find them (whatever the gate says of the call).
        this.selfFiles.push({ dossier: existsSync(join(spec.workspace, '.system', 'DOSSIER.md')), tasks: existsSync(join(spec.workspace, '.system', 'TASKS.md')) })
        const subject = /^Subject: (\S+)$/m.exec(spec.prompt)![1]!
        const changes = this.selfReviews++ < (this.script.selfChanges ?? 0)
        text = '```json\n' + JSON.stringify({
          subject, verdict: changes ? 'changes-requested' : 'approve',
          findings: [changes
            ? { severity: 'important', title: 'a stray debug line', file: 'calc.py', line: 2, evidence: 'calc.py line 2 holds a line the task does not need' }
            : { severity: 'nit', title: 'nothing the author is blind to', file: 'calc.py' }],
        }) + '\n```'
        break
      }
      case 'review': {
        if (this.brokenReviews < (this.script.reviewFails ?? 0)) {
          this.brokenReviews++
          throw new ProviderError('session_broken', 'scripted: Reached maximum number of turns (4)')
        }
        await call('Read', { file_path: join(spec.workspace, 'calc.py') })
        const subject = /^Subject: (\S+)$/m.exec(spec.prompt)![1]!
        const changes = this.reviews++ < (this.script.changes ?? 0)
        text = '```json\n' + JSON.stringify({
          subject, verdict: changes ? 'changes-requested' : 'approve',
          findings: [changes
            ? { severity: 'important', title: 'no test covers add()', file: 'calc.py', line: 2, evidence: 'calc.py line 2 changed add(), and no test calls it' }
            : { severity: 'nit', title: 'add() now adds', file: 'calc.py' }],
        }) + '\n```'
        break
      }
      case 'verify': {
        // The second reviewer reads the code and confirms each important finding it is given.
        await call('Read', { file_path: join(spec.workspace, 'calc.py') })
        const subject = /^Verified subject: (\S+)$/m.exec(spec.prompt)![1]!
        const votes = [...spec.prompt.matchAll(/^- (f\d+) important:/gm)].map((m) => ({ finding: m[1], vote: 'confirm', reason: 'calc.py has no test of add()' }))
        text = '```json\n' + JSON.stringify({ subject, votes }) + '\n```'
        break
      }
      case 'digest': {
        // Quote the first line of the first artifact given, verbatim, as the quote check requires.
        const [, artifact, first] = /<artifact id="(sha256:[0-9a-f]{64})">\n([^\n]*)/.exec(spec.prompt)!
        text = '```json\n' + JSON.stringify({
          status: 'passed', summary: 'The attempt was validated.', claims: [{ id: 'C1', kind: 'finding', text: 'The validation ran.', citation: { artifact, quote: first } }],
        }) + '\n```'
        break
      }
    }
    return { text, nativeHandle: handle, turns: 2, model: 'model-a', resultId: `result-${n}`, usage: { inputTokens: 1000, outputTokens: 100 }, costUsd: 0.25 }
  }
}

export interface Pilot {
  ctx: Context
  agent: PilotAgent
  /** The repository the Workers are configured on, and its HEAD commit. */
  repo: string
  head: string
  git: (dir: string, ...args: string[]) => string
  dispose: () => Promise<void>
}

const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim()

/**
 * Boot the pilot: a repository with one commit; three agent Workers on it, as the pilot runbook
 * configures them (a developer that writes in a worktree per run, a read-only reviewer, and a
 * read-only digest Worker on the economy tier), metered on one pool; then `extra` plugins.
 */
export async function bootPilot(script: Script = {}, extra: Plugin[] = []): Promise<Pilot> {
  const dir = mkdtempSync(join(tmpdir(), 'system-pilot-'))
  const repo = join(dir, 'algo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'calc.py'), ORIGINAL)
  if (script.checks) for (const [name, text] of Object.entries(CHECK_FILES)) writeFileSync(join(repo, name), text)
  if (script.guides) {
    mkdirSync(join(repo, 'docs', 'review'), { recursive: true })
    for (const [name, text] of Object.entries(script.guides)) writeFileSync(join(repo, 'docs', 'review', name), text)
  }
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  const agent = new PilotAgent(script)
  const worker = (id: string, sandbox: 'read-only' | 'workspace-write', tier: 'economy' | 'standard', kinds?: string[]) => ({
    id, runtime: 'scripted', workspace: repo, sandbox, tier, worktreePerRun: true, pool: POOL, account: 'plan', ...(kinds ? { kinds } : {}),
  })
  const writers = script.writers
    ? Object.entries(script.writers).map(([id, kinds]) => worker(id, 'workspace-write', 'standard', kinds))
    : [worker('developer', 'workspace-write', 'standard')]
  const ctx = new Context()
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    // With checks, the operator lists the setup's command and each check's in the studio policy, so each runs unasked.
    ctx.plugin(StoreApprovals, { policies: [script.checks ? { ...POLICY, commands: [...POLICY.commands!, SETUP_COMMAND, ...Object.values(script.checks)] } : POLICY], sweepSeconds: 3600 }),
    ctx.plugin(StoreResources, { pools: [{ pool: POOL, account: 'plan', kind: 'programmatic', unknown: 'available', windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18_000 }] }] }),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}), ctx.plugin(AgentRuntimeRegistry),
    ctx.plugin(AgentWorkers, {
      workers: [...writers, worker('reviewer', 'read-only', 'standard'), worker('digester', 'read-only', 'economy')], worktreeRoot: join(dir, 'worktrees'),
      ...(script.checks ? { worktreeSetup: [{ repository: repo, commands: [SETUP_COMMAND], checks: script.checks, ...(script.checkStallSeconds ? { checkStallSeconds: script.checkStallSeconds } : {}) }] } : {}),
    }),
    ctx.plugin(StoreBoard, { sweepSeconds: 0 }), ctx.plugin(StoreDigests, {}),
    // The landing seam's provider, as the bundle's `landing-local` row mounts it (PROP-0017 L0).
    ctx.plugin(LocalLanding),
    ctx.plugin(Workflow, { retryDelayMs: 50, maxAttempts: 2, approvalPollSeconds: 1 }),
  ]
  await Promise.all(fibers)
  ctx.agentRuntimes.register(agent)
  fibers.push(ctx.plugin(SoftwareDevelopment, script.profile ?? {}))
  await fibers.at(-1)
  for (const plugin of extra) {
    fibers.push(ctx.plugin(plugin))
    await fibers.at(-1)
  }
  return {
    ctx, agent, repo, head: git(repo, 'rev-parse', 'HEAD'), git,
    dispose: async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export const until = <T>(read: () => T | undefined | Promise<T | undefined>, what: string, ms = 30_000): Promise<T> => vi.waitFor(async () => {
  const value = await read()
  if (!value) throw new Error(`timed out waiting for ${what}`)
  return value
}, { timeout: ms, interval: 25 })

/** The operator's verdict on a request in the queue, bound to the subject it shows. */
export async function decide(ctx: Context, requestId: string, verdict: 'approved' | 'rejected' = 'approved'): Promise<void> {
  const request = (await ctx.approvals.get(requestId))!
  const [result] = await ctx.approvals.decide([{ requestId, subject: request.subject, verdict }])
  if (result?.refused) throw new Error(`the verdict on ${requestId} was refused: ${result.refused}`)
}

/** Found a project with the operator's approval of its charter (`maxInterruptionsPerDay` as its attention budget). */
export async function charter(ctx: Context, projectId: string, maxInterruptionsPerDay = 10): Promise<void> {
  const text: Charter = {
    version: 1, intent: 'add() adds, with its tests passing.',
    criteria: [{ id: 'correct', statement: 'npm test passes', measure: { kind: 'tests' } }], constraints: {},
    stopRules: [{ id: 'no-progress', condition: 'No accepted result in three attempts', action: 'pause' }],
    budget: { pools: [{ pool: POOL, unit: 'runs', amount: 50 }], attention: { maxBatchesPerDay: 4, maxInterruptionsPerDay } },
  }
  const { approvalRequest } = await ctx.board.charter({ projectId, title: `project ${projectId}`, charter: text, milestones: [{ id: 'm1', title: 'add() adds', state: 'planned' }] })
  await decide(ctx, approvalRequest)
  await ctx.board.sweep(new Date())
}

/** An algorithm-development task that writes the repository at `head`, made ready by the board's sweep. */
export async function propose(pilot: Pilot, projectId: string, title: string, extra: Partial<TaskInput> = {}): Promise<BoardTask> {
  const task = await pilot.ctx.board.propose({
    projectId, title, goal: 'Make add() add, with its tests passing', milestone: 'm1',
    acceptance: [{ id: 'a1', statement: `${TESTS} passes`, check: 'tests' }], actionClass: 'workspace-write', template: 'algorithm-development',
    writes: { type: 'git-head', ref: pilot.head }, ...extra,
  })
  await pilot.ctx.board.sweep(new Date())
  return (await pilot.ctx.board.task(task.taskId))!
}

/** Start one attempt of the task, as a lead does with MCP `run` and `task`; `fresh`, opting out of the previous attempt's change (T271). */
export const attempt = (ctx: Context, taskId: string, input = 'Fix add() so it adds', fresh = false): Promise<RunView> =>
  ctx.workflow.start({ template: 'algorithm-development', input, classification: 'operator-shared', task: { taskId, ...(fresh ? { fresh } : {}) } })

/** The run, once it waits on its remediation fix's request in the approval queue. */
export const queued = (ctx: Context, runId: string): Promise<{ approvalRequest: string; plan: string; nodeId: string }> => until(() => {
  const blocked = ctx.workflow.get(runId)?.blocked
  return blocked?.kind === 'gate' && blocked.approvalRequest ? { approvalRequest: blocked.approvalRequest, plan: blocked.plan, nodeId: blocked.nodeId } : undefined
}, `run ${runId} to wait on the approval queue`)

/** The run, once its outcome reached its board task. */
export const reported = (ctx: Context, runId: string): Promise<RunView> => until(() => {
  const view = ctx.workflow.get(runId)
  return view?.task?.phase === 'reported' ? view : undefined
}, `run ${runId}'s report to its task`, 60_000)

/** The operator's acceptance of a task's result on `/ui`: an `acceptance` decision by the operator, applied by the board. */
export async function operatorAccepts(ctx: Context, taskId: string, option: 'accept' | 'reject' = 'accept'): Promise<BoardTask> {
  const task = (await ctx.board.task(taskId))!
  const result = task.result!
  const other = option === 'accept' ? 'reject' : 'accept'
  const decision = ctx.artifacts.recordDecision({
    decisionType: 'acceptance', question: `Does the operator accept the result of board task ${taskId}?`,
    inputs: [...result.artifacts, ...(result.digest ? [result.digest] : [])],
    candidates: [{ option, selected: true, reasons: [`the operator ${option}s it`] }, { option: other, selected: false, reasons: [`not ${other}: the operator chose ${option}`] }],
    decider: { type: 'operator', id: 'operator.review', version: '1' }, outcome: { option, detail: { taskId, subject: result.subject } }, deterministic: false,
  }, { producer: { type: 'operator', ref: 'operator' } }).id as ArtifactRef
  return ctx.board.accept(taskId, decision)
}
