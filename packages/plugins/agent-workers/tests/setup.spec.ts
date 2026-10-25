// A worktree's setup (src/setup.ts, ADR-0058): commands the operator declares per repository run in
// a workflow run's new worktree before any agent works in it, each allowed by the autonomy policy,
// confined (the host read-only but the worktree and its private views, no network). Setup ok: the
// agent's own test command runs there. Setup fails, or is not allowed: the run fails at start, unsent,
// naming the cause. An ask waits on one request per command bound to the worktree and the setup's
// hash; a changed setup asks again.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry, { type AgentRuntimeProvider, type RunSpec } from '@tsuuanmi/system-agent-runtimes'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkerExecution, type WorkRequirement } from '@tsuuanmi/system-workers'
import { afterEach, describe, expect, it } from 'vitest'
import { cannotWrite, needsBubblewrap } from '../../../agent-runtime-core/tests/host.ts'
import AgentWorkers, { type Config } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const temp = (prefix: string, under = tmpdir()): string => {
  mkdirSync(under, { recursive: true })
  const dir = mkdtempSync(join(under, prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** Outside every path hidden from agents (the temporary directories are hidden): a view's host directory must be. */
const VISIBLE = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url))
/** Why no store can be made there (inside a run's check the worktree is read-only but for its scratch paths); undefined on a host. */
const NO_STORE = cannotWrite(VISIBLE)

const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim()

/** A repository whose test needs a dependency it does not hold: `check.mjs` imports node_modules/dep. */
function repository(): string {
  const dir = temp('system-setup-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\nprobe.json\n')
  writeFileSync(join(dir, 'check.mjs'), "import { ok } from './node_modules/dep/index.js'\nconsole.log(ok)\n")
  // What the setup's confinement lets it do: write outside its worktree, and which network devices it has.
  writeFileSync(join(dir, 'probe.mjs'), [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    'const out = {}',
    "try { writeFileSync(process.argv[2], 'x'); out.outside = 'written' } catch (error) { out.outside = error.code }",
    "out.devices = readFileSync('/proc/net/dev', 'utf8').split('\\n').slice(2).filter(Boolean).map((line) => line.trim().split(':')[0])",
    "writeFileSync('probe.json', JSON.stringify(out))",
    '',
  ].join('\n'))
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** A package store, as content-addressed stores are: an index the installer opens for writing, and files it only reads. */
function store(): string {
  const dir = temp('store-', VISIBLE)
  mkdirSync(join(dir, 'files', 'dep'), { recursive: true })
  writeFileSync(join(dir, 'files', 'dep', 'index.js'), "export const ok = 'dep ok'\n")
  writeFileSync(join(dir, 'index.db'), 'index v1')
  return dir
}

/** A writing agent whose run runs the repository's own test in its workspace, as a Worker's command would. */
class TestingAgent implements AgentRuntimeProvider {
  readonly kind = 'scripted'
  readonly runs: RunSpec[] = []
  async probe() {
    return { available: true, detail: 'scripted 1.0', sandboxes: ['read-only', 'workspace-write'] as Array<'read-only' | 'workspace-write'>, resume: true, executes: true, readsConfined: true, gatesToolCalls: true }
  }
  async run(spec: RunSpec, _signal: AbortSignal, onHandle?: (handle: string) => void) {
    this.runs.push(spec)
    onHandle?.(`h-${this.runs.length}`)
    return { text: execFileSync('node', ['check.mjs'], { cwd: spec.workspace, encoding: 'utf8' }).trim(), nativeHandle: `h-${this.runs.length}`, turns: 1 }
  }
}

/** The studio policy: commands ask unless listed (then they run as workspace-write, tests and lint pending). */
const policy = (commands: string[], command: 'ask' | 'forbid' = 'ask'): AutonomyPolicy => ({
  schema: 'autonomy-policy@1.0', id: 'studio-test', version: 1, scope: 'studio',
  rules: [
    { actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto', requires: ['tests', 'lint'] }, { actionClass: 'command', mode: command },
    ...(['merge', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change'] as const).map((actionClass) => ({ actionClass, mode: 'ask' as const })),
  ],
  default: 'ask', ...(commands.length ? { commands } : {}), expiry: { defaultSeconds: 3600, maxSeconds: 86_400 },
})

const requirement: WorkRequirement = {
  schema: 'work-requirement@1.0', objective: 'change the code', capabilities: ['develop', 'local-data'],
  data: { classification: 'operator-shared', refs: [] }, egressPolicy: 'egress.classification-and-secrets',
  tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.answer' },
}

const writer = (workspace: string): Config['workers'][number] => ({ id: 'dev', runtime: 'scripted', workspace, sandbox: 'workspace-write', tier: 'standard', tools: [], worktreePerRun: true })

async function boot(agent: AgentRuntimeProvider, config: Config, approvals: AutonomyPolicy | null, dir = temp('system-setup-')) {
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ...(approvals ? [ctx.plugin(StoreApprovals, { policies: [approvals] })] : []),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(AgentWorkers, config),
  ]
  await Promise.all(fibers)
  ctx.agentRuntimes.register(agent)
  const stop = async (): Promise<void> => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  cleanups.push(stop)
  let n = 0
  /** Start one run of `agent:dev` in workflow run `runId`, and wait for its end. */
  const run = async (runId: string): Promise<WorkerExecution> => {
    n += 1
    const source = ctx.workers.source('agents')!
    const started = source.start({ key: `${runId}-${n}-${Math.random()}`, worker: 'agent:dev', prompt: `step ${n}`, sessionId: `ses_${runId}`, runId, requirement, decisions: { tier: 'sha256:0', route: 'sha256:0' } as never })
    return source.wait(started.id, 30_000)
  }
  return { ctx, run, stop, dir }
}

type Gate = { decisionType: string; decider: { id: string }; outcome: { option: string; detail: Record<string, unknown> }; inputs: string[] }
/** The setup's `gate` decision among a run's decisions. */
const setupDecision = (ctx: Context, done: WorkerExecution): Gate => {
  const found = done.decisions.map((id) => ctx.artifacts.get(id)?.body as Gate).filter((d) => d?.decider?.id === 'agent-workers.worktree-setup')
  expect(found, 'one setup decision on the run').toHaveLength(1)
  return found[0]!
}

describe('a worktree\'s setup (worktreeSetup, ADR-0058)', { timeout: 60_000 }, () => {
  describe('under the real bubblewrap', () => {
    needsBubblewrap()
    it('sets a new worktree up before the agent starts, confined, offline, from a private view of a store; the agent\'s tests then run there, and a later run reuses it (REQ-WRK-6, INV-12, INV-13)', async (context) => {
      if (NO_STORE) context.skip(`needs a store outside the hidden paths: ${NO_STORE}`)
      const repo = repository()
      const host = store()
      const outside = join(VISIBLE, `outside-${process.pid}`)
      const lines = [
        'mkdir -p node_modules/dep',
        `cp ${join(host, 'files', 'dep', 'index.js')} node_modules/dep/`,
        `cp ${join(host, 'index.db')} node_modules/dep/`,
        // The view is the setup's own: written there, never on the host.
        `touch ${join(host, 'written-by-setup')}`,
        `node probe.mjs ${outside}`,
      ]
      const agent = new TestingAgent()
      const { ctx, run } = await boot(agent, {
        workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'),
        worktreeSetup: [{ repository: repo, commands: lines, views: [{ path: host, copy: ['index.db', 'absent.db'], readOnly: ['files'] }] }],
      }, policy(lines))
      const done = await run('run_ok')
      expect(done, JSON.stringify(done.error)).toMatchObject({ status: 'completed', submitted: true })
      // The repository's own test ran in the worktree, on what the setup installed.
      expect((ctx.artifacts.get(done.result!)!.body as { text: string }).text).toBe('dep ok')
      const worktree = agent.runs[0]!.workspace
      expect(readFileSync(join(worktree, 'node_modules', 'dep', 'index.db'), 'utf8')).toBe('index v1')
      expect(existsSync(join(host, 'written-by-setup'))).toBe(false)
      // Confined: the host is read-only to it, and it had no network but its loopback.
      expect(JSON.parse(readFileSync(join(worktree, 'probe.json'), 'utf8'))).toEqual({ outside: 'EROFS', devices: ['lo'] })
      expect(existsSync(outside)).toBe(false)
      // The run's decisions name the setup's gate decision: start, on the policy's decisions, checks pending.
      const decision = setupDecision(ctx, done)
      expect(decision).toMatchObject({ decisionType: 'gate', outcome: { option: 'start', detail: { worktree, commands: 5, pendingChecks: ['tests', 'lint'] } } })
      // The policy's autonomy decisions (one artifact for equal verdicts: decisions are content-addressed).
      expect(decision.inputs.length).toBeGreaterThan(0)
      for (const input of decision.inputs) expect(ctx.artifacts.get(input as `sha256:${string}`)!.body).toMatchObject({ decisionType: 'autonomy' })
      // The main working tree is untouched, and its ignored files stay out of the run's subject.
      expect(existsSync(join(repo, 'node_modules'))).toBe(false)
      expect(git(worktree, 'status', '--porcelain')).toBe('')
      // A later run of the workflow run works in the worktree as it is: the setup is not run again.
      const again = await run('run_ok')
      expect(again).toMatchObject({ status: 'completed' })
      expect(again.decisions).toContain(done.decisions.find((id) => (ctx.artifacts.get(id)?.body as Gate | undefined)?.decider?.id === 'agent-workers.worktree-setup'))
      expect(ctx.eventLog.query({ type: 'agent-workers.worktree.setup' }).map((e) => (e.data as { outcome: string }).outcome)).toEqual(['ran'])
      // Retired (its ignored dependencies go with it), then added again from its branch: set up again.
      expect(await ctx.agentWorkers.sweepWorktrees(Date.now() + 169 * 60 * 60_000)).toEqual({ removed: [worktree], kept: [] })
      expect(existsSync(worktree)).toBe(false)
      expect(await run('run_ok')).toMatchObject({ status: 'completed' })
      expect(readFileSync(join(worktree, 'node_modules', 'dep', 'index.js'), 'utf8')).toContain('dep ok')
      expect(ctx.eventLog.query({ type: 'agent-workers.worktree.setup' }).map((e) => (e.data as { outcome: string }).outcome)).toEqual(['ran', 'ran'])
    })

    it('fails the run at start when a setup command fails: unsent, the command, its exit code, and its output named; the agent never runs (INV-2)', async () => {
      const repo = repository()
      const lines = ['node check.mjs']
      const agent = new TestingAgent()
      const { ctx, run } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'), worktreeSetup: [{ repository: repo, commands: lines }] }, policy(lines))
      const done = await run('run_fails')
      expect(done).toMatchObject({
        status: 'failed', submitted: false,
        error: { kind: 'config_error', message: expect.stringMatching(/the setup of its worktree \S+run_fails did not complete: its command 1 \(node check\.mjs\) exited with code 1\. Its output ended: .*Cannot find module/s) },
      })
      expect(agent.runs).toEqual([])
      expect(setupDecision(ctx, done)).toMatchObject({ outcome: { option: 'refuse', detail: { command: 1, exitCode: 1 } } })
      // Never a silent skip: the next run of the workflow run tries the setup again, and fails the same way.
      expect(await run('run_fails')).toMatchObject({ status: 'failed', submitted: false, error: { message: expect.stringContaining('exited with code 1') } })
      expect(agent.runs).toEqual([])
    })

    it('stops a setup at its deadline (INV-9)', async () => {
      const repo = repository()
      const lines = ['sleep 30']
      const agent = new TestingAgent()
      const { run } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'), worktreeSetup: [{ repository: repo, commands: lines, timeoutSeconds: 1 }] }, policy(lines))
      const started = Date.now()
      expect(await run('run_slow')).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringContaining('did not finish within the setup\'s 1 s') } })
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(agent.runs).toEqual([])
    })

    it('asks the operator about a command the policy does not list, bound to the worktree and the setup\'s hash; runs it once approved; a changed setup asks again (INV-5)', async (context) => {
      if (NO_STORE) context.skip(`needs a store outside the hidden paths: ${NO_STORE}`)
      const repo = repository()
      const host = store()
      const lines = ['mkdir -p node_modules/dep', `cp ${join(host, 'files', 'dep', 'index.js')} node_modules/dep/`]
      const agent = new TestingAgent()
      const root = temp('system-worktrees-')
      const config = (timeoutSeconds: number): Config => ({ workers: [writer(repo)], worktreeRoot: root, worktreeSetup: [{ repository: repo, commands: lines, timeoutSeconds }] })
      const first = await boot(agent, config(600), policy([lines[0]!]))
      const waits = await first.run('run_ask')
      expect(waits).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringMatching(/waits for the operator's approval of its command \(approval request (\S+)\)/) } })
      expect(agent.runs).toEqual([])
      const queue = await first.ctx.approvals.list()
      expect(queue).toHaveLength(1)
      const [request] = queue
      const hash = setupDecision(first.ctx, waits).outcome.detail.setup
      expect(request).toMatchObject({
        state: 'open', subject: { type: 'content', ref: expect.stringMatching(/^agent-worktree-setup:.+\/run_ask:2$/), version: hash },
        action: { class: 'command', summary: expect.stringContaining(`command 2 of 2: ${lines[1]}`) }, requester: { component: 'worker' },
      })
      // Asked again before a verdict: the same request, nothing new queued.
      expect(await first.run('run_ask')).toMatchObject({ status: 'failed', error: { message: expect.stringContaining(request!.requestId) } })
      expect(await first.ctx.approvals.list()).toHaveLength(1)
      await first.ctx.approvals.decide([{ requestId: request!.requestId, subject: request!.subject, verdict: 'approved' }])
      const done = await first.run('run_ask')
      expect(done).toMatchObject({ status: 'completed' })
      expect(setupDecision(first.ctx, done).inputs).toContain((await first.ctx.approvals.get(request!.requestId))!.resolution!.decision)
      // The approval was this worktree's: another workflow run's worktree asks anew.
      expect(await first.run('run_other')).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('waits for the operator\'s approval') } })
      const other = (await first.ctx.approvals.list()).find((r) => r.state === 'open')!
      expect(other.subject.ref).toMatch(/\/run_other:2$/)
      // A changed setup (here, its deadline) is another setup: the worktree is set up again, and asked about again.
      await first.stop()
      cleanups.splice(cleanups.indexOf(first.stop), 1)
      const second = await boot(agent, config(300), policy([lines[0]!]), first.dir)
      const changed = await second.run('run_ask')
      expect(changed).toMatchObject({ status: 'failed', submitted: false, error: { message: expect.stringContaining('waits for the operator\'s approval') } })
      const asked = (await second.ctx.approvals.list({ states: ['open', 'approved'] })).filter((r) => r.subject.ref.endsWith('/run_ask:2'))
      expect(asked).toHaveLength(2)
      expect(asked.find((r) => r.state === 'open')!.subject.version).not.toBe(hash)
      expect(asked.find((r) => r.state === 'open')!.subject.version).toBe(setupDecision(second.ctx, changed).outcome.detail.setup)
    })
  })

  it('fails the run at start, unsent, when the policy forbids a setup command, when its request was rejected, and when no approval queue is loaded (INV-2)', async () => {
    const repo = repository()
    const lines = ['true']
    const agent = new TestingAgent()
    const forbidding = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'), worktreeSetup: [{ repository: repo, commands: lines }] }, policy([], 'forbid'))
    const forbidden = await forbidding.run('run_forbid')
    expect(forbidden).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringContaining('the autonomy policy forbids its command 1 (true)') } })
    expect(setupDecision(forbidding.ctx, forbidden)).toMatchObject({ outcome: { option: 'refuse' } })
    // Rejected: this worktree's setup never runs, and nothing new is queued.
    const asking = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'), worktreeSetup: [{ repository: repo, commands: lines }] }, policy([]))
    await asking.run('run_reject')
    const [request] = await asking.ctx.approvals.list()
    await asking.ctx.approvals.decide([{ requestId: request!.requestId, subject: request!.subject, verdict: 'rejected' }])
    expect(await asking.run('run_reject')).toMatchObject({ status: 'failed', submitted: false, error: { message: expect.stringContaining(`approval request ${request!.requestId} for its command 1 (true) was rejected by the operator`) } })
    expect(await asking.ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).toHaveLength(1)
    // No queue: no command runs without its autonomy decision (fail-closed rule 5).
    const unqueued = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'), worktreeSetup: [{ repository: repo, commands: lines }] }, null)
    expect(await unqueued.run('run_none')).toMatchObject({ status: 'failed', submitted: false, error: { message: expect.stringContaining('no approval queue (ctx.approvals) is loaded') } })
    expect(agent.runs).toEqual([])
  })

  it('refuses a view of a path hidden from agents before anything runs (REQ-WRK-6, INV-8)', async () => {
    const repo = repository()
    const lines = ['true']
    const hidden = temp('system-setup-hidden-')
    const agent = new TestingAgent()
    const { run } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'), worktreeSetup: [{ repository: repo, commands: lines, views: [{ path: realpathSync(hidden), copy: ['secret'] }] }] }, policy(lines))
    writeFileSync(join(hidden, 'secret'), 'not for agents')
    expect(await run('run_hidden')).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringContaining('which is hidden from agents') } })
    expect(agent.runs).toEqual([])
  })

  it('refuses at load a setup no worktreePerRun Worker\'s worktrees would run, a command the policy cannot match word for word, and malformed views', () => {
    const repo = repository()
    const load = (setup: Record<string, unknown>, workers = [writer(repo)]) => () => new AgentWorkers(new Context(), { workers, worktreeSetup: [{ repository: repo, commands: ['true'], ...setup } as never] })
    expect(load({}, [{ ...writer(repo), worktreePerRun: false }])).toThrow(/is the workspace of no Worker with worktreePerRun/)
    expect(load({ repository: 'relative' })).toThrow(/absolute path/)
    expect(load({ commands: [] })).toThrow(/1 to 16 commands/)
    expect(load({ commands: ['pnpm install && rm -rf /'] })).toThrow(/command 1 has a shell metacharacter/)
    expect(load({ commands: ['pnpm  install'] })).toThrow(/command 1 has an empty word 2/)
    expect(load({ commands: [`pnpm install --store-dir=/${'x'.repeat(200)}`] })).toThrow(/command 1 is longer than 200 characters/)
    expect(load({ views: [{ path: 'store' }] })).toThrow(/absolute, normalized path/)
    expect(load({ views: [{ path: '/srv/store', copy: ['../index.db'] }] })).toThrow(/plain name/)
    expect(load({ views: [{ path: '/srv/store', readOnly: ['files/../..'] }] })).toThrow(/relative paths/)
    expect(load({ views: [{ path: '/srv/store' }, { path: '/srv/store/v1' }] })).toThrow(/overlap/)
    expect(load({ timeoutSeconds: 0 })).toThrow(/timeoutSeconds/)
    expect(() => new AgentWorkers(new Context(), { workers: [writer(repo)], worktreeSetup: [{ repository: repo, commands: ['true'] }, { repository: `${repo}/`, commands: ['true'] }] })).toThrow(/two setups/)
  })
})
