/**
 * Read-only agent Workers as `review` team members (ADR-0049): the real workflow engine, routing,
 * approval queue, and `agents` source, with two scripted agent runtimes of different kinds (so two
 * provider families): one that resumes a conversation, as the Codex runtime does, and one that
 * cannot, as the Antigravity CLI runtime cannot, whose member's conversation this source replays.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry, { type AgentRuntimeProvider, type RunSpec, type ToolVerdict } from '@tsuuanmi/system-agent-runtimes'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkRequirement } from '@tsuuanmi/system-workers'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import Workflow from '@tsuuanmi/system-workflow'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import AgentWorkers, { type Config } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** Reads run on auto; everything else asks. */
const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio', rules: [{ actionClass: 'read', mode: 'auto' }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

const MATERIAL = 'Review this change:\nfunction f() {\n  const lease = acquire()\n  work()\n}'
/** Where a replayed conversation's next message starts. */
const NEXT = '### The conversation\'s next message\n'
const isProposal = (message: string): boolean => message.includes('Answer on your own')
const isDebate = (message: string): boolean => message.includes('is split')
const findings = (list: unknown[]): string => '```json\n' + JSON.stringify({ findings: list }) + '\n```'
const ballot = (choice: 'pass' | 'changes', objections: string[] = []): string => {
  const other = choice === 'pass' ? 'changes' : 'pass'
  return '```json\n' + JSON.stringify({ choice, ranking: [choice, other], rationale: `I vote ${choice}`, evidence: [], strongest: { [other]: 'it is careful' }, objections, confidence: 'high', findings: { F1: 'agree' } }) + '\n```'
}

/** A member's answer to the message it is given now: its findings, then its ballots. */
type Answer = (message: string, member: string) => string
const agreeing: Answer = (message, member) => (isProposal(message)
  ? findings([{ severity: 'warning', claim: `${member}: the lease is never released`, evidence: 'line 3', quote: { path: 'material', line: 3, text: 'const lease = acquire()' } }])
  : ballot('pass'))

/** A scripted agent runtime: every run asks its gate before its one tool call, then answers the message it was given now. */
class Member implements AgentRuntimeProvider {
  readonly runs: RunSpec[] = []
  readonly calls: ToolVerdict[] = []
  constructor(readonly kind: string, private readonly resume: boolean, private readonly answer: Answer = agreeing) {}

  async probe() {
    return { available: true, detail: `${this.kind} 1.0`, version: '1.0', sandboxes: ['read-only' as const], resume: this.resume, executes: false, readsConfined: true, gatesToolCalls: true }
  }

  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void) {
    // As the Antigravity CLI runtime does: a conversation it cannot continue is refused, never started anew.
    if (spec.resume && !this.resume) throw new ProviderError('config_error', `${this.kind}: continuing a conversation is not proven`)
    this.runs.push(spec)
    const handle = spec.resume ?? `${this.kind}-${this.runs.length}`
    onHandle?.(handle)
    this.calls.push(await spec.toolGate!({ tool: 'Read', input: { file_path: join(spec.workspace, 'README.md') }, callId: `${this.kind}-${this.runs.length}` }, signal))
    const at = spec.prompt.lastIndexOf(NEXT)
    const message = at >= 0 ? spec.prompt.slice(at + NEXT.length) : spec.prompt
    return { text: this.answer(message, this.kind), nativeHandle: handle, turns: 1 }
  }
}

const WORKSPACE = mkdtempSync(join(tmpdir(), 'system-review-members-'))
// The one file a member reads, through its gate.
writeFileSync(join(WORKSPACE, 'README.md'), '# scratch\n')
afterAll(() => rmSync(WORKSPACE, { recursive: true, force: true }))
type WorkerConfig = Config['workers'][number]
const member = (id: string, runtime: string, extra: Partial<WorkerConfig> = {}): WorkerConfig => ({
  id, runtime, workspace: WORKSPACE, sandbox: 'read-only', tier: 'standard', reviewMember: true, ...extra,
})

