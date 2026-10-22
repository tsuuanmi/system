// The tool gate of an agent run (src/gate.ts) over the store-backed approval queue, with a scripted
// runtime that asks the gate before each tool call as a gating runtime does: forbid denies, auto
// allows, ask opens one request on the exact call and defers, a later run of the session makes an
// approved call once, a rejected or expired one stays denied, and every other case fails closed.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry, { type AgentRuntimeProvider, type RunSpec, type ToolCall, type ToolVerdict } from '@tsuuanmi/system-agent-runtimes'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { contentId } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkerExecution, type WorkRequirement } from '@tsuuanmi/system-workers'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import AgentWorkers from '../src/index.ts'
import { classify } from '../src/gate.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const WORKSPACE = mkdtempSync(join(tmpdir(), 'system-gate-ws-'))
afterAll(() => rmSync(WORKSPACE, { recursive: true, force: true }))

/**
 * A scripted gating runtime: each run makes the next scripted list of tool calls, asking the run's
 * gate before each one. A deny is told to the agent, which goes on; a defer stops the run there and
 * rejects with a `config_error`, as a gating runtime must. `goesOn` makes one that keeps going after a
 * defer and reports success: the source must fail that run anyway.
 */
class GatedAgent implements AgentRuntimeProvider {
  readonly kind = 'gated'
  readonly runs: RunSpec[] = []
  readonly verdicts: ToolVerdict[][] = []
  constructor(private readonly script: Array<Array<Omit<ToolCall, 'callId'>>>, private readonly options: { goesOn?: boolean } = {}) {}
  async probe() {
    return { available: true, detail: 'gated 1.0', sandboxes: ['read-only', 'workspace-write'] as Array<'read-only' | 'workspace-write'>, resume: true, executes: true, readsConfined: true, gatesToolCalls: true }
  }
  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void) {
    this.runs.push(spec)
    const handle = spec.resume ?? `h-${this.runs.length}`
    onHandle?.(handle)
    const seen: ToolVerdict[] = []
    this.verdicts.push(seen)
    for (const [i, call] of (this.script[this.runs.length - 1] ?? []).entries()) {
      const verdict = await spec.toolGate!({ ...call, callId: `call-${this.runs.length}-${i + 1}` }, signal)
      seen.push(verdict)
      if (verdict.decision === 'defer' && !this.options.goesOn) throw new ProviderError('config_error', `gated: stopped at ${call.tool} (approval request ${verdict.requestId})`)
    }
    return { text: `done ${this.runs.length}`, nativeHandle: handle, turns: 1 }
  }
}

/** A studio policy: reads run, workspace writes run, commands and external sends ask; overrides per test. */
const policy = (rules: Partial<Record<AutonomyPolicy['rules'][number]['actionClass'], Omit<AutonomyPolicy['rules'][number], 'actionClass'>>> = {}): AutonomyPolicy => {
  const base: Record<string, Omit<AutonomyPolicy['rules'][number], 'actionClass'>> = {
    'read': { mode: 'auto' }, 'workspace-write': { mode: 'auto' }, 'merge': { mode: 'ask' }, 'command': { mode: 'ask' }, 'external-send': { mode: 'ask' },
    'deploy': { mode: 'ask' }, 'delete-data': { mode: 'ask' }, 'spend': { mode: 'ask' }, 'charter': { mode: 'ask' }, 'funding': { mode: 'ask' },
    'remediation': { mode: 'ask' }, 'policy-change': { mode: 'ask' }, ...rules,
  }
  return {
    schema: 'autonomy-policy@1.0', id: 'studio-test', version: 1, scope: 'studio',
    rules: Object.entries(base).map(([actionClass, rule]) => ({ actionClass: actionClass as AutonomyPolicy['rules'][number]['actionClass'], ...rule })),
    default: 'ask', commands: ['npm run build'], expiry: { defaultSeconds: 3600, maxSeconds: 86_400 },
  }
}

