// The tool gate of an agent run (src/gate.ts) over the store-backed approval queue, with a scripted
// runtime that asks the gate before each tool call as a gating runtime does: forbid denies, auto
// allows, ask opens one request on the exact call and defers, a later run of the session makes an
// approved call once, a rejected or expired one stays denied, and every other case fails closed.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { type RunMetering, withMetering } from '@tsuuanmi/system-agent-runtime-core'
import AgentRuntimeRegistry, { type AgentRuntimeProvider, type RunSpec, type ToolCall, type ToolVerdict } from '@tsuuanmi/system-agent-runtimes'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { AGENT_TOOL_EVENTS, AGENT_TOOL_EXPLANATION_MAX, agentToolDenialOf, agentToolDenialReasons, agentToolEventOf, contentId } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type { PoolConfig } from '@tsuuanmi/system-resources-core'
import { FakeResources } from '../../../resources-core/conformance/resources.ts'
import { ClaudeAgentRuntime, type QueryFn } from '@tsuuanmi/system-runtime-claude-agent-sdk'
import { CodexRuntime } from '@tsuuanmi/system-runtime-codex-sdk'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkerExecution, type WorkRequirement } from '@tsuuanmi/system-workers'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import Workflow from '@tsuuanmi/system-workflow'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import AgentWorkers from '../src/index.ts'
import { classify, DENIAL_REASONS, EXPLANATION_MAX, readToolsOf, TOOLS_NOTE_MAX, unaskedNote } from '../src/gate.ts'
import { probeExec, scripted as scriptedCodex } from '../../runtime-codex-sdk/tests/fake-codex.ts'
import { CHARTER } from '../../../board-core/conformance/board.ts'

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
  constructor(private readonly script: Array<Array<Omit<ToolCall, 'callId'>>>, private readonly options: { goesOn?: boolean; deferredMetering?: RunMetering; evidence?: { readTools?: string[]; workspaceReads?: boolean } } = {}) {}
  async probe() {
    return { available: true, detail: 'gated 1.0', sandboxes: ['read-only', 'workspace-write'] as Array<'read-only' | 'workspace-write'>, resume: true, executes: true, readsConfined: true, gatesToolCalls: true, ...this.options.evidence }
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
      if (verdict.decision === 'defer' && !this.options.goesOn) {
        const error = new ProviderError('config_error', `gated: stopped at ${call.tool} (approval request ${verdict.requestId})`)
        throw this.options.deferredMetering ? withMetering(error, this.options.deferredMetering) : error
      }
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

/** A pool the Worker draws on, when a test meters it. */
const POOL: PoolConfig = { pool: 'max.agents', account: 'max', kind: 'programmatic', unknown: 'available', windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18000 }] }

