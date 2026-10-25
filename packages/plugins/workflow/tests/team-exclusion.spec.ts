/**
 * Workers the operator keeps out of teams (`teams.excludeWorkers`, docs/design/teams.md#workers-left-out-of-teams):
 * no team member, the first one included, joins on a Worker it names or on any other Worker of
 * that Worker's account, or on an account it names; `allowSameFamily` never lifts it; the Workers
 * still take every other node. The Workers are scripted as a website account's tiers (siblings of
 * one another), a second website account, and a model Worker of the first one's family.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { sha256, startPrompt } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { ArtifactRef, CapabilityDescriptor, WorkerExecution, WorkerStart } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished } from 'vitest'
import { worker } from '../../../workers-core/conformance/workers.ts'
import type { Engine } from '../src/engine.ts'
import Workflow, { checkConfig, type Config } from '../src/index.ts'
import type { ResolvedNode } from '../src/spec.ts'
import { leftOutOfTeams, restriction } from '../src/teams.ts'
import type { RunRow } from '../src/types.ts'

/** A Worker a team member may take: it reasons and keeps its conversation. */
const member = (id: string, family: string, extra: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor => worker(id, {
  schema: 'capability-descriptor@1.5', provider: family, family, proves: ['reason', 'persistent-conversation'], ...extra,
})
const account = (id: string, group: string) => ({ account: { id, group, mode: 'assigned' as const } })

/** A website account's tiers, as its source describes them (economy is not configured, so never described). */
const WEB = [member('w:web/standard', 'family-web', account('web-main', 'web')), member('w:web/frontier', 'family-web', { ...account('web-main', 'web'), tier: 'frontier' })]
const WEB_TIERS = ['w:web/economy', 'w:web/standard', 'w:web/frontier']
const CHAT = member('w:chat/standard', 'family-chat', account('chat-main', 'chat'))
/** A model Worker of the website's family, metered, on no account. */
const API = member('m:api', 'family-web', { quotaClass: 'metered' })

const isProposal = (prompt: string): boolean => prompt.includes('Answer on your own')
const ballot = (choice: string, other: string): string => JSON.stringify({ choice, ranking: [choice, other], rationale: `I prefer ${choice}`, evidence: [], strongest: { [other]: 'it is simpler' }, objections: [], confidence: 'high' })
/** A brainstorm member: its own option, then a vote for O1 with no objection. */
const brainstormer = (prompt: string): string => (isProposal(prompt)
  ? `My proposal.\n${JSON.stringify({ recommendation: `option of ${/member (\d)/.exec(prompt)?.[1]}`, rationale: 'it fits', risks: [] })}`
  : ballot('O1', 'O2'))
/** A review member: no finding, then a vote to pass. */
const reviewer = (prompt: string): string => (isProposal(prompt) ? JSON.stringify({ findings: [] }) : ballot('pass', 'changes'))

/**
 * A scripted source over `workers`: sessions stay on their Worker; each Worker's siblings are the
 * set of `accounts` that holds it; every start answers at once by `answer`.
 */
function scripted(ctx: Context, state: { workers: CapabilityDescriptor[]; accounts?: string[][]; answer?: (prompt: string) => string }) {
  const started: Array<WorkerStart & { prompt: string }> = []
  const sessions = new Map<string, string>()
  const executions = new Map<string, WorkerExecution>()
  ctx.workers.register({
    name: 'scripted', describe: async () => state.workers,
    start: (request) => {
      const prompt = startPrompt(request, (ref) => ctx.artifacts.get(ref)).prompt
      if (request.sessionId) sessions.set(request.sessionId, sessions.get(request.sessionId) ?? request.worker)
      started.push({ ...request, prompt })
      const id = `x-${started.length}`
      const result = ctx.artifacts.put({
        kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'public', producer: { type: 'worker', ref: request.worker },
        body: { schema: 'provider-answer@1.0', provider: 'scripted', account: 'scripted', turnId: id, conversation: { mode: 'temporary' }, promptHash: sha256(prompt), text: (state.answer ?? brainstormer)(prompt) },
      }).id as ArtifactRef
      const execution: WorkerExecution = { id, status: 'completed', submitted: true, result, decisions: [] }
      executions.set(id, execution)
      return execution
    },
    get: (id) => executions.get(id),
    wait: async (id) => executions.get(id)!,
    affinity: (sessionId) => (sessions.has(sessionId) ? [sessions.get(sessionId)!] : undefined),
    siblings: (id) => state.accounts?.find((set) => set.includes(id)),
  })
  return started
}

/** The website account's tiers come first wherever tier and quota class tie, so without the exclusion its Worker is a member. */
async function boot(config: Config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-team-exclusion-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, { priority: ['w:web/standard'] }), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100, ...config }),
  ]
  await Promise.all(fibers)
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return ctx
}

