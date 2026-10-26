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
import { spawn, type StdioOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { childEnvironment, confinedCommand, type Confinement, proveConfinement } from '@tsuuanmi/system-agent-runtime-core'
import { type ApprovalRequest, type Approvals, type ArtifactRef, type AutonomyVerdict, SHELL_METACHARACTER } from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import type {} from '@tsuuanmi/system-event-log'
import { type ContentId, contentId, ensurePrivateDir, ignoredPath } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type {} from '@tsuuanmi/system-store'
import { RUN_CHECKS, type RunCheck } from '@tsuuanmi/system-workers-core'
import { changedFiles, DEFAULT_DEPENDENCY_FILES, type Dependencies, dependenciesOf, KEPT_FILES, missingPackages } from './dependencies.ts'
import { CHECKS } from './gate.ts'
import { repositoryKey } from './worktrees.ts'

/**
 * Package manager settings as environment variables, each under both prefixes: pnpm 11 and later
 * read only `pnpm_config_<name>` (an `npm_config_<name>` is ignored there), and npm and earlier
 * pnpm read `npm_config_<name>` (T235).
 */
function packageManagerSettings(settings: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(settings).flatMap(([name, value]) => [[`pnpm_config_${name}`, value], [`npm_config_${name}`, value]]))
}

/**
 * The environment a setup's commands run in: the child environment, with pnpm (and npm) told to stay
 * offline, so an install that lacks a package fails at once naming it, never waits on a network the
 * confinement does not give (T235).
 */
export function setupEnvironment(): Record<string, string> {
  return childEnvironment([], packageManagerSettings({ offline: 'true' }))
}

/**
 * The environment a command that must not install runs in: a check's (./checks.ts) and a landing's
 * generated files' commands (./regenerate.ts). The child environment, with pnpm's
 * verify-deps-before-run off, so pnpm never starts an install before a script (the setup owns
 * installation, and runs again for a result that changed its dependencies), and pnpm (and npm)
 * offline, so nothing waits on a network the confinement does not give (T235).
 */
export function noInstallEnvironment(): Record<string, string> {
  return childEnvironment([], packageManagerSettings({ verify_deps_before_run: 'false', offline: 'true' }))
}

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
  /**
   * The command of each check a policy can require (`tests`, `typecheck`, `lint`) for this repository,
   * its words split on single spaces as the policy's commands list matches them: a workflow run's
   * checks run it on the run's result, in the setup's confinement and views (./checks.ts, T151).
   */
  checks?: Partial<Record<RunCheck, string>>
  /** Each check's deadline, in seconds (default 1800). */
  checkTimeoutSeconds?: number
  /**
   * Seconds a check may print nothing before it is reported as stalled (default 300): an
   * `agent-workers.check` event the run's explain and the web UI show while it lasts (T235). The
   * check goes on to its deadline; this only says so, early.
   */
  checkStallSeconds?: number
  /**
   * The names of the files that say what the setup installs (default {@link DEFAULT_DEPENDENCY_FILES}):
   * when a result changes any of them, at any depth, against the tree the setup last ran on, the
   * setup runs again on the result's tree before its checks run (T235).
   */
  dependencyFiles?: string[]
  /**
   * Paths inside the worktree (relative) that its checks see as fresh, private, writable directories
   * (a build or test cache such as `node_modules/.vite`): the checks see the rest of the worktree
   * read-only. Each must be ignored by git and hold nothing tracked, so it is never part of the
   * subject a check is judged on; what a check writes there is discarded when it ends.
   */
  checkScratch?: string[]
  /**
   * The repository's generated files and the commands that make them (T166): a landing whose merge
   * conflicts only in these files regenerates them with the commands, in the run's worktree, in the
   * setup's confinement, instead of refusing (./regenerate.ts).
   */
  generated?: WorktreeGeneratedConfig
}

/** Files a repository generates, and how (`worktreeSetup[].generated`). */
export interface WorktreeGeneratedConfig {
  /** Repository-relative paths; a `*` stands for any characters within one path segment (never a `/`). */
  paths: string[]
  /** The commands that regenerate them, in order, each its words split on single spaces (no shell). */
  commands: string[]
}

/** A setup's generated files as loaded: the path patterns, and the commands as lines and argv. */
export interface Generated {
  paths: string[]
  lines: string[]
  commands: string[][]
}

