// The tool gate of an agent run (src/gate.ts) over the store-backed approval queue, with a scripted
// runtime that asks the gate before each tool call as a gating runtime does: forbid denies, auto
// allows, ask opens one request on the exact call and defers, a later run of the session makes an
// approved call once, a rejected or expired one stays denied, and every other case fails closed.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
import { ClaudeAgentRuntime, type QueryFn } from '@tsuuanmi/system-runtime-claude-agent-sdk'
import { CodexRuntime } from '@tsuuanmi/system-runtime-codex-sdk'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkerExecution, type WorkRequirement } from '@tsuuanmi/system-workers'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import Workflow from '@tsuuanmi/system-workflow'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import AgentWorkers from '../src/index.ts'
import { classify } from '../src/gate.ts'
import { probeExec, scripted as scriptedCodex } from '../../runtime-codex-sdk/tests/fake-codex.ts'

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
    ctx.plugin(AgentWorkers, { workers: [{ id: 'dev', runtime: agent.kind, workspace: WORKSPACE, sandbox: 'workspace-write', tier: 'standard' }] }),
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

/** The studio policy the bundle's `approvals` row carries by default (packages/system-bundle/cordis.patch.yml). */
function bundlePolicies(): AutonomyPolicy[] {
  const patch = parseYaml(readFileSync(fileURLToPath(new URL('../../../system-bundle/cordis.patch.yml', import.meta.url)), 'utf8')) as Array<{ insert?: Array<{ id: string; config?: { policies?: AutonomyPolicy[] } }> }>
  const row = patch.flatMap((p) => p.insert ?? []).find((r) => r.id === 'approvals')
  expect(row?.config?.policies?.length, 'the bundle row carries its default studio policy').toBe(1)
  return row!.config!.policies!
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

  it('denies a command with a shell metacharacter in a word, or an empty word, by its own rule before the policy is asked, though commands ask: argv is never parsed by a shell', async () => {
    const metacharacters = ['ls; rm -rf .', 'cat $HOME/x', 'npm test | tee log', 'echo safe;id', 'echo $(id)', 'echo a\nid', 'echo a\rid']
    const empty = ['echo  a', ' echo a', 'echo a ']
    const agent = new GatedAgent([[...metacharacters, ...empty].map(bash)])
    const { ctx, run } = await boot(agent)
    const check = vi.spyOn(ctx.get('approvals')!, 'check')
    await run()
    const verdicts = agent.verdicts[0]! as Array<{ decision: string; reason: string }>
    expect(verdicts).toHaveLength(metacharacters.length + empty.length)
    for (const [i, verdict] of verdicts.entries()) {
      expect(verdict).toMatchObject({ decision: 'deny', reason: expect.stringContaining(i < metacharacters.length ? 'shell metacharacter' : 'is empty') })
      expect(decisionOf(ctx, verdict.reason)).toMatchObject({ decisionType: 'gate', decider: { id: 'agent-workers.tool-gate' }, outcome: { option: 'deny' } })
    }
    expect(check).not.toHaveBeenCalled()
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

  // PROP-0013: no automated input to a session blocked on an approval. The state is derived when read.
  it('holds a session whose latest run stopped on a deferred call while its request is open, and frees it once the request is answered (PROP-0013, ADR-0054)', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm run lint')], [{ tool: 'Read', input: { file_path: 'a' } }]])
    const { ctx, run } = await boot(agent)
    expect(await ctx.workers.held('ses_dev'), 'a session this source does not hold yet').toBeUndefined()
    const first = await run()
    const [rejected] = await ctx.approvals.list()
    expect(ctx.store.db.prepare('SELECT deferred_request FROM agent_runs WHERE run_id = ?').get(first.runId)).toEqual({ deferred_request: rejected!.requestId })
    expect(await ctx.workers.held('ses_dev')).toBe(`its latest run ${first.runId} stopped on a tool call that waits for approval request ${rejected!.requestId}, still open: the session takes no input but that request's resolution`)
    expect(await ctx.workers.held('ses_other'), 'another session').toBeUndefined()
    await ctx.approvals.decide([{ requestId: rejected!.requestId, subject: rejected!.subject, verdict: 'rejected' }])
    expect(await ctx.workers.held('ses_dev'), 'rejected: free again').toBeUndefined()
    await run()
    const [open] = await ctx.approvals.list({ states: ['open'] })
    expect(await ctx.workers.held('ses_dev')).toContain(`approval request ${open!.requestId}, still open`)
    await ctx.approvals.decide([{ requestId: open!.requestId, subject: open!.subject, verdict: 'approved' }])
    expect(await ctx.workers.held('ses_dev'), 'approved: its resolution is the input, and the session is free').toBeUndefined()
    // A run that finished frees it too; a queue that cannot be read never shows a blocked one free.
    expect((await run()).status).toBe('completed')
    expect(await ctx.workers.held('ses_dev')).toBeUndefined()
  })

  it('cannot show a session free while the queue cannot tell whether its request is still open, nor while its latest run has not finished (PROP-0013, INV-2)', async () => {
    const agent = new GatedAgent([[bash('npm test')]])
    const { ctx, run } = await boot(agent)
    const first = await run()
    const [request] = await ctx.approvals.list()
    const get = vi.spyOn(ctx.get('approvals')!, 'get').mockRejectedValueOnce(new Error('database is locked'))
    expect(await ctx.workers.held('ses_dev')).toBe(`its latest run ${first.runId} stopped on a tool call that waits for approval request ${request!.requestId}, which cannot be read now (database is locked)`)
    get.mockResolvedValueOnce(undefined)
    expect(await ctx.workers.held('ses_dev')).toContain('which the approval queue does not hold')
    get.mockRestore()
    // A run of the session not finished yet holds it, whatever came before.
    ctx.store.db.prepare("UPDATE agent_runs SET status = 'running' WHERE run_id = ?").run(first.runId)
    expect(await ctx.workers.held('ses_dev')).toBe(`its latest run ${first.runId} has not finished (running), and one native session is driven by one run at a time`)
  })

  it('checks a stored request in full before its approval is used: one whose ref, session, or requester is not this call\'s is denied, and never asked again (INV-5)', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test')], [bash('npm test')], [bash('npm test')]])
    const { ctx, run } = await boot(agent)
    const first = await run()
    const [opened] = await ctx.approvals.list()
    const inputHash = contentId({ command: 'npm test' })
    const verdict = await ctx.approvals.check({ class: 'command', command: ['npm', 'test'] })
    const action = { class: 'command' as const, summary: 'Bash: npm test' }
    const forged = [
      { subject: { type: 'content' as const, ref: 'agent-tool-call:arun_other:Bash', version: inputHash }, requester: { component: 'worker' as const, runId: first.runId, sessionId: 'ses_dev' } },
      { subject: opened!.subject, requester: { component: 'worker' as const, runId: first.runId, sessionId: 'ses_other' } },
      { subject: opened!.subject, requester: { component: 'board' as const, runId: first.runId, sessionId: 'ses_dev' } },
    ]
    for (const [i, { subject, requester }] of forged.entries()) {
      const request = await ctx.approvals.request({ subject, action, requester, verdict, command: ['npm', 'test'], classification: 'operator-shared' })
      expect(await ctx.approvals.decide([{ requestId: request.requestId, subject, verdict: 'approved' }])).toMatchObject([{ state: 'approved' }])
      // The gate's row for this exact call in this session now names the forged request.
      ctx.store.transaction((tx) => {
        tx.prepare('INSERT INTO agent_tool_requests (request_id, scope, tool, input_hash, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(request.requestId, 'session:ses_dev', 'Bash', inputHash, first.runId, new Date(Date.now() + (i + 1) * 60_000).toISOString())
      })
      const before = (await ctx.approvals.list()).length
      const done = await run()
      const denied = agent.verdicts[i + 1]![0] as { decision: string; reason: string }
      expect(denied).toMatchObject({ decision: 'deny', reason: expect.stringContaining(`approval request ${request.requestId} is for another call than this one (its ${['subject ref', 'requester session', 'requester component'][i]} differs)`) })
      expect(decisionOf(ctx, denied.reason)).toMatchObject({ decisionType: 'gate', outcome: { option: 'deny' } })
      expect(done.status).toBe('completed')
      expect(await ctx.approvals.list()).toHaveLength(before)
    }
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

  it('lets a notify call run and shows it as an event naming its autonomy decision; lets an auto call run with its rule\'s required checks pending, named once per run, to bind at acceptance', async () => {
    const write = { tool: 'Write', input: { file_path: 'b.txt', content: 'x' } }
    const notified = new GatedAgent([[write]])
    const shown = await boot(notified, policy({ 'workspace-write': { mode: 'notify' } }))
    expect((await shown.run()).status).toBe('completed')
    expect(notified.verdicts[0]).toEqual([{ decision: 'allow' }])
    const [event] = shown.ctx.eventLog.query({ type: 'agent-workers.tool.notified' })
    expect(event).toMatchObject({ data: { tool: 'Write', actionClass: 'workspace-write' } })
    expect(shown.ctx.artifacts.get(event!.decision!)!.body).toMatchObject({ decisionType: 'autonomy', outcome: { option: 'notify' } })
    const checked = new GatedAgent([[write, { tool: 'Edit', input: { file_path: 'b.txt', old_string: 'x', new_string: 'y' } }]])
    const pending = await boot(checked, policy({ 'workspace-write': { mode: 'auto', requires: ['tests', 'lint'] } }))
    expect((await pending.run()).status).toBe('completed')
    expect(checked.verdicts[0]).toEqual([{ decision: 'allow' }, { decision: 'allow' }])
    const events = pending.ctx.eventLog.query({ type: 'agent-workers.tool.checks-pending' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ data: { actionClass: 'workspace-write', pendingChecks: ['tests', 'lint'] } })
    // The autonomy decision names them too: they bind when the result is accepted.
    expect(pending.ctx.artifacts.get(events[0]!.decision!)!.body).toMatchObject({ decisionType: 'autonomy', outcome: { option: 'auto', detail: { failedChecks: ['tests', 'lint'] } } })
    // A notify rule with required checks names them in its event.
    const both = new GatedAgent([[write]])
    const named = await boot(both, policy({ 'workspace-write': { mode: 'notify', requires: ['tests'] } }))
    await named.run()
    expect(both.verdicts[0]).toEqual([{ decision: 'allow' }])
    expect(named.ctx.eventLog.query({ type: 'agent-workers.tool.notified' })[0]).toMatchObject({ data: { pendingChecks: ['tests'] } })
  })

  it('under the bundle\'s default studio policy: a workspace write runs with tests and lint pending, a command still defers, and an outside write is still denied', async () => {
    const agent = new GatedAgent([[
      { tool: 'Read', input: { file_path: 'src/a.ts' } }, { tool: 'Write', input: { file_path: 'src/b.ts', content: 'x' } },
      { tool: 'Write', input: { file_path: '/etc/b.ts', content: 'x' } }, bash('npm test'),
    ]])
    const { ctx, run } = await boot(agent, bundlePolicies()[0]!)
    const done = await run()
    const [read, write, outside, command] = agent.verdicts[0]!
    expect(read).toEqual({ decision: 'allow' })
    expect(write).toEqual({ decision: 'allow' })
    expect(outside).toMatchObject({ decision: 'deny', reason: expect.stringContaining('not inside the workspace') })
    expect(command).toMatchObject({ decision: 'defer' })
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error' } })
    expect((await ctx.approvals.list())[0]).toMatchObject({ action: { class: 'command' }, policy: { id: 'studio-default' } })
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
  // A real tree: the workspace, a directory beside it, and symlinks from one into the other.
  const tree = realpathSync(mkdtempSync(join(tmpdir(), 'system-gate-tree-')))
  afterAll(() => rmSync(tree, { recursive: true, force: true }))
  const ws = join(tree, 'repo')
  const outside = join(tree, 'outside')
  mkdirSync(join(ws, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(ws, 'src', 'a.ts'), 'x')
  writeFileSync(join(outside, 'secret'), 'x')
  symlinkSync(join(outside, 'secret'), join(ws, 'link-file'))
  symlinkSync(outside, join(ws, 'link-dir'))
  symlinkSync(outside, join(ws, 'src', 'up'))
  symlinkSync(join(outside, 'new'), join(ws, 'dangling'))
  symlinkSync(join(ws, 'loop'), join(ws, 'loop'))
  symlinkSync(join(ws, 'src'), join(ws, 'inner'))
  symlinkSync(ws, join(tree, 'repo-link'))
  const edit = (file_path: string) => ({ tool: 'Edit', input: { file_path, old_string: 'a', new_string: 'b' } })
  const write = (file_path: string) => ({ tool: 'Write', input: { file_path, content: 'x' } })

  it('reads and writes inside the workspace only, and never by a home path', () => {
    expect(classify({ tool: 'Read', input: { file_path: 'src/a.ts' } }, ws)).toMatchObject({ class: 'read' })
    expect(classify({ tool: 'Read', input: { file_path: join(ws, 'src/a.ts') } }, ws)).toMatchObject({ class: 'read' })
    expect(classify({ tool: 'Grep', input: { pattern: 'x' } }, ws)).toMatchObject({ class: 'read' })
    for (const path of ['../other/a', `${ws}-other/a`, '~/.ssh/id_rsa', '']) {
      expect(classify({ tool: 'Read', input: { file_path: path } }, ws)).toHaveProperty('refused')
      expect(classify({ tool: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }, ws)).toHaveProperty('refused')
    }
    expect(classify({ tool: 'Glob', input: { pattern: '../**' } }, ws)).toHaveProperty('refused')
    expect(classify({ tool: 'Glob', input: { pattern: '/etc/**' } }, ws)).toHaveProperty('refused')
    expect(classify({ tool: 'Glob', input: { pattern: `${ws}/**/*.ts` } }, ws)).toMatchObject({ class: 'read' })
    expect(classify({ tool: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } }, ws)).toMatchObject({ class: 'workspace-write' })
  })

  it('follows every symlink: a path whose real location is outside the real workspace is refused, for a read and for a write', () => {
    for (const path of ['link-file', join(ws, 'link-file'), 'link-dir/secret', 'src/up/secret']) {
      expect(classify({ tool: 'Read', input: { file_path: path } }, ws), path).toMatchObject({ refused: expect.stringContaining('not inside the workspace') })
      expect(classify(write(path), ws), path).toMatchObject({ refused: expect.stringContaining('not inside the workspace') })
      expect(classify(edit(path), ws), path).toHaveProperty('refused')
    }
    expect(classify({ tool: 'LS', input: { path: 'link-dir' } }, ws)).toHaveProperty('refused')
    expect(classify({ tool: 'Grep', input: { pattern: 'x', path: 'link-dir' } }, ws)).toHaveProperty('refused')
    expect(classify({ tool: 'Glob', input: { pattern: 'link-dir/**' } }, ws)).toHaveProperty('refused')
    expect(classify({ tool: 'Glob', input: { pattern: '**', path: 'link-dir' } }, ws)).toHaveProperty('refused')
    // A symlink that stays inside is inside.
    expect(classify({ tool: 'Read', input: { file_path: 'inner/a.ts' } }, ws)).toMatchObject({ class: 'read' })
  })

  it('places a file that does not exist yet by its deepest existing ancestor: a new file under a symlinked directory pointing outside is refused, a new file inside is allowed', () => {
    for (const path of ['link-dir/new.txt', 'link-dir/deeper/new.txt', 'dangling', 'loop/x', 'loop']) {
      expect(classify(write(path), ws), path).toMatchObject({ refused: expect.stringContaining('not inside the workspace') })
    }
    // `..` is resolved on disk, never lexically: src/up/.. is the directory beside the workspace.
    expect(classify(write('src/up/../new.txt'), ws)).toHaveProperty('refused')
    // A `..` under a directory that does not exist cannot be placed, so it is refused.
    expect(classify(write('nope/../src/new.ts'), ws)).toHaveProperty('refused')
    for (const path of ['src/new.ts', 'new/deep/file.ts', join(ws, 'b.ts'), 'inner/new.ts']) {
      expect(classify(write(path), ws), path).toMatchObject({ class: 'workspace-write' })
    }
    // A workspace named through a symlink is its real directory; one that does not exist holds nothing.
    expect(classify(write('src/new.ts'), join(tree, 'repo-link'))).toMatchObject({ class: 'workspace-write' })
    expect(classify(write('link-dir/new.txt'), join(tree, 'repo-link'))).toHaveProperty('refused')
    expect(classify(write('a.ts'), join(tree, 'missing'))).toHaveProperty('refused')
  })

  it('refuses an input field a classified tool does not declare, or a declared one of another type, naming it', () => {
    const valid: Array<[string, Record<string, unknown>]> = [
      ['Read', { file_path: 'src/a.ts', offset: 1, limit: 10, pages: '1-2', allow_large: true }],
      ['NotebookRead', { notebook_path: 'n.ipynb', cell_id: 'c1' }],
      ['LS', { path: '.', ignore: ['node_modules'] }],
      ['Glob', { pattern: '**/*.ts', path: 'src' }],
      ['Grep', { 'pattern': 'x', 'path': 'src', 'glob': '*.ts', 'output_mode': 'content', '-B': 1, '-A': 1, '-C': 1, 'context': 1, '-n': true, '-i': true, '-o': false, 'type': 'ts', 'head_limit': 5, 'offset': 0, 'multiline': false }],
      ['Write', { file_path: 'b.ts', content: 'x' }],
      ['Edit', { file_path: 'b.ts', old_string: 'a', new_string: 'b', replace_all: true }],
      ['MultiEdit', { file_path: 'b.ts', edits: [{ old_string: 'a', new_string: 'b', replace_all: false }] }],
      ['NotebookEdit', { notebook_path: 'n.ipynb', cell_id: 'c1', new_source: 'x', cell_type: 'code', edit_mode: 'replace' }],
      ['Bash', { command: 'npm test', description: 'run', timeout: 1000, run_in_background: false }],
      ['WebFetch', { url: 'https://example.com', prompt: 'read it', offset: 0 }],
      ['WebSearch', { query: 'x', allowed_domains: ['example.com'], blocked_domains: [] }],
      ['apply_patch', { command: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch\n' }],
      ['view_image', { path: 'src/a.ts', detail: 'high' }],
      ['read_file', { Path: join(ws, 'src/a.ts'), StartLine: 1, EndLine: 2, ByteOffset: 0 }],
      ['write_file', { Path: join(ws, 'b.ts'), Content: 'x', Append: false, Overwrite: true }],
      ['edit_file', { Path: join(ws, 'src/a.ts'), Target: 'x', Replacement: 'y' }],
    ]
    const wrong: Record<string, [string, unknown]> = {
      Read: ['offset', '1'], NotebookRead: ['cell_id', 1], LS: ['ignore', 'node_modules'], Glob: ['path', 1], Grep: ['-i', 'yes'], Write: ['content', 1],
      Edit: ['replace_all', 'true'], MultiEdit: ['edits', [{ old_string: 'a', new_string: 'b', extra: 1 }]], NotebookEdit: ['new_source', 1],
      Bash: ['timeout', '1000'], WebFetch: ['prompt', 1], WebSearch: ['allowed_domains', 'example.com'], apply_patch: ['command', 1], view_image: ['detail', 1],
      read_file: ['StartLine', '1'], write_file: ['Append', 'true'], edit_file: ['Target', 1],
    }
    for (const [tool, input] of valid) {
      expect(classify({ tool, input }, ws), tool).not.toHaveProperty('refused')
      expect(classify({ tool, input: { ...input, extra: 1 } }, ws), tool).toEqual({ refused: `${tool} carries "extra", a field the gate does not classify` })
      const [field, value] = wrong[tool]!
      expect(classify({ tool, input: { ...input, [field]: value } }, ws), tool).toMatchObject({ refused: expect.stringContaining(`${tool} carries ${JSON.stringify(field)} that is not a `) })
    }
    expect(classify({ tool: 'Bash', input: { command: 'npm test', dangerouslyDisableSandbox: true } }, ws)).toEqual({ refused: 'Bash carries "dangerouslyDisableSandbox", a field the gate does not classify' })
    expect(classify({ tool: 'Read', input: JSON.parse('{"file_path": "src/a.ts", "__proto__": {"x": 1}}') as Record<string, unknown> }, ws)).toHaveProperty('refused')
  })

  it('splits a command on single spaces, exactly as the policy matches it, and refuses an empty word, a shell metacharacter, and an input field it does not know', () => {
    expect(classify(bash('npm run build'), ws)).toMatchObject({ class: 'command', command: ['npm', 'run', 'build'] })
    for (const command of ['npm  test', ' npm test', 'npm test ', 'echo safe;id', 'echo $(id)', 'echo a\nid', 'ls ~', 'echo `id`']) {
      expect(classify(bash(command), ws), command).toHaveProperty('refused')
    }
    expect(classify({ tool: 'Bash', input: { command: 'npm test', timeout: 1000, description: 'run', run_in_background: false } }, ws)).toMatchObject({ command: ['npm', 'test'] })
    expect(classify({ tool: 'Bash', input: { command: 'npm test', dangerouslyDisableSandbox: true } }, ws)).toHaveProperty('refused')
    expect(classify({ tool: 'Bash', input: { command: '' } }, ws)).toHaveProperty('refused')
  })

  it('reads a patch strictly and allows it only when every file it names is inside the workspace: added, deleted, updated, or moved to', () => {
    const patch = (...body: string[]) => ({ tool: 'apply_patch', input: { command: ['*** Begin Patch', ...body, '*** End Patch', ''].join('\n') } })
    expect(classify(patch('*** Add File: src/new.ts', '+x', '*** Delete File: src/a.ts', '*** Update File: src/a.ts', '*** Move to: src/b.ts', '@@ class A', ' keep', '', '-x', '+y', '*** End of File'), ws))
      .toMatchObject({ class: 'workspace-write', summary: 'apply_patch: add src/new.ts, delete src/a.ts, update src/a.ts, move to src/b.ts' })
    expect(classify(patch(`*** Update File: ${join(ws, 'src/a.ts')}`, '-x', '+y'), ws)).toMatchObject({ class: 'workspace-write' })
    for (const path of ['../outside/x', '/etc/passwd', 'link-dir/new.txt', 'link-file', '~/.bashrc']) {
      for (const body of [[`*** Add File: ${path}`, '+x'], [`*** Delete File: ${path}`], [`*** Update File: ${path}`, '-x'], ['*** Update File: src/a.ts', `*** Move to: ${path}`, '-x']]) {
        expect(classify(patch(...body), ws), body.join(' | ')).toMatchObject({ refused: expect.stringContaining('not inside the workspace') })
      }
    }
    const refused = (command: string) => expect(classify({ tool: 'apply_patch', input: { command } }, ws), command).toHaveProperty('refused')
    refused('*** Update File: src/a.ts\n-x\n')
    refused('*** Begin Patch\n*** End Patch\n')
    refused('*** Begin Patch\r\n*** Add File: x\r\n+x\r\n*** End Patch\r\n')
    refused('*** Begin Patch\n*** Add File:  src/x.ts\n+x\n*** End Patch\n')
    refused('*** Begin Patch\n*** Copy File: src/x.ts\n*** End Patch\n')
    refused('*** Begin Patch\n*** Update File: src/a.ts\n  *** Add File: /etc/x\n*** End Patch\n')
    refused('*** Begin Patch\n*** Add File: src/x.ts\n x\n*** End Patch\n')
    refused('*** Begin Patch\n*** Move to: src/x.ts\n*** End Patch\n')
    refused('*** Begin Patch\n*** Delete File: src/a.ts\n-x\n*** End Patch\n')
    refused('<<EOF\n*** Begin Patch\n*** Add File: src/x.ts\n+x\n*** End Patch\nEOF\n')
  })

  it('reads an image inside the workspace only', () => {
    expect(classify({ tool: 'view_image', input: { path: 'src/a.ts' } }, ws)).toMatchObject({ class: 'read', summary: 'view_image src/a.ts' })
    for (const path of ['/etc/hostname', 'link-file', '../x.png']) expect(classify({ tool: 'view_image', input: { path } }, ws), path).toHaveProperty('refused')
    expect(classify({ tool: 'view_image', input: {} }, ws)).toHaveProperty('refused')
  })

  it('classifies the Antigravity CLI\'s file tools by the file each names in Path: inside the workspace on disk, a file: URI as the path it names', () => {
    expect(classify({ tool: 'read_file', input: { Path: join(ws, 'src/a.ts') } }, ws)).toMatchObject({ class: 'read', summary: `read_file ${join(ws, 'src/a.ts')}` })
    expect(classify({ tool: 'read_file', input: { Path: ws } }, ws)).toMatchObject({ class: 'read' })
    expect(classify({ tool: 'write_file', input: { Path: join(ws, 'new/c.ts'), Content: '/etc/passwd' } }, ws)).toMatchObject({ class: 'workspace-write' })
    expect(classify({ tool: 'edit_file', input: { Path: 'src/a.ts', Target: '~/x', Replacement: '../y' } }, ws)).toMatchObject({ class: 'workspace-write' })
    const uri = (path: string) => pathToFileURL(path).href
    expect(classify({ tool: 'read_file', input: { Path: uri(join(ws, 'src/a.ts')) } }, ws)).toMatchObject({ class: 'read' })
    expect(classify({ tool: 'write_file', input: { Path: uri(join(ws, 'src/new.ts')), Content: 'x' } }, ws)).toMatchObject({ class: 'workspace-write' })
    const outsideUris = [uri(join(outside, 'secret')), uri(join(ws, 'link-file')), uri(join(ws, 'link-dir/new.txt')), `file://${ws}/src/%2E%2E/%2E%2E/outside/secret`, `file://other-host${ws}/src/a.ts`, `file://${ws}/src%2Fa.ts`, 'file:secret']
    for (const path of [join(outside, 'secret'), join(ws, 'link-file'), join(ws, 'link-dir', 'new.txt'), join(ws, 'src', 'up', 'secret'), `${ws}/../outside/secret`, '~/.ssh/id_rsa', '', ...outsideUris]) {
      expect(classify({ tool: 'read_file', input: { Path: path } }, ws), path).toHaveProperty('refused')
      expect(classify({ tool: 'write_file', input: { Path: path, Content: 'x' } }, ws), path).toHaveProperty('refused')
      expect(classify({ tool: 'edit_file', input: { Path: path, Target: 'a', Replacement: 'b' } }, ws), path).toHaveProperty('refused')
    }
    // A file: URI is a path for every tool: one outside is refused whichever tool names it.
    expect(classify({ tool: 'Read', input: { file_path: uri('/etc/hostname') } }, ws)).toHaveProperty('refused')
    for (const input of [{}, { Content: 'x' }, { Path: 1, Content: 'x' }, { Path: join(ws, 'b.ts'), Content: 'x', ArtifactMetadata: { Summary: 'plan' } }]) {
      expect(classify({ tool: 'write_file', input }, ws), JSON.stringify(input)).toHaveProperty('refused')
    }
  })

  it('denies the Antigravity CLI\'s run_command and every other tool of its, whatever their input: no confinement of its commands is proven', () => {
    for (const call of [
      { tool: 'run_command', input: { CommandLine: 'ls', WaitMsBeforeAsync: 5000, toolSummary: 'List current directory' } },
      { tool: 'run_command', input: { CommandLine: 'ls', BypassSandbox: true } },
      { tool: 'send_command_input', input: { CommandId: '1', Input: 'x' } },
      { tool: 'search_web', input: { query: 'x' } },
      { tool: 'invoke_subagent', input: { Prompt: 'x' } },
      { tool: 'schedule', input: { Prompt: 'x' } },
      { tool: 'call_mcp_tool', input: {} },
    ]) {
      expect(classify(call, ws), call.tool).toEqual({ refused: `${call.tool} is not a tool the gate classifies` })
    }
  })

  it('classifies every call agy 1.4.6 made in the supervised live check as the action it is: file reads and writes inside the workspace, run_command refused', () => {
    const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../runtime-antigravity-cli/tests/fixtures/agy-1.4.6-hook-inputs.json', import.meta.url)), 'utf8')
      .replaceAll('<workspace>', ws).replaceAll('<outside>', outside)) as {
      recorded: Array<{ input: { toolCall: { name: string; args: Record<string, unknown> } } }>
      bridge: Array<{ toolCall: { name: string; args: Record<string, unknown> }; by: 'gate' | 'rules'; reason?: string }>
    }
    const calls = [...fixture.recorded.map((r) => r.input.toolCall), ...fixture.bridge.map((b) => b.toolCall)]
    expect(new Set(calls.map((c) => c.name))).toEqual(new Set(['read_file', 'edit_file', 'write_file', 'run_command']))
    for (const call of calls) {
      const action = classify({ tool: call.name, input: call.args }, ws)
      const where = String(call.args.Path ?? '')
      const expected = call.name === 'run_command' || !where.startsWith(ws) ? 'refused' : call.name === 'read_file' ? 'read' : 'workspace-write'
      expect('refused' in action ? 'refused' : action.class, JSON.stringify(call)).toBe(expected)
    }
  })

  it('refuses a tool it does not know and an input that is not an object', () => {
    for (const call of [{ tool: 'mcp__x__y', input: {} }, { tool: 'Agent', input: {} }, { tool: 'request_user_input', input: { questions: [] } }, { tool: 'write_stdin', input: { session_id: 1, chars: 'x' } }, { tool: 'Read', input: 'a' }, { tool: 'Read', input: null }]) {
      expect(classify(call, ws)).toHaveProperty('refused')
    }
  })
})

describe('a Claude Code Worker under the bundle\'s default policy, end to end (docs/design/approvals.md#a-workers-tool-calls)', () => {
  type Hook = (input: Record<string, unknown>, id: string, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>
  const home = mkdtempSync(join(tmpdir(), 'system-gate-claude-home-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  /**
   * Claude Code on a host where both of its confinements are proven (ADR-0038), its SDK stream
   * scripted: each tool call goes through the hooks the run registered, and a defer ends the run.
   */
  function claude(calls: ReadonlyArray<readonly [string, Record<string, unknown>]>, outputs: Array<Record<string, unknown>>, optionsSeen: Array<Record<string, unknown>>): ClaudeAgentRuntime {
    const query = ((params: { prompt: string; options: Record<string, unknown> }) => {
      optionsSeen.push(params.options)
      const hooks = (params.options.hooks as { PreToolUse: Array<{ hooks: Hook[] }> }).PreToolUse
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'h-claude', model: 'model-main' }
        let deferred = false
        for (const [i, [tool, input]] of calls.entries()) {
          const output = await hooks[0]!.hooks[0]!({ hook_event_name: 'PreToolUse', session_id: 'h-claude', transcript_path: '/t', cwd: WORKSPACE, tool_name: tool, tool_input: input, tool_use_id: `toolu_${i}` }, `toolu_${i}`, { signal: new AbortController().signal })
          outputs.push(output)
          if ((output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === 'defer') {
            deferred = true
            break
          }
        }
        yield {
          type: 'result', subtype: 'success', is_error: false, result: deferred ? '' : 'changed b.ts', session_id: 'h-claude', uuid: 'r-1', num_turns: 3, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {},
          terminal_reason: deferred ? 'tool_deferred' : 'completed',
        }
      })()
    }) as unknown as QueryFn
    return new ClaudeAgentRuntime({
      query, executable: '/usr/bin/claude', findExecutable: () => undefined, version: async () => '2.1.300', home,
      confine: (bind) => ({ bwrap: '/usr/bin/bwrap', hide: [], readOnly: [...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] }),
      prove: async () => ({ confined: true, detail: 'host state hidden' }), nested: async () => '', status: async () => '{"loggedIn": true}',
    })
  }

  it('reads and writes inside its workspace through the runtime\'s PreToolUse hook, and its pre-approvals still bind it there', async () => {
    const outputs: Array<Record<string, unknown>> = []
    const optionsSeen: Array<Record<string, unknown>> = []
    const calls = [['Read', { file_path: 'src/a.ts' }], ['Grep', { pattern: 'x' }], ['Write', { file_path: 'src/b.ts', content: 'x' }], ['Edit', { file_path: 'src/b.ts', old_string: 'x', new_string: 'y' }]] as const
    const { ctx, run } = await boot(claude(calls, outputs, optionsSeen), bundlePolicies()[0]!)
    const done = await run()
    expect(done.status).toBe('completed')
    expect(ctx.artifacts.get(done.result!)!.body).toMatchObject({ runtime: 'claude-agent-sdk', text: 'changed b.ts' })
    // Every call allowed: no hook decision, so the workspace-scoped pre-approvals decide.
    expect(outputs).toEqual([{}, {}, {}, {}])
    expect(optionsSeen[0]).toMatchObject({ permissionMode: 'dontAsk', allowedTools: ['Read(./**)', 'Grep(./**)', 'Glob(./**)', 'Edit(./**)', 'Write(./**)', 'Bash'] })
    expect(ctx.eventLog.query({ type: 'agent-workers.tool.checks-pending' })).toEqual([expect.objectContaining({ data: expect.objectContaining({ pendingChecks: ['tests', 'lint'] }) })])
    expect(await ctx.approvals.list()).toEqual([])
  })

  it('passes each Bash command through the gate by its exact argv: a shell metacharacter is denied, a plain command waits for the operator; the sandbox only bounds where it acts (ADR-0038)', async () => {
    const outputs: Array<Record<string, unknown>> = []
    const optionsSeen: Array<Record<string, unknown>> = []
    const calls = [['Bash', { command: 'npm test && curl https://example.com' }], ['Bash', { command: 'npm test', description: 'run the tests' }], ['Read', { file_path: 'src/a.ts' }]] as const
    const { ctx, run } = await boot(claude(calls, outputs, optionsSeen), bundlePolicies()[0]!)
    const done = await run()
    // The run's commands would run in the SDK's sandbox, yet the policy still decides each one.
    expect(optionsSeen[0]).toMatchObject({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: [WORKSPACE] }, network: { allowedDomains: [] } } })
    const decision = (output: Record<string, unknown>) => (output.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string }).permissionDecision
    expect(outputs.map(decision)).toEqual(['deny', 'defer'])
    expect(decisionOf(ctx, (outputs[0]!.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason)).toMatchObject({ decisionType: 'gate', outcome: { option: 'deny' } })
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error' } })
    expect(await ctx.approvals.list()).toEqual([expect.objectContaining({ action: expect.objectContaining({ class: 'command', summary: 'Bash: npm test' }), requester: expect.objectContaining({ toolUseId: 'toolu_1' }) })])
  })
})

describe('a Codex Worker under the bundle\'s default policy, end to end (docs/design/agent-runtimes.md#tool-gate)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cxw-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  /**
   * Codex on a host where its confinement and its gate are proven, its stream scripted: each tool
   * call goes through the real gate hook the run installs (as Codex 0.164 runs it), and an allowed
   * one produces its item.
   */
  function codex(calls: Array<{ tool: string; input: Record<string, unknown>; item?: string }>) {
    const s = scriptedCodex(() => [
      { type: 'thread.started', thread_id: 'h-codex' }, { type: 'turn.started' },
      ...calls.map((call, i) => ({ call: { tool: call.tool, input: call.input }, ...(call.item ? { item: { id: `i${i}`, type: call.item, command: '', aggregated_output: '', status: 'completed' } } : {}) }) as never),
      { type: 'item.completed', item: { id: 'msg', type: 'agent_message', text: 'changed it' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ])
    const runtime = new CodexRuntime({
      executable: '/usr/bin/codex', home: join(root, 'home'), runDir: join(root, 'run'), hook: fileURLToPath(new URL('../../runtime-codex-sdk/src/gate-hook.ts', import.meta.url)),
      client: s.client, version: async () => '0.164.0', mcpServers: async () => [], exec: probeExec(),
      confine: (bind) => ({ bwrap: '/usr/bin/bwrap', hide: [], readOnly: [...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] }),
      prove: async () => ({ confined: true, detail: 'host state hidden' }), nested: async () => undefined, status: async () => undefined, launcher: () => '/launcher',
    })
    return { runtime, hooks: () => s.calls.flatMap((c) => c.hooks) }
  }

  it('is admitted on its probe, patches its workspace through the hook, is denied outside it, and waits for the operator on a command', async () => {
    const patch = (path: string) => ({ command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch\n` })
    const { runtime, hooks } = codex([
      { tool: 'apply_patch', input: patch('src/new.ts'), item: 'file_change' },
      { tool: 'view_image', input: { path: '/etc/hostname' } },
      { tool: 'apply_patch', input: patch('/etc/cron.d/x'), item: 'file_change' },
      { tool: 'Bash', input: { command: 'npm test' }, item: 'command_execution' },
    ])
    const { ctx, run } = await boot(runtime, bundlePolicies()[0]!)
    const done = await run()
    // A workspace patch runs (tests and lint pending); a read or a patch outside is denied by the gate's own rule; a command asks.
    expect(hooks().map((h) => h.blocked)).toEqual([false, true, true, true])
    expect(decisionOf(ctx, hooks()[1]!.reason)).toMatchObject({ decisionType: 'gate', outcome: { option: 'deny' } })
    expect(hooks()[2]!.reason).toContain('/etc/cron.d/x, which is not inside the workspace')
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringContaining('stopped at its Bash call, which waits for the operator') } })
    expect(await ctx.approvals.list()).toEqual([expect.objectContaining({ action: expect.objectContaining({ class: 'command', summary: 'Bash: npm test' }), requester: expect.objectContaining({ toolUseId: 'call_4' }) })])
    expect(ctx.eventLog.query({ type: 'agent-workers.tool.checks-pending' })).toEqual([expect.objectContaining({ data: expect.objectContaining({ tool: 'apply_patch', pendingChecks: ['tests', 'lint'] }) })])
  })
})

// A deferred call's continuation (docs/design/workflow-engine.md#a-deferred-tool-call): the workflow
// engine continues the session that stopped at the call, once, when the operator approves it.
describe('the continuation of a deferred call by the workflow engine', { timeout: 60_000 }, () => {
  const CHANGE = [{ nodeId: 'change', objective: 'Change the code', prompt: '{{input}}', capabilities: ['develop', 'local-data'], tier: 'standard' as const, conversation: 'persistent' as const, acceptance: 'acceptance.answer' }]

  async function bootFlow(agent: AgentRuntimeProvider) {
    const dir = mkdtempSync(join(tmpdir(), 'system-gate-flow-'))
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
      ctx.plugin(StoreApprovals, { policies: [policy()], sweepSeconds: 3600 }), ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(WorkerSessions, {}),
      ctx.plugin(AgentWorkers, { workers: [{ id: 'dev', runtime: agent.kind, workspace: WORKSPACE, sandbox: 'workspace-write', tier: 'standard' }] }),
      ctx.plugin(Workflow, { retryDelayMs: 50, approvalPollSeconds: 1, templates: { change: CHANGE } }),
    ]
    await Promise.all(fibers)
    ctx.agentRuntimes.register(agent)
    cleanups.push(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    return ctx
  }

  const settledRun = async (ctx: Context, runId: string, status: 'completed' | 'failed') => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const view = ctx.workflow.get(runId)!
      if (view.status === status) return view
      if (Date.now() > deadline) throw new Error(`run ${runId} is ${view.status}, not ${status}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  it('continues the session once the operator approves the call it stopped at: one more attempt, whose brief says so, and the call runs once', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test')]])
    const ctx = await bootFlow(agent)
    const run = ctx.workflow.start({ template: 'change', input: 'Make the tests pass', classification: 'operator-shared' })
    const failed = await settledRun(ctx, run.runId, 'failed')
    expect(failed.error).toMatchObject({ kind: 'config_error' })
    const [request] = await ctx.approvals.list()
    expect(request).toMatchObject({ action: { class: 'command' }, requester: { component: 'worker', sessionId: run.sessionId } })
    // Nothing continues before the verdict.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(agent.runs).toHaveLength(1)
    await ctx.approvals.decide([{ requestId: request!.requestId, subject: request!.subject, verdict: 'approved' }])
    const done = await settledRun(ctx, run.runId, 'completed')
    expect(done.nodes).toEqual([expect.objectContaining({ nodeId: 'change', state: 'COMPLETED', attempt: 2 })])
    // The same session, resumed, told the call was approved; the approved call ran.
    expect(agent.runs).toHaveLength(2)
    expect(agent.runs[1]!.resume).toBe(agent.runs[0]!.resume ?? 'h-1')
    expect(agent.runs[1]!.prompt).toContain(`The operator approved the tool call you stopped at (approval request ${request!.requestId})`)
    expect(agent.verdicts[1]).toEqual([{ decision: 'allow' }])
    const continued = ctx.artifacts.list({ kind: 'decision', runId: run.runId }).map((a) => a.body as { decisionType: string; decider: { id: string }; outcome: { option: string; detail?: Record<string, unknown> } })
      .filter((d) => d.decider.id === 'workflow.approved-call')
    expect(continued).toEqual([expect.objectContaining({ decisionType: 'recovery', outcome: expect.objectContaining({ option: 'continue', detail: expect.objectContaining({ approvalRequest: request!.requestId }) }) })])
    // At most once per approval: later sweeps continue nothing more.
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(agent.runs).toHaveLength(2)
  })

  it('continues nothing when the operator rejects the call: the run stays failed for the operator', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test')]])
    const ctx = await bootFlow(agent)
    const run = ctx.workflow.start({ template: 'change', input: 'Make the tests pass', classification: 'operator-shared' })
    await settledRun(ctx, run.runId, 'failed')
    const [request] = await ctx.approvals.list()
    await ctx.approvals.decide([{ requestId: request!.requestId, subject: request!.subject, verdict: 'rejected' }])
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(ctx.workflow.get(run.runId)!.status).toBe('failed')
    expect(agent.runs).toHaveLength(1)
    expect(ctx.store.db.prepare('SELECT outcome FROM workflow_deferrals WHERE request_id = ?').get(request!.requestId)).toEqual({ outcome: 'rejected' })
  })
})
