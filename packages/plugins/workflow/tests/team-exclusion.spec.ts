/**
 * Workers the operator keeps out of teams (`teams.excludeWorkers`, docs/design/teams.md#workers-left-out-of-teams):
 * no team member, the first one included, joins on a Worker it names or on any other Worker of
 * that Worker's account, or on an account it names; `allowSameFamily` never lifts it; the Workers
 * still take every other node; a team the exclusion leaves too few provider families fails
 * `config_error` before anything is sent; a member resuming its conversation on a Worker left out
 * keeps it only as this team's own in this run, recorded. The Workers are scripted as a website
 * account's tiers (siblings of one another), a second website account, and a model Worker of the
 * first one's family.
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
import type { ArtifactRef, CapabilityDescriptor, WorkerExecution, WorkerStart, WorkRequirement } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished } from 'vitest'
import { worker } from '../../../workers-core/conformance/workers.ts'
import type { Engine } from '../src/engine.ts'
import Workflow, { checkConfig, type Config } from '../src/index.ts'
import type { ResolvedNode } from '../src/spec.ts'
import { leftOutOfTeams, restriction, teamGroup } from '../src/teams.ts'
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
 * set of `accounts` that holds it; every start answers at once by `answer`, or, where `fail` says
 * so for its prompt and Worker, fails after the send with the site's own error.
 */