/** A setup as loaded: every default filled in, its commands as argv, and the hash an approval binds to. */
export interface Setup {
  repository: string
  lines: string[]
  commands: string[][]
  views: Array<Required<WorktreeSetupView>>
  timeoutSeconds: number
  /** The content id of the setup's definition (repository, commands, views, deadline): a change to any of it is another setup, asked about again. */
  hash: ContentId
  /** Each check's command line and argv; not part of the setup's hash, since the setup does not run them. */
  checks: Partial<Record<RunCheck, { line: string; argv: string[] }>>
  checkTimeoutSeconds: number
  /** Seconds a check may print nothing before it is reported as stalled; not part of the hash. */
  checkStallSeconds: number
  /** The file names whose change on a result sets the worktree up again before its checks; not part of the hash. */
  dependencyFiles: string[]
  /** The worktree's paths its checks see as fresh private writable directories (relative); not part of the hash either. */
  checkScratch: string[]
  /** The repository's generated files, when declared; not part of the setup's hash, since the setup does not run their commands. */
  generated?: Generated
}

/**
 * Whether the repository-relative `path` is one `pattern` names: as many segments, each equal, a `*`
 * in the pattern standing for any characters within its segment.
 */
export function generatedPath(patterns: readonly string[], path: string): boolean {
  const segments = path.split('/')
  return patterns.some((pattern) => {
    const parts = pattern.split('/')
    return parts.length === segments.length && parts.every((part, i) => new RegExp(`^${part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(segments[i]!))
  })
}

/** Why a generated-file pattern is not one: a relative path, no `.`, `..`, or empty segment, no glob but `*`, never under `.git` or `.system`. */
function patternProblem(pattern: unknown): string | undefined {
  if (!RELATIVE(pattern)) return 'is not a relative path without ., .., or an empty segment'
  const text = pattern as string
  if (text.length > SETUP_LIMITS.commandChars) return `is longer than ${SETUP_LIMITS.commandChars} characters`
  if (/[?[\]{}\\\n\r]/.test(text) || text.includes('**')) return 'holds a glob character other than a single * within a segment'
  const first = text.split('/')[0]!
  if (first === '.git' || first === '.system' || first === '*') return 'names .git, .system, or every top-level entry, which are never generated files'
  return undefined
}

/** `commandChars` is the policy's own bound on a commands-list line (`autonomy-policy@1.0`): every setup command can be listed there. */
const SETUP_LIMITS ={ commands: 16, commandChars: 200, views: 8, entries: 32, defaultTimeoutSeconds: 600, maxTimeoutSeconds: 3600, copyBytes: 1024 ** 3, defaultCheckTimeoutSeconds: 1800, generatedPaths: 32, defaultCheckStallSeconds: 300, dependencyFiles: 32 } as const
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
function lineProblem(line: unknown): string | undefined {
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
    const checks: Setup['checks'] = {}
    if (entry.checks !== undefined && (typeof entry.checks !== 'object' || entry.checks === null || Array.isArray(entry.checks))) fail(`${repository}: checks maps a check name to its command`)
    for (const [name, line] of Object.entries(entry.checks ?? {})) {
      if (!RUN_CHECKS.includes(name as RunCheck)) fail(`${repository}: checks names ${name}; a check is one of ${RUN_CHECKS.join(', ')}`)
      const problem = lineProblem(line)
      if (problem) fail(`${repository}: the ${name} check's command ${problem}`)
      checks[name as RunCheck] = { line: line as string, argv: (line as string).split(' ') }
    }
    const checkTimeoutSeconds = entry.checkTimeoutSeconds ?? SETUP_LIMITS.defaultCheckTimeoutSeconds
    if (!Number.isInteger(checkTimeoutSeconds) || checkTimeoutSeconds < 1 || checkTimeoutSeconds > SETUP_LIMITS.maxTimeoutSeconds) fail(`${repository}: checkTimeoutSeconds is 1 to ${SETUP_LIMITS.maxTimeoutSeconds}`)
    const checkStallSeconds = entry.checkStallSeconds ?? SETUP_LIMITS.defaultCheckStallSeconds
    if (!Number.isInteger(checkStallSeconds) || checkStallSeconds < 1 || checkStallSeconds > SETUP_LIMITS.maxTimeoutSeconds) fail(`${repository}: checkStallSeconds is 1 to ${SETUP_LIMITS.maxTimeoutSeconds}`)
    // The config schema gives an omitted list as empty: the default then.
    const dependencyFiles = entry.dependencyFiles?.length ? entry.dependencyFiles : [...DEFAULT_DEPENDENCY_FILES]
    if (!Array.isArray(dependencyFiles) || dependencyFiles.length > SETUP_LIMITS.dependencyFiles || dependencyFiles.some((name) => !RELATIVE(name) || name.includes('/') || name === '.git' || name.length > 255)) {
      fail(`${repository}: dependencyFiles names up to ${SETUP_LIMITS.dependencyFiles} file names, each a plain name (no /, not . or ..)`)
    }
    if (new Set(dependencyFiles).size !== dependencyFiles.length) fail(`${repository}: dependencyFiles names a file twice`)
    const checkScratch = entry.checkScratch ?? []
    if (!Array.isArray(checkScratch) || checkScratch.length > SETUP_LIMITS.entries || checkScratch.some((path) => !RELATIVE(path) || path.split('/')[0] === '.git')) {
      fail(`${repository}: checkScratch names up to ${SETUP_LIMITS.entries} relative paths inside the worktree, none with . or .., none in .git`)
    }
    const overlapping = checkScratch.find((p, i) => checkScratch.some((q, j) => i !== j && (p === q || p.startsWith(`${q}/`))))
    if (overlapping) fail(`${repository}: checkScratch names ${overlapping} and another that holds it, or names it twice`)
    const generated = loadGenerated(repository, entry.generated)
    const definition = { repository, commands: [...lines], views, timeoutSeconds }
    loaded.set(repository, { ...definition, lines: [...lines], commands: lines.map((line) => line.split(' ')), hash: contentId(definition), checks, checkTimeoutSeconds, checkStallSeconds, dependencyFiles: [...dependencyFiles], checkScratch: [...checkScratch], ...(generated ? { generated } : {}) })
  }
  return loaded
}

/** A setup's `generated` as loaded, checked: 1 to 32 path patterns, distinct, and 1 to 16 commands a policy can match word for word. */
function loadGenerated(repository: string, generated: WorktreeGeneratedConfig | undefined): Generated | undefined {
  if (generated === undefined) return undefined
  if (typeof generated !== 'object' || generated === null || Array.isArray(generated)) fail(`${repository}: generated holds paths and commands`)
  const { paths, commands } = generated
  // The config schema gives an omitted `generated` as an object with both lists empty (or absent): none declared.
  const none = (list: unknown): boolean => list === undefined || (Array.isArray(list) && !list.length)
  if (none(paths) && none(commands)) return undefined
  if (!Array.isArray(paths) || !paths.length || paths.length > SETUP_LIMITS.generatedPaths) fail(`${repository}: generated.paths holds 1 to ${SETUP_LIMITS.generatedPaths} paths`)
  for (const [i, pattern] of paths.entries()) {
    const problem = patternProblem(pattern)
    if (problem) fail(`${repository}: generated path ${i + 1} (${String(pattern)}) ${problem}`)
  }
  if (new Set(paths).size !== paths.length) fail(`${repository}: generated.paths names a path twice`)
  if (!Array.isArray(commands) || !commands.length || commands.length > SETUP_LIMITS.commands) fail(`${repository}: generated.commands holds 1 to ${SETUP_LIMITS.commands} commands`)
  for (const [i, line] of commands.entries()) {
    const problem = lineProblem(line)
    if (problem) fail(`${repository}: generated command ${i + 1} ${problem}`)
  }
  return { paths: [...paths], lines: [...commands], commands: commands.map((line) => line.split(' ')) }
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
  constructor(message: string, readonly inputs: ArtifactRef[] = [], readonly detail: Record<string, unknown> = {}, readonly output?: string) {
    super(message)
  }
}

/** A workflow run whose result's checks need its worktree set up for the result's dependencies. */
export interface RefreshRun {
  workflowRunId: string
  sessionId?: string | undefined
  classification: 'public' | 'operator-shared' | 'local-private'
  /** The worktree (its stored path) and the repository it belongs to (real path). */
  worktree: string
  repository: string
  /** The result's subject id (`git:<ref>:<version>`): the tree the checks are for. */
  subject: string
}

/**
 * What setting a worktree up for a result's checks came to: `current` when its dependency files are
 * as its setup last installed them (nothing ran); `ran` when the setup ran again on the result's tree;
 * `refused` when it could not, with the `gate` decision that records why, unless nothing was judged.
 */
export type Refreshed =
  | { outcome: 'current' }
  | { outcome: 'ran'; decision: ContentId; changed: string[] | undefined }
  | { outcome: 'refused'; decision?: ContentId; cause: 'dependency_unavailable' | 'failed'; reason: string; missing?: string[] }

/** The rule of the decision a setup run again for a result's checks records (T235). */
const AGAIN_RULE = { type: 'rule', id: 'agent-workers.worktree-setup-again', version: '1' } as const

/** The dependency files a setup decision recorded, when it recorded them. */
function recordedDependencies(body: unknown): { digest: string; files?: Record<string, string> } | undefined {
  const deps = (body as { outcome?: { detail?: { dependencies?: { digest?: unknown; files?: unknown } } } } | undefined)?.outcome?.detail?.dependencies
  if (typeof deps?.digest !== 'string') return undefined
  return { digest: deps.digest, ...(deps.files && typeof deps.files === 'object' ? { files: deps.files as Record<string, string> } : {}) }
}

/** The dependency files as a decision keeps them: the digest, and each file's hash while they are few. */
const keptDependencies = (deps: Dependencies): Record<string, unknown> => ({ digest: deps.digest, count: Object.keys(deps.files).length, ...(Object.keys(deps.files).length <= KEPT_FILES ? { files: deps.files } : {}) })

/** Paths as a reason names them: the first ten, and how many more. */
const listed = (paths: readonly string[]): string => `${paths.slice(0, 10).join(', ')}${paths.length > 10 ? ` and ${paths.length - 10} more` : ''}`

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
      const row = this.ctx.store.db.prepare('SELECT setup_hash, setup_decision, gitdir FROM agent_worktrees WHERE path = ? AND removed_at IS NULL').get(run.worktree) as { setup_hash: string | null; setup_decision: string | null; gitdir: string } | undefined
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
        await this.execute(run.worktree, setup, signal)
      } catch (error) {
        if (signal.aborted) throw error
        return this.refused(run, setup, error instanceof Refusal ? new Refusal(error.message, inputs, error.detail) : new Refusal((error as Error).message, inputs))
      }
      // What it installed for: a result that changes any of these has the setup run again before its checks (T235).
      const dependencies = await this.dependencies(run.worktree, row.gitdir, setup)
      const decision = this.decide(run, setup, 'start', [`its setup ${setup.hash} ran: ${setup.commands.length} command(s), each allowed by the autonomy policy and exited 0, confined (the host read-only but the worktree, no network)${pending.length ? `; the checks ${pending.join(', ')} stay pending, bound when the run's result is accepted` : ''}`], inputs, {
        ...(pending.length ? { pendingChecks: pending } : {}), ...(dependencies ? { dependencies: keptDependencies(dependencies) } : {}),
      })
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

  /**
   * Set the worktree up again for a result's checks (T235), when its dependency files (the setup's
   * `dependencyFiles`, at any depth) are not what the setup last installed for: the setup's commands,
   * each judged by the autonomy policy and run only when it allows them unasked (no one is there to
   * ask while checks run), in the setup's confinement (the worktree writable, no network) and offline
   * environment, on the result's tree. What it came to is a `gate` decision (rule
   * `agent-workers.worktree-setup-again`); once it ran, that decision is the worktree's setup decision,
   * with the dependency files it installed for. An install that needed the network is refused as
   * `dependency_unavailable`, naming the packages it lacked. One setup at a time per worktree. Throws
   * only when `signal` stopped it.
   */
  refresh(run: RefreshRun, setup: Setup, signal: AbortSignal): Promise<Refreshed> {
    return this.exclusive(run.worktree, async () => {
      const row = this.ctx.store.db.prepare('SELECT setup_hash, setup_decision, gitdir FROM agent_worktrees WHERE path = ? AND removed_at IS NULL').get(run.worktree) as { setup_hash: string | null; setup_decision: string | null; gitdir: string } | undefined
      if (!row || row.setup_hash !== setup.hash || !row.setup_decision) return { outcome: 'refused', cause: 'failed', reason: `the worktree ${run.worktree} was not set up under its repository's setup as loaded now (${setup.hash})` }
      const now = await this.dependencies(run.worktree, row.gitdir, setup)
      if (!now) return { outcome: 'refused', cause: 'failed', reason: `the dependency files of the worktree ${run.worktree} cannot be read, so whether its setup still holds for the result is not known` }
      const before = recordedDependencies(this.ctx.artifacts.get(row.setup_decision as ContentId)?.body)
      if (before?.digest === now.digest) return { outcome: 'current' }
      const changed = before?.files ? changedFiles(before.files, now.files) : undefined
      const why = before ? `its dependency files changed since its setup ran${changed ? ` (${listed(changed)})` : ''}` : 'its setup recorded no dependency files to compare with'
      const detail = { dependencies: keptDependencies(now), ...(changed ? { changed: changed.slice(0, 50) } : {}) }
      const inputs: ArtifactRef[] = [row.setup_decision as ArtifactRef]
      const refuse = (cause: 'dependency_unavailable' | 'failed', reason: string, more: Record<string, unknown> = {}, missing?: string[]): Refreshed => {
        const decision = this.decideAgain(run, setup, 'refuse', [`${why}, and its setup could not run again on the result: ${reason}`], inputs, { ...detail, cause, ...more })
        this.eventAgain(run, setup, 'refused', decision)
        return { outcome: 'refused', decision, cause, reason: `${why}; its setup run again on the result ${cause === 'dependency_unavailable' ? 'needs the network' : 'did not complete'}: ${reason} (decision ${decision})`, ...(missing ? { missing } : {}) }
      }
      const approvals = this.ctx.get('approvals')
      if (!approvals) return refuse('failed', 'no approval queue (ctx.approvals) is loaded, and no setup command runs without its autonomy decision')
      for (const [i, argv] of setup.commands.entries()) {
        const verdict = await approvals.check({ class: 'command', command: argv })
        inputs.push(verdict.decision)
        const pending = verdict.failedChecks ?? []
        if ((verdict.mode !== 'auto' && verdict.mode !== 'notify') || pending.some((c) => !CHECKS.includes(c))) {
          return refuse('failed', `the autonomy policy does not let its command ${i + 1} (${setup.lines[i]}) run unasked (${String(verdict.mode)}); a setup run again for a result's checks runs only commands the policy allows unasked, such as lines on the studio policy's commands list`)
        }
      }
      try {
        await this.execute(run.worktree, setup, signal)
      } catch (error) {
        if (signal.aborted) throw error
        const message = (error as Error).message
        const missing = error instanceof Refusal && error.output !== undefined ? missingPackages(error.output) : undefined
        if (missing) {
          return refuse('dependency_unavailable', `${missing.length ? `the packages ${missing.join(', ')} are not in the store it installs from` : 'it could not reach a registry'}, and it runs with no network: ${message}`, { missing }, missing)
        }
        return refuse('failed', message, error instanceof Refusal ? error.detail : {})
      }
      const after = await this.dependencies(run.worktree, row.gitdir, setup) ?? now
      const decision = this.decideAgain(run, setup, 'run', [`${why}: its setup ${setup.hash} ran again on the result, ${setup.commands.length} command(s), each allowed by the autonomy policy unasked and exited 0, confined (the host read-only but the worktree, no network)`], inputs, { ...detail, dependencies: keptDependencies(after) })
      this.ctx.store.transaction((db) => {
        db.prepare('UPDATE agent_worktrees SET setup_decision = ? WHERE path = ? AND removed_at IS NULL AND setup_hash = ?').run(decision, run.worktree, setup.hash)
      })
      this.eventAgain(run, setup, 'ran', decision)
      this.ctx.logger.info(`agent Workers: the setup ${setup.hash} of ${run.worktree} ran again for the dependencies of ${run.subject} (decision ${decision})`)
      return { outcome: 'ran', decision, changed }
    })
  }

  /** The worktree's dependency files now, or undefined when they cannot be read. */
  private async dependencies(worktree: string, gitdir: string, setup: Setup): Promise<Dependencies | undefined> {
    const path = real(worktree)
    if (!path) return undefined
    try {
      return await dependenciesOf(path, gitdir, setup.dependencyFiles)
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: the dependency files of ${worktree} could not be read: ${(error as Error).message}`)
      return undefined
    }
  }

  /** The `gate` decision of rule `agent-workers.worktree-setup-again` (INV-13): may the result's checks run, its worktree set up again for its dependencies? */
  private decideAgain(run: RefreshRun, setup: Setup, option: 'run' | 'refuse', reasons: string[], inputs: ArtifactRef[], detail: Record<string, unknown>): ContentId {
    return this.ctx.artifacts.recordDecision({
      decisionType: 'gate', question: `May the checks of workflow run ${run.workflowRunId} run on its result ${run.subject} in the worktree ${run.worktree}, its setup run again for the dependency files the result changed?`.slice(0, 500),
      inputs: [...new Set(inputs)],
      candidates: [
        { option: 'run', selected: option === 'run', reasons: option === 'run' ? reasons : [`not run: ${reasons[0]}`] },
        { option: 'refuse', selected: option === 'refuse', reasons: option === 'refuse' ? reasons : ['not refuse: the setup ran again and every command exited 0'] },
      ],
      decider: AGAIN_RULE,
      outcome: { option, detail: { worktree: run.worktree, repository: run.repository, subject: run.subject, setup: setup.hash, commands: setup.commands.length, ...detail } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, runId: run.workflowRunId, classification: run.classification }).id as ContentId
  }

  private eventAgain(run: RefreshRun, setup: Setup, outcome: 'ran' | 'refused', decision: ContentId): void {
    try {
      this.ctx.get('eventLog')?.append({
        type: 'agent-workers.worktree.setup', runId: run.workflowRunId, ...(run.sessionId ? { sessionId: run.sessionId } : {}), decision,
        data: { worktree: run.worktree, setup: setup.hash, outcome, for: 'checks', subject: run.subject },
      })
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: the setup event of ${run.worktree} was not appended: ${(error as Error).message}`)
    }
  }

  /** Run the commands in order, confined and offline, within the setup's deadline. Throws a {@link Refusal} naming the cause. */
  private async execute(stored: string, setup: Setup, signal: AbortSignal): Promise<void> {
    const worktree = real(stored)
    if (!worktree) throw new Refusal(`its worktree ${stored} cannot be read`)
    const confined = await confineIn(this.ctx, setup, worktree, this.runDir)
    try {
      const deadline = AbortSignal.timeout(setup.timeoutSeconds * 1000)
      const env = setupEnvironment()
      for (const [i, argv] of setup.commands.entries()) {
        const ended = await runBounded(confined.command(argv), env, AbortSignal.any([signal, deadline]))
        if (signal.aborted) throw signal.reason ?? new ProviderError('aborted', 'stopped')
        if (deadline.aborted) throw new Refusal(`its command ${i + 1} (${setup.lines[i]}) did not finish within the setup's ${setup.timeoutSeconds} s; it was stopped${tail(ended.output)}`, [], { command: i + 1, timedOut: true }, ended.output)
        if (ended.code !== 0) {
          throw new Refusal(`its command ${i + 1} (${setup.lines[i]}) ${ended.code === null ? `ended on signal ${ended.signal ?? 'unknown'}` : `exited with code ${ended.code}`}${tail(ended.output)}`, [], { command: i + 1, ...(ended.code !== null ? { exitCode: ended.code } : {}) }, ended.output)
        }
      }
    } finally {
      confined.dispose()
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

/** A setup's confinement, its private views made: how each command runs in it, and how it is cleared up. */
export interface Confined {
  command(argv: string[]): { command: string; args: string[] }
  /** Remove the private views (always call it once the commands ended). */
  dispose(): void
  /** The confinement itself. */
  confinement: Confinement
  /** A check's report file ({@link REPORT_PATH}), at the same path on the host and inside: `check` mode only. */
  report?: string
}

/**
 * What a check's launcher says on its own channel (fd 3) once the kernel executed the check's command
 * (an exec that succeeded, never only a command found on `PATH`).
 */
const STARTED = 'started'

/** What a check's launcher says on fd 3, and only that, when the exec of its command failed: `exec-failed <errno code>`. */
const EXEC_FAILED =/^exec-failed [A-Z0-9_]+$/

/** The word before a check's argv in its launcher's arguments, so the launcher finds the argv whatever Node did with `--`. */
const LAUNCHED = 'system-check'

/**
 * The fixed program a check's command starts through, inside the confinement (System's own Node,
 * `-e`, only `node:` modules): it spawns the command with its argv as given (never parsed by a
 * shell) and says, on fd 3, {@link STARTED} once the spawn succeeded, or `exec-failed <code>` when the
 * exec failed (no such command, an interpreter its `#!` names that is not there, not executable).
 * Node learns that from the exec itself (libuv's close-on-exec handshake), so an exec failure is
 * never mistaken for the command's own exit code, 127 or another. The command gets its fd 3 as
 * `/dev/null`, never the channel; it reports on its report file ({@link REPORT_PATH}). The launcher
 * ends with the command's exit code (128 + the signal when a signal ended it).
 */
const LAUNCHER = [
  "'use strict'",
  "const { spawn } = require('node:child_process')",
  "const { openSync, writeSync } = require('node:fs')",
  "const { signals } = require('node:os').constants",
  "const argv = process.argv.slice(process.argv.indexOf('system-check') + 1)",
  'const say = (text) => { try { writeSync(3, text) } catch {} }',
  "const child = spawn(argv[0], argv.slice(1), { stdio: [0, 1, 2, openSync('/dev/null', 'r')] })",
  'let spawned = false',
  "child.once('spawn', () => { spawned = true; say('started') })",
  "child.on('error', (error) => {",
  '  if (spawned) return',
  "  say(`exec-failed ${/^[A-Z0-9_]+$/.test(String(error.code)) ? error.code : 'EUNKNOWN'}`)",
  '  process.stderr.write(`system: ${argv[0]}: ${error.message}\\n`)',
  '  process.exit(127)',
  '})',
  "child.once('exit', (code, signal) => process.exit(code ?? 128 + (signals[signal] ?? 0)))",
].join('\n')
// The launcher names its marker and its start word as literals (no value is spliced into code); they must be these.
if (!LAUNCHER.includes(`indexOf('${LAUNCHED}')`) || !LAUNCHER.includes(`say('${STARTED}')`)) throw new Error('agent-workers: the check launcher and its constants disagree')

/** Node's arguments that start `argv` through the check {@link LAUNCHER}, as {@link confineIn} runs a check's command. */
export const launcherArgs = (argv: readonly string[]): string[] => ['-e', LAUNCHER, '--', LAUNCHED, ...argv]

/**
 * The confinement a repository's commands run in, in its worktree `worktree` (its real path): the
 * host read-only but the setup's private views, no network. A setup (`mode` `setup`) can write the
 * worktree. A check (`check`) sees it read-only, so it cannot change what it checks even for a while
 * (INV-5): only the setup's `checkScratch` paths are writable to it, each a fresh private directory
 * (git-ignored, so never in the subject), its private `/tmp`, and its report file
 * ({@link reportChannel}); and each check's command starts through {@link LAUNCHER} (System's own
 * Node, bound back read-only), so the caller can tell a command the kernel executed from one that
 * never started. A check's confinement is made for one command: its scratch directories and its
 * report file are its own, and {@link Confined.dispose} discards them. The views are
 * checked (never a path hidden from agents, nor over the worktree), the confinement proven, and the
 * views made in a fresh owner-only directory under `runDir`. Throws, naming the cause, when any of it
 * cannot be: nothing has run then.
 */
export async function confineIn(ctx: Context, setup: Setup, worktree: string, runDir: string, mode: 'setup' | 'check' = 'setup'): Promise<Confined> {
  // The launcher's Node, at its real path: what is bound back is what runs.
  const node = real(process.execPath) ?? process.execPath
  const confinement = ctx.agentRuntimes.confinement(mode === 'check' ? { readOnly: [worktree, node] } : { writable: [worktree] })
  const scratchPaths = mode === 'check' ? setup.checkScratch.map((entry) => scratchPoint(worktree, entry)) : []
  const hidden = confinement.hide.map((h) => real(h)).filter((h): h is string => !!h)
  // A view shows the commands a private copy of host files: never of a path hidden from agents, nor over the worktree.
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
  ensurePrivateDir(runDir)
  const scratch = mkdtempSync(join(runDir, 'setup-'))
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
    // A check's writable places in the worktree: each a fresh private directory over its (ignored) path.
    const scratchViews = scratchPaths.map((path, i) => {
      const dir = join(scratch, `scratch-${i}`)
      mkdirSync(dir, { mode: 0o700 })
      return { source: dir, path, writable: true }
    })
    const options = { readOnly: true, network: false, chdir: worktree, views: [...views, ...scratchViews] } as const
    if (mode === 'setup') {
      return {
        command: (argv) => confinedCommand(argv[0]!, argv.slice(1), confinement, options),
        dispose: () => rmSync(scratch, { recursive: true, force: true }),
        confinement,
      }
    }
    const channel = reportChannel(scratch, confinement)
    return {
      command: (argv) => confinedCommand(node, launcherArgs(argv), channel.confinement, { ...options, views: [...options.views, channel.view] }),
      dispose: () => rmSync(scratch, { recursive: true, force: true }),
      confinement,
      report: channel.path,
    }
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }
}

/**
 * Where a check's scratch path `entry` is mounted in the worktree (its real path): every directory on
 * the way is a directory of the worktree itself, never a link, made (owner-only) when missing, so the
 * private directory can be mounted over it. Refused unless git ignores it and it holds nothing tracked:
 * a writable place there can never be part of the subject a check is judged on (INV-5).
 */
function scratchPoint(worktree: string, entry: string): string {
  let ignored: boolean
  try {
    ignored = ignoredPath(worktree, entry)
  } catch (error) {
    throw new Refusal(`its check scratch ${entry} cannot be judged against git's ignore rules: ${(error as Error).message.split('\n')[0]}`)
  }
  if (!ignored) throw new Refusal(`its check scratch ${entry} is not ignored by git, or holds a tracked file: a check's writable place is never part of the subject it is judged on`)
  let path = worktree
  for (const part of entry.split('/')) {
    path = join(path, part)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) mkdirSync(path, { mode: 0o700 })
    else if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Refusal(`its check scratch ${entry} reaches ${path}, which is not a directory of the worktree (a link or a file)`)
  }
  if (real(path) !== path) throw new Refusal(`its check scratch ${entry} is reached through a link`)
  return path
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

/**
 * A confined command's end: its exit code or signal, the last 64 KiB of what it printed (stdout and
 * stderr as they came), and how much it printed in all with its hash; with `acknowledged`, whether its
 * launcher executed it (a check's command, {@link STARTED}).
 */
export interface Ended {
  code: number | null; signal: string | null; output: string; bytes: number; sha256: string; started?: boolean
  /** `signal` killed it before it ended by itself: what it would have come to is not known. */
  stopped?: true
  /** What it wrote to its report file (a check's command; the first {@link REPORT_BYTES} bytes), when it wrote anything. */
  report?: string
  /** Why its report file could not be read after it ended (a check's command): what it reported is not known. */
  reportUnread?: string
}

/**
 * The variable that names a check's report file to its command, and so to every process it starts,
 * whatever runner lies between them (pnpm's lifecycle runner passes only fds 0 to 2, so no descriptor
 * would reach a suite it starts, T247): a line `nested-confinement-refused: <detail>`
 * ({@link NESTED_REFUSED}) says a nested bubblewrap it needed was refused, so its nonzero exit is the
 * host's, not the check's (./checks.ts); a line `browser-tests-not-run: <detail>`
 * ({@link BROWSER_TESTS_NOT_RUN}) says what of it did not run. Writing either never makes a check pass.
 */
export const REPORT_PATH = 'SYSTEM_CHECK_REPORT_PATH'
/** The report of a nested bubblewrap refused inside a check's confinement ({@link REPORT_PATH}). */
export const NESTED_REFUSED = 'nested-confinement-refused'
/**
 * The report of tests a check's command skipped because they could not run where it ran
 * ({@link REPORT_PATH}): a line `browser-tests-not-run: <detail>` says its browser tests did not run
 * (no usable browser in the confinement), so its exit says nothing of them and a review is told so
 * (T247). It never changes the outcome.
 */
export const BROWSER_TESTS_NOT_RUN = 'browser-tests-not-run'
/** How much of a check's report is kept. */
const REPORT_BYTES = 4096

/**
 * A check's report channel (T247): a fresh, empty, owner-only regular file `report` in `dir` (the
 * check's own private directory under the run's), bound writable at its own path (beside its scratch
 * paths and its private `/tmp`, the only place it writes), and named in {@link REPORT_PATH}, which bubblewrap sets
 * inside over whatever the command's environment says. A file, not a descriptor: any process the
 * command starts opens it by its name, through any runner (a descriptor's `/proc/<pid>/fd` name does
 * not reopen a pipe's socket). Being a mount point inside, it cannot be replaced there, only written;
 * the host reads it once the command ended ({@link runBounded}).
 */
export function reportChannel(dir: string, confinement: Confinement): { path: string; view: { source: string; path: string; writable: true }; confinement: Confinement } {
  const path = join(dir, 'report')
  closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600))
  return { path, view: { source: path, path, writable: true }, confinement: { ...confinement, env: { ...confinement.env, [REPORT_PATH]: path } } }
}

