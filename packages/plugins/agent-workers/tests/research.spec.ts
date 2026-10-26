/**
 * A read-only research role on agent runtimes (T262, ADR-0074): the real `agents` source, routing,
 * store-backed approval queue, egress check, and engine, with a scripted research runtime that asks
 * the run's gate before each tool call. The role has no write or shell tool; its Worker proves
 * `web-search` only by its web probe's real search; its web calls run unasked only under the
 * autonomy policy's web access grant, egress-checked and bounded per run (concurrent calls included),
 * each recorded; a project's prohibition and a session's denial both bind; every other role's web
 * call still asks; a research step prefers it over a Worker that only reasons.
 */
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
import { agentToolEventOf, startPrompt } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { ClaudeAgentRuntime } from '@tsuuanmi/system-runtime-claude-agent-sdk'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkerExecution, type WorkRequirement } from '@tsuuanmi/system-workers'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import Workflow, { type NodeTemplate } from '@tsuuanmi/system-workflow'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import AgentWorkers, { type Config } from '../src/index.ts'
import { runGate } from '../src/gate.ts'
import { deriveWorkers } from '../src/roles.ts'
import { RESEARCH_TOOLS, WEB_PROBE_PROMPT, WEB_PROBE_QUERY } from '../src/research.ts'

const WORKSPACE = mkdtempSync(join(tmpdir(), 'system-research-ws-'))
afterAll(() => rmSync(WORKSPACE, { recursive: true, force: true }))

type Call = Omit<ToolCall, 'callId'>

/**
 * A scripted research runtime: it offers web tools on a read-only run (`webTools`), and each run makes
 * the calls `script` gives for its prompt, asking the gate first; a deny is told to the agent, which
 * goes on; a defer stops the run, as a gating runtime must. The web probe's run makes the probe's
 * search and answers with a result's URL.
 */
class Researcher implements AgentRuntimeProvider {
  readonly kind = 'researcher'
  readonly runs: RunSpec[] = []
  readonly verdicts: Array<{ tool: string; verdict: ToolVerdict }> = []
  script: (prompt: string) => Call[] = () => []
  /** Ask the gate about every call of a run at once, as an agent's parallel tool calls do. */
  concurrent = false
  constructor(private readonly evidence: { webTools?: boolean } = {}) {}
  async probe() {
    return { available: true, detail: 'researcher 1.0', version: '1.0', sandboxes: ['read-only' as const], resume: true, executes: false, readsConfined: true, gatesToolCalls: true, webTools: this.evidence.webTools ?? true }
  }
  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void) {
    this.runs.push(spec)
    const probe = spec.prompt === WEB_PROBE_PROMPT
    const handle = spec.resume ?? `r-${this.runs.length}`
    if (!probe) onHandle?.(handle)
    const calls = probe ? [{ tool: 'WebSearch', input: { query: WEB_PROBE_QUERY } }] : this.script(spec.prompt)
    if (this.concurrent && !probe) {
      const verdicts = await Promise.all(calls.map((call, i) => spec.toolGate!({ ...call, callId: `c-${this.runs.length}-${i + 1}` }, signal)))
      verdicts.forEach((verdict, i) => this.verdicts.push({ tool: calls[i]!.tool, verdict }))
      const stopped = verdicts.find((v) => v.decision === 'defer')
      if (stopped) throw new ProviderError('config_error', `researcher: stopped at a call (approval request ${(stopped as { requestId: string }).requestId})`)
      return { text: 'One trial found X lowered Y: https://example.org/trial', nativeHandle: handle, turns: 1 }
    }
    for (const [i, call] of calls.entries()) {
      const verdict = await spec.toolGate!({ ...call, callId: `c-${this.runs.length}-${i + 1}` }, signal)
      this.verdicts.push({ tool: call.tool, verdict })
      if (verdict.decision === 'defer') throw new ProviderError('config_error', `researcher: stopped at ${call.tool} (approval request ${verdict.requestId})`)
    }
    return { text: probe ? 'https://en.wikipedia.org/wiki/Main_Page' : 'One trial found X lowered Y: https://example.org/trial', nativeHandle: handle, turns: 1 }
  }
}