const run = (ctx: Context, template: string, input: string) => ctx.workflow.wait(ctx.workflow.start({ template, input, classification: 'public' }).runId, 60_000)
const workerOf = (view: { nodes: Array<{ nodeId: string; worker?: string }> }, nodeId: string): string | undefined => view.nodes.find((n) => n.nodeId === nodeId)?.worker
const MEMBERS = ['brainstorm:m1:propose', 'brainstorm:m2:propose']

type Candidates = Array<{ option: string; selected: boolean; reasons: string[] }>
/** Each candidate of the route decision that started a node. */
const routeOf = (ctx: Context, runId: string, nodeId: string): Candidates => {
  const record = ctx.workflow.records(runId).find((r) => r.nodeId === nodeId)!
  return (ctx.artifacts.get(record.execution!.route)!.body as { candidates: Candidates }).candidates
}
const reasonsOf = (candidates: Candidates, option: string): string[] => candidates.find((c) => c.option === option)?.reasons ?? []

const LEFT_OUT = 'team brainstorm: left out of teams by the operator\'s teams.excludeWorkers'
const ACCOUNTS = 'team brainstorm: members use distinct accounts (REQ-TEAM-4); another member holds this account'

describe('the Workers teams.excludeWorkers leaves out of teams', () => {
  const siblings = (sets: string[][]) => (w: string): string[] => sets.find((s) => s.includes(w)) ?? [w]

  it('leaves out a named Worker with its account: its siblings, described or not, and every Worker naming its account', () => {
    const elsewhere = member('agent:web', 'family-agent', account('web-main', 'web'))
    const out = leftOutOfTeams(['w:web/standard'], [...WEB, CHAT, API, elsewhere], siblings([WEB_TIERS]))
    expect([...out].sort()).toEqual(['agent:web', ...WEB_TIERS].sort())
  })

  it('leaves out every Worker on a named account, by its id in any group, with their siblings', () => {
    const roles = [member('agent:acc/review', 'family-agent', account('acc', 'runtime')), member('agent:acc/develop', 'family-agent', account('acc', 'runtime'))]
    expect([...leftOutOfTeams(['web-main'], [...WEB, CHAT, API], siblings([WEB_TIERS]))].filter((w) => w !== 'web-main').sort()).toEqual([...WEB_TIERS].sort())
    // Roles of one home name it as their account; a source may name siblings beyond the described ones.
    const out = leftOutOfTeams(['acc'], [...roles, CHAT], siblings([['agent:acc/review', 'agent:acc/develop', 'agent:acc/test']]))
    expect([...out].filter((w) => w !== 'acc').sort()).toEqual(['agent:acc/develop', 'agent:acc/review', 'agent:acc/test'])
  })

  it('leaves out a Worker on no account by itself only, and nothing for an id no Worker has', () => {
    const listed = [...WEB, CHAT, API]
    expect([...leftOutOfTeams(['m:api'], listed, siblings([WEB_TIERS]))]).toEqual(['m:api'])
    expect(listed.filter((w) => leftOutOfTeams(['m:none', 'no-account'], listed, siblings([WEB_TIERS])).has(w.worker))).toEqual([])
  })
})