const requirement: WorkRequirement = {
  schema: 'work-requirement@1.0', objective: 'change the code', capabilities: ['develop', 'local-data'],
  data: { classification: 'operator-shared', refs: [] }, egressPolicy: 'egress.classification-and-secrets',
  tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.answer' },
}

async function boot(agent: AgentRuntimeProvider, approvals: AutonomyPolicy | null = policy()) {
  const dir = mkdtempSync(join(tmpdir(), 'system-gate-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ...(approvals ? [ctx.plugin(StoreApprovals, { policies: [approvals] })] : []),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry),
    ctx.plugin(AgentWorkers, { workers: [{ id: 'dev', runtime: 'gated', workspace: WORKSPACE, sandbox: 'workspace-write', tier: 'standard' }] }),
  ]
  await Promise.all(fibers)
  ctx.agentRuntimes.register(agent)
  cleanups.push(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const admitted = await ctx.workers.route(requirement)
  expect(admitted).toMatchObject({ worker: { worker: 'agent:dev' } })
  const source = ctx.workers.source('agents')!
  let n = 0
  /** Start one run (in `session` unless null) and wait for its end. */
  const run = async (session: string | null = 'ses_dev'): Promise<WorkerExecution & { runId: string }> => {
    n += 1
    const started = source.start({ key: `k-${n}`, worker: 'agent:dev', prompt: `step ${n}`, ...(session ? { sessionId: session } : {}), requirement, decisions: (admitted as { decisions: { tier: `sha256:${string}`; route: `sha256:${string}` } }).decisions })
    return { ...(await source.wait(started.id, 10_000)), runId: started.id }
  }
  return { ctx, run }
}

const decisionOf = (ctx: Context, reason: string) => {
  const id = /decision (sha256:[0-9a-f]{64})/.exec(reason)?.[1]
  expect(id, `a decision is named in ${reason}`).toBeDefined()
  return ctx.artifacts.get(id!)!.body as { decisionType: string; decider: { type: string; id: string }; outcome: { option: string; detail?: Record<string, unknown> } }
}
const bash = (command: string) => ({ tool: 'Bash', input: { command } })

describe('the tool gate of an agent run (docs/design/approvals.md#a-workers-tool-calls)', () => {
  it('lets a read inside the workspace run on its auto decision; denies one outside it, and a tool it does not classify, by its own rule, without asking anyone', async () => {
    const agent = new GatedAgent([[{ tool: 'Read', input: { file_path: 'src/a.ts' } }, { tool: 'Read', input: { file_path: '/etc/passwd' } }, { tool: 'Task', input: { prompt: 'help' } }]])
    const { ctx, run } = await boot(agent)
    const done = await run()
    expect(done.status).toBe('completed')
    const [read, outside, unknown] = agent.verdicts[0]!
    expect(read).toEqual({ decision: 'allow' })
    expect(outside).toMatchObject({ decision: 'deny', reason: expect.stringContaining('not inside the workspace') })
    expect(unknown).toMatchObject({ decision: 'deny', reason: expect.stringContaining('Task is not a tool the gate classifies') })
    for (const denied of [outside, unknown] as Array<{ reason: string }>) {
      expect(decisionOf(ctx, denied.reason)).toMatchObject({ decisionType: 'gate', decider: { type: 'rule', id: 'agent-workers.tool-gate' }, outcome: { option: 'deny' } })
    }
    expect(await ctx.approvals.list()).toEqual([])
    expect(ctx.eventLog.query({ type: 'agent-workers.tool.denied' })).toHaveLength(2)
  })

  it('denies a call the policy forbids, with the reason its autonomy decision records', async () => {
    const agent = new GatedAgent([[bash('ls')]])
    const { ctx, run } = await boot(agent, policy({ command: { mode: 'forbid' } }))
    expect((await run()).status).toBe('completed')
    const verdict = agent.verdicts[0]![0] as { decision: string; reason: string }
    expect(verdict).toMatchObject({ decision: 'deny', reason: expect.stringContaining('the autonomy policy forbids this command call') })
    expect(decisionOf(ctx, verdict.reason)).toMatchObject({ decisionType: 'autonomy', decider: { type: 'policy', id: 'studio-test' }, outcome: { option: 'forbid' } })
    expect(await ctx.approvals.list()).toEqual([])
  })

  it('denies a command with a shell metacharacter in a word, though commands ask: argv is never parsed by a shell', async () => {
    const agent = new GatedAgent([[bash('ls; rm -rf .'), bash('cat $HOME/x'), bash('npm test | tee log')]])
    const { ctx, run } = await boot(agent)
    await run()
    for (const verdict of agent.verdicts[0]! as Array<{ decision: string; reason: string }>) {
      expect(verdict).toMatchObject({ decision: 'deny', reason: expect.stringContaining('shell metacharacter') })
      expect(decisionOf(ctx, verdict.reason)).toMatchObject({ decisionType: 'autonomy', outcome: { option: 'forbid' } })
    }
    expect(await ctx.approvals.list()).toEqual([])
  })

  it('lets a command on the commands list run as the workspace write it is judged as', async () => {
    const agent = new GatedAgent([[bash('npm run build')]])
    const { run } = await boot(agent)
    expect((await run()).status).toBe('completed')
    expect(agent.verdicts[0]).toEqual([{ decision: 'allow' }])
  })

  it('opens one request bound to the exact call on an ask, defers it, and fails the run naming the request; a later run before the verdict waits on the same one (REQ-WRK-6, INV-5)', async () => {
    const agent = new GatedAgent([[{ tool: 'Read', input: { file_path: 'a' } }, bash('npm test')], [bash('npm test')]])
    const { ctx, run } = await boot(agent)
    const first = await run()
    expect(agent.verdicts[0]![0]).toEqual({ decision: 'allow' })
    const deferred = agent.verdicts[0]![1] as { decision: string; requestId: string }
    expect(deferred).toMatchObject({ decision: 'defer', requestId: expect.stringMatching(/^apr-/) })
    expect(first).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'config_error', message: expect.stringContaining(`approval request ${deferred.requestId}`) } })
    const queue = await ctx.approvals.list()
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({
      requestId: deferred.requestId, classification: 'operator-shared',
      subject: { type: 'content', ref: `agent-tool-call:${first.runId}:Bash`, version: contentId({ command: 'npm test' }) },
      action: { class: 'command', summary: 'Bash: npm test' },
      requester: { component: 'worker', runId: first.runId, sessionId: 'ses_dev', toolUseId: 'call-1-2' },
    })
    expect(ctx.eventLog.query({ type: 'agent-workers.tool.deferred' })[0]).toMatchObject({ sessionId: 'ses_dev', data: { agentRun: first.runId, tool: 'Bash', requestId: deferred.requestId } })
    // Not answered yet: the next run of the session waits on the same request, and queues no other.
    const second = await run()
    expect(agent.verdicts[1]).toEqual([expect.objectContaining({ decision: 'defer', requestId: deferred.requestId })])
    expect(second).toMatchObject({ status: 'failed', error: { kind: 'config_error' } })
    expect(await ctx.approvals.list()).toHaveLength(1)
    // The run resumed the session the deferred call is in.
    expect(agent.runs[1]!.resume).toBe('h-1')
  })

  it('fails a run whose gate deferred a call, though its runtime went on and reported success; every later call of that run is denied', async () => {
    const agent = new GatedAgent([[bash('npm test'), { tool: 'Read', input: { file_path: 'a' } }]], { goesOn: true })
    const { run } = await boot(agent)
    const done = await run()
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringContaining('approval request apr-') } })
    expect(done.result).toBeUndefined()
    expect(agent.verdicts[0]![1]).toMatchObject({ decision: 'deny', reason: expect.stringContaining('the run stopped at its Bash call') })
  })

  it('lets exactly the approved call run once in a later run of the session, and not another input; a used approval asks again', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test'), bash('npm test -- --watch')], [bash('npm test')]])
    const { ctx, run } = await boot(agent)
    await run()
    const [request] = await ctx.approvals.list()
    expect(await ctx.approvals.decide([{ requestId: request!.requestId, subject: request!.subject, verdict: 'approved' }])).toMatchObject([{ state: 'approved' }])
    const second = await run()
    expect(agent.verdicts[1]![0]).toEqual({ decision: 'allow' })
    // Another input is another call: it asks for itself.
    const other = agent.verdicts[1]![1] as { decision: string; requestId: string }
    expect(other).toMatchObject({ decision: 'defer' })
    expect(other.requestId).not.toBe(request!.requestId)
    expect(second.status).toBe('failed')
    expect((await ctx.approvals.get(other.requestId))!.subject.version).toBe(contentId({ command: 'npm test -- --watch' }))
    // One approval, one call: the same call again opens a new request.
    await run()
    const again = agent.verdicts[2]![0] as { decision: string; requestId: string }
    expect(again).toMatchObject({ decision: 'defer' })
    expect([request!.requestId, other.requestId]).not.toContain(again.requestId)
  })

  it('denies the exact call a rejected request was for, and one whose request expired, and queues nothing new', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test')], [bash('npm run lint')], [bash('npm run lint')]])
    const { ctx, run } = await boot(agent)
    await run()
    const [rejected] = await ctx.approvals.list()
    await ctx.approvals.decide([{ requestId: rejected!.requestId, subject: rejected!.subject, verdict: 'rejected' }])
    await run()
    expect(agent.verdicts[1]![0]).toMatchObject({ decision: 'deny', reason: expect.stringContaining('rejected by the operator') })
    await run()
    const [expiring] = await ctx.approvals.list()
    expect(expiring!.subject.version).toBe(contentId({ command: 'npm run lint' }))
    await ctx.approvals.sweep(new Date(Date.parse(expiring!.expiresAt) + 1000))
    const last = await run()
    expect(agent.verdicts[3]![0]).toMatchObject({ decision: 'deny', reason: expect.stringContaining('unanswered when it expired') })
    expect(last.status).toBe('completed')
    expect(await ctx.approvals.list()).toEqual([])
  })

  it('denies an ask in a run with no session, by its own rule: no later run could make the call, so nothing is queued', async () => {
    const agent = new GatedAgent([[bash('npm test')]])
    const { ctx, run } = await boot(agent)
    const done = await run(null)
    expect(done.status).toBe('completed')
    const verdict = agent.verdicts[0]![0] as { decision: string; reason: string }
    expect(verdict).toMatchObject({ decision: 'deny', reason: expect.stringContaining('no session') })
    expect(decisionOf(ctx, verdict.reason)).toMatchObject({ decisionType: 'gate', outcome: { option: 'deny' } })
    expect(await ctx.approvals.list()).toEqual([])
  })

  it('denies every call, reads included, when no approval queue is loaded (fail-closed rule 5)', async () => {
    const agent = new GatedAgent([[{ tool: 'Read', input: { file_path: 'a' } }, { tool: 'Write', input: { file_path: 'b', content: 'x' } }, bash('npm run build')]])
    const { ctx, run } = await boot(agent, null)
    expect((await run()).status).toBe('completed')
    for (const verdict of agent.verdicts[0]! as Array<{ decision: string; reason: string }>) {
      expect(verdict).toMatchObject({ decision: 'deny', reason: expect.stringContaining('no approval queue') })
      expect(decisionOf(ctx, verdict.reason)).toMatchObject({ decisionType: 'gate', decider: { id: 'agent-workers.tool-gate' } })
    }
  })

  it('lets a notify call run and shows it as an event naming its autonomy decision; denies an auto call whose required checks have not run', async () => {
    const write = { tool: 'Write', input: { file_path: 'b.txt', content: 'x' } }
    const notified = new GatedAgent([[write]])
    const shown = await boot(notified, policy({ 'workspace-write': { mode: 'notify' } }))
    expect((await shown.run()).status).toBe('completed')
    expect(notified.verdicts[0]).toEqual([{ decision: 'allow' }])
    const [event] = shown.ctx.eventLog.query({ type: 'agent-workers.tool.notified' })
    expect(event).toMatchObject({ data: { tool: 'Write', actionClass: 'workspace-write' } })
    expect(shown.ctx.artifacts.get(event!.decision!)!.body).toMatchObject({ decisionType: 'autonomy', outcome: { option: 'notify' } })
    const checked = new GatedAgent([[write]])
    const { run } = await boot(checked, policy({ 'workspace-write': { mode: 'auto', requires: ['tests', 'lint'] } }))
    await run()
    expect(checked.verdicts[0]![0]).toMatchObject({ decision: 'deny', reason: expect.stringContaining('runs only once tests, lint pass') })
  })

  it('sends a web fetch to the operator as an external send, which always asks', async () => {
    const agent = new GatedAgent([[{ tool: 'WebFetch', input: { url: 'https://example.com', prompt: 'read it' } }]])
    const { ctx, run } = await boot(agent, policy())
    await run()
    expect(agent.verdicts[0]![0]).toMatchObject({ decision: 'defer' })
    expect((await ctx.approvals.list())[0]).toMatchObject({ action: { class: 'external-send', summary: 'WebFetch: https://example.com' } })
  })
})