/**
 * The first {@link REPORT_BYTES} bytes of a check's report file, read as itself (O_NOFOLLOW, a
 * plain file, never blocking): `report` when it holds anything, `reportUnread` when it cannot be read.
 */
function readReport(path: string): Pick<Ended, 'report' | 'reportUnread'> {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    return { reportUnread: `${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` }
  }
  try {
    if (!fstatSync(fd).isFile()) return { reportUnread: `${path} is not a plain file` }
    const buffer = Buffer.alloc(REPORT_BYTES)
    let read = 0
    while (read < REPORT_BYTES) {
      const n = readSync(fd, buffer, read, REPORT_BYTES - read, null)
      if (!n) break
      read += n
    }
    const report = buffer.subarray(0, read).toString('utf8')
    return report ? { report } : {}
  } catch (error) {
    return { reportUnread: `${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` }
  } finally {
    closeSync(fd)
  }
}

/**
 * Whether a check's command was executed, from what its launcher said on fd 3: not when it said
 * nothing (the confinement or the launcher never got that far), nor when it said exactly
 * `exec-failed <code>`. Anything else, `started` or bytes no launcher says alone, means a process of
 * the command existed (only one can have added to what the launcher said): its exit code is judged.
 */
function launched(said: string): boolean {
  return said !== '' && !EXEC_FAILED.test(said)
}