/** The studio policy: reads and workspace writes run, every send and command asks; with `grant`, the research role's web access grant. */
const studio = (grant?: { max?: number; tools?: Array<'WebSearch' | 'WebFetch'> }): AutonomyPolicy => ({
  schema: grant ? 'autonomy-policy@1.3' : 'autonomy-policy@1.0', id: 'studio-test', version: 1, scope: 'studio',
  rules: [
    { actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto' }, { actionClass: 'command', mode: 'ask' },
    { actionClass: 'external-send', mode: 'ask' }, { actionClass: 'policy-change', mode: 'ask' },
  ],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86_400 },
  ...(grant ? { webAccess: { version: 1, rules: [{ profile: 'research' as const, tools: grant.tools ?? ['WebSearch', 'WebFetch'], maxWebCallsPerRun: grant.max ?? 40, maxClassification: 'operator-shared' as const, note: 'the test grant' }] } } : {}),
})

type WorkerConfig = Config['workers'][number]
const researcher = (extra: Partial<WorkerConfig> = {}): WorkerConfig => ({ id: 'researcher', runtime: 'researcher', workspace: WORKSPACE, sandbox: 'read-only', tier: 'standard', family: 'family-c', research: true, ...extra })
/** A read-only Worker of no research role, on the same runtime. */
const reader = (): WorkerConfig => ({ id: 'reader', runtime: 'researcher', workspace: WORKSPACE, sandbox: 'read-only', tier: 'standard', family: 'family-c', tools: ['Read', 'Grep', 'Glob'] })

async function boot(runtime: Researcher, policy: AutonomyPolicy | AutonomyPolicy[], workers: WorkerConfig[] = [researcher(), reader()], templates: Record<string, NodeTemplate[]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-research-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(StoreApprovals, { policies: Array.isArray(policy) ? policy : [policy], sweepSeconds: 3600 }), ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry),
    ctx.plugin(AgentWorkers, { workers }), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100, templates }),
  ]
  await Promise.all(fibers)
  ctx.agentRuntimes.register(runtime)
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  return ctx
}

const research = (overrides: Partial<WorkRequirement> = {}): WorkRequirement => ({
  schema: 'work-requirement@1.2', objective: 'review the literature', capabilities: ['reason'], kind: 'research',
  data: { classification: 'operator-shared', refs: [] }, egressPolicy: 'egress.classification-and-secrets',
  tier: { min: 'standard', source: 'profile' }, acceptance: { contract: 'acceptance.answer' }, ...overrides,
})

/** Work that names no kind: an ordinary step. */
const ordinary = (overrides: Partial<WorkRequirement> = {}): WorkRequirement => {
  const { kind: _kind, ...rest } = research(overrides)
  return { ...rest, schema: 'work-requirement@1.0' }
}

/** Start one run on `worker` and wait for its end. */
async function runOn(ctx: Context, worker: string, requirement: WorkRequirement, prompt: string, n: number): Promise<WorkerExecution> {
  const admitted = await ctx.workers.route(requirement, { restrict: { workers: [worker], reason: 'the test' } })
  admitted.release()
  const source = ctx.workers.source('agents')!
  const started = source.start({ key: `k-${n}`, worker, prompt, sessionId: `ses_${worker.replace(/\W/g, '')}_${n}`, requirement, decisions: admitted.decisions })
  return source.wait(started.id, 10_000)
}

/** The web access rule's decisions, the probe's own search left out unless `probe`. */
const webDecisions = (ctx: Context, probe = false) => ctx.artifacts.list({ kind: 'decision', decisionType: 'gate', limit: 1000 })
  .filter((a) => (a.body as { decider: { id: string } }).decider.id === 'agent-workers.web-access')
  .map((a) => a.body as { outcome: { option: string; detail: Record<string, unknown> }; inputs: string[] })
  .filter((d) => probe || d.outcome.detail.target !== WEB_PROBE_QUERY)

/** A credential-shaped value, made at run time so the repository's secrets audit never reads one in this file. */
const KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')