function scripted(ctx: Context, state: { workers: CapabilityDescriptor[]; accounts?: string[][]; answer?: (prompt: string) => string; fail?: (prompt: string, worker: string) => boolean }) {
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
      if (state.fail?.(prompt, request.worker)) {
        // The site's own error after the send: never resent, so the run fails for the operator (ADR-0062).
        const failed: WorkerExecution = { id, status: 'failed', submitted: true, error: { kind: 'overloaded', disposition: 'USER_ACTION', message: 'the site erred' }, decisions: [] }
        executions.set(id, failed)
        return failed
      }
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
    const { out, unmatched } = leftOutOfTeams(['w:web/standard'], [...WEB, CHAT, API, elsewhere], siblings([WEB_TIERS]))
    expect([...out].sort()).toEqual(['agent:web', ...WEB_TIERS].sort())
    expect(unmatched).toEqual([])
  })

  it('leaves out every Worker on a named account, by its id or as <group>/<id>, with their siblings', () => {
    const roles = [member('agent:acc/review', 'family-agent', account('acc', 'runtime')), member('agent:acc/develop', 'family-agent', account('acc', 'runtime'))]
    expect([...leftOutOfTeams(['web-main'], [...WEB, CHAT, API], siblings([WEB_TIERS])).out].sort()).toEqual([...WEB_TIERS].sort())
    expect([...leftOutOfTeams(['web/web-main'], [...WEB, CHAT, API], siblings([WEB_TIERS])).out].sort()).toEqual([...WEB_TIERS].sort())
    // Roles of one home name it as their account; a source may name siblings beyond the described ones.
    const { out } = leftOutOfTeams(['acc'], [...roles, CHAT], siblings([['agent:acc/review', 'agent:acc/develop', 'agent:acc/test']]))
    expect([...out].sort()).toEqual(['agent:acc/develop', 'agent:acc/review', 'agent:acc/test'])
  })

  it('takes a whole account with each Worker it adds, until nothing new is added (N2)', () => {
    // agent:web names the excluded account; its own source names agent:web/other as its sibling, on no descriptor.
    const elsewhere = member('agent:web', 'family-agent', account('web-main', 'web'))
    const { out } = leftOutOfTeams(['w:web/standard'], [...WEB, CHAT, elsewhere], siblings([WEB_TIERS, ['agent:web', 'agent:web/other']]))
    expect([...out].sort()).toEqual(['agent:web', 'agent:web/other', ...WEB_TIERS].sort())
  })

  it('refuses a bare account id two groups share, and takes the one named as <group>/<id> (S3)', () => {
    const one = member('w:one', 'family-web', account('default', 'web'))
    const two = member('w:two', 'family-chat', account('default', 'chat'))
    const shared = leftOutOfTeams(['default'], [one, two, CHAT], siblings([]))
    expect(shared.problem).toBe('teams.excludeWorkers entry default is the id of accounts in 2 groups (chat, web); name the one meant as <group>/default, as system roster lists it')
    const named = leftOutOfTeams(['web/default'], [one, two, CHAT], siblings([]))
    expect(named.problem).toBeUndefined()
    expect([...named.out]).toEqual(['w:one'])
  })

  it('refuses a named Worker whose source\'s siblings name different accounts, as the distinct-account rule does (S4)', () => {
    const odd = member('w:web/frontier', 'family-web', account('web-other', 'web'))
    const left = leftOutOfTeams(['w:web/standard'], [WEB[0]!, odd, CHAT], siblings([WEB_TIERS]))
    expect(left.problem).toMatch(/^teams\.excludeWorkers entry w:web\/standard: its source names w:web\/economy, w:web\/frontier, w:web\/standard as the Workers of its account, and their descriptors name different accounts/)
  })

  it('refuses a named Worker no source describes now when its described siblings name different accounts (fail closed)', () => {
    // w:web/economy is never described; its source names the tiers, whose descriptors disagree on the account.
    const odd = member('w:web/frontier', 'family-web', account('web-other', 'web'))
    const left = leftOutOfTeams(['w:web/economy'], [WEB[0]!, odd, CHAT], siblings([WEB_TIERS]))
    expect(left.problem).toMatch(/^teams\.excludeWorkers entry w:web\/economy: its source names w:web\/economy, w:web\/frontier, w:web\/standard as the Workers of its account, and their descriptors name different accounts/)
  })

  it('leaves out a Worker on no account by itself only, and reports an id no Worker or account has (S1)', () => {
    const listed = [...WEB, CHAT, API]
    expect([...leftOutOfTeams(['m:api'], listed, siblings([WEB_TIERS])).out]).toEqual(['m:api'])
    const typo = leftOutOfTeams(['m:none', 'no-account', 'm:none'], listed, siblings([WEB_TIERS]))
    expect([...typo.out]).toEqual([])
    expect(typo.unmatched).toEqual(['m:none', 'no-account'])
  })

  it('never pulls a Worker\'s siblings in for an entry that is an account id (N1)', () => {
    // An account id equal to a Worker id another source names siblings for.
    const acct = member('w:x', 'family-x', account('agent:a', 'agent'))
    const { out } = leftOutOfTeams(['agent:a'], [acct, CHAT], siblings([['agent:a', 'agent:a/review']]))
    expect([...out]).toEqual(['w:x'])
  })

  it('resolves an entry as an account before a listed Worker of the same id, whose siblings and account stay in (N1)', () => {
    // The Worker agent:a is listed, on its own account, with a sibling: an entry naming the account agent:a leaves none of them out.
    const acct = member('w:x', 'family-x', account('agent:a', 'agent'))
    const colliding = member('agent:a', 'family-agent', account('home', 'runtime'))
    const sibling = member('agent:a/review', 'family-agent', account('home', 'runtime'))
    const left = leftOutOfTeams(['agent:a'], [acct, colliding, sibling, CHAT], siblings([['agent:a', 'agent:a/review']]))
    expect(left.problem).toBeUndefined()
    expect([...left.out]).toEqual(['w:x'])
    expect(left.unmatched).toEqual([])
  })
})