/**
 * Run a confined command to its end, or until `signal` stops it (SIGKILL; bubblewrap takes its
 * namespace with it). `check`: a check's command ({@link confineIn} in `check` mode), whose launcher
 * says on fd 3 whether its command was executed, and its end says whether it was ({@link launched});
 * what it wrote to its report file `check.report` is read once it ended.
 * `onOutput` is called on each piece the command prints (a check's stall watch, ./checks.ts).
 */
export function runBounded(command: { command: string; args: string[] }, env: Record<string, string>, signal: AbortSignal, check?: { report: string }, onOutput?: () => void): Promise<Ended> {
  const acknowledged = check !== undefined
  return new Promise((resolvePromise, reject) => {
    let output = ''
    let bytes = 0
    let said = ''
    let stopped = false
    const hash = createHash('sha256')
    const keep = (chunk: Buffer): void => {
      onOutput?.()
      bytes += chunk.length
      hash.update(chunk)
      output = (output + chunk.toString('utf8')).slice(-64 * 1024)
    }
    const stdio: StdioOptions = acknowledged ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
    const child = spawn(command.command, command.args, { env, stdio })
    const stop = (): void => {
      // Only a command still running is stopped by it: one that already exited ended by itself.
      if (child.exitCode === null && child.signalCode === null) stopped = true
      child.kill('SIGKILL')
    }
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
    child.stdout!.on('data', keep)
    child.stderr!.on('data', keep)
    // What the launcher says on its own channel: only the first bytes are kept.
    if (acknowledged) (child.stdio[3] as Readable).on('data', (chunk: Buffer) => void (said = (said + chunk.toString('utf8')).slice(0, 64)))
    child.once('error', (error) => {
      signal.removeEventListener('abort', stop)
      reject(new Refusal(`its commands cannot start: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? `${command.command} is not installed` : error.message}`))
    })
    child.once('close', (code, killed) => {
      signal.removeEventListener('abort', stop)
      resolvePromise({
        code, signal: killed, output, bytes, sha256: hash.digest('hex'),
        ...(check ? { started: launched(said), ...readReport(check.report) } : {}), ...(stopped ? { stopped: true as const } : {}),
      })
    })
  })
}