describe('a team member\'s allowed Workers under teams.excludeWorkers', () => {
  /** An engine as `restriction` reads it: the team's nodes, sessions, and Workers. */
  const engine = (config: Config, nodes: Array<Partial<ResolvedNode>>, held: Record<string, string> = {}): Engine => ({
    config,
    nodeRows: () => nodes.map((spec) => ({ spec: JSON.stringify(spec) })),
    ctx: {
      workers: {
        affinity: (sessionId: string) => (held[sessionId] ? [held[sessionId]] : undefined),
        list: async () => [...WEB, CHAT, API],
        siblings: (w: string) => (WEB_TIERS.includes(w) ? WEB_TIERS : [w]),
      },
      workerSessions: { session: (sessionId: string) => (held[sessionId] ? { worker: held[sessionId] } : undefined) },
    },
  }) as unknown as Engine
  const RUN = { run_id: 'r1' } as RunRow
  const m = (k: number): Partial<ResolvedNode> => ({ nodeId: `brainstorm:m${k}:propose`, team: { id: 'brainstorm', kind: 'brainstorm', role: 'propose', member: k, members: 2, debateRounds: 1 }, session: { sessionId: `s${k}` } })
  const TEAMS = { teams: { excludeWorkers: ['web-main'] } }
  const ALLOWED = ['w:chat/standard', 'm:api']

  it('changes nothing without the option', async () => {
    expect(await restriction(engine({}, [m(1), m(2)]), RUN, m(1) as ResolvedNode)).toEqual({})
  })

  it('restricts the first member too, to the Workers listed now less the ones left out', async () => {
    const teams = { workers: ALLOWED, reason: LEFT_OUT }
    expect(await restriction(engine(TEAMS, [m(1), m(2)]), RUN, m(1) as ResolvedNode)).toEqual({ restrict: teams, teams })
  })

  it('restricts a later member by both rules, and keeps the exclusion alone for when the distinct-account rule is lifted', async () => {
    const held = await restriction(engine(TEAMS, [m(1), m(2)], { s1: 'w:chat/standard' }), RUN, m(2) as ResolvedNode)
    expect(held).toEqual({
      restrict: { workers: ['m:api'], reason: `${ACCOUNTS}, or it is left out of teams by the operator's teams.excludeWorkers` },
      distinctAccounts: ACCOUNTS, teams: { workers: ALLOWED, reason: LEFT_OUT },
    })
    // Without the option, as before.
    expect(await restriction(engine({}, [m(1), m(2)], { s1: 'w:chat/standard' }), RUN, m(2) as ResolvedNode))
      .toEqual({ restrict: { workers: [...WEB, API].map((w) => w.worker), reason: ACCOUNTS }, distinctAccounts: ACCOUNTS })
  })

  it('keeps a member already in its conversation on its Worker, though it is left out now (Model A)', async () => {
    expect(await restriction(engine(TEAMS, [m(1), m(2)], { s2: 'w:web/standard' }), RUN, m(2) as ResolvedNode))
      .toEqual({ restrict: { workers: ['w:web/standard'], reason: 'session s2 stays on its Worker' } })
  })
})