describe('a team member\'s allowed Workers under teams.excludeWorkers', () => {
  /**
   * An engine as `restriction` reads it: the team's nodes, the sessions held (`held`, each joined
   * in `groups` when given), and the Workers listed.
   */
  const engine = (config: Config, nodes: Array<Partial<ResolvedNode>>, held: Record<string, string> = {}, options: { listed?: CapabilityDescriptor[]; groups?: Record<string, string> } = {}): Engine => ({
    config,
    nodeRows: () => nodes.map((spec) => ({ spec: JSON.stringify(spec) })),
    ctx: {
      workers: {
        affinity: (sessionId: string) => (held[sessionId] ? [held[sessionId]] : undefined),
        list: async () => options.listed ?? [...WEB, CHAT, API],
        siblings: (w: string) => (WEB_TIERS.includes(w) ? WEB_TIERS : [w]),
      },
      workerSessions: { session: (sessionId: string) => (held[sessionId] ? { worker: held[sessionId], group: options.groups?.[sessionId] } : undefined) },
    },
  }) as unknown as Engine
  const RUN = { run_id: 'r1' } as RunRow
  const m = (k: number, role: 'propose' | 'ballot' | 'debate' = 'propose'): Partial<ResolvedNode> => ({ nodeId: `brainstorm:m${k}:${role}`, team: { id: 'brainstorm', kind: 'brainstorm', role, member: k, members: 2, debateRounds: 1 }, session: { sessionId: `s${k}` } })
  const TEAMS = { teams: { excludeWorkers: ['web-main'] } }
  const ALLOWED = ['w:chat/standard', 'm:api']
  const LEFT = [...WEB_TIERS].sort()

  it('changes nothing without the option', async () => {
    expect(await restriction(engine({}, [m(1), m(2)]), RUN, m(1) as ResolvedNode)).toEqual({})
  })

  it('restricts the first member too, to the Workers listed now less the ones left out', async () => {
    const teams = { workers: ALLOWED, reason: LEFT_OUT }
    expect(await restriction(engine(TEAMS, [m(1), m(2)]), RUN, m(1) as ResolvedNode)).toEqual({ restrict: teams, teams, leftOut: LEFT })
  })

  it('restricts a later member by both rules, names the Workers the exclusion refuses, and keeps it alone for when the distinct-account rule is lifted (S2)', async () => {
    const held = await restriction(engine(TEAMS, [m(1), m(2)], { s1: 'w:chat/standard' }), RUN, m(2) as ResolvedNode)
    expect(held).toEqual({
      restrict: { workers: ['m:api'], reason: `${ACCOUNTS}; or, for w:web/frontier, w:web/standard, left out of teams by the operator's teams.excludeWorkers` },
      distinctAccounts: ACCOUNTS, teams: { workers: ALLOWED, reason: LEFT_OUT }, leftOut: LEFT,
    })
    // Without the option, as before.
    expect(await restriction(engine({}, [m(1), m(2)], { s1: 'w:chat/standard' }), RUN, m(2) as ResolvedNode))
      .toEqual({ restrict: { workers: [...WEB, API].map((w) => w.worker), reason: ACCOUNTS }, distinctAccounts: ACCOUNTS })
  })

  it('reports the entries that match no Worker or account, beside the ones that do (S1)', async () => {
    const typo = { teams: { excludeWorkers: ['web-main', 'claude-ma1n'] } }
    expect(await restriction(engine(typo, [m(1), m(2)]), RUN, m(1) as ResolvedNode)).toMatchObject({ teams: { workers: ALLOWED }, unmatched: ['claude-ma1n'] })
  })

  it('refuses every member, whatever its role, when the exclusion leaves the team too few provider families (B1, INV-2)', async () => {
    const listed = [...WEB, CHAT]
    const shortage = 'team brainstorm needs 2 provider families, one per member; 1 is ready outside the operator\'s teams.excludeWorkers, which leaves 1 more out of teams (ADR-0027, REQ-TEAM-8)'
    for (const node of [m(1), m(2, 'ballot'), m(2, 'debate')]) {
      expect(await restriction(engine(TEAMS, [m(1), m(2)], {}, { listed }), RUN, node as ResolvedNode))
        .toEqual({ problem: `${shortage}; nothing was sent for member m${node.team!.member}` })
    }
    // Every Worker listed left out: no member can join.
    expect(await restriction(engine({ teams: { excludeWorkers: ['web-main', 'chat-main'] } }, [m(1), m(2)], {}, { listed }), RUN, m(1) as ResolvedNode))
      .toEqual({ problem: 'team brainstorm: the operator\'s teams.excludeWorkers leaves out every Worker listed now (3), so no member can join (REQ-TEAM-8, INV-2); nothing was sent for member m1' })
  })

  it('counts only the families that can do the step, and leaves a roster short of families without the option to the family rule (B1)', async () => {
    // The model Worker cannot keep a conversation: without it the exclusion leaves one family that can.
    const requirement = { capabilities: ['persistent-conversation'] } as WorkRequirement
    const api = worker('m:api', { schema: 'capability-descriptor@1.5', provider: 'family-web', family: 'family-web', quotaClass: 'metered', proves: ['reason'] })
    expect(await restriction(engine(TEAMS, [m(1), m(2)], {}, { listed: [...WEB, CHAT, api] }), RUN, m(1) as ResolvedNode, requirement)).toMatchObject({ problem: expect.stringMatching(/^team brainstorm needs 2 provider families/) })
    // One family in all, the exclusion taking none of it away: not the exclusion's shortage.
    const chat2 = member('w:chat-2/standard', 'family-chat', account('chat-2', 'chat'))
    const chat3 = member('w:chat-3/standard', 'family-chat', account('chat-3', 'chat'))
    expect(await restriction(engine({ teams: { excludeWorkers: ['w:chat-3/standard'] } }, [m(1), m(2)], {}, { listed: [CHAT, chat2, chat3] }), RUN, m(1) as ResolvedNode))
      .toMatchObject({ restrict: { workers: ['w:chat/standard', 'w:chat-2/standard'] } })
  })

  it('keeps a member already in this team\'s conversation in this run on its Worker, and says it is left out now (B2, Model A)', async () => {
    const own = { s2: teamGroup('r1', 'brainstorm') }
    expect(await restriction(engine(TEAMS, [m(1), m(2)], { s2: 'w:web/standard' }, { groups: own }), RUN, m(2, 'ballot') as ResolvedNode))
      .toEqual({ restrict: { workers: ['w:web/standard'], reason: 'session s2 stays on its Worker: w:web/standard, which the operator\'s teams.excludeWorkers leaves out of teams, is kept as team brainstorm\'s own conversation in this run (Model A)' } })
    // A Worker not left out stays as before.
    expect(await restriction(engine(TEAMS, [m(1), m(2)], { s2: 'w:chat/standard' }, { groups: own }), RUN, m(2, 'ballot') as ResolvedNode))
      .toEqual({ restrict: { workers: ['w:chat/standard'], reason: 'session s2 stays on its Worker' } })
  })

  it('refuses a member resuming a conversation on a Worker left out that is not this team\'s in this run (B2)', async () => {
    for (const groups of [{ s2: teamGroup('r0', 'brainstorm') }, {}]) {
      expect(await restriction(engine(TEAMS, [m(1), m(2)], { s2: 'w:web/standard' }, { groups }), RUN, m(2) as ResolvedNode))
        .toEqual({ problem: 'team brainstorm: member m2 would resume session s2 on w:web/standard, which the operator\'s teams.excludeWorkers leaves out of teams, and the session is not this team\'s own conversation in this run (REQ-TEAM-8); nothing was sent for member m2' })
    }
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
    // One reason holds both rules and names the Workers the exclusion refuses, so the record tells the two apart (S2).
    expect(reasonsOf(second, 'w:web/standard')).toContain(`${ACCOUNTS}; or, for w:web/frontier, w:web/standard, left out of teams by the operator's teams.excludeWorkers`)
    expect(second.find((c) => c.selected)?.option).toBe('m:api')
    expect(ctx.eventLog.query({ type: 'workflow.team.unmatched-exclusions', runId: done.runId })).toEqual([])
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

  it('records the entries that match no Worker or account when a member routes, and leaves out the rest (S1)', async () => {
    const ctx = await boot({ teams: { excludeWorkers: ['web-main', 'claude-ma1n'] } })
    scripted(ctx, { workers: [...WEB, CHAT, API], accounts: [WEB_TIERS] })
    const done = await run(ctx, 'brainstorm', 'Which store?')
    expect(done.status).toBe('completed')
    expect(MEMBERS.map((n) => workerOf(done, n))).toEqual(['w:chat/standard', 'm:api'])
    const events = ctx.eventLog.query({ type: 'workflow.team.unmatched-exclusions', runId: done.runId })
    expect(events.map((e) => e.nodeId).sort()).toEqual([...MEMBERS].sort())
    expect(events[0]!.data).toMatchObject({ entries: ['claude-ma1n'], more: 0 })
  }, 60_000)

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

  /** The message a team the exclusion leaves one of two families fails with, for member `k`. */
  const SHORT = (k: number) => `team brainstorm needs 2 provider families, one per member; 1 is ready outside the operator's teams.excludeWorkers, which leaves 1 more out of teams (ADR-0027, REQ-TEAM-8); nothing was sent for member m${k}`

  it('fails a team the Worker it names and its siblings leave one family, at its first member, config_error, naming the exclusion, sending nothing (B1, REQ-TEAM-8, INV-2)', async () => {
    const ctx = await boot({ teams: { excludeWorkers: ['w:web/standard'] } })
    // The model Worker is not configured: the website account's other tier is its family's only other Worker.
    const started = scripted(ctx, { workers: [...WEB, CHAT], accounts: [WEB_TIERS] })
    const done = await run(ctx, 'brainstorm', 'Which store?')
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: SHORT(1) } })
    expect(started).toEqual([])
  }, 60_000)

  it('fails it under allowSameFamily too: a team never runs on one family the operator\'s exclusion made (B1, INV-2)', async () => {
    const other = member('w:chat-2/standard', 'family-chat', account('chat-2', 'chat'))
    const ctx = await boot({ allowSameFamily: true, teams: { excludeWorkers: ['web-main'] } })
    const started = scripted(ctx, { workers: [...WEB, CHAT, other], accounts: [WEB_TIERS] })
    const done = await run(ctx, 'brainstorm', 'Which store?')
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: SHORT(1) } })
    expect(started).toEqual([])
    const sameFamily = ctx.artifacts.list({ kind: 'decision', decisionType: 'admission', runId: done.runId, limit: 100 })
      .map((a) => (a.body as { outcome: { option: string } }).outcome.option).filter((o) => o.startsWith('same-family'))
    expect(sameFamily).toEqual([])
  }, 60_000)

  it('keeps the exclusion when allowSameFamily lifts the family rule, then the distinct-account rule, on a roster of one family (REQ-TEAM-8, ADR-0029, ADR-0035)', async () => {
    const other = member('w:chat-2/standard', 'family-chat', account('chat-2', 'chat'))
    // Left out: an account of the one family there is, so the exclusion takes no family away.
    const out = member('w:chat-3/standard', 'family-chat', account('chat-3', 'chat'))
    // An account of the same family stays the member's own.
    const ctx = await boot({ allowSameFamily: true, teams: { excludeWorkers: ['chat/chat-3'] } })
    const started = scripted(ctx, { workers: [out, CHAT, other] })
    const done = await run(ctx, 'brainstorm', 'Which store?')
    expect(done.status).toBe('completed')
    expect(MEMBERS.map((n) => workerOf(done, n)).sort()).toEqual(['w:chat-2/standard', 'w:chat/standard'])
    const m2 = ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === MEMBERS[1])!
    expect(m2.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'admission', outcome: 'same-family' })]))
    expect(started.filter((s) => s.worker === out.worker)).toEqual([])

    // With no other account of that family outside the exclusion, the members share one: still never the left-out Worker.
    const shared = await boot({ allowSameFamily: true, teams: { excludeWorkers: ['chat/chat-3'] } })
    const sent = scripted(shared, { workers: [out, CHAT] })
    const both = await run(shared, 'brainstorm', 'Which store?')
    expect(both.status).toBe('completed')
    expect(MEMBERS.map((n) => workerOf(both, n))).toEqual(['w:chat/standard', 'w:chat/standard'])
    expect(sent.filter((s) => s.worker === out.worker)).toEqual([])
    const lifted = shared.artifacts.list({ kind: 'decision', decisionType: 'admission', runId: both.runId, nodeId: MEMBERS[1]!, limit: 100 })
      .map((a) => a.body as { outcome: { option: string; detail?: { rules?: string[] } } }).find((d) => d.outcome.option === 'same-family-shared-account')
    // The record names the rules it lifted: the family and distinct-account rules, never the exclusion.
    expect(lifted?.outcome.detail?.rules).toEqual([expect.stringMatching(/^differs from node brainstorm:m1:propose/), ACCOUNTS])
  }, 60_000)
})