describe('classify: a tool call as the action the policy judges', () => {
  const ws = '/work/repo'
  it('reads and writes inside the workspace only, lexically, and never by a home path', () => {
    expect(classify({ tool: 'Read', input: { file_path: 'src/a.ts' } }, ws)).toMatchObject({ class: 'read' })
    expect(classify({ tool: 'Read', input: { file_path: '/work/repo/src/a.ts' } }, ws)).toMatchObject({ class: 'read' })
    expect(classify({ tool: 'Grep', input: { pattern: 'x' } }, ws)).toMatchObject({ class: 'read' })
    for (const path of ['../other/a', '/work/repo-other/a', '~/.ssh/id_rsa', '']) {
      expect(classify({ tool: 'Read', input: { file_path: path } }, ws)).toHaveProperty('refused')
      expect(classify({ tool: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }, ws)).toHaveProperty('refused')
    }
    expect(classify({ tool: 'Glob', input: { pattern: '../**' } }, ws)).toHaveProperty('refused')
    expect(classify({ tool: 'Glob', input: { pattern: '/etc/**' } }, ws)).toHaveProperty('refused')
    expect(classify({ tool: 'Glob', input: { pattern: '/work/repo/**/*.ts' } }, ws)).toMatchObject({ class: 'read' })
    expect(classify({ tool: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } }, ws)).toMatchObject({ class: 'workspace-write' })
  })

  it('splits a command on single spaces, exactly as the policy matches it, and refuses an input field it does not know', () => {
    expect(classify(bash('npm  test'), ws)).toMatchObject({ class: 'command', command: ['npm', '', 'test'] })
    expect(classify({ tool: 'Bash', input: { command: 'npm test', timeout: 1000, description: 'run', run_in_background: false } }, ws)).toMatchObject({ command: ['npm', 'test'] })
    expect(classify({ tool: 'Bash', input: { command: 'npm test', dangerouslyDisableSandbox: true } }, ws)).toHaveProperty('refused')
    expect(classify({ tool: 'Bash', input: { command: '' } }, ws)).toHaveProperty('refused')
  })

  it('refuses a tool it does not know and an input that is not an object', () => {
    for (const call of [{ tool: 'mcp__x__y', input: {} }, { tool: 'Agent', input: {} }, { tool: 'Read', input: 'a' }, { tool: 'Read', input: null }]) {
      expect(classify(call, ws)).toHaveProperty('refused')
    }
  })
})
