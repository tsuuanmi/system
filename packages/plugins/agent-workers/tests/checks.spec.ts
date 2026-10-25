// A workflow run's checks (src/checks.ts, T151, ADR-0063): the source that holds the run's worktree
// runs each check the run asks for with the command the operator configured for the repository, on
// the exact tree the result is on, confined as the setup is, only when the policy lets the command run
// unasked. A check passes on exit 0 and fails on any other code, only while the tree is unchanged
// after it; anything else is an error, neither passed nor failed. What ran is one check-run@1.0.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry, { type AgentRuntimeProvider, type RunSpec } from '@tsuuanmi/system-agent-runtimes'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { captureGitSubject, SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type RunCheck, type WorkRequirement } from '@tsuuanmi/system-workers'
import type { Checked } from '@tsuuanmi/system-workers-core'
import { afterEach, describe, expect, it } from 'vitest'
import { needsBubblewrap } from '../../../agent-runtime-core/tests/host.ts'
import { RunChecks, type RunChecksOptions } from '../src/checks.ts'
import AgentWorkers, { type Config } from '../src/index.ts'
import { loadSetups } from '../src/setup.ts'
import { Worktrees } from '../src/worktrees.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim()

/** A repository whose tests need what its setup installs, and whose lint fails on a file the agent writes. */
function repository(): string {
  const dir = temp('system-checks-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(dir, 'test.mjs'), "import { ok } from './node_modules/dep/index.js'\nconsole.log(`tests: ${ok}`)\n")
  writeFileSync(join(dir, 'lint.mjs'), [
    "import { existsSync } from 'node:fs'",
    "if (existsSync('unused.js')) { console.error('lint: unused.js declares a variable it never uses'); process.exit(3) }",
    "console.log('lint: clean')",
    '',
  ].join('\n'))
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** A writing agent: it writes `unused.js` when its prompt says so, as a change the lint check judges. */
class WritingAgent implements AgentRuntimeProvider {
  readonly kind = 'scripted'
  readonly runs: RunSpec[] = []
  async probe() {
    return { available: true, detail: 'scripted 1.0', sandboxes: ['read-only', 'workspace-write'] as Array<'read-only' | 'workspace-write'>, resume: true, executes: true, readsConfined: true, gatesToolCalls: true }
  }
  async run(spec: RunSpec, _signal: AbortSignal, onHandle?: (handle: string) => void) {
    this.runs.push(spec)
    onHandle?.(`h-${this.runs.length}`)
    writeFileSync(join(spec.workspace, spec.prompt.includes('unused') ? 'unused.js' : 'used.js'), 'const kept = 1\n')
    return { text: 'done', nativeHandle: `h-${this.runs.length}`, turns: 1 }
  }
}

const SETUP = ['mkdir -p node_modules/dep', 'cp dep.js node_modules/dep/index.js']

/** The studio policy: listed commands run as workspace-write (tests and lint pending); others ask. */
const policy = (commands: string[]): AutonomyPolicy => ({
  schema: 'autonomy-policy@1.0', id: 'studio-test', version: 1, scope: 'studio',
  rules: [
    { actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto', requires: ['tests', 'lint'] }, { actionClass: 'command', mode: 'ask' },
    ...(['merge', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change'] as const).map((actionClass) => ({ actionClass, mode: 'ask' as const })),
  ],
  default: 'ask', commands, expiry: { defaultSeconds: 3600, maxSeconds: 86_400 },
})

const requirement: WorkRequirement = {
  schema: 'work-requirement@1.0', objective: 'change the code', capabilities: ['develop', 'local-data'],
  data: { classification: 'operator-shared', refs: [] }, egressPolicy: 'egress.classification-and-secrets',
  tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.answer' },
}

const writer = (workspace: string): Config['workers'][number] => ({ id: 'dev', runtime: 'scripted', workspace, sandbox: 'workspace-write', tier: 'standard', tools: [], worktreePerRun: true })

type Setup = NonNullable<Config['worktreeSetup']>[number]

/** Where a booted daemon keeps its store and worktrees: a second boot on the same ones is its restart. */
type Home = { db: string; root: string }

async function boot(repo: string, setup: Partial<Setup>, listed: string[] | null, restartOf?: Home) {
  if (!restartOf) {
    // The setup copies the dependency from the repository's own untracked file, so no view is needed.
    writeFileSync(join(repo, 'dep.js'), "export const ok = 'dep ok'\n")
    git(repo, 'add', 'dep.js')
    git(repo, 'commit', '-q', '-m', 'dep')
  }
  const home: Home = restartOf ?? { db: join(temp('system-checks-'), 'system.db'), root: temp('system-worktrees-') }
  const ctx = new Context()
  const agent = new WritingAgent()
  const config: Config = { workers: [writer(repo)], worktreeRoot: home.root, worktreeSetup: [{ repository: repo, commands: SETUP, ...setup }] }
  const fibers = [
    ctx.plugin(Store, { path: home.db }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ...(listed ? [ctx.plugin(StoreApprovals, { policies: [policy(listed)] })] : []),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(AgentWorkers, config),
  ]
  await Promise.all(fibers)
  ctx.agentRuntimes.register(agent)
  let stopped = false
  /** Stop the daemon (its store kept): what a restart starts from. */
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  cleanups.push(stop)
  /** One writing run of `agent:dev` in workflow run `runId`; its worktree and the exact tree it left. */
  const write = async (runId: string, prompt = 'write'): Promise<{ workspace: string; subject: { ref: string; version: string } }> => {
    const source = ctx.workers.source('agents')!
    const started = source.start({ key: `${runId}-${Math.random()}`, worker: 'agent:dev', prompt, sessionId: `ses_${runId}`, runId, requirement, decisions: { tier: 'sha256:0', route: 'sha256:0' } as never })
    const done = await source.wait(started.id, 30_000)
    expect(done, JSON.stringify(done.error)).toMatchObject({ status: 'completed' })
    const workspace = agent.runs.at(-1)!.workspace
    const { subject } = captureGitSubject(workspace)!
    return { workspace, subject: { ref: subject.ref, version: subject.version! } }
  }
  const check = (runId: string, at: { workspace: string; subject: { ref: string; version: string } }, checks: RunCheck[] = ['tests', 'lint']) =>
    ctx.workers.check!({ runId, workspace: at.workspace, subject: at.subject, checks, classification: 'operator-shared' })
  /** The checks as this source runs them, with `options` (the test's view of the moment a command ended). */
  const checksWith = (options: RunChecksOptions) => new RunChecks(ctx, new Worktrees(ctx, home.root), loadSetups(config.worktreeSetup, [repo]), join(home.root, '.setup'), options)
  return { ctx, write, check, stop, home, checksWith, setupHash: loadSetups(config.worktreeSetup, [repo]).get(repo)!.hash }
}

/** Commit `files` to the repository, so a run's worktree holds them. */
function commit(repo: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text)
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'files')
}

type Evidence = { checks: Array<{ check: string; outcome: string; reason: string; output?: { tail: string; sha256: string } }> }
const evidenceOf = (ctx: Context, checked: Checked | undefined): Evidence => {
  if (checked?.outcome !== 'checked' || !checked.evidence) throw new Error('no evidence')
  return ctx.artifacts.get(checked.evidence as `sha256:${string}`)!.body as Evidence
}

const TESTS = 'node test.mjs'
const LINT = 'node lint.mjs'

describe('a workflow run\'s checks (worktreeSetup checks, T151)', { timeout: 60_000 }, () => {
  describe('under the real bubblewrap', () => {
    needsBubblewrap()
    it('runs each check\'s configured command on the exact tree, confined, in the setup\'s environment: tests pass, lint fails by its exit code, recorded as check-run@1.0 (REQ-WF-15, INV-5, INV-13)', async () => {
      const repo = repository()
      const { ctx, write, check } = await boot(repo, { checks: { tests: TESTS, lint: LINT } }, [...SETUP, TESTS, LINT])
      const at = await write('run_lint', 'write unused')
      const checked = await check('run_lint', at)
      expect(checked).toMatchObject({
        source: 'agents', outcome: 'checked',
        results: [
          { check: 'tests', outcome: 'passed', exitCode: 0, reason: expect.stringContaining(`(${TESTS}) exited 0 on git:${at.subject.ref}:${at.subject.version}`) },
          { check: 'lint', outcome: 'failed', exitCode: 3, reason: expect.stringContaining(`(${LINT}) exited with code 3`) },
        ],
      })
      if (checked?.outcome !== 'checked') throw new Error('not checked')
      const evidence = ctx.artifacts.get(checked.evidence as `sha256:${string}`)!
      expect(evidence).toMatchObject({ kind: 'evidence', bodySchema: 'check-run@1.0', classification: 'operator-shared', runId: 'run_lint', producer: { type: 'system', ref: 'agent-workers' } })
      new SchemaRegistry().assert('check-run@1.0', evidence.body)
      const body = evidence.body as { subject: unknown; checks: Array<{ argv: string[]; autonomy: string; output: { tail: string; bytes: number; sha256: string } }> }
      expect(body.subject).toEqual({ type: 'git-head', ...at.subject })
      expect(body.checks[0]).toMatchObject({ argv: ['node', 'test.mjs'], output: { tail: 'tests: dep ok\n', bytes: 14 } })
      expect(body.checks[1]!.output.tail).toContain('lint: unused.js declares a variable it never uses')
      // Each command ran on the policy's own decision, named among the evidence's inputs.
      for (const c of body.checks) {
        expect(evidence.inputs).toContain(c.autonomy)
        expect(ctx.artifacts.get(c.autonomy as `sha256:${string}`)!.body).toMatchObject({ decisionType: 'autonomy' })
      }
      // The tree is as the result left it.
      expect(captureGitSubject(at.workspace)!.subject).toMatchObject(at.subject)
      // A clean change passes both.
      const clean = await write('run_clean')
      expect(await check('run_clean', clean)).toMatchObject({ outcome: 'checked', results: [{ check: 'tests', outcome: 'passed' }, { check: 'lint', outcome: 'passed', exitCode: 0 }] })
    })

    it('never lets a check change the tree it checks: the worktree is read-only to it, so a write fails it and the tree stays the subject; stops one at its deadline (INV-5, INV-9)', async () => {
      const repo = repository()
      const touch = 'touch stray.txt'
      const { check, write } = await boot(repo, { checks: { tests: touch, lint: LINT, typecheck: 'sleep 30' }, checkTimeoutSeconds: 1 }, [...SETUP, touch, LINT, 'sleep 30'])
      const at = await write('run_moves')
      expect(await check('run_moves', at)).toMatchObject({
        outcome: 'checked',
        results: [
          { check: 'tests', outcome: 'failed', exitCode: 1, reason: expect.stringContaining(`(touch stray.txt) exited with code 1 on git:${at.subject.ref}:${at.subject.version}`) },
          { check: 'lint', outcome: 'passed', exitCode: 0 },
        ],
      })
      expect(existsSync(join(at.workspace, 'stray.txt'))).toBe(false)
      expect(captureGitSubject(at.workspace)!.subject).toMatchObject(at.subject)
      const slow = await write('run_slow')
      const started = Date.now()
      expect(await check('run_slow', slow, ['typecheck'])).toMatchObject({ outcome: 'checked', results: [{ check: 'typecheck', outcome: 'error', reason: expect.stringContaining('did not finish within 1 s') }] })
      expect(Date.now() - started).toBeLessThan(15_000)
    })

    it('runs no check the policy does not let run unasked, none with no command configured, and none on a worktree its setup no longer matches; each stays an error, never passed (INV-2, INV-6)', async () => {
      const repo = repository()
      // The lint command is not on the policy's commands list: it would ask, so it is not run.
      const { ctx, write, check } = await boot(repo, { checks: { tests: TESTS, lint: LINT } }, [...SETUP, TESTS])
      const at = await write('run_ask')
      const checked = await check('run_ask', at, ['tests', 'lint', 'typecheck'])
      expect(checked).toMatchObject({
        outcome: 'checked',
        results: [
          { check: 'tests', outcome: 'passed' },
          { check: 'lint', outcome: 'error', reason: expect.stringContaining('the autonomy policy asks the operator about its command (node lint.mjs)') },
          { check: 'typecheck', outcome: 'error', reason: expect.stringContaining('no command for the typecheck check is configured') },
        ],
      })
      // Nothing was put to the operator for it.
      expect(await ctx.approvals.list()).toEqual([])
    })

    it('never passes a check that swaps in a passing source, tests it, and puts the defective one back before it exits 0: it runs on a read-only view of the result (INV-5)', async () => {
      const repo = repository()
      commit(repo, {
        'calc.mjs': 'export const add = (a, b) => a - b\n',
        'calc.test.mjs': "import { add } from './calc.mjs'\nif (add(1, 2) !== 3) { console.error('calc: add(1, 2) is not 3'); process.exit(1) }\nconsole.log('calc: ok')\n",
        // The adversary: the check script the result's author controls.
        'cheat.mjs': [
          "import { execFileSync } from 'node:child_process'",
          "import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'",
          "const kept = readFileSync('calc.mjs')",
          "const { atime, mtime } = statSync('calc.mjs')",
          "writeFileSync('calc.mjs', 'export const add = (a, b) => a + b\\n')",
          "execFileSync(process.execPath, ['calc.test.mjs'], { stdio: 'inherit' })",
          "writeFileSync('calc.mjs', kept)",
          "utimesSync('calc.mjs', atime, mtime)",
          'process.exit(0)',
          '',
        ].join('\n'),
      })
      const cheat = 'node cheat.mjs'
      const honest = 'node calc.test.mjs'
      const { ctx, write, check } = await boot(repo, { checks: { tests: cheat, lint: honest } }, [...SETUP, cheat, honest])
      const at = await write('run_cheat')
      const checked = await check('run_cheat', at)
      // The swap is refused (a read-only file system), so its tests never ran on code that is not the result's, and it is not passed.
      expect(checked).toMatchObject({
        outcome: 'checked',
        results: [{ check: 'tests', outcome: 'failed', exitCode: 1 }, { check: 'lint', outcome: 'failed', exitCode: 1 }],
      })
      const tests = evidenceOf(ctx, checked).checks[0]!
      expect(tests.output!.tail).toMatch(/EROFS/)
      expect(tests.output!.tail).not.toContain('calc: ok')
      expect(readFileSync(join(at.workspace, 'calc.mjs'), 'utf8')).toBe('export const add = (a, b) => a - b\n')
      expect(captureGitSubject(at.workspace)!.subject).toMatchObject(at.subject)
    })

    it('gives each check its scratch paths as fresh private writable directories of its own, discarded after it, and refuses one git does not ignore (INV-5)', async () => {
      const repo = repository()
      commit(repo, {
        'cache.mjs': "import { mkdirSync, writeFileSync } from 'node:fs'\nmkdirSync('node_modules/.cache/run', { recursive: true })\nwriteFileSync('node_modules/.cache/run/result.json', '{}')\nconsole.log('cache: written')\n",
        // The next check: it fails when it sees what the one before it wrote in the same scratch path.
        'peek.mjs': "import { existsSync } from 'node:fs'\nif (existsSync('node_modules/.cache/run/result.json')) { console.error('peek: the last check\\'s scratch is still here'); process.exit(1) }\nconsole.log('peek: fresh')\n",
      })
      const cache = 'node cache.mjs'
      const peek = 'node peek.mjs'
      const { write, check } = await boot(repo, { checks: { tests: cache, lint: peek }, checkScratch: ['node_modules/.cache'] }, [...SETUP, cache, peek])
      const at = await write('run_cache')
      expect(await check('run_cache', at, ['tests', 'lint'])).toMatchObject({
        outcome: 'checked', results: [{ check: 'tests', outcome: 'passed', exitCode: 0 }, { check: 'lint', outcome: 'passed', exitCode: 0 }],
      })
      expect(existsSync(join(at.workspace, 'node_modules/.cache/run'))).toBe(false)
      expect(captureGitSubject(at.workspace)!.subject).toMatchObject(at.subject)

      const other = repository()
      commit(other, { 'cache.mjs': "import { writeFileSync } from 'node:fs'\nwriteFileSync('build/out.txt', 'x')\n" })
      const refused = await boot(other, { checks: { tests: cache }, checkScratch: ['build'] }, [...SETUP, cache])
      const there = await refused.write('run_build')
      expect(await refused.check('run_build', there, ['tests'])).toMatchObject({
        outcome: 'checked', results: [{ check: 'tests', outcome: 'error', reason: expect.stringContaining('its check scratch build is not ignored by git') }],
      })
    })

    it('tells a command the confinement did not start, and a nested bubblewrap the command reports refused, from a failed check: each an error; any other nonzero exit stays failed (INV-2)', async () => {
      const repo = repository()
      commit(repo, {
        // A suite of confinement tests whose nested bubblewrap the host refuses: it says so on its own channel.
        'nested.mjs': [
          "import { writeSync } from 'node:fs'",
          "writeSync(Number(process.env.SYSTEM_CHECK_REPORT_FD), 'nested-confinement-refused: bwrap: setting up uid map: Permission denied\\n')",
          "console.error('confinement: bwrap could not start')",
          'process.exit(1)',
          '',
        ].join('\n'),
      })
      const missing = 'no-such-check-command --run'
      const nested = 'node nested.mjs'
      const { write, check } = await boot(repo, { checks: { tests: nested, lint: LINT, typecheck: missing } }, [...SETUP, nested, LINT, missing])
      const at = await write('run_infra', 'write unused')
      const launched = await check('run_infra', at, ['typecheck'])
      expect(launched).toMatchObject({ outcome: 'checked', results: [{ check: 'typecheck', outcome: 'error', reason: expect.stringContaining('was not started by the confinement (an infrastructure failure, not a failed check)') }] })
      // Nothing of it ran, so nothing is kept: asked again, it is tried again, and is again an error.
      expect(await check('run_infra', at, ['typecheck'])).toMatchObject({ results: [{ outcome: 'error', reason: expect.stringContaining('was not started by the confinement') }] })
      // The suite that reported its nested bubblewrap refused is an error; the lint check that merely failed, in the same confinement, is failed.
      expect(await check('run_infra', at, ['tests', 'lint'])).toMatchObject({
        outcome: 'checked',
        results: [
          { check: 'tests', outcome: 'error', exitCode: 1, reason: expect.stringMatching(/exited with code 1 on git:\S+ and reported a nested bubblewrap refused \(bwrap: setting up uid map: Permission denied\)/) },
          { check: 'lint', outcome: 'failed', exitCode: 3, reason: expect.stringContaining(`(${LINT}) exited with code 3`) },
        ],
      })
    })

    it('tells an executable whose #! interpreter is missing, found on its path but never executed, from a command that exits 127 by itself: the first an error, the second failed (INV-2)', async () => {
      const repo = repository()
      // Found, and executable: only its exec fails, for the interpreter it names.
      writeFileSync(join(repo, 'orphan.sh'), '#!/nonexistent/interpreter\nexit 0\n')
      chmodSync(join(repo, 'orphan.sh'), 0o755)
      commit(repo, { 'gone.mjs': "console.error('gone: a command of its own exits 127')\nprocess.exit(127)\n" })
      const orphan = './orphan.sh'
      const gone = 'node gone.mjs'
      const { write, check } = await boot(repo, { checks: { tests: orphan, lint: gone } }, [...SETUP, orphan, gone])
      const at = await write('run_exec')
      const checked = await check('run_exec', at)
      expect(checked).toMatchObject({
        outcome: 'checked',
        results: [
          { check: 'tests', outcome: 'error', reason: expect.stringMatching(/\(\.\/orphan\.sh\) was not started by the confinement \(an infrastructure failure, not a failed check\).*ENOENT/) },
          { check: 'lint', outcome: 'failed', exitCode: 127, reason: expect.stringContaining(`(${gone}) exited with code 127`) },
        ],
      })
      // Nothing of the first ran, so asked again it is tried again; the second's failure stands as stored.
      expect(await check('run_exec', at)).toMatchObject({ results: [{ check: 'tests', outcome: 'error' }, { check: 'lint', outcome: 'failed', exitCode: 127 }] })
    })

    it('stores what a check came to when a stop comes after its command ended, before its outcome was stored, and never runs it again to replace it (INV-4)', async () => {
      const repo = repository()
      commit(repo, { 'clock.mjs': "console.log(`clock: ${process.hrtime.bigint()}`)\nprocess.exit(1)\n" })
      const clock = 'node clock.mjs'
      const { ctx, write, check, checksWith } = await boot(repo, { checks: { tests: clock } }, [...SETUP, clock])
      const at = await write('run_stop')
      const controller = new AbortController()
      // The lease is lost the moment the command ended, before its outcome is stored.
      const stopping = checksWith({ commandEnded: () => controller.abort(new Error('the lease of run_stop was lost')) })
      await expect(stopping.check({ runId: 'run_stop', workspace: at.workspace, subject: at.subject, checks: ['tests'], classification: 'operator-shared' }, controller.signal))
        .rejects.toThrow('the lease of run_stop was lost')
      const row = ctx.store.db.prepare('SELECT state, record FROM agent_check_runs WHERE workflow_run_id = ? AND check_name = ?').get('run_stop', 'tests') as { state: string; record: string }
      expect(row.state).toBe('done')
      const stored = JSON.parse(row.record) as { outcome: string; exitCode: number; output: unknown }
      expect(stored).toMatchObject({ outcome: 'failed', exitCode: 1 })
      // Asked again, the failure stands as stored, to the byte: it is not run again to come to something else.
      const again = await check('run_stop', at, ['tests'])
      expect(again).toMatchObject({ outcome: 'checked', results: [{ check: 'tests', outcome: 'failed', exitCode: 1 }] })
      expect(evidenceOf(ctx, again).checks[0]!.output).toEqual(stored.output)
    })

    it('holds a check a stop killed before its end as an error, never run again on its subject (INV-4)', async () => {
      const repo = repository()
      const slow = 'sleep 30'
      const { ctx, write, check, checksWith } = await boot(repo, { checks: { typecheck: slow } }, [...SETUP, slow])
      const at = await write('run_killed')
      const controller = new AbortController()
      const running = checksWith({}).check({ runId: 'run_killed', workspace: at.workspace, subject: at.subject, checks: ['typecheck'], classification: 'operator-shared' }, controller.signal)
      const started = (): boolean => !!ctx.store.db.prepare('SELECT 1 FROM agent_check_runs WHERE workflow_run_id = ?').get('run_killed')
      for (let i = 0; i < 400 && !started(); i++) await new Promise((resolve) => setTimeout(resolve, 50))
      expect(started()).toBe(true)
      // Long enough for its command to have said it started.
      await new Promise((resolve) => setTimeout(resolve, 1000))
      controller.abort(new Error('the run was stopped'))
      await expect(running).rejects.toThrow('the run was stopped')
      const before = Date.now()
      expect(await check('run_killed', at, ['typecheck'])).toMatchObject({
        outcome: 'checked', results: [{ check: 'typecheck', outcome: 'error', reason: expect.stringContaining('was stopped before its end') }],
      })
      // Not run again: a second run would take its 30 s.
      expect(Date.now() - before).toBeLessThan(10_000)
    })

    it('keeps each check\'s outcome on its subject across a restart and never runs it again, and holds one a crash interrupted as an error (INV-4)', async () => {
      const repo = repository()
      // Each run of it prints another number, so a second run would show.
      commit(repo, { 'clock.mjs': "console.log(`clock: ${process.hrtime.bigint()}`)\nprocess.exit(1)\n" })
      const clock = 'node clock.mjs'
      const setup = { checks: { tests: clock, lint: LINT, typecheck: TESTS } }
      const listed = [...SETUP, clock, LINT, TESTS]
      const first = await boot(repo, setup, listed)
      const at = await first.write('run_restart')
      const failed = await first.check('run_restart', at, ['tests'])
      expect(failed).toMatchObject({ results: [{ check: 'tests', outcome: 'failed', exitCode: 1 }] })
      const printed = evidenceOf(first.ctx, failed).checks[0]!.output!
      // A crash while the typecheck check ran: it started, and no end was stored.
      first.ctx.store.transaction((db) => {
        db.prepare('INSERT INTO agent_check_runs (workflow_run_id, workspace, subject, check_name, argv, setup_hash, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run('run_restart', at.workspace, `git:${at.subject.ref}:${at.subject.version}`, 'typecheck', JSON.stringify(TESTS.split(' ')), first.setupHash, 'started', '2026-10-25T00:00:00.000Z')
      })
      await first.stop()

      const second = await boot(repo, setup, listed, first.home)
      const again = await second.check('run_restart', at, ['tests', 'typecheck', 'lint'])
      expect(again).toMatchObject({
        outcome: 'checked',
        results: [
          { check: 'tests', outcome: 'failed', exitCode: 1 },
          { check: 'typecheck', outcome: 'error', reason: expect.stringContaining('started at 2026-10-25T00:00:00.000Z and recorded no end (the daemon stopped meanwhile); it is not run again on this subject') },
          { check: 'lint', outcome: 'passed', exitCode: 0 },
        ],
      })
      const body = evidenceOf(second.ctx, again)
      // The same output, to the byte: the stored outcome, not a second run.
      expect(body.checks[0]!.output).toEqual(printed)
      expect(body.checks[1]).not.toHaveProperty('output')
      // Asked once more, every outcome stands as stored.
      const third = await second.check('run_restart', at, ['tests', 'typecheck', 'lint'])
      expect(third?.outcome === 'checked' && third.results).toEqual(again?.outcome === 'checked' && again.results)
      expect(evidenceOf(second.ctx, third).checks).toEqual(body.checks)
    })
  })

  it('answers nothing for a worktree it does not hold, so another source may (ADR-0063)', async () => {
    const repo = repository()
    const { check } = await boot(repo, { checks: { tests: TESTS } }, null)
    expect(await check('run_none', { workspace: '/nowhere', subject: { ref: 'a'.repeat(40), version: 'b'.repeat(64) } })).toBeUndefined()
  })

  it('refuses at load a check no policy can require, a command the policy cannot match word for word, and a deadline out of bounds', () => {
    const repo = repository()
    mkdirSync(join(repo, 'x'), { recursive: true })
    const load = (setup: Record<string, unknown>) => () => new AgentWorkers(new Context(), { workers: [writer(repo)], worktreeSetup: [{ repository: repo, commands: ['true'], ...setup } as never] })
    expect(load({ checks: { review: 'true' } })).toThrow(/checks names review; a check is one of tests, typecheck, lint/)
    expect(load({ checks: { tests: 'pnpm test && rm -rf /' } })).toThrow(/the tests check's command has a shell metacharacter/)
    expect(load({ checks: { lint: 'pnpm  lint' } })).toThrow(/the lint check's command has an empty word 2/)
    expect(load({ checks: ['pnpm test'] })).toThrow(/checks maps a check name to its command/)
    expect(load({ checkTimeoutSeconds: 0 })).toThrow(/checkTimeoutSeconds/)
    expect(load({ checkScratch: ['../outside'] })).toThrow(/checkScratch names up to 32 relative paths inside the worktree/)
    expect(load({ checkScratch: ['.git/hooks'] })).toThrow(/none in \.git/)
    expect(load({ checkScratch: ['node_modules', 'node_modules/.cache'] })).toThrow(/checkScratch names node_modules\/\.cache and another that holds it/)
    expect(loadSetups([{ repository: repo, commands: ['true'], checkScratch: ['node_modules/.vite'] }], [repo]).get(repo)).toMatchObject({ checkScratch: ['node_modules/.vite'] })
    // Loaded: each command as argv, and none of it in the setup's hash, so a setup's approvals stand when its checks change.
    const plain = loadSetups([{ repository: repo, commands: ['true'] }], [repo]).get(repo)!
    const checked = loadSetups([{ repository: repo, commands: ['true'], checks: { tests: 'corepack pnpm test:affected' }, checkTimeoutSeconds: 3600 }], [repo]).get(repo)!
    expect(checked).toMatchObject({ checks: { tests: { line: 'corepack pnpm test:affected', argv: ['corepack', 'pnpm', 'test:affected'] } }, checkTimeoutSeconds: 3600, hash: plain.hash })
    expect(plain).toMatchObject({ checks: {}, checkTimeoutSeconds: 1800, checkScratch: [] })
  })
})