describe('a team member resuming its conversation once the exclusion is added (B2, Model A)', () => {
  it('continues an old run after the operator leaves its member\'s Worker out: kept as the team\'s own conversation in this run, and the route decision says so (INV-13)', async () => {
    const ctx = await boot()
    let erring = true
    // The ballot on the website Worker meets the site's own error the first time: the run fails after
    // both members joined, with that ballot among its failed nodes; the operator names it to continue.
    const started = scripted(ctx, { workers: [...WEB, CHAT, API], accounts: [WEB_TIERS], fail: (prompt, on) => erring && !isProposal(prompt) && on.startsWith('w:web/') })
    const failed = await run(ctx, 'brainstorm', 'Which store?')
    expect(failed.status).toBe('failed')
    expect(MEMBERS.map((n) => workerOf(failed, n))).toEqual(['w:web/standard', 'w:chat/standard'])
    const ballotNode = 'brainstorm:m1:ballot:1'
    expect(failed.nodes.filter((n) => n.state === 'FAILED').map((n) => n.nodeId)).toContain(ballotNode)

    // The operator adds the exclusion (in place of a restart on the new configuration), then continues the run.
    ;(ctx.workflow as unknown as { engine: Engine }).engine.config.teams = { excludeWorkers: ['web-main'] }
    erring = false
    const before = started.length
    // Named, as the operator names it (operator.ts: a run with more than one failed node needs the one to continue).
    ctx.workflow.continue(failed.runId, ballotNode)
    const done = await ctx.workflow.wait(failed.runId, 60_000)
    expect(done.status).toBe('completed')
    // The member resumed its own conversation on the Worker now left out, and on no other Worker of that account.
    expect(workerOf(done, ballotNode)).toBe('w:web/standard')
    expect(started.slice(before).filter((s) => s.worker.startsWith('w:web/')).map((s) => s.sessionId)).toEqual([started[0]!.sessionId])
    // Its route decision records why: kept as this team's own conversation in this run, despite the exclusion.
    const route = routeOf(ctx, done.runId, ballotNode)
    expect(reasonsOf(route, 'w:chat/standard').join(' ')).toContain('w:web/standard, which the operator\'s teams.excludeWorkers leaves out of teams, is kept as team brainstorm\'s own conversation in this run (Model A)')
  }, 60_000)
})