async function boot(agent: AgentRuntimeProvider, approvals: AutonomyPolicy | null = policy(), metered = false, sandbox: 'read-only' | 'workspace-write' = 'workspace-write') {
  // A read-only Worker proves review, never develop (INV-15): it is routed a review.
  const required: WorkRequirement = sandbox === 'read-only' ? { ...requirement, capabilities: ['review', 'local-data'] } : requirement
  const dir = mkdtempSync(join(tmpdir(), 'system-gate-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ...(approvals ? [ctx.plugin(StoreApprovals, { policies: [approvals] })] : []),
    ...(metered ? [ctx.plugin(FakeResources, { pools: [POOL] })] : []),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry),
    // Its worktree root, where a writing run's report file is made (T265), is the test's own, never the host's DSH home.
    ctx.plugin(AgentWorkers, { workers: [{ id: 'dev', runtime: agent.kind, workspace: WORKSPACE, sandbox, tier: 'standard', ...(metered ? { pool: POOL.pool, account: POOL.account } : {}) }], worktreeRoot: join(dir, 'worktrees') }),
  ]
  await Promise.all(fibers)
  ctx.agentRuntimes.register(agent)
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const admitted = await ctx.workers.route(required)
  expect(admitted).toMatchObject({ worker: { worker: 'agent:dev' } })
  const source = ctx.workers.source('agents')!
  let n = 0
  /** Start one run (in `session` unless null) and wait for its end. */
  const run = async (session: string | null = 'ses_dev'): Promise<WorkerExecution & { runId: string }> => {
    n += 1
    const started = source.start({ key: `k-${n}`, worker: 'agent:dev', prompt: `step ${n}`, ...(session ? { sessionId: session } : {}), requirement: required, decisions: (admitted as { decisions: { tier: `sha256:${string}`; route: `sha256:${string}` } }).decisions })
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
/** A run whose runtime enforces shells that read no startup code (`cleanShells`, T198): the only one where a shell command can be a read. */
const CLEAN = { shellReads: true } as const

// The board's own steps to a ready task, as the workflow's suite takes them; kept here so the agent
// Workers' tests compose the engine's code, never its tests (docs/engineering/testing.md#test-groups).
async function activeProject(ctx: Context, projectId = 'p1'): Promise<void> {
  const { approvalRequest } = await ctx.board.charter({ projectId, title: `project ${projectId}`, charter: CHARTER })
  const request = await ctx.approvals.get(approvalRequest)
  const [verdict] = await ctx.approvals.decide([{ requestId: approvalRequest, subject: request!.subject, verdict: 'approved' }])
  expect(verdict?.refused).toBeUndefined()
  await ctx.board.sweep(new Date())
  expect((await ctx.board.project(projectId))?.state).toBe('active')
}

/** A `read` task of project p1, proposed and made ready by the board's sweep. */
async function readyTask(ctx: Context, title: string) {
  const proposed = await ctx.board.propose({ projectId: 'p1', title, goal: `do ${title}`, acceptance: [{ id: 'a1', statement: 'it answers' }], actionClass: 'read' })
  await ctx.board.sweep(new Date())
  const task = (await ctx.board.task(proposed.taskId))!
  expect(task.state).toBe('ready')
  return task
}

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
    const events = ctx.eventLog.query({ type: 'agent-workers.tool.denied' })
    expect(events).toHaveLength(2)
    // Each denial explains itself (T207): a stable code, its fixed explanation, the Worker's kind, and the decision.
    const decisions = [outside, unknown].map((v) => /decision (sha256:[0-9a-f]{64})/.exec((v as { reason: string }).reason)![1])
    expect(events.map((e) => ({ decision: e.decision, data: e.data }))).toEqual([
      { decision: decisions[0], data: { agentRun: done.runId, worker: 'agent:dev', workerKind: 'gated', tool: 'Read', reason: 'outside-workspace', explanation: DENIAL_REASONS['outside-workspace'], decision: decisions[0] } },
      { decision: decisions[1], data: { agentRun: done.runId, worker: 'agent:dev', workerKind: 'gated', tool: 'Task', reason: 'unclassified-tool', explanation: DENIAL_REASONS['unclassified-tool'], decision: decisions[1] } },
    ])
    // The explanation never names the call's input.
    expect(JSON.stringify(events)).not.toContain('/etc/passwd')
    expect(decisionOf(ctx, (outside as { reason: string }).reason).outcome.detail).toMatchObject({ reason: 'outside-workspace' })
  })

  it('denies each shell inspection command at once, naming the reading tool, with no request, where the runtime gives its agent read tools; under one that gives none, it asks as before (T222)', async () => {
    const forms: Array<[string, string, string]> = [
      ['cat src/a.ts', 'Read', 'read_file'], ['head -n 5 src/a.ts', 'Read', 'read_file'], ['tail src/a.ts', 'Read', 'read_file'], ['sed -n 1,9p src/a.ts', 'Read', 'read_file'],
      ['wc -l src/a.ts', 'Read', 'read_file'], ['grep -rn needle src', 'Grep', 'search'], ['rg needle src', 'Grep', 'search'], ['ls -la src', 'Glob', 'list_dir'], ['find src -name a.ts', 'Glob', 'list_dir'],
    ]
    const script = [forms.map(([command]) => bash(command))]
    const kinds = { claude: { readTools: ['Read', 'Grep', 'Glob'] }, codex: { workspaceReads: true } }
    for (const [kind, evidence] of Object.entries(kinds)) {
      const agent = new GatedAgent(script, { evidence })
      const { ctx, run } = await boot(agent)
      const done = await run()
      expect(done.status, kind).toBe('completed')
      for (const [i, [command, own, server]] of forms.entries()) {
        const tool = kind === 'claude' ? own : server
        const verdict = agent.verdicts[0]![i] as { decision: string; reason: string }
        expect(verdict, `${command} under ${kind}`).toMatchObject({ decision: 'deny', reason: expect.stringContaining(`use ${tool} instead`) })
        expect(decisionOf(ctx, verdict.reason), command).toMatchObject({ decisionType: 'gate', outcome: { option: 'deny', detail: { reason: 'use-read-tool' } } })
      }
      // No request: nothing waits for the operator.
      expect(await ctx.approvals.list(), kind).toEqual([])
      const events = ctx.eventLog.query({ type: 'agent-workers.tool.denied' })
      expect(events.map((e) => e.data!.reason)).toEqual(forms.map(() => 'use-read-tool'))
      expect(events.map((e) => e.data!.explanation)).toEqual(forms.map(() => DENIAL_REASONS['use-read-tool']))
      for (const event of events) expect(agentToolDenialOf(event.data), kind).toBeDefined()
      // The brief's Tools section says so, naming the tool for each.
      const prompt = agent.runs[0]!.prompt
      expect(prompt).toContain('A Bash inspection command you have a reading tool for is denied at once, never asked')
      expect(prompt).toContain(kind === 'claude' ? 'grep, rg: use Grep' : 'grep, rg: use search')
      expect(prompt).toContain(kind === 'claude' ? 'ls, find: use Glob' : 'ls, find: use list_dir')
    }
    // A runtime that gives its agent no read tools: the first form is the exact command, asked as before; the run stops there.
    const agent = new GatedAgent(script)
    const { ctx, run } = await boot(agent)
    const done = await run()
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error' } })
    expect(agent.verdicts[0]).toEqual([expect.objectContaining({ decision: 'defer' })])
    expect(await ctx.approvals.list()).toEqual([expect.objectContaining({ action: expect.objectContaining({ class: 'command', summary: 'Bash: cat src/a.ts' }) })])
    expect(ctx.eventLog.query({ type: 'agent-workers.tool.denied' })).toEqual([])
    expect(agent.runs[0]!.prompt).not.toContain('A Bash inspection command you have a reading tool for')
    expect(agent.runs[0]!.prompt).toContain('cat, ls, rg, and the like are commands, judged as one')
  })

  it('gives every denial reason a plain explanation of at most 300 characters (T207)', () => {
    expect(EXPLANATION_MAX).toBe(300)
    expect(Object.keys(DENIAL_REASONS)).toEqual(expect.arrayContaining(['metacharacter', 'empty-word', 'outside-workspace', 'unclassified-tool', 'unsupported-field', 'policy-forbid', 'not-listed']))
    for (const [code, explanation] of Object.entries(DENIAL_REASONS)) {
      expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/)
      expect(explanation.length, code).toBeGreaterThan(0)
      expect(explanation.length, code).toBeLessThanOrEqual(EXPLANATION_MAX)
    }
  })

  it('declares every reason code the gate emits, and the explanation\'s bound, in the tool events\' schema; an entry from before T207 stays valid (T211)', async () => {
    // Derived from the gate's own list: a code added there and not to the schema fails here.
    const declared = agentToolDenialReasons()
    for (const code of Object.keys(DENIAL_REASONS)) expect(declared, code).toContain(code)
    const call = { agentRun: 'arun_1', worker: 'agent:dev', tool: 'Bash' }
    for (const [code, explanation] of Object.entries(DENIAL_REASONS)) {
      expect(agentToolDenialOf({ ...call, workerKind: 'codex-sdk', reason: code, explanation, actionClass: 'command', requestId: 'apr-1', decision: `sha256:${'a'.repeat(64)}` }), code).toBeDefined()
    }
    // From before T207: no reason, no explanation, no Worker kind.
    expect(agentToolDenialOf(call)).toEqual(call)
    // The bound is the gate's own: EXPLANATION_MAX characters pass, one more does not.
    expect(AGENT_TOOL_EXPLANATION_MAX).toBe(EXPLANATION_MAX)
    expect(agentToolDenialOf({ ...call, reason: 'gate-error', explanation: 'x'.repeat(EXPLANATION_MAX) })).toBeDefined()
    expect(agentToolDenialOf({ ...call, reason: 'gate-error', explanation: 'x'.repeat(EXPLANATION_MAX + 1) })).toBeUndefined()
    expect(agentToolDenialOf({ ...call, reason: 'gate-error', explanation: '' })).toBeUndefined()
    // A code the gate does not have, an explanation without a code, a field no denial carries: not a valid denial.
    expect(agentToolDenialOf({ ...call, reason: 'made-up' })).toBeUndefined()
    expect(agentToolDenialOf({ ...call, explanation: 'why' })).toBeUndefined()
    expect(agentToolDenialOf({ ...call, reason: 'gate-error', command: 'rm -rf /' })).toBeUndefined()
    expect(agentToolDenialOf({ ...call, tool: 'x'.repeat(101) })).toBeUndefined()

    // What the gate appends is valid under its event type's definition, every kind.
    const agent = new GatedAgent([[{ tool: 'Read', input: { file_path: '/etc/passwd' } }, { tool: 'Task', input: {} }, bash('npm test'), bash('echo a;b')]])
    const { ctx, run } = await boot(agent)
    await run()
    const events = Object.keys(AGENT_TOOL_EVENTS).flatMap((type) => ctx.eventLog.query({ type }))
    expect(events.map((e) => e.type).sort()).toEqual(['agent-workers.tool.deferred', 'agent-workers.tool.denied', 'agent-workers.tool.denied'])
    for (const e of events) expect(agentToolEventOf(e.type, e.data), e.type).toBeDefined()
    const pending = await boot(new GatedAgent([[{ tool: 'Write', input: { file_path: 'a.ts', content: 'x' } }, { tool: 'Read', input: { file_path: 'a.ts' } }]]), policy({ 'workspace-write': { mode: 'auto', requires: ['tests'] }, 'read': { mode: 'notify', requires: ['lint'] } }))
    await pending.run()
    const shown = Object.keys(AGENT_TOOL_EVENTS).flatMap((type) => pending.ctx.eventLog.query({ type }))
    expect(shown.map((e) => e.type).sort()).toEqual(['agent-workers.tool.checks-pending', 'agent-workers.tool.notified'])
    for (const e of shown) expect(agentToolEventOf(e.type, e.data), e.type).toBeDefined()
  })

  it('denies a workspace reads server call under a runtime that reports no such server, whatever the policy lets read, and tells it of no such server (T200b)', async () => {
    const agent = new GatedAgent([[{ tool: 'mcp__workspace__read_file', input: { path: 'src/a.ts' } }, { tool: 'Read', input: { file_path: join(WORKSPACE, 'src/a.ts') } }]])
    const { ctx, run } = await boot(agent)
    expect((await run()).status).toBe('completed')
    expect(agent.verdicts[0]!.map((v) => v.decision)).toEqual(['deny', 'allow'])
    expect(ctx.eventLog.query({ type: 'agent-workers.tool.denied' }).map((e) => e.data!.reason)).toEqual(['unclassified-tool'])
    expect(agent.runs[0]!.prompt).not.toContain('workspace server')
  })

  it('denies a call the policy forbids, with the reason its autonomy decision records', async () => {
    // A command that is no read-only inspection stays `command`, which the policy decides.
    const agent = new GatedAgent([[bash('npm test')]])
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
    // Each event names why (T207): never the command itself.
    const events = ctx.eventLog.query({ type: 'agent-workers.tool.denied' })
    expect(events.map((e) => e.data!.reason)).toEqual([...metacharacters.map(() => 'metacharacter'), ...empty.map(() => 'empty-word')])
    expect(events.every((e) => e.data!.explanation === DENIAL_REASONS[e.data!.reason as keyof typeof DENIAL_REASONS] && typeof e.decision === 'string' && e.data!.decision === e.decision)).toBe(true)
    expect(JSON.stringify(events.map((e) => e.data))).not.toContain('rm -rf')
  })

  it('names a forbidden command not on the commands list not-listed, and any other forbidden call policy-forbid, with its action class (T207)', async () => {
    const agent = new GatedAgent([[bash('npm test'), bash('npm run build'), { tool: 'WebFetch', input: { url: 'https://example.com' } }]])
    const { ctx, run } = await boot(agent, policy({ 'command': { mode: 'forbid' }, 'external-send': { mode: 'forbid' } }))
    expect((await run()).status).toBe('completed')
    expect(agent.verdicts[0]!.map((v) => v.decision)).toEqual(['deny', 'deny', 'deny'])
    const events = ctx.eventLog.query({ type: 'agent-workers.tool.denied' })
    expect(events.map((e) => [e.data!.reason, e.data!.actionClass])).toEqual([['not-listed', 'command'], ['policy-forbid', 'command'], ['policy-forbid', 'external-send']])
    for (const [i, e] of events.entries()) {
      expect(decisionOf(ctx, (agent.verdicts[0]![i] as { reason: string }).reason)).toMatchObject({ decisionType: 'autonomy', outcome: { option: 'forbid' } })
      expect(e.decision).toBe(e.data!.decision)
    }
  })

  it('lets a command on the commands list run as the workspace write it is judged as', async () => {
    const agent = new GatedAgent([[bash('npm run build')]])
    const { run } = await boot(agent)
    expect((await run()).status).toBe('completed')
    expect(agent.verdicts[0]).toEqual([{ decision: 'allow' }])
  })

  it('tells a Worker that may run commands which calls run unasked, the policy\'s commands list word for word, so it asks less (T199)', async () => {
    const agent = new GatedAgent([[]])
    const { run } = await boot(agent, { ...policy(), commands: ['npm run build', 'git status --short'] })
    expect((await run()).status).toBe('completed')
    const sent = agent.runs[0]!.prompt
    // One Tools section (T199, extended by T207): the workspace, then what runs unasked.
    expect(sent.startsWith(`step 1\n\nTools (your tool gate and the autonomy policy now):\n- Workspace: ${WORKSPACE}. A tool's path outside it is denied, and so is a write in its .git.\nTool calls that run without asking the operator:\n`)).toBe(true)
    expect(sent).toContain('- Bash, exactly these commands, word for word (the autonomy policy\'s commands list; no other word, option, or argument):\n  - npm run build\n  - git status --short\n')
    expect(sent).toContain(`- Reading tools (Read, Glob, Grep, LS) on paths inside your workspace ${WORKSPACE}.`)
    // This runtime enforces no clean shells, so its gate takes no Bash command for a read, and the section says so.
    expect(sent).not.toContain('Bash read-only inspection')
    expect(sent).toContain('Under this runtime no Bash command is a read')
    expect(sent).toContain('a word with a shell metacharacter (; & | $ < > ( ) quotes * ? ~ and the like) or an empty word (a doubled, leading, or trailing space) is denied')
    expect(sent).toContain('so a relative path makes no command a read')
    expect(sent).toContain('Any other command waits for the operator; unanswered in time, or rejected, it is denied and you go on without it')
    expect(sent).toContain('An approval resumes this step')
    expect(sent.length - 'step 1\n\n'.length).toBeLessThanOrEqual(TOOLS_NOTE_MAX)
    // Nor is it told of a workspace reads server its runtime does not give it.
    expect(sent).not.toContain('workspace server')
  })

  it('names Bash inspection among the unasked calls only where shells are clean, and the workspace server\'s tools where the runtime gives them, telling the Worker to read with them, never with a shell (T198, T200b)', () => {
    const effective = [{ actionClass: 'read' as const, mode: 'auto' }]
    expect(unaskedNote({ policies: [], effective }, '/ws')).not.toContain('Bash read-only inspection')
    expect(unaskedNote({ policies: [], effective }, '/ws', { shellReads: true })).toContain('- Bash read-only inspection, every path absolute and inside /ws')
    const reads = unaskedNote({ policies: [], effective }, '/ws', { workspaceReads: true })
    expect(reads).toContain('- Reading tools (the workspace server\'s read_file, list_dir, search, git_log, git_show, git_diff, and git_status) on paths inside your workspace /ws.')
    expect(reads).toContain('Read its git history the same way, never with git in a shell: git_log (count, skip, commit, paths)')
    expect(reads).toContain('- Read your workspace with the workspace server\'s tools, never with a shell: read_file (path; startLine and endLine for a range)')
    expect(reads).toContain('read with the workspace server\'s tools, never with a shell.')
    // A read-only Worker is told the same, whatever the policy runs unasked.
    expect(unaskedNote({ policies: [], effective: [] }, '/ws', { workspaceReads: true, sandbox: 'read-only' })).toContain('- Read your workspace with the workspace server\'s tools, never with a shell')
    expect(unaskedNote({ policies: [], effective }, '/ws')).not.toContain('workspace server')
  })

  it('tells a read-only Worker its Tools section too, fit to its sandbox: the workspace, its reads, the refusals, and whether an approval resumes the step, with no writing tool, and the exact commands the gate runs unasked whatever the sandbox (T207)', async () => {
    const agent = new GatedAgent([[]])
    const { run } = await boot(agent, { ...policy(), commands: ['npm run build'] }, false, 'read-only')
    expect((await run()).status).toBe('completed')
    const sent = agent.runs[0]!.prompt
    expect(sent.startsWith(`step 1\n\nTools (your tool gate and the autonomy policy now):\n- Workspace: ${WORKSPACE}.`)).toBe(true)
    expect(sent).toContain('- Your sandbox is read-only: no tool call writes a file')
    expect(sent).toContain(`- Reading tools (Read, Glob, Grep, LS) on paths inside your workspace ${WORKSPACE}.`)
    expect(sent).toContain('a word with a shell metacharacter')
    expect(sent).toContain('so a relative path makes no command a read')
    expect(sent).toContain('An approval resumes this step')
    expect(sent).not.toContain('Writing tools')
    expect(sent).toContain('npm run build')
    expect(sent.length - 'step 1\n\n'.length).toBeLessThanOrEqual(TOOLS_NOTE_MAX)
    // Pure: a read-only sandbox where commands run unasked says the sandbox still holds them.
    const all = [{ actionClass: 'read' as const, mode: 'auto' }, { actionClass: 'workspace-write' as const, mode: 'auto' }, { actionClass: 'command' as const, mode: 'auto' }]
    const readOnly = unaskedNote({ policies: [{ commands: ['npm test'] }], effective: all }, '/ws', { sandbox: 'read-only', shellReads: true })
    expect(readOnly).toContain('- Any other Bash command, under your read-only sandbox (it changes no file).')
    expect(readOnly).toContain('- Bash read-only inspection, every path absolute and inside /ws')
    expect(readOnly).not.toContain('Writing tools')
    expect(unaskedNote({ policies: [], effective: all }, '/ws')).not.toContain('Your sandbox is read-only')
    // A read-only Worker (a reviewer) is told the exact commands too: the gate runs a listed one unasked whatever the sandbox.
    const listed = [{ actionClass: 'read' as const, mode: 'auto' }, { actionClass: 'workspace-write' as const, mode: 'auto' }, { actionClass: 'command' as const, mode: 'ask' }]
    const reviewer = unaskedNote({ policies: [{ commands: ['git diff --stat'] }], effective: listed }, '/ws', { sandbox: 'read-only' })
    expect(reviewer).toContain('  - git diff --stat')
    expect(reviewer).not.toContain('Writing tools')
  })

  it('tells a run with no session that a call that would ask is denied at once, since no approval could resume it (T207)', async () => {
    const agent = new GatedAgent([[]])
    const { run } = await boot(agent)
    expect((await run(null)).status).toBe('completed')
    const sent = agent.runs[0]!.prompt
    expect(sent).toContain('Any other command is denied at once: this run has no session an approval could resume.')
    expect(sent).not.toContain('An approval resumes this step')
  })

  it('names in that section only what the policy lets run unasked: no commands list when commands are forbidden, every command when they run, none when nothing does; Bash reads only under clean shells; bounded', () => {
    const effective = (modes: Record<string, string>) => Object.entries(modes).map(([actionClass, mode]) => ({ actionClass: actionClass as AutonomyPolicy['rules'][number]['actionClass'], mode }))
    const policies = [{ commands: ['npm test'] }]
    const forbidden = unaskedNote({ policies, effective: effective({ 'read': 'auto', 'workspace-write': 'auto', 'command': 'forbid' }) }, '/ws')
    expect(forbidden).not.toContain('npm test')
    expect(forbidden).toContain('Any other command is denied')
    // Commands forbidden, reads and writes asked: the section still says whether an approval resumes the step.
    const forbidAsk = effective({ 'read': 'ask', 'workspace-write': 'ask', 'command': 'forbid' })
    const forbidResumes = unaskedNote({ policies, effective: forbidAsk }, '/ws')
    expect(forbidResumes).toContain('Any other command is denied. A call the policy asks the operator about waits for the operator;')
    expect(forbidResumes).toContain('An approval resumes this step')
    const forbidNoSession = unaskedNote({ policies, effective: forbidAsk }, '/ws', { resumes: false })
    expect(forbidNoSession).toContain('Any other command is denied. A call the policy asks the operator about is denied at once: this run has no session an approval could resume.')
    expect(forbidNoSession).not.toContain('An approval resumes this step')
    const asked = unaskedNote({ policies, effective: effective({ 'read': 'auto', 'workspace-write': 'ask', 'command': 'ask' }) }, '/ws')
    // A listed command runs as a workspace write: when writes ask, so does it.
    expect(asked).not.toContain('npm test')
    expect(asked).not.toContain('Writing tools')
    expect(unaskedNote({ policies, effective: effective({ 'read': 'notify', 'workspace-write': 'auto', 'command': 'auto' }) }, '/ws')).toContain('- Any other Bash command.')
    // Nothing runs unasked: the section still names the workspace and the gate's refusals.
    const nothing = unaskedNote({ policies, effective: effective({ 'read': 'ask', 'workspace-write': 'ask', 'command': 'ask' }) }, '/ws')
    expect(nothing).toContain('Tool calls that run without asking the operator:\n- none now: every call asks the operator or is denied.')
    expect(nothing).toContain('- Workspace: /ws.')
    expect(nothing).toContain('shell metacharacter')
    expect(nothing).not.toContain('Reading tools')
    // A Bash inspection command is a read only where the runtime enforces clean shells (T198), as the gate judges it.
    const reads = effective({ 'read': 'auto', 'workspace-write': 'auto', 'command': 'ask' })
    expect(unaskedNote({ policies, effective: reads }, '/ws', { shellReads: true })).toContain('- Bash read-only inspection, every path absolute and inside /ws (a relative path, or a form that names none, asks): cat, head, tail')
    expect(unaskedNote({ policies, effective: reads }, '/ws', { shellReads: true })).not.toContain('Under this runtime no Bash command is a read')
    expect(unaskedNote({ policies, effective: reads }, '/ws')).not.toContain('Bash read-only inspection')
    const many = unaskedNote({ policies: [{ commands: Array.from({ length: 60 }, (_, i) => `make t${i}`) }], effective: effective({ 'workspace-write': 'auto', 'command': 'ask' }) }, '/ws')
    expect(many).toContain('  - make t49\n  - and 10 more')
    expect(many).not.toContain('make t50')
    // Bounded whatever the list holds: long lines are cut first, the rest counted, and a long workspace path is cut.
    const long = Array.from({ length: 50 }, (_, i) => `make ${String(i).padStart(2, '0')}${'x'.repeat(190)}`)
    const bounded = unaskedNote({ policies: [{ commands: long }], effective: effective({ 'read': 'auto', 'workspace-write': 'auto', 'command': 'ask' }) }, `/${'w'.repeat(1000)}`, { shellReads: true })
    expect(bounded.length).toBeLessThanOrEqual(TOOLS_NOTE_MAX)
    expect(bounded).toContain(`  - ${long[0]}`)
    expect(bounded).toMatch(/\n {2}- and \d+ more\n/)
    expect(bounded).toContain('An approval resumes this step')
    expect(bounded).not.toContain('w'.repeat(301))
  })

  it('says what happens to other commands by the command mode, and that a listed command is judged as a workspace write, for every combination (T209)', () => {
    const effective = (modes: Record<string, string>) => Object.entries(modes).map(([actionClass, mode]) => ({ actionClass: actionClass as AutonomyPolicy['rules'][number]['actionClass'], mode }))
    const MODES = ['auto', 'notify', 'ask', 'forbid'] as const
    const unasked = (m: string): boolean => m === 'auto' || m === 'notify'
    const LISTED_RULE = 'A command on the autonomy policy\'s commands list is judged as a workspace write, not as a command'
    for (const command of MODES) {
      for (const write of MODES) {
        for (const commands of [['npm test'], undefined]) {
          const label = `command ${command}, workspace-write ${write}, ${commands ? 'a' : 'no'} commands list`
          const note = unaskedNote({ policies: [{ commands }], effective: effective({ 'read': 'auto', 'workspace-write': write, 'command': command }) }, '/ws')!
          // What any other command does, by the command mode.
          if (unasked(command)) {
            expect(note, label).toContain('- Any other Bash command')
            expect(note, label).not.toContain('Any other command waits for the operator')
            expect(note, label).not.toContain('Any other command is denied')
          } else {
            expect(note, label).not.toContain('- Any other Bash command')
            expect(note, label).toContain(command === 'forbid' ? 'Any other command is denied' : 'Any other command waits for the operator; unanswered in time, or rejected, it is denied and you go on without it')
          }
          // A listed command is judged as a workspace write, unless commands are forbidden: said, with what that means now.
          const rule = commands && command !== 'forbid'
          if (!rule) {
            expect(note, label).not.toContain(LISTED_RULE)
            expect(note, label).not.toContain('npm test')
            continue
          }
          expect(note, label).toContain(LISTED_RULE)
          expect(note, label).toContain(unasked(write) ? 'workspace writes run unasked, so it runs unasked too'
            : write === 'forbid' ? 'workspace writes are denied, so it is denied too, even where other commands run unasked'
            : 'workspace writes wait for the operator, so it waits too, even where other commands run unasked')
          // Named where it differs from other commands: run unasked while they wait, or the exception while they run.
          if (unasked(write) && !unasked(command)) expect(note, label).toContain('word for word (the autonomy policy\'s commands list; no other word, option, or argument):\n  - npm test')
          else if (!unasked(write) && unasked(command)) expect(note, label).toContain('- Any other Bash command, except one on the autonomy policy\'s commands list:\n  - npm test')
          else if (unasked(command)) expect(note, label).toContain('- Any other Bash command.\n')
          else expect(note, label).not.toContain('npm test')
        }
      }
    }
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

  it('records what a run that stopped at a deferred call reported, as a lower bound, and keeps it unknown, naming the request it waits on (INV-2)', async () => {
    const deferredMetering: RunMetering = { turns: 1, usage: { inputTokens: 20, outputTokens: 8 }, partial: 'gated stopped at a deferred tool call before its result' }
    const { ctx, run } = await boot(new GatedAgent([[bash('npm test')]], { deferredMetering }), policy(), true)
    const done = await run()
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error' } })
    const [request] = await ctx.approvals.list()
    expect((await ctx.resources.usage({ runId: done.runId })).records).toMatchObject([{ outcome: 'failed', usage: deferredMetering.usage, turns: 1 }])
    const facts = ctx.eventLog.query({ type: 'usage.unknown' }).map((e) => e.data!)
    expect(facts).toEqual([expect.objectContaining({
      schema: 'usage-unknown@1.1', runId: done.runId, kind: 'not-reported', outcome: 'failed', partial: expect.stringMatching(/^sha256:/),
      reason: `it stopped at a Bash call that waits for approval request ${request!.requestId}; the ledger counted what its runtime reported while it ran (20 input and 8 output tokens, 1 turn), a lower bound: gated stopped at a deferred tool call before its result`,
    })])
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
    // Each denial names why, the class, and the request (T207).
    expect(ctx.eventLog.query({ type: 'agent-workers.tool.denied' }).map((e) => e.data)).toEqual([
      expect.objectContaining({ reason: 'request-rejected', explanation: DENIAL_REASONS['request-rejected'], actionClass: 'command', requestId: rejected!.requestId }),
      expect.objectContaining({ reason: 'request-expired', explanation: DENIAL_REASONS['request-expired'], actionClass: 'command', requestId: expiring!.requestId }),
    ])
  })

  // PROP-0013: no automated input to a session blocked on an approval. The state is derived when read.
  it('holds a session whose latest run stopped on a deferred call while its request is open, and frees it once the request is answered (PROP-0013, REQ-SES-7)', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm run lint')], [{ tool: 'Read', input: { file_path: 'a' } }]])
    const { ctx, run } = await boot(agent)
    expect(await ctx.workers.held!('ses_dev'), 'a session this source does not hold yet').toBeUndefined()
    const first = await run()
    const [rejected] = await ctx.approvals.list()
    expect(ctx.store.db.prepare('SELECT deferred_request FROM agent_runs WHERE run_id = ?').get(first.runId)).toEqual({ deferred_request: rejected!.requestId })
    expect(await ctx.workers.held!('ses_dev')).toBe(`its latest run ${first.runId} stopped on a tool call that waits for approval request ${rejected!.requestId}, still open: the session takes no input but that request's resolution`)
    expect(await ctx.workers.held!('ses_other'), 'another session').toBeUndefined()
    await ctx.approvals.decide([{ requestId: rejected!.requestId, subject: rejected!.subject, verdict: 'rejected' }])
    expect(await ctx.workers.held!('ses_dev'), 'rejected: free again').toBeUndefined()
    await run()
    const [open] = await ctx.approvals.list({ states: ['open'] })
    expect(await ctx.workers.held!('ses_dev')).toContain(`approval request ${open!.requestId}, still open`)
    await ctx.approvals.decide([{ requestId: open!.requestId, subject: open!.subject, verdict: 'approved' }])
    expect(await ctx.workers.held!('ses_dev'), 'approved: its resolution is the input, and the session is free').toBeUndefined()
    // A run that finished frees it too; a queue that cannot be read never shows a blocked one free.
    expect((await run()).status).toBe('completed')
    expect(await ctx.workers.held!('ses_dev')).toBeUndefined()
  })

  it('cannot show a session free while the queue cannot tell whether its request is still open, nor while its latest run has not finished (PROP-0013, INV-2)', async () => {
    const agent = new GatedAgent([[bash('npm test')]])
    const { ctx, run } = await boot(agent)
    const first = await run()
    const [request] = await ctx.approvals.list()
    const get = vi.spyOn(ctx.get('approvals')!, 'get').mockRejectedValueOnce(new Error('database is locked'))
    expect(await ctx.workers.held!('ses_dev')).toBe(`its latest run ${first.runId} stopped on a tool call that waits for approval request ${request!.requestId}, which cannot be read now (database is locked)`)
    get.mockResolvedValueOnce(undefined)
    expect(await ctx.workers.held!('ses_dev')).toContain('which the approval queue does not hold')
    get.mockRestore()
    // A run of the session not finished yet holds it, whatever came before.
    ctx.store.db.prepare("UPDATE agent_runs SET status = 'running' WHERE run_id = ?").run(first.runId)
    expect(await ctx.workers.held!('ses_dev')).toBe(`its latest run ${first.runId} has not finished (running), and one native session is driven by one run at a time`)
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
      expect(classify({ tool, input: { ...input, extra: 1 } }, ws), tool).toEqual({ refused: `${tool} carries "extra", a field the gate does not classify`, reason: 'unsupported-field' })
      const [field, value] = wrong[tool]!
      expect(classify({ tool, input: { ...input, [field]: value } }, ws), tool).toMatchObject({ refused: expect.stringContaining(`${tool} carries ${JSON.stringify(field)} that is not a `), reason: 'unsupported-field' })
    }
    expect(classify({ tool: 'Bash', input: { command: 'npm test', dangerouslyDisableSandbox: true } }, ws)).toEqual({ refused: 'Bash carries "dangerouslyDisableSandbox", a field the gate does not classify', reason: 'unsupported-field' })
    expect(classify({ tool: 'Read', input: JSON.parse('{"file_path": "src/a.ts", "__proto__": {"x": 1}}') as Record<string, unknown> }, ws)).toHaveProperty('refused')
  })

  it('splits a command on single spaces, exactly as the policy matches it, and refuses an empty word, a shell metacharacter, and an input field it does not know', () => {
    expect(classify(bash('npm run build'), ws)).toMatchObject({ class: 'command', command: ['npm', 'run', 'build'] })
    for (const command of ['npm  test', ' npm test', 'npm test ']) {
      expect(classify(bash(command), ws), command).toMatchObject({ refused: expect.any(String), reason: 'empty-word' })
    }
    for (const command of ['echo safe;id', 'echo $(id)', 'echo a\nid', 'ls ~', 'echo `id`']) {
      expect(classify(bash(command), ws), command).toMatchObject({ refused: expect.any(String), reason: 'metacharacter' })
    }
    expect(classify({ tool: 'Bash', input: { command: 'npm test', timeout: 1000, description: 'run', run_in_background: false } }, ws)).toMatchObject({ command: ['npm', 'test'] })
    expect(classify({ tool: 'Bash', input: { command: 'npm test', dangerouslyDisableSandbox: true } }, ws)).toHaveProperty('refused')
    expect(classify({ tool: 'Bash', input: { command: '' } }, ws)).toMatchObject({ refused: expect.any(String), reason: 'invalid-input' })
  })

  it('gives each refusal its stable reason code (T207)', () => {
    const patchOf = (...lines: string[]) => ({ tool: 'apply_patch', input: { command: ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n') } })
    const cases: Array<[ToolCall, string]> = [
      [{ tool: 'Read', input: 'not an object' as never }, 'invalid-input'],
      [{ tool: 'run_command', input: { CommandLine: 'ls' } }, 'unclassified-tool'],
      [{ tool: 'Read', input: { file_path: 'a', extra: 1 } }, 'unsupported-field'],
      [{ tool: 'Read', input: { file_path: '/etc/passwd' } }, 'outside-workspace'],
      [{ tool: 'Read', input: {} }, 'invalid-input'],
      [{ tool: 'Glob', input: { pattern: '/etc/**' } }, 'outside-workspace'],
      [{ tool: 'Write', input: { file_path: '/etc/x', content: 'x' } }, 'outside-workspace'],
      [{ tool: 'Write', input: { file_path: '.git/config', content: 'x' } }, 'git-data'],
      [{ tool: 'apply_patch', input: { command: 'not a patch' } }, 'invalid-patch'],
      [patchOf('*** Add File: /etc/x', '+x'), 'outside-workspace'],
      [{ tool: 'WebFetch', input: { url: '' } }, 'invalid-input'],
      [bash('a  b'), 'empty-word'],
      [bash('a;b'), 'metacharacter'],
    ]
    for (const [call, reason] of cases) expect(classify(call, ws), JSON.stringify(call)).toMatchObject({ refused: expect.any(String), reason })
  })

  it('classifies a probe that can do nothing as read: echo with any plain words, pwd with no argument, true, false (T187)', () => {
    for (const command of ['echo', 'echo noop', 'echo -n x', 'echo -e a', 'echo -E -n', 'echo --help', 'echo #x', 'echo a=b /etc/passwd ../x', 'pwd', 'true', 'false']) {
      expect(classify(bash(command), ws, CLEAN), command).toEqual({ class: 'read', summary: command, consequences: expect.stringContaining('reads and changes nothing') })
    }
    // A metacharacter is still refused, an empty word too.
    for (const command of ['echo $HOME', 'echo `id`', 'echo a;id', 'echo a|id', 'echo >x', 'echo *', 'echo ~', 'echo "a"', 'echo a\\nb', 'echo  a', 'echo ', 'true;id', 'pwd&&id']) {
      expect(classify(bash(command), ws, CLEAN), command).toHaveProperty('refused')
    }
    // Anything else of these programs stays a command, by its exact argv.
    for (const command of ['pwd -P', 'pwd -L', 'pwd /tmp', 'true x', 'false --help', '/bin/echo x', 'printf x', 'Echo x', 'sh -c true']) {
      expect(classify(bash(command), ws, CLEAN), command).toMatchObject({ class: 'command', command: command.split(' ') })
    }
  })

  it('takes no shell command for a read where the runtime does not enforce shells that read no startup code: a function named echo or cat could run instead (T198)', () => {
    const a = join(ws, 'src/a.ts')
    for (const command of ['echo', 'echo noop', 'pwd', 'true', 'false', `cat ${a}`, `head -n 20 ${a}`, `ls -la ${ws}`, `sed -n 1,40p ${a}`, `rg -n foo ${ws}`, `grep -r foo ${ws}`, `find ${ws} -name a.ts`]) {
      // Enforced clean: a read. Not enforced (absent, or false): the exact command, which the policy judges by its argv.
      expect(classify(bash(command), ws, CLEAN), command).toMatchObject({ class: 'read' })
      for (const options of [undefined, {}, { shellReads: false }]) {
        expect(classify(bash(command), ws, options), command).toMatchObject({ class: 'command', command: command.split(' ') })
      }
    }
    // The file tools read as before: the program they name is the runtime's own, no shell between.
    expect(classify({ tool: 'Read', input: { file_path: a } }, ws)).toMatchObject({ class: 'read' })
  })

  describe('read-only inspection commands', () => {
    // A workspace that holds its own .git.
    const repo = join(tree, 'git-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'a.ts'), 'x')
    writeFileSync(join(repo, '.git', 'config'), '')
    symlinkSync(join(repo, '.git'), join(repo, 'meta'))
    // Each under a runtime that enforces clean shells (T198): only there could any of them be a read.
    const read = (command: string, workspace = ws) => expect(classify(bash(command), workspace, CLEAN), command).toEqual({ class: 'read', summary: command, consequences: expect.stringContaining('Reads inside the run\'s workspace') })
    const asks = (command: string, workspace = ws) => expect(classify(bash(command), workspace, CLEAN), command).toMatchObject({ class: 'command', command: command.split(' ') })
    const notRead = (command: string, workspace = ws) => {
      const action = classify(bash(command), workspace, CLEAN)
      expect('refused' in action ? 'refused' : action.class, command).not.toBe('read')
    }

    it('classifies each program\'s allowed forms on absolute paths inside the workspace as read, with no argv for the commands list', () => {
      const a = join(ws, 'src/a.ts')
      const src = join(ws, 'src')
      for (const command of [
        `cat ${a}`, `cat -n ${a}`, `cat ${join(ws, 'inner/a.ts')}`, `cat ${a} ${join(ws, 'src/new.ts')}`,
        `head -n 20 ${a}`, `head -20 ${a}`, `head -c 100 ${a}`, `tail -n +5 ${a}`, `tail -n 3 ${a}`, `tail -50 ${a}`,
        `wc -l ${a}`, `wc -c -w ${a}`, `ls ${ws}`, `ls -la ${ws}`, `ls -la ${src}`, `ls -R ${src}`, `ls -1 ${ws}/`, `stat ${a}`, `file ${a}`, `file -i ${a}`,
        `sed -n 1,40p ${a}`, `sed -n 7p ${a}`,
        `rg -n classify ${src}`, `rg -i -F -w -c foo ${a}`, `rg -A 2 -B 1 -C 3 --line-number foo ${src}`, `rg -g src/a.ts --glob !dist -t ts foo ${ws}`, `rg -l foo ${ws}`,
        `grep foo ${a}`, `grep -r -n foo ${src}`, `grep -r -i -F -w -c foo ${ws}`, `grep -l -A 2 -B 2 -C 1 --line-number foo ${a}`,
        `find ${src}`, `find ${ws} -name a.ts -type f`, `find ${src} ${join(ws, 'inner')} -iname A.TS -path src/a.ts -maxdepth 2 -mindepth 1`,
      ]) {
        read(command)
      }
    })

    it('leaves a relative path, a form that names no path, and git a command: the gate does not see the directory a command runs in (Codex\'s exec_command workdir)', () => {
      for (const command of [
        'cat src/a.ts', 'cat .ssh/id_rsa', 'cat src/new.ts', 'head -n 5 src/a.ts', 'tail src/a.ts', 'wc -l src/a.ts', 'stat src/a.ts', 'file src/a.ts', 'sed -n 1p src/a.ts',
        'ls', 'ls -la', 'ls -R', 'ls .', 'ls src', 'rg -n token', 'rg foo src', 'rg foo .', 'grep -r foo', 'grep foo src/a.ts', 'find', 'find .', 'find src', 'find -name a.ts',
        `cat ${join(ws, 'src')}/../src/a.ts`,
      ]) {
        notRead(command)
      }
      for (const command of [
        'git status', 'git status --short', 'git diff', 'git log --oneline -n 5', 'git show HEAD:src/a.ts', 'git ls-files src', 'git grep -n foo', 'git blame src/a.ts', 'git rev-parse HEAD',
        `git diff -- ${join(repo, 'src/a.ts')}`, `git log ${repo}`,
      ]) {
        asks(command, repo)
        asks(command)
      }
    })

    it('leaves every other form of these programs a command, which the policy asks about: an option off the list, an action, a missing path or value, a cluster or an abbreviation', () => {
      const a = join(ws, 'src/a.ts')
      const src = join(ws, 'src')
      for (const command of [
        'cat', `cat -v ${a}`, `cat -- ${a}`, `cat ${a} #x`, `cat file:${a}`, `head ${a} -n`, `head -n ${a}`, `head -n -5 ${a}`, `tail -f ${a}`, `tail -F ${a}`,
        `wc --files0-from ${a}`, `wc -L ${a}`, `ls -L ${join(ws, 'link-dir')}`, `ls --color ${ws}`, `stat -L ${a}`, `stat -c %n ${a}`, `file -m ${a} ${a}`, `file -L ${a}`,
        'sed -n 1p', `sed 1p ${a}`, `sed -n 1,2p ${a} ${a}`, `sed -i 1d ${a}`, `sed -n 1w ${a}`, `sed -n 1,2pw ${a}`, `sed -n -e 1p ${a}`, `sed -n /x/p ${a}`,
        `rg --pre cat foo ${ws}`, `rg --pre-glob x foo ${ws}`, `rg -f ${a} ${ws}`, `rg --files-from ${a} foo ${ws}`, `rg -z foo ${ws}`, `rg --search-zip foo ${ws}`, `rg --follow foo ${ws}`, `rg -L foo ${ws}`, `rg -r x foo ${ws}`,
        `rg -n ${ws}`, `rg -in foo ${ws}`, `rg --line foo ${ws}`, `rg -A x foo ${ws}`, `rg -A -1 foo ${ws}`, `rg -g -x foo ${ws}`, `rg -t t-s foo ${ws}`, `rg --files ${ws}`, `rg -- foo ${ws}`,
        `grep -f ${a} ${src}`, `grep -R foo ${ws}`, `grep -z foo ${src}`, `grep --line foo ${src}`, `grep -rn foo ${ws}`, `grep --include a.ts foo ${src}`, `grep -g a.ts foo ${src}`, `grep -e foo ${src}`,
        `find ${ws} -exec cat`, `find ${ws} -execdir ls`, `find ${ws} -ok ls`, `find ${ws} -okdir ls`, `find ${ws} -delete`, `find ${ws} -fprint out`, `find ${ws} -fprint0 out`, `find ${ws} -fprintf out x`, `find ${ws} -fls out`,
        `find -L ${ws}`, `find -H ${ws}`, `find ${ws} -follow`, `find ${ws} -name`, `find ${ws} -name -delete`, `find ${ws} -type x`, `find ${ws} -maxdepth x`, `find ${ws} -newer ${a}`, `find ${src} ! -name a.ts`, `find ${ws} -print`,
        `less ${a}`, `more ${a}`, `awk 1 ${a}`, `python3 ${a}`, `node ${a}`, `/bin/cat ${a}`, `./cat ${a}`, 'xargs cat', `env cat ${a}`, `nl ${a}`,
        `git -c core.fsmonitor=x status`, `git -C ${repo} status`, `git --git-dir=${repo}/.git log`, 'git push', 'git',
      ]) {
        asks(command)
      }
    })

    it('never reads outside the workspace: an absolute path outside, a climb with .., or a symlink pointing out is refused or stays a command', () => {
      for (const path of ['/etc/passwd', `${ws}/../outside/secret`, join(outside, 'secret'), `${ws}-other/a`, join(ws, 'link-file'), join(ws, 'link-dir/secret'), join(ws, 'src/up/secret'), `${ws}/src/up/../outside/secret`, join(ws, 'dangling'), join(ws, 'loop'), '~/.ssh/id_rsa', '$HOME/x', '../outside/secret']) {
        for (const command of [`cat ${path}`, `head -n 5 ${path}`, `tail ${path}`, `wc -l ${path}`, `ls ${path}`, `stat ${path}`, `file ${path}`, `sed -n 1p ${path}`, `rg foo ${path}`, `grep -r foo ${path}`, `find ${path}`, `find ${ws} ${path} -name a`]) {
          notRead(command)
        }
      }
      for (const dir of [join(ws, 'link-dir'), join(ws, 'src/up'), `${ws}/..`, '/', tree]) {
        for (const command of [`ls ${dir}`, `ls -la ${dir}`, `rg foo ${dir}`, `grep -r foo ${dir}`, `find ${dir}`]) notRead(command)
      }
      // A workspace named through a symlink is its real directory.
      read(`cat ${join(tree, 'repo-link', 'src/a.ts')}`, join(tree, 'repo-link'))
      notRead(`cat ${join(tree, 'repo-link', 'link-file')}`, join(tree, 'repo-link'))
    })

    it('refuses a file tool\'s write into git\'s own data, which git reads its configuration from, as written or through a symlink; other dotfiles are written as before', () => {
      for (const path of ['.git/config', '.git', 'src/.git/config', '.GIT/config', 'meta/config', 'meta/hooks/new', join(repo, '.git', 'config')]) {
        expect(classify(write(path), repo), path).toMatchObject({ refused: expect.stringContaining('git\'s own data') })
        expect(classify(edit(path), repo), path).toMatchObject({ refused: expect.stringContaining('git\'s own data') })
        expect(classify({ tool: 'apply_patch', input: { command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch\n` } }, repo), path).toMatchObject({ refused: expect.stringContaining('git\'s own data') })
        expect(classify({ tool: 'write_file', input: { Path: path.startsWith('/') ? path : join(repo, path), Content: 'x' } }, repo), path).toHaveProperty('refused')
      }
      for (const path of ['.gitignore', '.gitattributes', 'src/.github/workflows/ci.yml', 'src/a.ts']) {
        expect(classify(write(path), repo), path).toMatchObject({ class: 'workspace-write' })
      }
      // Reading it stays a read.
      expect(classify({ tool: 'Read', input: { file_path: '.git/config' } }, repo)).toMatchObject({ class: 'read' })
      read(`cat ${join(repo, '.git/config')}`, repo)
    })
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
      expect(classify(call, ws), call.tool).toEqual({ reason: 'unclassified-tool', refused: `${call.tool} is not a tool the gate classifies` })
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

  it('classifies exactly the workspace reads server\'s three tools as reads inside the workspace, for a run whose runtime gives its agent that server, and refuses any other tool of it (T200b)', () => {
    const served = { workspaceReads: true }
    for (const options of [served, { ...served, shellReads: false }, { ...served, shellReads: true }]) {
      expect(classify({ tool: 'mcp__workspace__read_file', input: { path: 'src/a.ts', startLine: 1, endLine: 2 } }, ws, options)).toMatchObject({ class: 'read', summary: 'mcp__workspace__read_file src/a.ts' })
      expect(classify({ tool: 'mcp__workspace__list_dir', input: {} }, ws, options)).toMatchObject({ class: 'read' })
      expect(classify({ tool: 'mcp__workspace__list_dir', input: { path: '' } }, ws, options)).toMatchObject({ class: 'read' })
      expect(classify({ tool: 'mcp__workspace__search', input: { pattern: 'x', regex: true, ignoreCase: false, path: join(ws, 'src') } }, ws, options)).toMatchObject({ class: 'read' })
    }
    // Outside the workspace, through a symlink out, climbing with "..", or into git's data: refused, the policy never asked.
    mkdirSync(join(ws, '.git'), { recursive: true })
    const reasons: Record<string, string> = {
      '/etc/hostname': 'outside-workspace', [join(outside, 'secret')]: 'outside-workspace', 'link-file': 'outside-workspace', 'link-dir': 'outside-workspace', 'src/up/secret': 'outside-workspace',
      '../outside/secret': 'outside-workspace', 'src/../src/a.ts': 'outside-workspace', '.git/config': 'git-data', '.git': 'git-data',
    }
    for (const [path, reason] of Object.entries(reasons)) {
      expect(classify({ tool: 'mcp__workspace__read_file', input: { path } }, ws, served), path).toMatchObject({ refused: expect.any(String), reason })
      expect(classify({ tool: 'mcp__workspace__search', input: { pattern: 'x', path } }, ws, served), path).toMatchObject({ refused: expect.any(String), reason })
    }
    expect(classify({ tool: 'mcp__workspace__read_file', input: {} }, ws, served)).toMatchObject({ reason: 'invalid-input' })
    // An argument the server does not take, or one of another type.
    expect(classify({ tool: 'mcp__workspace__read_file', input: { path: 'src/a.ts', offset: 1 } }, ws, served)).toMatchObject({ refused: expect.stringContaining('"offset"'), reason: 'unsupported-field' })
    expect(classify({ tool: 'mcp__workspace__search', input: { pattern: 'x', regex: 'yes' } }, ws, served)).toMatchObject({ reason: 'unsupported-field' })
    // Any other tool of that server is refused by name, whatever its input.
    for (const tool of ['mcp__workspace__write_file', 'mcp__workspace__exec', 'mcp__workspace__', 'mcp__workspace__read_file_x']) {
      expect(classify({ tool, input: { path: 'src/a.ts' } }, ws, served), tool).toMatchObject({ refused: expect.stringContaining('is not one of the workspace reads server\'s tools'), reason: 'unclassified-tool' })
    }
  })

  it('classifies exactly the workspace reads server\'s four git views as reads: commits only as hex ids, every path inside the workspace and not git\'s data (T223)', () => {
    const served = { workspaceReads: true }
    const hash = 'a'.repeat(40)
    expect(classify({ tool: 'mcp__workspace__git_log', input: {} }, ws, served)).toMatchObject({ class: 'read', summary: 'mcp__workspace__git_log the workspace' })
    expect(classify({ tool: 'mcp__workspace__git_log', input: { count: 5, skip: 1, commit: 'abc1234', paths: ['src/a.ts', 'src/gone.ts'], fields: ['hash', 'subject'] } }, ws, served))
      .toMatchObject({ class: 'read', summary: 'mcp__workspace__git_log src/a.ts src/gone.ts' })
    expect(classify({ tool: 'mcp__workspace__git_show', input: { commit: hash, stat: true, patch: false, paths: [join(ws, 'src')] } }, ws, served)).toMatchObject({ class: 'read' })
    expect(classify({ tool: 'mcp__workspace__git_diff', input: { from: hash, to: 'ABCDEF12', stat: true } }, ws, served)).toMatchObject({ class: 'read' })
    expect(classify({ tool: 'mcp__workspace__git_diff', input: { cached: true } }, ws, served)).toMatchObject({ class: 'read' })
    expect(classify({ tool: 'mcp__workspace__git_status', input: { paths: ['src'] } }, ws, served)).toMatchObject({ class: 'read' })
    // A commit that is not a hex id: refused, whichever field names it.
    for (const commit of ['HEAD', 'main', 'HEAD~1', `${hash}^{tree}`, '--output=/tmp/x', 'abc', 'g1234', '']) {
      expect(classify({ tool: 'mcp__workspace__git_show', input: { commit } }, ws, served), commit).toMatchObject({ refused: expect.stringContaining('not a commit\'s hex id'), reason: 'invalid-input' })
      expect(classify({ tool: 'mcp__workspace__git_log', input: { commit } }, ws, served), commit).toMatchObject({ reason: 'invalid-input' })
      expect(classify({ tool: 'mcp__workspace__git_diff', input: { from: hash, to: commit } }, ws, served), commit).toMatchObject({ reason: 'invalid-input' })
    }
    // A path outside the workspace, through a symlink out, climbing, into git's data, or empty: refused.
    mkdirSync(join(ws, '.git'), { recursive: true })
    const reasons: Record<string, string> = {
      '/etc/hostname': 'outside-workspace', 'link-dir': 'outside-workspace', 'src/up/secret': 'outside-workspace', '../outside/secret': 'outside-workspace',
      'src/../src/a.ts': 'outside-workspace', '.git/config': 'git-data', '.git': 'git-data', '': 'invalid-input',
    }
    for (const [path, reason] of Object.entries(reasons)) {
      for (const tool of ['mcp__workspace__git_log', 'mcp__workspace__git_diff', 'mcp__workspace__git_status']) {
        expect(classify({ tool, input: { paths: ['src', path] } }, ws, served), `${tool} ${path}`).toMatchObject({ refused: expect.any(String), reason })
      }
    }
    // Fields the server does not take, or of another type.
    expect(classify({ tool: 'mcp__workspace__git_log', input: { revision: 'HEAD' } }, ws, served)).toMatchObject({ reason: 'unsupported-field' })
    expect(classify({ tool: 'mcp__workspace__git_log', input: { paths: 'src' } }, ws, served)).toMatchObject({ reason: 'unsupported-field' })
    expect(classify({ tool: 'mcp__workspace__git_show', input: { commit: 1234 } }, ws, served)).toMatchObject({ reason: 'unsupported-field' })
    // Only the four: no other git tool of that server.
    for (const tool of ['mcp__workspace__git', 'mcp__workspace__git_checkout', 'mcp__workspace__git_blame']) {
      expect(classify({ tool, input: {} }, ws, served), tool).toMatchObject({ reason: 'unclassified-tool' })
    }
    // Without the server's evidence, refused like the other tools of that name.
    expect(classify({ tool: 'mcp__workspace__git_status', input: {} }, ws, {})).toMatchObject({ refused: expect.stringContaining('gives its agent no workspace reads server'), reason: 'unclassified-tool' })
  })

  it('takes the workspace reads server\'s tools for reads only where the runtime reports it gives its agent that server: otherwise any tool of that name is refused (T200b)', () => {
    for (const options of [{}, { workspaceReads: false }, { shellReads: true }, { shellReads: true, workspaceReads: false }]) {
      for (const call of [
        { tool: 'mcp__workspace__read_file', input: { path: 'src/a.ts' } }, { tool: 'mcp__workspace__list_dir', input: {} }, { tool: 'mcp__workspace__search', input: { pattern: 'x' } },
        { tool: 'mcp__workspace__write_file', input: { path: 'src/a.ts' } }, { tool: 'mcp__workspace__read_file', input: 'a' },
      ]) {
        expect(classify(call, ws, options), `${call.tool} ${JSON.stringify(options)}`).toMatchObject({ refused: expect.stringContaining('gives its agent no workspace reads server'), reason: 'unclassified-tool' })
      }
    }
  })

  it('refuses a shell inspection command at once, naming the reading tool to use, where the run\'s agent has it: Claude Code\'s own, or the workspace reads server\'s; under none it stays a command (T222)', () => {
    const a = join(ws, 'src/a.ts')
    // Each inspection form, by its first word whatever its other words (relative paths and all), and the tool each runtime kind names for it.
    const forms: Array<[string, string, string]> = [
      [`cat ${a}`, 'Read', 'read_file'], ['cat src/a.ts', 'Read', 'read_file'], [`head -n 5 ${a}`, 'Read', 'read_file'], ['tail -20 src/a.ts', 'Read', 'read_file'],
      [`sed -n 1,5p ${a}`, 'Read', 'read_file'], ['wc -l src/a.ts', 'Read', 'read_file'],
      [`grep -n needle ${ws}`, 'Grep', 'search'], ['grep -rn needle .', 'Grep', 'search'], ['rg needle', 'Grep', 'search'], [`rg -i needle ${ws}`, 'Grep', 'search'],
      ['ls', 'Glob', 'list_dir'], [`ls -la ${ws}`, 'Glob', 'list_dir'], ['find . -name a.ts', 'Glob', 'list_dir'], [`find ${ws} -type f`, 'Glob', 'list_dir'],
    ]
    const kinds = { claude: ['Read', 'Grep', 'Glob'], codex: ['read_file', 'list_dir', 'search'] }
    for (const [command, own, server] of forms) {
      for (const [kind, readTools] of Object.entries(kinds)) {
        const tool = kind === 'claude' ? own : server
        for (const options of [{ readTools }, { readTools, workspaceReads: kind === 'codex' }]) {
          const refused = classify(bash(command), ws, options)
          expect(refused, `${command} under ${kind}`).toEqual({ refused: expect.stringContaining(`you have ${tool} for it`), reason: 'use-read-tool' })
          expect((refused as { refused: string }).refused, `${command} under ${kind}`).toContain(`use ${tool} instead`)
        }
      }
      // Both kinds' tools at once: each is named.
      expect(classify(bash(command), ws, { readTools: [...kinds.claude, ...kinds.codex] })).toMatchObject({ refused: expect.stringContaining(`you have ${own} or ${server} for it`), reason: 'use-read-tool' })
      // No reading tools: the exact command, as before.
      for (const options of [undefined, {}, { readTools: [] }, { workspaceReads: false }]) {
        expect(classify(bash(command), ws, options), `${command} under none`).toMatchObject({ class: 'command', command: command.split(' ') })
      }
    }
    // Only the tool the agent has counts: a Claude Code Worker listing Read alone has no Grep, so its grep stays a command.
    expect(classify(bash('grep needle src'), ws, { readTools: ['Read'] })).toMatchObject({ class: 'command' })
    expect(classify(bash('cat src/a.ts'), ws, { readTools: ['Read'] })).toMatchObject({ reason: 'use-read-tool' })
    // A form that writes is no inspection, and neither is another program: each stays a command.
    // A sed script that writes a file (w), runs a command (e), or comes from -e or -f is no read-only print either.
    for (const command of ['sed -i s/a/b/ src/a.ts', 'sed -n -i 1p src/a.ts', 'sed s/a/b/ src/a.ts', 'sed -n -e woutput.txt src/a.ts', 'sed -n woutput.txt src/a.ts', 'sed -n 1woutput.txt src/a.ts', 'sed -n 1,2pw src/a.ts', 'sed -n 1e src/a.ts', 'sed -n -f script.sed src/a.ts', 'sed -n 1p -f script.sed src/a.ts', 'sed -n /x/p src/a.ts', 'sed -n 1p', 'find . -delete', `find ${ws} -name a.ts -exec rm`, 'npm test', `stat ${a}`, 'git status']) {
      expect(classify(bash(command), ws, { readTools: kinds.claude }), command).toMatchObject({ class: 'command' })
    }
    // A metacharacter or an empty word is still refused for that first.
    expect(classify(bash('cat src/a.ts | head'), ws, { readTools: kinds.claude })).toMatchObject({ reason: 'metacharacter' })
    expect(classify(bash('cat  src/a.ts'), ws, { readTools: kinds.claude })).toMatchObject({ reason: 'empty-word' })
    // Where the runtime enforces clean shells, an inspection inside the workspace is still a read that runs unasked; any other is refused.
    expect(classify(bash(`cat ${a}`), ws, { ...CLEAN, readTools: kinds.claude })).toMatchObject({ class: 'read' })
    expect(classify(bash('cat src/a.ts'), ws, { ...CLEAN, readTools: kinds.claude })).toMatchObject({ reason: 'use-read-tool' })
  })

  it('derives the reading tools a run\'s agent has from its runtime\'s evidence and the Worker\'s tools list (T222)', () => {
    expect(readToolsOf(undefined, undefined)).toEqual([])
    expect(readToolsOf({ readTools: ['Read', 'Grep', 'Glob'] }, undefined)).toEqual(['Read', 'Grep', 'Glob'])
    expect(readToolsOf({ readTools: ['Read', 'Grep', 'Glob'] }, [])).toEqual(['Read', 'Grep', 'Glob'])
    expect(readToolsOf({ readTools: ['Read', 'Grep', 'Glob'] }, ['Read', 'Bash'])).toEqual(['Read'])
    expect(readToolsOf({ workspaceReads: true }, ['Bash'])).toEqual(['read_file', 'list_dir', 'search', 'git_log', 'git_show', 'git_diff', 'git_status'])
    expect(readToolsOf({ workspaceReads: false }, undefined)).toEqual([])
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
  const runDir = mkdtempSync(join(tmpdir(), 'system-gate-claude-run-'))
  afterAll(() => rmSync(runDir, { recursive: true, force: true }))

  function claude(calls: ReadonlyArray<readonly [string, Record<string, unknown>]>, outputs: Array<Record<string, unknown>>, optionsSeen: Array<Record<string, unknown>>, enforcesCleanShells = false): ClaudeAgentRuntime {
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
    const runtime = new ClaudeAgentRuntime({
      query, executable: '/usr/bin/claude', findExecutable: () => undefined, version: async () => '2.1.300', home,
      confine: (bind) => ({ bwrap: '/usr/bin/bwrap', hide: [], readOnly: [...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] }),
      prove: async () => ({ confined: true, detail: 'host state hidden' }), nested: async () => '', status: async () => '{"loggedIn": true}',
      runDir,
    })
    // A stand-in for a runtime that would itself start every shell with no startup files (`cleanShells`, T198); Claude Code is not one.
    if (enforcesCleanShells) {
      const probe = runtime.probe.bind(runtime)
      runtime.probe = async (options) => ({ ...await probe(options), cleanShells: true })
    }
    return runtime
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
    // Besides the workspace, what a browser test writes: the confinement's private /dev/shm and the run's report file (T265).
    expect(optionsSeen[0]).toMatchObject({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: [WORKSPACE, '/dev/shm', expect.stringMatching(/\/worktrees\/\.setup\/run-report-[^/]+\/report$/)] }, network: { allowedDomains: [] } } })
    const decision = (output: Record<string, unknown>) => (output.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string }).permissionDecision
    expect(outputs.map(decision)).toEqual(['deny', 'defer'])
    expect(decisionOf(ctx, (outputs[0]!.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason)).toMatchObject({ decisionType: 'gate', outcome: { option: 'deny' } })
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error' } })
    expect(await ctx.approvals.list()).toEqual([expect.objectContaining({ action: expect.objectContaining({ class: 'command', summary: 'Bash: npm test' }), requester: expect.objectContaining({ toolUseId: 'toolu_1' }) })])
  })

  it('takes a shell read for a read only where the runtime enforces shells with no startup files: Claude Code does not, so a function named echo in a startup file or its shell snapshot could run instead, and the exact command waits for the operator (T198); its cat is denied at once, naming Read (T222)', async () => {
    const a = join(WORKSPACE, 'src/a.ts')
    const calls = [['Bash', { command: `cat ${a}` }], ['Bash', { command: 'echo probe' }]] as const
    // A runtime that enforced it: both read, nothing asked.
    const clean: Array<Record<string, unknown>> = []
    const enforced = await boot(claude(calls, clean, [], true), bundlePolicies()[0]!)
    expect((await enforced.run()).status).toBe('completed')
    expect(clean).toEqual([{}, {}])
    expect(await enforced.ctx.approvals.list()).toEqual([])
    // Claude Code itself: its cat is denied at once, naming Read; the probe is the exact command, which the operator decides; the run stops there.
    const unproven: Array<Record<string, unknown>> = []
    const { ctx, run } = await boot(claude(calls, unproven, []), bundlePolicies()[0]!)
    const done = await run()
    const hook = (o: Record<string, unknown>) => o.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string }
    expect(unproven.map((o) => hook(o).permissionDecision)).toEqual(['deny', 'defer'])
    expect(hook(unproven[0]!).permissionDecisionReason).toContain('you have Read for it')
    expect(decisionOf(ctx, hook(unproven[0]!).permissionDecisionReason!)).toMatchObject({ decisionType: 'gate', outcome: { option: 'deny', detail: { reason: 'use-read-tool' } } })
    expect(ctx.eventLog.query({ type: 'agent-workers.tool.denied' }).map((e) => e.data!.reason)).toEqual(['use-read-tool'])
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error' } })
    expect(await ctx.approvals.list()).toEqual([expect.objectContaining({ action: expect.objectContaining({ class: 'command', summary: 'Bash: echo probe' }) })])
  })
})

// The gate hook runs as a real Node process for each tool call, as Codex runs it, and the probe runs
// it first: 4.0 to 4.7 s of the 5 s default in loaded runs of the suite.
describe('a Codex Worker under the bundle\'s default policy, end to end (docs/design/agent-runtimes.md#tool-gate)', { timeout: 30_000 }, () => {
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
    return { runtime, hooks: () => s.calls.flatMap((c) => c.hooks), prompts: () => s.calls.map((c) => c.prompt) }
  }

  it('reads its workspace through the workspace reads server with no approval request, as its brief tells it; another tool of that server is denied, and Bash cat is denied at once, naming read_file (T200b, T222)', async () => {
    const a = join(WORKSPACE, 'src/a.ts')
    const { runtime, hooks, prompts } = codex([
      { tool: 'mcp__workspace__read_file', input: { path: 'src/a.ts', startLine: 1, endLine: 20 }, item: 'mcp_tool_call' },
      { tool: 'mcp__workspace__search', input: { pattern: 'needle' }, item: 'mcp_tool_call' },
      { tool: 'mcp__workspace__write_file', input: { path: 'src/a.ts' }, item: 'mcp_tool_call' },
      { tool: 'Bash', input: { command: `cat ${a}` }, item: 'command_execution' },
    ])
    expect(await runtime.probe()).toMatchObject({ gatesToolCalls: true, cleanShells: false, workspaceReads: true })
    const { ctx, run } = await boot(runtime, bundlePolicies()[0]!)
    const done = await run()
    // The two reads run unasked; the server's other tool is denied by the gate's own rule; the shell read is denied at once, naming read_file.
    expect(hooks().map((h) => h.blocked)).toEqual([false, false, true, true])
    expect(hooks()[2]!.reason).toContain('mcp__workspace__write_file is not one of the workspace reads server\'s tools')
    expect(decisionOf(ctx, hooks()[2]!.reason)).toMatchObject({ decisionType: 'gate', outcome: { option: 'deny' } })
    expect(hooks()[3]!.reason).toContain('you have read_file for it')
    expect(decisionOf(ctx, hooks()[3]!.reason)).toMatchObject({ decisionType: 'gate', outcome: { option: 'deny', detail: { reason: 'use-read-tool' } } })
    expect(ctx.eventLog.query({ type: 'agent-workers.tool.denied' }).map((e) => e.data!.reason)).toEqual(['unclassified-tool', 'use-read-tool'])
    // Nothing waits for the operator: no request at all.
    expect(done.status).toBe('completed')
    expect(await ctx.approvals.list()).toEqual([])
    // Its brief says to read with the server's tools, never with a shell, names no shell read as unasked, and says a shell inspection is denied.
    expect(prompts()[0]).toContain('- Read your workspace with the workspace server\'s tools, never with a shell: read_file')
    expect(prompts()[0]).toContain('- Reading tools (the workspace server\'s read_file, list_dir, search, git_log, git_show, git_diff, and git_status) on paths inside your workspace')
    expect(prompts()[0]).not.toContain('Bash read-only inspection')
    expect(prompts()[0]).toContain('A Bash inspection command you have a reading tool for is denied at once, never asked: cat, head, tail, sed -n: use read_file')
  })

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

  it('reads nothing through its shell: each call picks its own shell, which the hook does not see, so even a probe waits for the operator as the exact command it is (T198); its cat is denied at once, naming read_file (T222)', async () => {
    const shell = (command: string) => ({ tool: 'Bash', input: { command }, item: 'command_execution' })
    const a = join(WORKSPACE, 'src/a.ts')
    const { runtime, hooks } = codex([shell(`cat ${a}`), shell('echo probe')])
    expect(await runtime.probe()).toMatchObject({ gatesToolCalls: true, cleanShells: false })
    const { ctx, run } = await boot(runtime, bundlePolicies()[0]!)
    const done = await run()
    // The cat is denied, the probe blocked (deferred).
    expect(hooks().map((h) => h.blocked)).toEqual([true, true])
    expect(hooks()[0]!.reason).toContain('you have read_file for it')
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringContaining('stopped at its Bash call, which waits for the operator') } })
    expect(await ctx.approvals.list()).toEqual([expect.objectContaining({ action: expect.objectContaining({ class: 'command', summary: 'Bash: echo probe' }) })])
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
    onTestFinished(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    // The engine's deferral sweep (every approvalPollSeconds) starts by reading the deferrals still
    // unsettled, then reads each one's request from the queue: a test waits for the sweeps it needs,
    // never for a fixed time, so a loaded host is slow, never wrong.
    const swept = { sweeps: 0, reads: new Map<string, number>() }
    const prepare = ctx.store.db.prepare.bind(ctx.store.db)
    ctx.store.db.prepare = ((sql: string) => {
      if (/^SELECT \* FROM workflow_deferrals WHERE settled_at IS NULL\b/.test(sql)) swept.sweeps++
      return prepare(sql)
    }) as typeof ctx.store.db.prepare
    const get = ctx.approvals.get.bind(ctx.approvals)
    ctx.approvals.get = async (requestId) => {
      const request = await get(requestId)
      swept.reads.set(requestId, (swept.reads.get(requestId) ?? 0) + 1)
      return request
    }
    return Object.assign(ctx, { swept })
  }

  const settledRun = (ctx: Context, runId: string, status: 'completed' | 'failed') => vi.waitFor(() => {
    const view = ctx.workflow.get(runId)!
    if (view.status !== status) throw new Error(`run ${runId} is ${view.status}, not ${status}`)
    return view
  }, { timeout: 30_000, interval: 50 })

  it('continues the session once the operator approves the call it stopped at: one more attempt, whose brief says so, and the call runs once', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test')]])
    const ctx = await bootFlow(agent)
    const run = ctx.workflow.start({ template: 'change', input: 'Make the tests pass', classification: 'operator-shared' })
    const failed = await settledRun(ctx, run.runId, 'failed')
    expect(failed.error).toMatchObject({ kind: 'config_error' })
    const [request] = await ctx.approvals.list()
    expect(request).toMatchObject({ action: { class: 'command' }, requester: { component: 'worker', sessionId: run.sessionId } })
    // Nothing continues before the verdict: a sweep reads the request, open, and continues nothing.
    const read = ctx.swept.reads.get(request!.requestId) ?? 0
    await vi.waitFor(() => expect(ctx.swept.reads.get(request!.requestId)).toBeGreaterThan(read), { timeout: 15_000 })
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
    // At most once per approval: later sweeps continue nothing more. Sweeps never overlap, so two
    // more starts mean a whole sweep ran after the continuation.
    expect(ctx.store.db.prepare('SELECT outcome FROM workflow_deferrals WHERE request_id = ?').get(request!.requestId)).toEqual({ outcome: 'continued' })
    const sweeps = ctx.swept.sweeps
    await vi.waitFor(() => expect(ctx.swept.sweeps).toBeGreaterThanOrEqual(sweeps + 2), { timeout: 15_000 })
    expect(agent.runs).toHaveLength(2)
  })

  it('continues nothing when the operator rejects the call: the run stays failed for the operator', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test')]])
    const ctx = await bootFlow(agent)
    const run = ctx.workflow.start({ template: 'change', input: 'Make the tests pass', classification: 'operator-shared' })
    await settledRun(ctx, run.runId, 'failed')
    const [request] = await ctx.approvals.list()
    await ctx.approvals.decide([{ requestId: request!.requestId, subject: request!.subject, verdict: 'rejected' }])
    // The next sweep settles the deferral as rejected, continuing nothing; a settled one is never read again.
    await vi.waitFor(() => expect(ctx.store.db.prepare('SELECT outcome FROM workflow_deferrals WHERE request_id = ?').get(request!.requestId)).toEqual({ outcome: 'rejected' }), { timeout: 15_000 })
    expect(ctx.workflow.get(run.runId)!.status).toBe('failed')
    expect(agent.runs).toHaveLength(1)
  })
})

// A board task's run (docs/design/workflow-engine.md#a-deferred-tool-call; T99 D2): its step waits on
// the request instead of failing the attempt, the same session goes on once the operator approves,
// a rejection or an expiry ends the attempt for the operator, and an attempt that ends any other way
// leaves no request open on a session no later attempt resumes.
describe('a board task\'s step whose Worker stops at a deferred call', { timeout: 60_000 }, () => {
  const CHANGE = [{ nodeId: 'change', objective: 'Change the code', prompt: '{{input}}', capabilities: ['develop', 'local-data'], tier: 'standard' as const, conversation: 'persistent' as const, acceptance: 'acceptance.answer' }]
  const WORKFLOW = { retryDelayMs: 50, approvalPollSeconds: 1, templates: { change: CHANGE } }

  /**
   * `backdateMs`: each request the gate opens is made that long ago, so it expires that much sooner (the queue never sweeps here).
   * `failRead`: a read of the queue fails while it returns true for the reading engine function's name (`awaitCall`, `settleCalls`).
   */
  async function bootTask(agent: AgentRuntimeProvider, overrides: Record<string, unknown> = {}, options: { backdateMs?: number; failRead?: (reader: 'awaitCall' | 'settleCalls') => boolean } = {}) {
    const workflow = { ...WORKFLOW, ...overrides }
    const dir = mkdtempSync(join(tmpdir(), 'system-gate-task-'))
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
      ctx.plugin(StoreApprovals, { policies: [policy()], sweepSeconds: 3600 }), ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(WorkerSessions, {}),
      ctx.plugin(AgentWorkers, { workers: [{ id: 'dev', runtime: agent.kind, workspace: WORKSPACE, sandbox: 'workspace-write', tier: 'standard' }] }),
      ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
    ]
    await Promise.all(fibers)
    let engine = ctx.plugin(Workflow, workflow)
    await engine
    ctx.agentRuntimes.register(agent)
    onTestFinished(async () => {
      await engine.dispose()
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    await activeProject(ctx)
    if (options.backdateMs) {
      const request = ctx.approvals.request.bind(ctx.approvals)
      ctx.approvals.request = (asked) => request(asked, new Date(Date.now() - options.backdateMs!))
    }
    if (options.failRead) {
      // The engine's own reads, told apart by the function that makes them: the Worker's gate reads the queue too.
      const get = ctx.approvals.get.bind(ctx.approvals)
      ctx.approvals.get = (requestId) => {
        const stack = new Error().stack ?? ''
        const reader = (['awaitCall', 'settleCalls'] as const).find((name) => stack.includes(`at ${name} `))
        return reader && options.failRead!(reader) ? Promise.reject(new Error('the approval queue is unavailable')) : get(requestId)
      }
    }
    const task = await readyTask(ctx, 'change')
    const run = await ctx.workflow.start({ template: 'change', input: 'Make the tests pass', classification: 'operator-shared', task: { taskId: task.taskId } })
    // Stop the engine alone, and start it again over the same store (a restart).
    const stop = async (): Promise<void> => {
      await engine.dispose()
    }
    const start = async (): Promise<void> => {
      engine = ctx.plugin(Workflow, workflow)
      await engine
    }
    const restart = async (): Promise<void> => {
      await stop()
      await start()
    }
    return { ctx, task, run, restart, stop, start }
  }

  const blockedOn = (ctx: Context, runId: string) => vi.waitFor(() => {
    const view = ctx.workflow.get(runId)!
    if (view.blocked?.kind !== 'tool-call') throw new Error(`run ${runId} is ${view.status}, not waiting on a tool call (${JSON.stringify(view.error ?? view.nodes)})`)
    return view as typeof view & { blocked: { kind: 'tool-call'; nodeId: string; approvalRequest: string; until: string } }
  }, { timeout: 30_000, interval: 50 })
  const reportedRun = (ctx: Context, runId: string) => vi.waitFor(() => {
    const view = ctx.workflow.get(runId)!
    if (view.task?.phase !== 'reported') throw new Error(`run ${runId} is not reported yet (${view.status})`)
    return view
  }, { timeout: 30_000, interval: 50 })
  const open = async (ctx: Context) => (await ctx.approvals.list({ states: ['open', 'batched'] })).filter((r) => r.requester.component === 'worker')

  it('waits on the request instead of failing the attempt: the task keeps running, and once the operator approves, the same session makes the call once and the attempt completes', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test')]])
    const { ctx, task, run } = await bootTask(agent)
    const waiting = await blockedOn(ctx, run.runId)
    const [request] = await open(ctx)
    // The run waits on exactly the request the Worker's gate opened, for that session; nothing failed.
    expect(request).toMatchObject({ action: { class: 'command' }, requester: { component: 'worker', runId: waiting.nodes[0]!.executionId, sessionId: run.sessionId } })
    // A command call waits at most deferredCommandMinutes (default 10) from its request's creation, inside the request's own expiry.
    expect(waiting).toMatchObject({ status: 'running', blocked: { nodeId: 'change', approvalRequest: request!.requestId, until: new Date(Date.parse(request!.createdAt) + 600_000).toISOString() } })
    expect(Date.parse(waiting.blocked.until)).toBeLessThan(Date.parse(request!.expiresAt))
    expect(waiting.nodes).toEqual([expect.objectContaining({ nodeId: 'change', state: 'BLOCKED', attempt: 1 })])
    expect(waiting.nodes[0]!.error).toBeUndefined()
    expect(waiting.error).toBeUndefined()
    const wait = ctx.workflow.explain(run.runId)!.nodes[0]!.decisions.at(-1)!
    expect(wait).toMatchObject({ type: 'recovery', outcome: 'wait' })
    expect((ctx.artifacts.get(wait.id)!.body as { decider: { id: string } }).decider.id).toBe('workflow.deferred-call')
    // The task is still the run's, its attempt not spent: the run renews its lease while it waits.
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'running', run: { runId: run.runId }, attempts: { count: 1 } })
    // A read of the queue while it is open continues nothing.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(agent.runs).toHaveLength(1)

    await ctx.approvals.decide([{ requestId: request!.requestId, subject: request!.subject, verdict: 'approved' }])
    const done = await reportedRun(ctx, run.runId)
    expect(done).toMatchObject({ status: 'completed', task: { outcome: { status: 'accepted', state: 'done' } } })
    expect(done.nodes).toEqual([expect.objectContaining({ nodeId: 'change', state: 'COMPLETED', attempt: 2 })])
    // The same session, resumed, told the call was approved; the approved call ran, once.
    expect(agent.runs).toHaveLength(2)
    expect(agent.runs[1]!.resume).toBe(agent.runs[0]!.resume ?? 'h-1')
    expect(agent.runs[1]!.prompt).toContain(`The operator approved the tool call you stopped at (approval request ${request!.requestId})`)
    expect(agent.verdicts[1]).toEqual([{ decision: 'allow' }])
    // One attempt of the task, done, and no request left open.
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', attempts: { count: 1 } })
    expect(await open(ctx)).toEqual([])
  })

  /** The step's `recovery` decisions of rule `workflow.deferred-call` whose outcome is `deny`. */
  const denials = (ctx: Context, runId: string) => ctx.artifacts.list({ kind: 'decision', runId }).map((a) => a.body as { decisionType: string; decider: { id: string }; inputs: string[]; outcome: { option: string; detail?: Record<string, unknown> } })
    .filter((d) => d.decider.id === 'workflow.deferred-call' && d.outcome.option === 'deny')

  it('returns a rejected or expired call to the agent as a denied tool result, and the same session goes on once without it: the attempt completes, nothing of the call run (T199)', async () => {
    for (const how of ['rejected', 'expired'] as const) {
      // The second run is the session resumed: the call it stopped at is put to the gate again, then the next call.
      const agent = new GatedAgent([[bash('npm test')], [bash('npm test'), bash('npm run build')]])
      // deferredCommandMinutes 0 keeps waiting as before: until the request's own expiry. The expired
      // request is made to expire 3 s from now, and the queue never sweeps: the engine reaches the
      // deadline first, and resolves the expiry itself as a denial, never by ending the attempt.
      const { ctx, task, run } = await bootTask(agent, { deferredCommandMinutes: 0 }, how === 'expired' ? { backdateMs: 3_597_000 } : {})
      const waiting = await blockedOn(ctx, run.runId)
      const request = (await ctx.approvals.get(waiting.blocked.approvalRequest))!
      expect(waiting.blocked.until, how).toBe(request.expiresAt)
      if (how === 'rejected') await ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'rejected' }])
      const done = await reportedRun(ctx, run.runId)
      expect(done, how).toMatchObject({ status: 'completed', task: { outcome: { status: 'accepted', state: 'done' } } })
      expect(done.nodes, how).toEqual([expect.objectContaining({ nodeId: 'change', state: 'COMPLETED', attempt: 2 })])
      // The same session, resumed once, told the call was denied and why.
      expect(agent.runs, how).toHaveLength(2)
      expect(agent.runs[1]!.resume, how).toBe(agent.runs[0]!.resume ?? 'h-1')
      expect(agent.runs[1]!.prompt, how).toContain(`The tool call you stopped at was denied (approval request ${request.requestId}): ${how === 'rejected' ? 'the operator rejected it' : `no verdict came by ${request.expiresAt}`}. It did not run`)
      // The call itself is denied with the reason, never run, and nothing new is asked; the Worker's next call runs.
      expect(agent.verdicts[1], how).toEqual([
        { decision: 'deny', reason: `approval request ${request.requestId} for exactly this call was ${how === 'rejected' ? 'rejected by the operator' : 'withdrawn before a verdict (unanswered in time, its work ended, or the policy changed)'}, so it does not run; go on without it` },
        { decision: 'allow' },
      ])
      // Recorded (INV-13): the denial, on the queue's own resolution and the autonomy decision that the class still asks.
      const [deny, ...more] = denials(ctx, run.runId)
      expect(more, how).toEqual([])
      expect(deny, how).toMatchObject({ decisionType: 'recovery', inputs: expect.arrayContaining([request.resolution?.decision ?? (await ctx.approvals.get(request.requestId))!.resolution!.decision]), outcome: { detail: { approvalRequest: request.requestId, cause: how } } })
      expect(ctx.eventLog.query({ type: 'workflow.run.continued', runId: run.runId }).at(-1)?.data, how).toMatchObject({ approvalRequest: request.requestId, denied: true, cause: how })
      // One attempt of the task, done; no request left open.
      expect(await ctx.board.task(task.taskId), how).toMatchObject({ state: 'done', attempts: { count: 1 } })
      expect(await open(ctx), how).toEqual([])
      expect((await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).filter((r) => r.requester.component === 'worker'), how).toHaveLength(1)
    }
  })

  it('treats a command call unanswered past deferredCommandMinutes as denied, for that call alone: its request withdrawn, the expiry recorded, and the session goes on once (T199)', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test'), bash('npm run build')]])
    const { ctx, task, run } = await bootTask(agent, { deferredCommandMinutes: 0.05 })
    const waiting = await blockedOn(ctx, run.runId)
    const request = (await ctx.approvals.get(waiting.blocked.approvalRequest))!
    // Bounded: 3 s after the request was made, well inside its own expiry.
    expect(waiting.blocked.until).toBe(new Date(Date.parse(request.createdAt) + 3000).toISOString())
    expect(Date.parse(request.expiresAt) - Date.parse(waiting.blocked.until)).toBeGreaterThan(3_000_000)
    const done = await reportedRun(ctx, run.runId)
    expect(done).toMatchObject({ status: 'completed', task: { outcome: { status: 'accepted', state: 'done' } } })
    // The request is withdrawn, by the queue's own record, and the expiry is the engine's decision.
    const withdrawn = (await ctx.approvals.get(request.requestId))!
    expect(withdrawn).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
    expect(denials(ctx, run.runId)).toEqual([expect.objectContaining({
      decisionType: 'recovery', inputs: expect.arrayContaining([withdrawn.resolution!.decision]),
      outcome: { option: 'deny', detail: expect.objectContaining({ approvalRequest: request.requestId, cause: 'bound', boundMinutes: 0.05 }) },
    })])
    // That call is denied, never run; the session goes on, and its next call runs.
    expect(agent.runs).toHaveLength(2)
    expect(agent.runs[1]!.prompt).toContain(`The tool call you stopped at was denied (approval request ${request.requestId}): no verdict came within 0.05 minutes, so the call is denied.`)
    expect(agent.verdicts[1]).toEqual([{ decision: 'deny', reason: expect.stringContaining(`approval request ${request.requestId} for exactly this call was withdrawn before a verdict`) }, { decision: 'allow' }])
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', attempts: { count: 1 } })
    expect(await open(ctx)).toEqual([])
  })

  it('still ends the attempt for the operator when the policy now forbids the call\'s class: USER_ACTION, an attempt the board counts, nothing of the call run', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test')]])
    const { ctx, task, run } = await bootTask(agent)
    const waiting = await blockedOn(ctx, run.runId)
    const request = (await ctx.approvals.get(waiting.blocked.approvalRequest))!
    // The operator forbids commands while the step waits: the open request is withdrawn on the change.
    const { request: change } = await ctx.approvals.proposePolicy!({ policy: { ...policy({ command: { mode: 'forbid' } }), version: 2 } })
    const [applied] = await ctx.approvals.decide([{ requestId: change.requestId, subject: change.subject, verdict: 'approved' }])
    expect(applied?.refused).toBeUndefined()
    const ended = await reportedRun(ctx, run.runId)
    expect(ended).toMatchObject({ status: 'failed', error: { kind: 'call_rejected', disposition: 'USER_ACTION' } })
    expect(ended.nodes[0]!.error).toMatchObject({ disposition: 'USER_ACTION', message: expect.stringContaining('the autonomy policy now forbids its class command') })
    expect(await ctx.approvals.get(request.requestId)).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
    expect(ended.task?.outcome).toMatchObject({ status: 'reconciled', state: 'ready' })
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    expect(agent.runs).toHaveLength(1)
    expect(denials(ctx, run.runId)).toEqual([])
    // The notifier reads the step's failure as one only the operator resolves.
    expect(ctx.eventLog.query({ type: 'workflow.node.failed', runId: run.runId }).at(-1)?.data).toMatchObject({ disposition: 'USER_ACTION', approvalRequest: request.requestId })
  })

  it('keeps a command call\'s bound across a restart of the engine mid-wait: past it, the call is denied once and the session goes on, nothing asked twice (INV-4)', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test')]])
    const { ctx, run, restart } = await bootTask(agent, { deferredCommandMinutes: 0.05 })
    const waiting = await blockedOn(ctx, run.runId)
    await restart()
    const done = await reportedRun(ctx, run.runId)
    expect(done).toMatchObject({ status: 'completed', task: { outcome: { status: 'accepted' } } })
    expect(agent.runs).toHaveLength(2)
    expect(agent.verdicts[1]).toEqual([expect.objectContaining({ decision: 'deny' })])
    // One request, withdrawn once by its bound; one denial; one continuation.
    expect((await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).filter((r) => r.requester.component === 'worker').map((r) => r.requestId)).toEqual([waiting.blocked.approvalRequest])
    expect(denials(ctx, run.runId)).toEqual([expect.objectContaining({ outcome: expect.objectContaining({ detail: expect.objectContaining({ cause: 'bound' }) }) })])
    expect(ctx.eventLog.query({ type: 'workflow.run.continued', runId: run.runId })).toHaveLength(1)
  })

  /** The step's `wait` decisions of rule `workflow.deferred-call`, oldest first. */
  const waits = (ctx: Context, runId: string) => ctx.artifacts.list({ kind: 'decision', runId }).map((a) => a.body as { decider: { id: string }; createdAt?: string; outcome: { option: string; detail: { until: string; boundMinutes?: number } } })
    .filter((d) => d.decider.id === 'workflow.deferred-call' && d.outcome.option === 'wait')
    .sort((a, b) => Date.parse(a.outcome.detail.until) - Date.parse(b.outcome.detail.until)).reverse()

  it('bounds a command call by deferredCommandMinutes once its request can be read, when the first read of the queue failed: reconciled, persisted, and denied at the bound, not at the request\'s expiry (T209)', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test'), bash('npm run build')]])
    let failed = 0
    // Only the engine's first read, as the step starts to wait, fails.
    const { ctx, task, run } = await bootTask(agent, { deferredCommandMinutes: 0.05 }, { failRead: (reader) => reader === 'awaitCall' && failed++ === 0 })
    const done = await reportedRun(ctx, run.runId)
    expect(failed).toBeGreaterThan(0)
    expect(done).toMatchObject({ status: 'completed', task: { outcome: { status: 'accepted', state: 'done' } } })
    const requestId = (await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).find((r) => r.requester.component === 'worker')!.requestId
    const request = (await ctx.approvals.get(requestId))!
    const bounded = new Date(Date.parse(request.createdAt) + 3000).toISOString()
    // The first wait, unread, by gateTimeoutHours; then the bound, once the request was read, recorded once.
    const [first, reconciled, ...more] = waits(ctx, run.runId)
    expect(more).toEqual([])
    expect(first!.outcome.detail.boundMinutes).toBeUndefined()
    expect(Date.parse(first!.outcome.detail.until)).toBeGreaterThan(Date.parse(bounded) + 3_000_000)
    expect(reconciled!.outcome.detail).toMatchObject({ until: bounded, boundMinutes: 0.05 })
    // Denied at the bound, the request withdrawn: not left to wait for its own expiry, an hour off.
    expect(await ctx.approvals.get(requestId)).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
    expect(denials(ctx, run.runId)).toEqual([expect.objectContaining({ outcome: { option: 'deny', detail: expect.objectContaining({ approvalRequest: requestId, cause: 'bound', boundMinutes: 0.05 }) } })])
    expect(agent.runs).toHaveLength(2)
    expect(agent.runs[1]!.prompt).toContain(`The tool call you stopped at was denied (approval request ${requestId}): no verdict came within 0.05 minutes, so the call is denied.`)
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', attempts: { count: 1 } })
  })

  it('bounds it after a restart between the failed read and the first readable one: the deadline is derived from the request, not from the row, once (INV-4, T209)', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test')]])
    // Every read of the engine fails until the restart.
    let readable = false
    const { ctx, run, stop, start } = await bootTask(agent, { deferredCommandMinutes: 0.05 }, { failRead: () => !readable })
    const waiting = await blockedOn(ctx, run.runId)
    const request = (await ctx.approvals.get(waiting.blocked.approvalRequest))!
    // Unread, the step waits by gateTimeoutHours, far past the command bound.
    expect(Date.parse(waiting.blocked.until)).toBeGreaterThan(Date.parse(request.createdAt) + 3_000_000)
    await stop()
    readable = true
    await start()
    const done = await reportedRun(ctx, run.runId)
    expect(done).toMatchObject({ status: 'completed', task: { outcome: { status: 'accepted' } } })
    const [, reconciled, ...more] = waits(ctx, run.runId)
    expect(more).toEqual([])
    expect(reconciled!.outcome.detail).toMatchObject({ until: new Date(Date.parse(request.createdAt) + 3000).toISOString(), boundMinutes: 0.05 })
    // One request, withdrawn once by its bound; one denial; one continuation.
    expect(await ctx.approvals.get(request.requestId)).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
    expect(denials(ctx, run.runId)).toEqual([expect.objectContaining({ outcome: expect.objectContaining({ detail: expect.objectContaining({ cause: 'bound' }) }) })])
    expect(ctx.eventLog.query({ type: 'workflow.run.continued', runId: run.runId })).toHaveLength(1)
    expect(agent.runs).toHaveLength(2)
  })

  it('denies an approval given after a command call\'s bound while the engine was down: the call never runs, the denial is the engine\'s, and the session goes on (INV-4); a later workflow run of the session is denied it too, once the event log dropped the engine\'s events', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test'), bash('npm test')], [bash('npm test')]])
    const { ctx, task, run, stop, start } = await bootTask(agent, { deferredCommandMinutes: 0.05 })
    const waiting = await blockedOn(ctx, run.runId)
    await stop()
    // The bound passes with no engine to withdraw the request; the queue's own expiry is an hour off, so it takes the approval.
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(Date.parse(waiting.blocked.until) + 100), { timeout: 10_000, interval: 100 })
    const request = (await ctx.approvals.get(waiting.blocked.approvalRequest))!
    const [applied] = await ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'approved' }])
    expect(applied?.refused).toBeUndefined()
    await start()
    const done = await reportedRun(ctx, run.runId)
    expect(done).toMatchObject({ status: 'completed', task: { outcome: { status: 'accepted', state: 'done' } } })
    const approved = (await ctx.approvals.get(request.requestId))!
    expect(denials(ctx, run.runId)).toEqual([expect.objectContaining({
      decisionType: 'recovery', inputs: expect.arrayContaining([approved.resolution!.decision]),
      outcome: { option: 'deny', detail: expect.objectContaining({ approvalRequest: request.requestId, cause: 'late' }) },
    })])
    // The approved call is denied, both times the resumed session makes it: its approval is never taken.
    expect(agent.runs).toHaveLength(2)
    expect(agent.runs[1]!.prompt).toContain(`The tool call you stopped at was denied (approval request ${request.requestId}): the approval came at ${approved.resolution!.at}, after the call's deadline`)
    expect(agent.verdicts[1]).toEqual([
      { decision: 'deny', reason: expect.stringContaining(`approval request ${request.requestId} for exactly this call was denied (late`) },
      { decision: 'deny', reason: expect.stringContaining(`approval request ${request.requestId} for exactly this call was denied (late`) },
    ])
    expect(ctx.store.db.prepare('SELECT used_at FROM agent_tool_requests WHERE request_id = ?').get(request.requestId)).toEqual({ used_at: null })
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', attempts: { count: 1 } })
    // The denial is kept on the gate's own row of the request, with the engine's decision and cause.
    const kept = ctx.store.db.prepare('SELECT denial_decision, denial_cause FROM agent_tool_requests WHERE request_id = ?').get(request.requestId) as { denial_decision: string; denial_cause: string }
    expect(kept.denial_cause).toBe('late')
    expect(ctx.artifacts.get(kept.denial_decision)?.body).toMatchObject({ decisionType: 'recovery', outcome: { option: 'deny', detail: { approvalRequest: request.requestId, cause: 'late' } } })

    // The event log's retention drops the engine's events; then another workflow run continues the
    // session (a next attempt, a chained task). The request is still approved and its approval
    // unused, but the call stays denied in the session: it never runs, and the approval is never taken.
    ctx.store.db.prepare("DELETE FROM events WHERE type = 'workflow.run.continued'").run()
    expect(ctx.eventLog.query({ type: 'workflow.run.continued', runId: run.runId })).toEqual([])
    expect(await ctx.approvals.get(request.requestId)).toMatchObject({ state: 'approved' })
    const admitted = await ctx.workers.route(requirement) as { decisions: { tier: `sha256:${string}`; route: `sha256:${string}` } }
    const source = ctx.workers.source('agents')!
    const later = source.start({ key: 'a-later-workflow-run', worker: 'agent:dev', prompt: 'the next attempt', sessionId: run.sessionId!, runId: 'run_later', requirement, decisions: admitted.decisions })
    expect(await source.wait(later.id, 10_000)).toMatchObject({ status: 'completed' })
    expect(agent.runs).toHaveLength(3)
    expect(agent.verdicts[2]).toEqual([{ decision: 'deny', reason: `approval request ${request.requestId} for exactly this call was denied (late, decision ${kept.denial_decision}), so it does not run; go on without it` }])
    expect(ctx.store.db.prepare('SELECT used_at FROM agent_tool_requests WHERE request_id = ?').get(request.requestId)).toEqual({ used_at: null })
    expect(await open(ctx)).toEqual([])
  })

  it('never runs a denied call once a newer policy lists its command: the replay in the resumed session is denied by the persisted denial', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test'), bash('npm run build')]])
    const { ctx, task, run } = await bootTask(agent)
    const waiting = await blockedOn(ctx, run.runId)
    const request = (await ctx.approvals.get(waiting.blocked.approvalRequest))!
    // The operator lists the very command while the step waits: the queue withdraws the open request on the change.
    const { request: change } = await ctx.approvals.proposePolicy!({ policy: { ...policy(), commands: ['npm run build', 'npm test'], version: 2 } })
    const [applied] = await ctx.approvals.decide([{ requestId: change.requestId, subject: change.subject, verdict: 'approved' }])
    expect(applied?.refused).toBeUndefined()
    expect((await ctx.approvals.check({ class: 'command', command: ['npm', 'test'] })).mode).not.toBe('ask')
    const done = await reportedRun(ctx, run.runId)
    expect(done).toMatchObject({ status: 'completed', task: { outcome: { status: 'accepted', state: 'done' } } })
    expect(await ctx.approvals.get(request.requestId)).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
    expect(denials(ctx, run.runId)).toEqual([expect.objectContaining({ outcome: expect.objectContaining({ detail: expect.objectContaining({ approvalRequest: request.requestId, cause: 'withdrawn' }) }) })])
    // The policy now lets `npm test` run unasked, but this session's call was denied: it stays denied; the next call runs.
    expect(agent.verdicts[1]).toEqual([
      { decision: 'deny', reason: expect.stringContaining(`approval request ${request.requestId} for exactly this call was withdrawn before a verdict`) },
      { decision: 'allow' },
    ])
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', attempts: { count: 1 } })
  })

  it('leaves no request open once the attempt has ended any other way: stopped while it waits, its request is withdrawn, so none is orphaned on a session no later attempt resumes', async () => {
    const agent = new GatedAgent([[bash('npm test')]])
    const { ctx, task, run } = await bootTask(agent)
    const [request] = await vi.waitFor(async () => {
      const opened = await open(ctx)
      if (!opened.length) throw new Error('no request opened yet')
      return opened
    }, { timeout: 30_000, interval: 50 })
    // While the step waits on it the run is live; the operator ends the attempt.
    if (ctx.workflow.get(run.runId)!.status === 'running') await ctx.workflow.stop(run.runId, 'not needed')
    const ended = await reportedRun(ctx, run.runId)
    // The attempt is over and nothing waits on the request: it is withdrawn, never left open (T99 D2).
    expect(await ctx.approvals.get(request!.requestId)).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
    expect(await open(ctx)).toEqual([])
    expect(ended).toMatchObject({ status: 'failed', error: { kind: 'stopped' }, task: { outcome: { status: 'reconciled', state: 'ready' } } })
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'ready', attempts: { count: 1 } })
  })

  it('keeps waiting on the same request across a restart of the engine, asking nothing twice, and goes on once it is approved (INV-4)', async () => {
    const agent = new GatedAgent([[bash('npm test')], [bash('npm test')]])
    const { ctx, run, restart } = await bootTask(agent)
    const waiting = await blockedOn(ctx, run.runId)
    await restart()
    expect((await blockedOn(ctx, run.runId)).blocked).toEqual(waiting.blocked)
    expect(await open(ctx)).toHaveLength(1)
    const request = (await ctx.approvals.get(waiting.blocked.approvalRequest))!
    await ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'approved' }])
    expect(await reportedRun(ctx, run.runId)).toMatchObject({ status: 'completed', task: { outcome: { status: 'accepted' } } })
    expect(agent.runs).toHaveLength(2)
  })
})
