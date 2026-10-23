// The tool gate of an agent run (src/gate.ts) over the store-backed approval queue, with a scripted
// runtime that asks the gate before each tool call as a gating runtime does: forbid denies, auto
// allows, ask opens one request on the exact call and defers, a later run of the session makes an
// approved call once, a rejected or expired one stays denied, and every other case fails closed.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkerExecution, type WorkRequirement } from '@tsuuanmi/system-workers'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
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

  it('passes each Bash command through the gate by its exact argv: a shell metacharacter is forbidden, a plain command waits for the operator; the sandbox only bounds where it acts (ADR-0038)', async () => {
    const outputs: Array<Record<string, unknown>> = []
    const optionsSeen: Array<Record<string, unknown>> = []
    const calls = [['Bash', { command: 'npm test && curl https://example.com' }], ['Bash', { command: 'npm test', description: 'run the tests' }], ['Read', { file_path: 'src/a.ts' }]] as const
    const { ctx, run } = await boot(claude(calls, outputs, optionsSeen), bundlePolicies()[0]!)
    const done = await run()
    // The run's commands would run in the SDK's sandbox, yet the policy still decides each one.
    expect(optionsSeen[0]).toMatchObject({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: [WORKSPACE] }, network: { allowedDomains: [] } } })
    const decision = (output: Record<string, unknown>) => (output.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string }).permissionDecision
    expect(outputs.map(decision)).toEqual(['deny', 'defer'])
    expect(decisionOf(ctx, (outputs[0]!.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason)).toMatchObject({ decisionType: 'autonomy', outcome: { option: 'forbid' } })
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error' } })
    expect(await ctx.approvals.list()).toEqual([expect.objectContaining({ action: expect.objectContaining({ class: 'command', summary: 'Bash: npm test' }), requester: expect.objectContaining({ toolUseId: 'toolu_1' }) })])
  })
})