describe('a read-only research role on agent runtimes (T262, ADR-0074)', () => {
  it('has no write or shell tool: refused unless read-only, its tools reads and the web tools only, and its gate denies a write or a command', async () => {
    // The configuration: read-only, no review member, no writing or shell tool.
    expect(() => new AgentWorkers(new Context(), { workers: [researcher({ sandbox: 'workspace-write' })] })).toThrow(/a research role is read-only/)
    expect(() => new AgentWorkers(new Context(), { workers: [researcher({ tools: ['Read', 'Bash'] })] })).toThrow(/research role's tools are Read, Grep, Glob, WebSearch, WebFetch only; refusing Bash/)
    expect(() => new AgentWorkers(new Context(), { workers: [researcher({ tools: ['Write', 'WebSearch'] })] })).toThrow(/refusing Write/)
    expect(() => new AgentWorkers(new Context(), { workers: [researcher({ reviewMember: true })] })).toThrow(/is not a review member/)
    // The runtime refuses a research run that would list a writing tool or the shell, or that is not read-only.
    const claude = new ClaudeAgentRuntime({ findExecutable: () => '/nonexistent/claude' })
    await expect(claude.run({ prompt: 'p', workspace: WORKSPACE, sandbox: 'read-only', web: true, tools: ['Read', 'Write'] }, new AbortController().signal)).rejects.toThrow(/a research run allows only Read, Grep, Glob, WebSearch, WebFetch; refusing Write/)
    await expect(claude.run({ prompt: 'p', workspace: WORKSPACE, sandbox: 'workspace-write', web: true }, new AbortController().signal)).rejects.toThrow(/a research run \(web\) is read-only/)
    await expect(claude.run({ prompt: 'p', workspace: WORKSPACE, sandbox: 'read-only', tools: ['Read', 'WebSearch'] }, new AbortController().signal)).rejects.toThrow(/a read-only run allows only Read, Grep, Glob; refusing WebSearch/)

    const runtime = new Researcher()
    runtime.script = () => [
      { tool: 'Write', input: { file_path: join(WORKSPACE, 'notes.md'), content: 'x' } },
      { tool: 'Edit', input: { file_path: join(WORKSPACE, 'notes.md'), old_string: 'x', new_string: 'y' } },
      { tool: 'Bash', input: { command: 'curl https://example.org' } },
      { tool: 'Read', input: { file_path: join(WORKSPACE, 'README.md') } },
    ]
    const ctx = await boot(runtime, studio({}))
    const done = await runOn(ctx, 'agent:researcher', research(), 'review the literature', 1)
    expect(done.status).toBe('completed')
    // Its run is read-only, every research tool listed (its default), web tools on.
    const run = runtime.runs.find((r) => r.prompt.startsWith('review the literature'))!
    expect(run).toMatchObject({ sandbox: 'read-only', web: true, tools: [...RESEARCH_TOOLS] })
    expect(RESEARCH_TOOLS).toEqual(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'])
    const mine = runtime.verdicts.filter((v) => v.tool !== 'WebSearch')
    expect(mine.map((v) => [v.tool, v.verdict.decision])).toEqual([['Write', 'deny'], ['Edit', 'deny'], ['Bash', 'deny'], ['Read', 'allow']])
    expect((mine[0]!.verdict as { reason: string }).reason).toMatch(/a research role's run writes no file and runs no command; this Write call is workspace-write/)
    expect((mine[2]!.verdict as { reason: string }).reason).toMatch(/this Bash call is command/)
    const denied = ctx.eventLog.query({ type: 'agent-workers.tool.denied', limit: 10 }).map((e) => e.data as { reason: string; tool: string })
    expect(denied.map((d) => [d.tool, d.reason])).toEqual([['Write', 'research-role'], ['Edit', 'research-role'], ['Bash', 'research-role']])
    // Its Tools section says so: it reads and searches only.
    expect(run.prompt).toContain('You are a research role: you read your workspace and search and fetch the web (WebSearch, WebFetch), and nothing else')
    expect(run.prompt).toContain('- Web calls (WebSearch, WebFetch), at most 40 in this run')
  })

  it('refuses a research role whose tier names a writing tool or a shell, as it refuses the role\'s own', () => {
    const tiered = (tools: string[]) => researcher({ tier: undefined as never, tiers: [{ tier: 'standard', tools }] } as unknown as Partial<WorkerConfig>)
    expect(() => new AgentWorkers(new Context(), { workers: [tiered(['Read', 'Bash'])] })).toThrow(/refusing Bash/)
  })

  it('is on the standard tier by default as a role, and takes the tiers shape: its tiers\' tools stay research tools', () => {
    const account = 'researcher:0123456789abcdef'
    const role = { id: 'research', workspace: WORKSPACE, sandbox: 'read-only' as const, research: true, runtimes: { researcher: { family: 'family-c' } } }
    // No tier and no tiers: the standard tier; any other role is refused without one.
    expect(deriveWorkers([role], [{ account, roles: ['research'] }], [])[0]).toMatchObject({ id: `${account}/research`, tier: 'standard', research: true })
    expect(() => deriveWorkers([{ ...role, research: false }], [{ account, roles: ['research'] }], [])).toThrow(/gives no tier on researcher/)
    // T261's tiers per role: the standard tier's model named in the live profile only, here a placeholder.
    const tiered = { ...role, runtimes: { researcher: { family: 'family-c', tiers: { standard: { model: 'model-standard-1' } } } } }
    expect(deriveWorkers([tiered], [{ account, roles: ['research'] }], [])[0]).toMatchObject({ tier: 'standard', tiers: [{ tier: 'standard', declared: true, model: 'model-standard-1' }] })
    const shell = { ...role, runtimes: { researcher: { family: 'family-c', tiers: { standard: { model: 'model-standard-1', tools: ['Read', 'Bash'] } } } } }
    expect(() => new AgentWorkers(new Context(), { roles: [shell], assignments: [{ account, roles: ['research'] }] } as unknown as Config)).toThrow(/refusing Bash/)
  })

  it('proves reason, and web-search only by its web probe\'s real search of the fixed query, recorded; without the grant the probe proves nothing', async () => {
    const runtime = new Researcher()
    const ctx = await boot(runtime, studio({}))
    // Its first describe starts the probe in the background; once it searched, web-search is offered on its decision.
    const offers = async () => (await ctx.workers.list()).find((w) => w.worker === 'agent:researcher')!.capabilities
    await vi.waitFor(async () => expect((await offers()).map((c) => c.capability)).toContain('web-search'), { timeout: 10_000 })
    const web = (await offers()).find((c) => c.capability === 'web-search')!
    expect((await offers()).map((c) => c.capability)).toEqual(['reason', 'web-search', 'persistent-conversation'])
    expect(web.evidence).toMatchObject({ kind: 'probe', ref: expect.stringMatching(/^sha256:/) })
    const proof = ctx.artifacts.get(web.evidence.ref!)!.body as { decider: { id: string }; outcome: { option: string; detail: Record<string, unknown> } }
    expect(proof).toMatchObject({ decider: { id: 'agent-workers.web-probe' }, outcome: { option: 'proven', detail: { worker: 'agent:researcher', query: WEB_PROBE_QUERY, searched: true } } })
    // The probe ran read-only, WebSearch its one tool, and its search went through the web access rule.
    expect(runtime.runs[0]).toMatchObject({ prompt: WEB_PROBE_PROMPT, sandbox: 'read-only', tools: ['WebSearch'], web: true })
    expect(webDecisions(ctx, true)).toEqual([expect.objectContaining({ outcome: expect.objectContaining({ option: 'auto', detail: expect.objectContaining({ tool: 'WebSearch', target: WEB_PROBE_QUERY, egress: 'allow' }) }) })])
    // It takes research work only, never an ordinary ask (P1); the reader proves no reason at all.
    await expect(ctx.workers.route(ordinary())).rejects.toThrow(/takes research work only; this work names no kind/)
    expect((await ctx.workers.list()).find((w) => w.worker === 'agent:reader')!.capabilities.map((c) => c.capability)).toEqual(['local-data', 'review', 'persistent-conversation'])

    // No grant: the probe's search asks, and a probe has no session to wait in, so nothing is proven.
    const ungranted = new Researcher()
    const other = await boot(ungranted, studio())
    await other.workers.list()
    const probeDecision = () => other.artifacts.list({ kind: 'decision', decisionType: 'gate', limit: 100 }).map((a) => a.body as { decider: { id: string }; outcome: { option: string }; candidates: Array<{ selected: boolean; reasons: string[] }> })
      .find((d) => d.decider.id === 'agent-workers.web-probe')
    await vi.waitFor(() => expect(probeDecision()).toBeDefined(), { timeout: 10_000 })
    expect(probeDecision()!.outcome.option).toBe('not-proven')
    expect(probeDecision()!.candidates.find((c) => c.selected)!.reasons[0]).toMatch(/made no search the gate let run/)
    expect((await other.workers.list()).find((w) => w.worker === 'agent:researcher')!.capabilities.map((c) => c.capability)).toEqual(['reason', 'persistent-conversation'])
    // A runtime that offers no web tools admits no research Worker.
    const plain = await boot(new Researcher({ webTools: false }), studio({}))
    expect((await plain.workers.list()).find((w) => w.worker === 'agent:researcher')).toMatchObject({ state: 'unavailable', unavailableReason: expect.stringMatching(/offers no web tools to a research role's read-only run/) })
  })

  it('runs a clean query unasked, asks on one that names a local path or a credential and past the bound, and records every call', async () => {
    const runtime = new Researcher()
    const ctx = await boot(runtime, studio({ max: 2 }))
    await vi.waitFor(async () => expect((await ctx.workers.list()).find((w) => w.worker === 'agent:researcher')!.capabilities.map((c) => c.capability)).toContain('web-search'), { timeout: 10_000 })
    // Two clean calls within the bound run unasked; the third is past it and asks.
    runtime.script = (prompt) => (prompt.startsWith('bound') ? [
      { tool: 'WebSearch', input: { query: 'bubblewrap 0.12 release notes' } },
      { tool: 'WebFetch', input: { url: 'https://github.com/containers/bubblewrap/releases', prompt: 'the latest release' } },
      { tool: 'WebSearch', input: { query: 'gVisor rootless systrap' } },
    ] : prompt.startsWith('local') ? [
      { tool: 'WebSearch', input: { query: `contents of ${WORKSPACE}/secrets.txt` } },
    ] : prompt.startsWith('secret') ? [
      { tool: 'WebSearch', input: { query: `is ${KEY} a valid key` } },
    ] : [])
    const bound = await runOn(ctx, 'agent:researcher', research(), 'bound: review the literature', 1)
    expect(bound).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringMatching(/stopped at its WebSearch call, which waits for the operator's approval/) } })
    expect((await runOn(ctx, 'agent:researcher', research(), 'local: review the literature', 2)).status).toBe('failed')
    expect((await runOn(ctx, 'agent:researcher', research(), 'secret: review the literature', 3)).status).toBe('failed')
    // The first verdict is the probe's own search.
    expect(runtime.verdicts.slice(1).map((v) => [v.tool, v.verdict.decision])).toEqual([['WebSearch', 'allow'], ['WebFetch', 'allow'], ['WebSearch', 'defer'], ['WebSearch', 'defer'], ['WebSearch', 'defer']])
    // Each call judged is a decision: its query or URL, its number, the bound, the egress outcome, and why it asked.
    const judged = webDecisions(ctx).map((d) => [d.outcome.option, d.outcome.detail.target, d.outcome.detail.egress, d.outcome.detail.reason ?? null, d.outcome.detail.max])
    expect(judged).toHaveLength(5)
    expect(judged).toEqual(expect.arrayContaining([
      ['auto', 'bubblewrap 0.12 release notes', 'allow', null, 2],
      ['auto', 'https://github.com/containers/bubblewrap/releases', 'allow', null, 2],
      ['ask', 'gVisor rootless systrap', 'not-checked', 'bound', 2],
      ['ask', `contents of ${WORKSPACE}/secrets.txt`, 'not-checked', 'local-path', 2],
      ['ask', `is ${KEY} a valid key`, 'deny', 'egress', 2],
    ]))
    // A call it let run names its egress decision among its inputs; one that asks also opened a request on the exact call.
    const fetched = webDecisions(ctx).find((d) => d.outcome.detail.tool === 'WebFetch')!
    const egress = fetched.inputs.map((i) => ctx.artifacts.get(i as `sha256:${string}`)!.body as { decisionType: string; outcome: { option: string } }).find((b) => b.decisionType === 'egress')!
    expect(egress.outcome.option).toBe('allow')
    const requests = await ctx.approvals.list({ states: ['open', 'batched'] })
    expect(requests.map((r) => r.action.summary).sort()).toEqual([
      `WebSearch: contents of ${WORKSPACE}/secrets.txt`, 'WebSearch: gVisor rootless systrap', `WebSearch: is ${KEY} a valid key`,
    ])
    // Every event is one the contract declares, and carries no query or URL.
    const events = ctx.eventLog.query({ type: 'agent-workers.tool.web', limit: 100 })
    expect(events).toHaveLength(6)
    for (const e of events) {
      expect(agentToolEventOf('agent-workers.tool.web', e.data), JSON.stringify(e.data)).toBeDefined()
      expect(JSON.stringify(e.data)).not.toMatch(/bubblewrap|gVisor|AKIA|secrets/)
    }
  })

  // One stack and one run per test: three stacks booted in one test add up to more than the default
  // test timeout on a loaded host, though each is quick.
  it('keeps external-send always-ask for every other role', async () => {
    const runtime = new Researcher()
    runtime.script = () => [{ tool: 'WebSearch', input: { query: 'bubblewrap 0.12 release notes' } }]
    const ctx = await boot(runtime, studio({}))
    const reads = await runOn(ctx, 'agent:reader', ordinary({ capabilities: ['review'] }), 'review the change', 1)
    expect(reads.status).toBe('failed')
    expect(runtime.verdicts.filter((v) => v.tool === 'WebSearch' && v.verdict.decision === 'defer')).toHaveLength(1)
    // The web access rule never judged it: only a research run's calls are its.
    expect(webDecisions(ctx).filter((d) => d.outcome.detail.worker === 'agent:reader')).toEqual([])
    // A reader's run is no research run: no web tools on its spec.
    expect(runtime.runs.find((r) => r.prompt.startsWith('review the change'))!.web).toBeUndefined()
  })

  it('keeps external-send always-ask for a research role with no grant', async () => {
    const none = new Researcher()
    none.script = () => [{ tool: 'WebSearch', input: { query: 'bubblewrap 0.12 release notes' } }]
    const plain = await boot(none, studio())
    expect((await runOn(plain, 'agent:researcher', research(), 'review the literature', 1)).status).toBe('failed')
    expect(webDecisions(plain).filter((d) => d.outcome.detail.worker === 'agent:researcher').map((d) => [d.outcome.option, d.outcome.detail.reason])).toEqual([['ask', 'no-grant']])
  })

  it('keeps external-send always-ask for a WebFetch when the grant is for WebSearch alone', async () => {
    const fetches = new Researcher()
    fetches.script = () => [{ tool: 'WebFetch', input: { url: 'https://example.org/' } }]
    const narrow = await boot(fetches, studio({ tools: ['WebSearch'] }))
    expect((await runOn(narrow, 'agent:researcher', research(), 'review the literature', 1)).status).toBe('failed')
    expect(webDecisions(narrow).filter((d) => d.outcome.detail.tool === 'WebFetch').map((d) => [d.outcome.option, d.outcome.detail.reason])).toEqual([['ask', 'tool-not-granted']])
  })

  it('routes a research step that prefers web-search to the research Worker of another family, and explain shows its web calls', async () => {
    const runtime = new Researcher()
    runtime.script = (prompt) => (prompt.includes('Review B') ? [{ tool: 'WebSearch', input: { query: 'X lowers Y randomized trial' } }] : [])
    const templates: Record<string, NodeTemplate[]> = {
      lit: [
        { nodeId: 'lit:1', objective: 'Review A', prompt: 'Review A: {{input}}', capabilities: ['reason', 'web-search'], tier: 'standard', kind: 'research', conversation: 'temporary', acceptance: 'acceptance.answer' },
        { nodeId: 'lit:2', objective: 'Review B', prompt: 'Review B: {{input}}', capabilities: ['reason'], prefers: ['web-search'], tier: 'standard', kind: 'research', conversation: 'temporary', acceptance: 'acceptance.answer', differentFrom: ['lit:1'] },
        { nodeId: 'join', objective: 'Join', prompt: '{{node:lit:1}}\n{{node:lit:2}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', dependsOn: ['lit:1', 'lit:2'] },
      ],
    }
    const ctx = await boot(runtime, studio({}), [researcher()], templates)
    // Two website Workers: one that searches (family a) and one that only reasons (family b).
    const executions = new Map<string, WorkerExecution>()
    const chat = (id: string, family: string, web: boolean) => ({
      schema: 'capability-descriptor@1.1' as const, worker: id, provider: 'test', family, tier: 'standard' as const, quotaClass: 'subscription-chat' as const, locality: 'remote' as const,
      capabilities: ['reason', ...(web ? ['web-search'] : [])].map((capability) => ({ capability, evidence: { kind: 'probe' as const, at: '2026-10-26T00:00:00Z' } })), state: 'ready' as const, observedAt: '2026-10-26T00:00:00Z',
    })
    ctx.workers.register({
      name: 'chat', describe: async () => [chat('chat:a', 'family-a', true), chat('chat:b', 'family-b', false)],
      start: (request) => {
        const text = `${startPrompt(request, (ref) => ctx.artifacts.get(ref)).prompt.slice(0, 40)} (${request.worker})`
        const result = ctx.artifacts.put({ kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: request.worker },
          body: { schema: 'provider-answer@1.0', provider: 'test', account: 'a', turnId: `t-${executions.size}`, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text } }).id
        const execution: WorkerExecution = { id: `chat-${executions.size}`, status: 'completed', submitted: true, result: result as `sha256:${string}`, decisions: [] }
        executions.set(execution.id, execution)
        return execution
      },
      get: (id) => executions.get(id), wait: async (id) => executions.get(id)!,
    })
    await vi.waitFor(async () => expect((await ctx.workers.list()).find((w) => w.worker === 'agent:researcher')!.capabilities.map((c) => c.capability)).toContain('web-search'), { timeout: 10_000 })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'lit', input: 'Does X lower Y?' }).runId, 30_000)
    expect(done.status).toBe('completed')
    // Review A on the website Worker that searches; review B prefers a Worker that searches too, of another family: the research Worker, not chat:b.
    expect(done.nodes.map((n) => [n.nodeId, n.worker])).toEqual([['lit:1', 'chat:a'], ['lit:2', 'agent:researcher'], ['join', 'chat:a']])
    const route = ctx.artifacts.get(ctx.workflow.records(done.runId).find((r) => r.nodeId === 'lit:2')!.execution!.route)!.body as { candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
    expect(route.candidates.find((c) => c.selected)!.reasons).toContain('proves web-search, which the work prefers')
    expect(route.candidates.find((c) => c.option === 'chat:b')!.reasons).toEqual(['admitted; agent:researcher proves web-search, which the work prefers, and this one does not'])
    expect(JSON.stringify(route)).not.toMatch(/family-[abc]/)
    // explain shows the run's web calls: how many, unasked and asked, each query with its egress outcome.
    expect(ctx.workflow.explain(done.runId)!.webCalls).toEqual({
      count: 1, auto: 1, asked: 0, denied: 0,
      calls: [{ at: expect.any(String), nodeId: 'lit:2', tool: 'WebSearch', target: 'X lowers Y randomized trial', verdict: 'auto', egress: 'allow', decision: expect.stringMatching(/^sha256:/) }],
    })
  })

  it('lets concurrent web calls take the bound one at a time: with a bound of one, of two simultaneous searches one runs and one asks', async () => {
    const runtime = new Researcher()
    const ctx = await boot(runtime, studio({ max: 1 }))
    await vi.waitFor(async () => expect((await ctx.workers.list()).find((w) => w.worker === 'agent:researcher')!.capabilities.map((c) => c.capability)).toContain('web-search'), { timeout: 10_000 })
    runtime.concurrent = true
    runtime.script = () => [
      { tool: 'WebSearch', input: { query: 'bubblewrap 0.12 release notes' } },
      { tool: 'WebSearch', input: { query: 'gVisor rootless systrap' } },
    ]
    expect((await runOn(ctx, 'agent:researcher', research(), 'review the literature', 1)).status).toBe('failed')
    // The first verdict is the probe's own search.
    expect(runtime.verdicts.slice(1).map((v) => v.verdict.decision).sort()).toEqual(['allow', 'defer'])
    const judged = webDecisions(ctx).map((d) => [d.outcome.option, d.outcome.detail.unasked, d.outcome.detail.reason ?? null])
    expect(judged.sort()).toEqual([['ask', 1, 'bound'], ['auto', 1, null]])
  })

  it('keeps a project\'s external-send forbid binding on a research run, whatever the studio\'s grant says', async () => {
    const project: AutonomyPolicy = {
      schema: 'autonomy-policy@1.0', id: 'p1.policy', version: 1, scope: 'project', projectId: 'p1', narrows: 'studio-test',
      rules: [{ actionClass: 'external-send', mode: 'forbid' }], default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86_400 },
    }
    const ctx = await boot(new Researcher(), [studio({}), project])
    const search = { tool: 'WebSearch', input: { query: 'bubblewrap 0.12 release notes' } }
    const gateOf = (projectId?: string) => runGate(ctx, { runId: `arun_${projectId ?? 'studio'}`, worker: 'agent:researcher', workspace: WORKSPACE, sessionId: `ses_${projectId ?? 'studio'}`, classification: 'operator-shared', profile: 'research', ...(projectId ? { projectId } : {}) }).gate
    // Under the project that forbids it: denied by the policy, never by the grant's auto.
    const forbidden = await gateOf('p1')(search, new AbortController().signal)
    expect(forbidden).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/the autonomy policy forbids this external-send call/) })
    expect(webDecisions(ctx).filter((d) => d.outcome.detail.agentRun === 'arun_p1')).toEqual([])
    // A run of no project: the studio's grant holds.
    expect(await gateOf()(search, new AbortController().signal)).toEqual({ decision: 'allow' })
  })

  it('denies a call its session was denied before the grant counts it: recorded as denied, never as unasked, and it takes no place in the bound', async () => {
    const ctx = await boot(new Researcher(), studio({ max: 1 }))
    const signal = new AbortController().signal
    const search = (query: string) => ({ tool: 'WebSearch', input: { query } })
    const first = runGate(ctx, { runId: 'arun_first', worker: 'agent:researcher', workspace: WORKSPACE, sessionId: 'ses_one', classification: 'operator-shared', profile: 'research' }).gate
    expect(await first(search('bubblewrap 0.12 release notes'), signal)).toEqual({ decision: 'allow' })
    // Past the bound, the second asks; the operator rejects it.
    const asked = await first(search('gVisor rootless systrap'), signal)
    expect(asked).toMatchObject({ decision: 'defer' })
    const request = (await ctx.approvals.get((asked as { requestId: string }).requestId))!
    await ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'rejected' }])
    // A later run of the session, with a fresh bound: the grant would let it run, but the session was denied it.
    const later = runGate(ctx, { runId: 'arun_later', worker: 'agent:researcher', workspace: WORKSPACE, sessionId: 'ses_one', classification: 'operator-shared', profile: 'research' }).gate
    expect(await later(search('gVisor rootless systrap'), signal)).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/rejected by the operator/) })
    const denied = webDecisions(ctx).filter((d) => d.outcome.detail.agentRun === 'arun_later')
    expect(denied.map((d) => [d.outcome.option, d.outcome.detail.target, d.outcome.detail.unasked, d.outcome.detail.reason])).toEqual([['deny', 'gVisor rootless systrap', 0, 'session-denied']])
    // No web event says it ran: its event is the denial's.
    expect(ctx.eventLog.query({ type: 'agent-workers.tool.web', limit: 100 }).filter((e) => (e.data as { agentRun: string }).agentRun === 'arun_later')).toEqual([])
    // The bound is untouched: the run's next clean call still runs unasked.
    expect(await later(search('Langfuse OTLP ingestion'), signal)).toEqual({ decision: 'allow' })
  })
})