describe('system check of teams', () => {
  it('refuses an option under teams it does not know, so a misspelt excludeWorkers never leaves nothing out unnoticed', () => {
    expect(checkConfig({ teams: { excludeWorkers: ['web-main'] } })).toEqual([])
    expect(checkConfig({ teams: { exludeWorkers: ['web-main'] } } as Config)).toEqual(['teams.exludeWorkers is not an option; teams takes excludeWorkers'])
  })

  it('refuses what the schema refuses, and an entry listed twice, one line per entry it reads, bounded (S1)', () => {
    const check = (teams: unknown): string[] => checkConfig({ teams } as Config)
    expect(check(['w1'])).toEqual(['teams must be an object; it takes excludeWorkers, a list of Worker ids and account ids'])
    expect(check({ excludeWorkers: 'web-main' })).toEqual(['teams.excludeWorkers must be a list of Worker ids and account ids, not a single value'])
    expect(check({ excludeWorkers: ['web main', 'x'.repeat(201), 7, 'web-main', 'web-main'] })).toEqual([
      'teams.excludeWorkers[0] must be a Worker id or an account id: 1 to 200 characters, no whitespace',
      'teams.excludeWorkers[1] must be a Worker id or an account id: 1 to 200 characters, no whitespace',
      'teams.excludeWorkers[2] must be a Worker id or an account id: 1 to 200 characters, no whitespace',
      'teams.excludeWorkers lists web-main more than once',
    ])
    // It reads at most 65 entries (w0 to w64), none listed twice among them: one line in all.
    expect(check({ excludeWorkers: Array.from({ length: 1000 }, (_, i) => `w${i % 100}`) })).toEqual(['teams.excludeWorkers lists 1000 entries; it takes at most 64'])
    expect(check({ excludeWorkers: [...Array.from({ length: 64 }, (_, i) => `w${i}`), 'w0'] })).toEqual(['teams.excludeWorkers lists 65 entries; it takes at most 64', 'teams.excludeWorkers lists w0 more than once'])
    expect(check({})).toEqual([])
  })
})