async function boot(runtimes: AgentRuntimeProvider[], config: Partial<Config> & Pick<Config, 'workers'>, workflow: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-review-members-db-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }),
    ctx.plugin(AgentWorkers, config), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100, ...workflow }),
  ]
  await Promise.all(fibers)
  for (const runtime of runtimes) ctx.agentRuntimes.register(runtime)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return { ctx }
}

const requirement = (overrides: Partial<WorkRequirement> = {}): WorkRequirement => ({
  schema: 'work-requirement@1.1', objective: 'a review member\'s step', capabilities: ['reason', 'persistent-conversation'], scope: 'review-member',
  data: { classification: 'public', refs: [] }, egressPolicy: 'egress.classification-and-secrets',
  tier: { min: 'standard', source: 'profile' }, acceptance: { contract: 'acceptance.answer' }, ...overrides,
})

/** Work of no scope: an ordinary step. */
const ordinary = (overrides: Partial<WorkRequirement> = {}): WorkRequirement => {
  const { scope: _scope, ...rest } = requirement(overrides)
  return { ...rest, schema: 'work-requirement@1.0' }
}

describe('read-only agent Workers as review team members (ADR-0049)', () => {
  it('offers reason only to a Worker named a review member, for a review member\'s steps only, and its conversation by replay when its runtime cannot resume', async () => {
    const { ctx } = await boot([new Member('resumes', true), new Member('replays', false)], {
      workers: [member('codex', 'resumes'), member('agy', 'replays'), member('plain', 'replays', { reviewMember: false })],
    })
    const workers = Object.fromEntries((await ctx.workers.list()).map((w) => [w.worker, w]))
    const offers = (id: string) => workers[id]!.capabilities.map((c) => [c.capability, c.evidence.kind, c.scope ?? 'any'])
    expect(workers['agent:codex']).toMatchObject({ schema: 'capability-descriptor@1.4', quotaClass: 'agent-plan', family: 'resumes' })
    expect(offers('agent:codex')).toEqual([['local-data', 'probe', 'any'], ['review', 'probe', 'any'], ['persistent-conversation', 'probe', 'any'], ['reason', 'probe', 'review-member']])
    expect(offers('agent:agy')).toEqual([['local-data', 'probe', 'any'], ['review', 'probe', 'any'], ['reason', 'probe', 'review-member'], ['persistent-conversation', 'conformance', 'review-member']])
    // Not named a review member: never reason, and no conversation its runtime cannot keep.
    expect(workers['agent:plain']).toMatchObject({ schema: 'capability-descriptor@1.1' })
    expect(offers('agent:plain')).toEqual([['local-data', 'probe', 'any'], ['review', 'probe', 'any']])
    // An ordinary ask never reaches them (P1): fail closed, the scope named.
    await expect(ctx.workers.route(ordinary({ capabilities: ['reason'] }))).rejects.toThrow(/no Worker proves reason \(.*it proves reason only for review-member work/)
    // A writer is never a review member (INV-15): the configuration is refused.
    expect(() => new AgentWorkers(new Context(), { workers: [member('writer', 'resumes', { sandbox: 'workspace-write' })] })).toThrow(/a review member must be read-only/)
  })

  it('runs a review with two agent members: one continues natively, the other by replay, each ballot judged on what its member read; asks and brainstorms never reach them', async () => {
    const resumes = new Member('resumes', true)
    const replays = new Member('replays', false)
    const { ctx } = await boot([resumes, replays], { workers: [member('codex', 'resumes'), member('agy', 'replays')] })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: MATERIAL, classification: 'public' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'completed' })
    expect(done.answer).toMatch(/^outcome: pass; method: team-majority; winner: pass;/)
    // Two provider families, one per member (ADR-0027): an agent Worker's family is its runtime.
    const byId = Object.fromEntries(done.nodes.map((n) => [n.nodeId, n]))
    expect(new Set([byId['review:m1:propose']!.worker, byId['review:m2:propose']!.worker])).toEqual(new Set(['agent:codex', 'agent:agy']))
    // Every member step is review-member work, needing reason and its conversation; nothing else is.
    for (const record of ctx.workflow.records(done.runId)) {
      const step = /^review:m\d:(propose|ballot:1)$/.test(record.nodeId)
      expect(record.requirement, record.nodeId).toMatchObject(step
        ? { schema: 'work-requirement@1.1', scope: 'review-member', capabilities: ['reason', 'persistent-conversation'] }
        : { schema: 'work-requirement@1.0' })
      if (!step) expect(record.requirement).not.toHaveProperty('scope')
    }
    // The member whose runtime resumes continues its own conversation, and is sent the ballot alone.
    expect(resumes.runs.map((r) => r.resume)).toEqual([undefined, 'resumes-1'])
    expect(resumes.runs[1]!.prompt).toMatch(/^Every member of the team has now answered on their own/)
    // The other is never asked to resume: its ballot replays its own proposal turn, as it was, then the ballot.
    expect(replays.runs.map((r) => r.resume)).toEqual([undefined, undefined])
    const replayed = replays.runs[1]!.prompt
    expect(replayed).toMatch(/^This message continues a conversation you had earlier\. Its 1 earlier turn\(s\) follow/)
    expect(replayed.indexOf(replays.runs[0]!.prompt)).toBeGreaterThan(0)
    expect(replayed).toContain('replays: the lease is never released')
    expect(replayed).toMatch(/3\s+const lease = acquire\(\)/)
    expect(replayed.slice(replayed.indexOf(NEXT) + NEXT.length)).toMatch(/^Every member of the team has now answered on their own/)
    // Its replay keeps no native handle: no brief claims to resume one.
    const ballotBrief = ctx.artifacts.get(ctx.workflow.records(done.runId).find((r) => r.nodeId === `review:m${byId['review:m1:propose']!.worker === 'agent:agy' ? 1 : 2}:ballot:1`)!.execution!.brief!)!.body
    expect(ballotBrief).not.toHaveProperty('resume')
    // Every run carried the run's gate, and the policy judged every tool call (the tool gate is unchanged).
    expect([...resumes.runs, ...replays.runs].every((r) => typeof r.toolGate === 'function')).toBe(true)
    expect([...resumes.calls, ...replays.calls].map((v) => v.decision)).toEqual(['allow', 'allow', 'allow', 'allow'])
    expect([...resumes.runs, ...replays.runs].every((r) => r.sandbox === 'read-only')).toBe(true)
    // An ask and a brainstorm fail closed, with nothing sent to an agent (P1).
    const asked = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' }).runId, 30_000)
    expect(asked).toMatchObject({ status: 'failed', error: { message: expect.stringMatching(/no Worker proves reason/) } })
    const brainstorm = await ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'q', classification: 'public' }).runId, 30_000)
    expect(brainstorm.status).toBe('failed')
    expect(resumes.runs).toHaveLength(2)
    expect(replays.runs).toHaveLength(2)
  }, 120_000)

  it('replays every earlier turn of a member that debates, its ballot included', async () => {
    // A split with objections: one debate round, after which both pass.
    const split: Answer = (message, kind) => (isProposal(message) ? agreeing(message, kind)
      : isDebate(message) ? ballot('pass') : kind === 'resumes' ? ballot('changes', ['the lease leaks']) : ballot('pass', ['it is fine']))
    const resumes = new Member('resumes', true, split)
    const replays = new Member('replays', false, split)
    const { ctx } = await boot([resumes, replays], { workers: [member('codex', 'resumes'), member('agy', 'replays')] })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: MATERIAL, classification: 'public' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'completed' })
    expect(done.answer).toMatch(/^outcome: pass; method: team-majority;/)
    expect(done.nodes.filter((n) => /:debate:1$/.test(n.nodeId)).map((n) => n.state)).toEqual(['COMPLETED', 'COMPLETED'])
    expect(ctx.workflow.records(done.runId).find((r) => /:debate:1$/.test(r.nodeId))!.requirement).toMatchObject({ scope: 'review-member' })
    expect(resumes.runs.map((r) => r.resume)).toEqual([undefined, 'resumes-1', 'resumes-1'])
    const debate = replays.runs[2]!.prompt
    expect(debate).toMatch(/^This message continues a conversation you had earlier\. Its 2 earlier turn\(s\) follow/)
    for (const earlier of replays.runs.slice(0, 2)) expect(debate).toContain(earlier.prompt.slice(earlier.prompt.lastIndexOf(NEXT) >= 0 ? earlier.prompt.lastIndexOf(NEXT) + NEXT.length : 0))
    expect(debate).toContain('### Turn 2: your answer')
    expect(debate.slice(debate.indexOf(NEXT) + NEXT.length)).toMatch(/^The vote of round 1 is split/)
  }, 120_000)

  it('never cuts a replay: a member whose earlier turns are past maxReplayChars fails before its turn is sent (INV-9)', async () => {
    const resumes = new Member('resumes', true)
    const replays = new Member('replays', false)
    const { ctx } = await boot([resumes, replays], { workers: [member('codex', 'resumes'), member('agy', 'replays')], maxReplayChars: 200 })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: MATERIAL, classification: 'public' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'invalid_input', message: expect.stringMatching(/earlier turn\(s\) hold \d+ characters, over the 200 its replay holds .*never cut/) } })
    expect(replays.runs).toHaveLength(1)
  }, 120_000)

  it('checks a replay at egress as it is sent: a credential in an earlier answer stops the member\'s next turn (INV-12)', async () => {
    // Generated at run time: never a real secret in the repository.
    const secret = String(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }))
    const leaking: Answer = (message, kind) => (isProposal(message) ? `I found this key in the change:\n${secret}\n${agreeing(message, kind)}` : ballot('pass'))
    const resumes = new Member('resumes', true)
    const replays = new Member('replays', false, leaking)
    const { ctx } = await boot([resumes, replays], { workers: [member('codex', 'resumes'), member('agy', 'replays')] })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: MATERIAL, classification: 'public' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'egress_denied' } })
    expect(replays.runs).toHaveLength(1)
  }, 120_000)

  it('refuses to continue a session its runtime cannot resume outside a review member\'s steps, and replays a reset session from scratch', async () => {
    const replays = new Member('replays', false, () => 'an answer')
    const { ctx } = await boot([replays], { workers: [member('agy', 'replays'), member('plain', 'replays', { reviewMember: false })] })
    const source = ctx.workers.source('agents')!
    const admitted = await ctx.workers.route(requirement())
    const run = async (key: string, worker: string, sessionId: string, work: WorkRequirement = requirement()) =>
      source.wait(source.start({ key, worker, prompt: key, sessionId, requirement: work, decisions: admitted.decisions }).id, 10_000)
    // A review member's session: replayed, and after a reset, replayed from the reset on.
    expect(await run('one', 'agent:agy', 'ses_member')).toMatchObject({ status: 'completed' })
    expect(await run('two', 'agent:agy', 'ses_member')).toMatchObject({ status: 'completed' })
    expect(replays.runs[1]!.prompt).toContain('### Turn 1: the message you were given')
    expect(ctx.workers.handle('ses_member')).toBeUndefined()
    expect(ctx.workers.reset('ses_member')).toBe(true)
    expect(await run('three', 'agent:agy', 'ses_member')).toMatchObject({ status: 'completed' })
    expect(replays.runs[2]!.prompt).toBe('three')
    expect(await run('four', 'agent:agy', 'ses_member')).toMatchObject({ status: 'completed' })
    expect(replays.runs[3]!.prompt).toMatch(/Its 1 earlier turn\(s\)/)
    expect(replays.runs[3]!.prompt).toContain('\nthree\n')
    expect(replays.runs[3]!.prompt).not.toContain('\none\n')
    // Not review-member work, or not a review member: the second turn is refused, unsent.
    const other = ordinary()
    expect(await run('a1', 'agent:agy', 'ses_ask', other)).toMatchObject({ status: 'completed' })
    expect(await run('a2', 'agent:agy', 'ses_ask', other)).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringMatching(/cannot continue session ses_ask: its runtime cannot resume/) } })
    expect(await run('p1', 'agent:plain', 'ses_plain')).toMatchObject({ status: 'completed' })
    expect(await run('p2', 'agent:plain', 'ses_plain')).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error' } })
    expect(replays.runs.map((r) => r.prompt).filter((p) => /^(a2|p2)$/.test(p))).toEqual([])
  })
})