describe('teams.excludeWorkers keeps Workers out of team runs, and only out of them (D58)', () => {
  it('routes a brainstorm\'s members around the account it names, the first one too, and says why in each route decision (REQ-TEAM-8)', async () => {
    // Control: without the option, the website account takes the first member.
    const control = await boot()
    scripted(control, { workers: [...WEB, CHAT, API], accounts: [WEB_TIERS] })
    const before = await run(control, 'brainstorm', 'Which store?')
    expect(before.status).toBe('completed')
    expect(MEMBERS.map((n) => workerOf(before, n))).toEqual(['w:web/standard', 'w:chat/standard'])

    const ctx = await boot({ teams: { excludeWorkers: ['web-main'] } })
    const started = scripted(ctx, { workers: [...WEB, CHAT, API], accounts: [WEB_TIERS] })
    const done = await run(ctx, 'brainstorm', 'Which store?')
    expect(done.status).toBe('completed')
    expect(MEMBERS.map((n) => workerOf(done, n))).toEqual(['w:chat/standard', 'm:api'])
    expect(started.filter((s) => s.worker.startsWith('w:web/'))).toEqual([])
    const first = routeOf(ctx, done.runId, MEMBERS[0]!)
    for (const w of WEB) expect(reasonsOf(first, w.worker)).toEqual([LEFT_OUT])
    const second = routeOf(ctx, done.runId, MEMBERS[1]!)
    expect(reasonsOf(second, 'w:web/standard')).toContain(`${ACCOUNTS}, or it is left out of teams by the operator's teams.excludeWorkers`)
    expect(second.find((c) => c.selected)?.option).toBe('m:api')
  }, 60_000)

  it('tells a surface which Workers it keeps out of teams, read only: the entries and each Worker they leave out now, its account\'s Workers with it (T141)', async () => {
    expect(await (await boot()).workflow.teamExclusion()).toEqual({ entries: [], workers: [] })
    const ctx = await boot({ teams: { excludeWorkers: ['web-main'] } })
    scripted(ctx, { workers: [...WEB, CHAT, API], accounts: [WEB_TIERS] })
    expect(await ctx.workflow.teamExclusion()).toEqual({ entries: ['web-main'], workers: [...WEB_TIERS].sort() })
    // A read decides nothing: no run, no decision.
    expect(ctx.workflow.usage(10)).toEqual([])
    expect(ctx.artifacts.list({ kind: 'decision', limit: 10 })).toEqual([])
  })

  it('keeps a review team off it as well (REQ-TEAM-8)', async () => {
    const ctx = await boot({ teams: { excludeWorkers: ['web-main'] } })
    const started = scripted(ctx, { workers: [...WEB, CHAT, API], accounts: [WEB_TIERS], answer: reviewer })
    const done = await run(ctx, 'review', 'Review this:\nconst lease = acquire()\nrelease(lease)\n')
    expect(done).toMatchObject({ status: 'completed', answer: expect.stringMatching(/^outcome: pass; method: team-majority/) })
    expect(['review:m1:propose', 'review:m2:propose'].map((n) => workerOf(done, n))).toEqual(['w:chat/standard', 'm:api'])
    expect(started.filter((s) => s.worker.startsWith('w:web/'))).toEqual([])
  }, 60_000)

  it('leaves the Workers to every node that is not a team member (REQ-TEAM-8)', async () => {
    const ctx = await boot({ teams: { excludeWorkers: ['w:web/standard'] } })
    scripted(ctx, { workers: [...WEB, CHAT, API], accounts: [WEB_TIERS], answer: () => 'An answer.' })
    const asked = await run(ctx, 'ask', 'What is a lease?')
    expect(asked.status).toBe('completed')
    expect(workerOf(asked, 'ask:1')).toBe('w:web/standard')
  }, 60_000)

  it('fails a member that finds no other family once the Worker it names and its siblings are left out, config_error, naming the exclusion, sending nothing (REQ-TEAM-8, INV-2)', async () => {
    const ctx = await boot({ teams: { excludeWorkers: ['w:web/standard'] } })
    // The model Worker is not configured: the website account's other tier is its family's only other Worker.
    const started = scripted(ctx, { workers: [...WEB, CHAT], accounts: [WEB_TIERS] })
    const done = await run(ctx, 'brainstorm', 'Which store?')
    expect(done).toMatchObject({
      status: 'failed',
      error: { kind: 'config_error', message: expect.stringMatching(/^team brainstorm needs 2 provider families, one per member; 1 is ready outside the operator's teams\.excludeWorkers, which leaves 1 more out of teams \(ADR-0027\)\. no Worker can take this work/) },
    })
    expect((done.error as { message: string }).message).toContain(`w:web/frontier: ${ACCOUNTS}, or it is left out of teams by the operator's teams.excludeWorkers`)
    expect(started.map((s) => s.worker)).toEqual(['w:chat/standard'])
  }, 60_000)

  it('keeps the exclusion when allowSameFamily lifts the family rule, then the distinct-account rule (REQ-TEAM-8, ADR-0029, ADR-0035)', async () => {
    const other = member('w:chat-2/standard', 'family-chat', account('chat-2', 'chat'))
    // An account of the same family stays the member's own.
    const ctx = await boot({ allowSameFamily: true, teams: { excludeWorkers: ['web-main'] } })
    const started = scripted(ctx, { workers: [...WEB, CHAT, other], accounts: [WEB_TIERS] })
    const done = await run(ctx, 'brainstorm', 'Which store?')
    expect(done.status).toBe('completed')
    expect(MEMBERS.map((n) => workerOf(done, n)).sort()).toEqual(['w:chat-2/standard', 'w:chat/standard'])
    const m2 = ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === MEMBERS[1])!
    expect(m2.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'admission', outcome: 'same-family' })]))
    expect(started.filter((s) => s.worker.startsWith('w:web/'))).toEqual([])

    // With no other account of that family, the members share one: still never the left-out Workers.
    const shared = await boot({ allowSameFamily: true, teams: { excludeWorkers: ['web-main'] } })
    const sent = scripted(shared, { workers: [...WEB, CHAT], accounts: [WEB_TIERS] })
    const both = await run(shared, 'brainstorm', 'Which store?')
    expect(both.status).toBe('completed')
    expect(MEMBERS.map((n) => workerOf(both, n))).toEqual(['w:chat/standard', 'w:chat/standard'])
    expect(sent.filter((s) => s.worker.startsWith('w:web/'))).toEqual([])
    const lifted = shared.artifacts.list({ kind: 'decision', decisionType: 'admission', runId: both.runId, nodeId: MEMBERS[1]!, limit: 100 })
      .map((a) => a.body as { outcome: { option: string; detail?: { rules?: string[] } } }).find((d) => d.outcome.option === 'same-family-shared-account')
    // The record names the rules it lifted: the family and distinct-account rules, never the exclusion.
    expect(lifted?.outcome.detail?.rules).toEqual([expect.stringMatching(/^differs from node brainstorm:m1:propose/), ACCOUNTS])
  }, 60_000)
})

describe('system check of teams', () => {
  it('refuses an option under teams it does not know, so a misspelt excludeWorkers never leaves nothing out unnoticed', () => {
    expect(checkConfig({ teams: { excludeWorkers: ['web-main'] } })).toEqual([])
    expect(checkConfig({ teams: { exludeWorkers: ['web-main'] } } as Config)).toEqual(['teams.exludeWorkers is not an option; teams takes excludeWorkers'])
  })
})
