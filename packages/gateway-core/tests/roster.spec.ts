import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { describe, expect, it } from 'vitest'
import { formatRoster, type Known, readRoster, type Roster, ROSTER_BOUNDS, type RosterDescriptor, type RosterEntry, type RosterPool, type RosterRun, type RosterServices } from '../src/index.ts'

const NOW = new Date('2026-10-24T09:30:00.000Z')
const AT = '2026-10-24T09:29:58.000Z'
const schemas = new SchemaRegistry()

const descriptor = (worker: string, extra: Partial<RosterDescriptor> = {}): RosterDescriptor => ({
  worker, provider: 'claude-agent-sdk', family: 'claude-agent-sdk', tier: 'standard', quotaClass: 'agent-plan', locality: 'local', state: 'ready', observedAt: AT, ...extra,
})
const CLAUDE = 'claude-agent-sdk:1f0c2b7e9a5d3c41'
const CODEX = 'codex-sdk:04aa5c1e9b7d3f20'
const agentAccount = (accountId: string) => ({ id: accountId, group: accountId.split(':')[0]!, mode: 'assigned' as const })
const DECISION = `sha256:${'d'.repeat(64)}`

/** A composition's services, each replaceable: two agent accounts, one website account, a pool, a run. */
function services(over: Partial<RosterServices> = {}, workers: RosterDescriptor[] = [
  descriptor(`agent:${CLAUDE}/review`, { account: agentAccount(CLAUDE), description: 'Reviews the studio\'s diffs before they merge', load: { running: 1, queued: 1, pending: 0, slots: 2 } }),
  descriptor(`agent:${CLAUDE}/develop`, { account: agentAccount(CLAUDE), load: { running: 1, queued: 1, pending: 0, slots: 2 } }),
  descriptor(`agent:${CODEX}/review`, { provider: 'codex-sdk', family: 'codex-sdk', account: agentAccount(CODEX), state: 'unavailable', load: { running: 0, queued: 0, pending: 0, slots: 1 } }),
  descriptor('worker:plus/standard', { provider: 'chatgpt-web', family: 'chatgpt-web', quotaClass: 'subscription-chat', locality: 'remote', account: { id: 'plus', group: 'chatgpt-web', mode: 'assigned', limitUntil: '2026-10-24T11:00:00Z' }, state: 'quota-exhausted', load: { running: 0, queued: 0, pending: 0, slots: 2 } }),
]): RosterServices {
  const agents = [
    { accountId: CLAUDE, provider: 'claude-agent-sdk', slot: 1, status: 'ready' as const, hint: 't***@example.com' },
    { accountId: CODEX, provider: 'codex-sdk', slot: 2, status: 'quarantined' as const, quarantine: { reason: 'changed' as const, since: '2026-10-24T08:00:00Z', decision: DECISION } },
  ]
  const pool: RosterPool = {
    pool: `claude-plan/${CLAUDE}`, account: CLAUDE, kind: 'interactive', available: true,
    windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18_000 }, { id: 'weekly', kind: 'rolling', seconds: 604_800 }],
    readings: [{ window: { id: 'five-hour' }, state: 'ok', usedPercentage: 37.5, resetsAt: '2026-10-24T13:00:00Z', source: 'runtime-result', observedAt: '2026-10-24T09:20:00Z' }],
  }
  const runs: RosterRun[] = [
    { runId: 'run_2', template: 'agent-review', status: 'running', task: { taskId: 'task-42' }, nodes: [{ nodeId: 'review:1', state: 'RUNNING', attempt: 1, worker: `agent:${CLAUDE}/review` }] },
    { runId: 'run_1', template: 'ask', status: 'completed', nodes: [{ nodeId: 'answer', state: 'RUNNING', attempt: 1, worker: `agent:${CLAUDE}/develop` }] },
  ]
  const unknownEntry = { seq: 1, at: '2026-10-24T09:00:00.000Z', data: { schema: 'usage-unknown@1.0', runId: 'arun_1', kind: 'not-reported', account: CLAUDE, pool: pool.pool, observedAt: '2026-10-24T09:00:00.000Z', reason: 'no usage reported' } }
  return {
    workers: { list: async () => workers, sources: () => [{ source: 'website', state: 'described', at: AT, workers: 1 }, { source: 'agents', state: 'described', at: AT, workers: 3 }], siblings: (w) => { const id = workers.find((d) => d.worker === w)?.account?.id; return id ? workers.filter((o) => o.account?.id === id).map((o) => o.worker) : [w] } },
    accounts: { list: async () => [{ id: 'plus', label: 'Studio Plus', status: 'ready' }], duplicateIdentities: async () => [] },
    agentWorkers: { agentAccounts: { list: () => agents, workersIn: (a: { accountId?: string }) => workers.filter((w) => w.account?.id === a.accountId).map((w) => w.worker) } },
    resources: { pools: async () => [pool], usage: async () => ({ records: [] }) },
    eventLog: {
      query: ({ type, afterSeq, runId, nodeId }) => type === 'workflow.node.started'
        ? (runId === 'run_2' && nodeId === 'review:1' ? [{ seq: 2, at: '2026-10-24T09:20:00.000Z', data: { attempt: 0 } }, { seq: 3, at: '2026-10-24T09:26:00.000Z', data: { attempt: 1 } }] : [])
        : afterSeq === 0 ? [unknownEntry] : [],
    },
    workflow: { usage: () => runs },
    board: { task: async (taskId) => (taskId === 'task-42' ? { taskId, projectId: 'studio', title: 'Review the parser change', state: 'running' } : undefined) },
    ...over,
  }
}

const value = <T>(k: Known<T>): T => {
  if (!('value' in k)) throw new Error(`unknown: ${k.unknown}`)
  return k.value
}
const entries = (roster: Roster): RosterEntry[] => value(roster.workers)
const entry = (roster: Roster, worker: string): RosterEntry => entries(roster).find((e) => e.worker === worker)!
const valid = (roster: Roster): void => schemas.assertDef('mcp-roster@1.4', 'roster-output', roster)

describe('the roster: every Worker in one read model, projected on read (REQ-HOST-8)', () => {
  it('lists each Worker with its account, role, tier, quota class, load, work, and its account\'s pools and windows', async () => {
    const roster = await readRoster(services(), { scope: 'operator', now: NOW })
    valid(roster)
    expect(roster.asOf).toBe(NOW.toISOString())
    expect(entries(roster).map((e) => e.worker)).toEqual([`agent:${CLAUDE}/develop`, `agent:${CLAUDE}/review`, `agent:${CODEX}/review`, 'worker:plus/standard'])
    const review = entry(roster, `agent:${CLAUDE}/review`)
    expect(review).toMatchObject({
      provider: 'claude-agent-sdk', family: { value: 'claude-agent-sdk' }, role: { value: 'review' }, tier: 'standard', quotaClass: 'agent-plan',
      account: { value: { id: CLAUDE, group: 'claude-agent-sdk', mode: 'assigned', record: { value: { kind: 'agent', label: { value: 't***@example.com' }, status: 'ready', slot: 1 } } } },
      load: { value: { running: 1, queued: 1, pending: 0, slots: 2 } },
      siblings: { value: [`agent:${CLAUDE}/develop`] },
      work: { value: { items: [{ runId: 'run_2', template: 'agent-review', nodeId: 'review:1', attempt: 1, task: { taskId: 'task-42', board: { value: { projectId: 'studio', title: 'Review the parser change', state: 'running' } } } }], more: 0 } },
    })
    expect(value(review.pools)).toEqual([{
      pool: `claude-plan/${CLAUDE}`, kind: 'interactive', available: true,
      windows: [
        { id: 'five-hour', kind: 'rolling', seconds: 18_000, state: 'ok', used: { value: 37.5 }, resets: { value: '2026-10-24T13:00:00Z' }, observedAt: '2026-10-24T09:20:00Z', source: 'runtime-result' },
        { id: 'weekly', kind: 'rolling', seconds: 604_800, state: 'unknown', used: { unknown: 'no reading yet' }, resets: { unknown: 'no reading yet' } },
      ],
      // A run whose usage the ledger could not count, in the pool's current window (D25).
      unknownUsage: { value: { runs: 1, kinds: { 'not-reported': 1 } } },
    }])
    // A step of a run that is no longer running is not current work.
    expect(value(entry(roster, `agent:${CLAUDE}/develop`).work).items).toEqual([])
    expect(entry(roster, 'worker:plus/standard')).toMatchObject({ role: { value: null }, account: { value: { record: { value: { kind: 'website', label: { value: 'Studio Plus' }, status: 'ready' } } } }, pools: { value: [] } })
    expect(roster.counts).toEqual({ ready: 0, busy: 2, resting: 1, unavailable: 0, quarantined: 1 })
    expect(value(roster.sources).map((s) => s.source)).toEqual(['agents', 'website'])
  })

  it('says what each Worker is for, in the operator\'s words or as a line marked derived, and what it does now in one sentence, since its step started (T85)', async () => {
    const roster = await readRoster(services(), { scope: 'operator', now: NOW })
    valid(roster)
    const review = entry(roster, `agent:${CLAUDE}/review`)
    expect(review.description).toEqual({ value: 'Reviews the studio\'s diffs before they merge' })
    expect(review.derived).toBe('claude-agent-sdk Worker, role review, standard tier, agent-plan, local')
    // No description configured: unknown, never a default; the derived line is there for a reader to show, marked.
    expect(entry(roster, 'worker:plus/standard')).toMatchObject({ description: { unknown: 'no description is configured for it' }, derived: 'chatgpt-web Worker, standard tier, subscription-chat, remote' })
    // The step's start is its current attempt's workflow.node.started, never an earlier attempt's.
    const [work] = value(review.work).items
    expect(work).toMatchObject({ since: { value: '2026-10-24T09:26:00.000Z' }, summary: 'Working on "Review the parser change" (task task-42, project studio): agent-review run run_2, step review:1, for 4 min' })
    // Without the event log, the start is unknown and the sentence says so.
    const blind = await readRoster(services({ eventLog: undefined }), { scope: 'operator', now: NOW })
    valid(blind)
    expect(value(entry(blind, `agent:${CLAUDE}/review`).work).items[0]).toMatchObject({
      since: { unknown: 'the event log (ctx.eventLog) is not mounted' },
      summary: 'Working on "Review the parser change" (task task-42, project studio): agent-review run run_2, step review:1, since an unknown time',
    })
    // A step past the bound has its start unknown, never a guess.
    const on = [`agent:${CLAUDE}/review`, `agent:${CLAUDE}/develop`, 'worker:plus/standard']
    const many: RosterRun[] = Array.from({ length: ROSTER_BOUNDS.starts + 1 }, (_, i) => ({ runId: `run_${String(i).padStart(3, '0')}`, template: 'ask', status: 'running', nodes: [{ nodeId: 'answer', state: 'RUNNING', attempt: 1, worker: on[i % 3]! }] }))
    const busy = await readRoster(services({ workflow: { usage: () => many } }), { scope: 'operator', now: NOW })
    const items = on.flatMap((w) => value(entry(busy, w).work).items)
    expect(items.find((i) => i.runId === `run_0${ROSTER_BOUNDS.starts}`)!.since).toEqual({ unknown: `more than ${ROSTER_BOUNDS.starts} steps run now; this one's start was not read` })
    expect(items.find((i) => i.runId === 'run_000')).toMatchObject({
      since: { unknown: 'the event log holds no workflow.node.started of attempt 1 (its retention may have dropped it)' },
      summary: 'Running ask run run_000, step answer, since an unknown time',
    })
  })

  it('says beside what a Worker does now which of its runs are stalled, looked at, or held for want of a verdict, in one sentence each, and never reads a source that cannot tell as having none (PROP-0013, INV-2)', async () => {
    const review = `agent:${CLAUDE}/review`
    const develop = `agent:${CLAUDE}/develop`
    const told = {
      runs: [
        { execution: 'arun_00000000000000a1', worker: review, state: 'stalled' as const, since: '2026-10-24T09:20:00.000Z', holds: ['session ses_1'], runId: 'run_2' },
        { execution: 'arun_00000000000000a2', worker: develop, state: 'unknown' as const, since: '2026-10-24T07:30:00.000Z', holds: ['session ses_2', 'worktree /w/run_9 (branch system/run/run_9)'], runId: 'run_9' },
        { execution: 'arun_00000000000000a3', worker: develop, state: 'looking' as const, since: '2026-10-24T09:28:00.000Z', looks: { taken: 1, max: 3 }, holds: [] },
      ],
      counts: { unknown: 1, looking: 1, stalled: 1 }, unread: [] as Array<{ source: string; detail: string }>,
    }
    const base = services()
    const roster = await readRoster(services({ workers: { ...base.workers!, liveness: async () => told } }), { scope: 'operator', now: NOW })
    valid(roster)
    expect(entry(roster, review).liveness).toEqual({ value: [{
      execution: 'arun_00000000000000a1', state: 'stalled', since: '2026-10-24T09:20:00.000Z', runId: 'run_2',
      summary: 'Stalled: agent run arun_00000000000000a1 of run run_2 has shown no activity for 10 min or more; nothing is sent to it, and its own deadline ends it',
    }] })
    expect(value(entry(roster, develop).liveness!).map((l) => l.summary)).toEqual([
      'Held for 2 h: agent run arun_00000000000000a2 of run run_9 ended without being known to be gone, holding session ses_2 and worktree /w/run_9 (branch system/run/run_9); free it once its agent is gone (system free arun_00000000000000a2 --agent-gone)',
      'Not known to be gone: agent run arun_00000000000000a3 lost its holder 2 min ago and is looked at again (1 of 3 verdicts)',
    ])
    // A Worker with none has no such field; one whose source could not tell has it unknown.
    expect(entry(roster, 'worker:plus/standard')).not.toHaveProperty('liveness')
    expect(formatRoster(roster)).toContain(`  liveness   Stalled: agent run arun_00000000000000a1 of run run_2`)
    const unread = await readRoster(services({ workers: { ...base.workers!, liveness: async () => ({ runs: [], counts: { unknown: 0, looking: 0, stalled: 0 }, unread: [{ source: 'agents', detail: 'the store failed' }] }) } }), { scope: 'operator', now: NOW })
    valid(unread)
    expect(entry(unread, review).liveness).toEqual({ unknown: 'source agents could not tell (the store failed)' })
    const failed = await readRoster(services({ workers: { ...base.workers!, liveness: async () => { throw new Error('no router') } } }), { scope: 'operator', now: NOW })
    expect(entry(failed, review).liveness).toEqual({ unknown: 'it could not be read: no router' })
    // A router that tells no liveness: no field at all.
    expect(entry(await readRoster(services(), { scope: 'operator', now: NOW }), review)).not.toHaveProperty('liveness')
  })

  it('names each Worker for people, provider · account · role or tier, the label for the operator only, and counts a Worker running a step as busy whatever its source reports (T97)', async () => {
    const roster = await readRoster(services(), { scope: 'operator', now: NOW })
    valid(roster)
    expect(entry(roster, `agent:${CLAUDE}/review`).name).toBe('Claude · t***@example.com, slot 1 · review')
    expect(entry(roster, `agent:${CODEX}/review`).name).toBe('Codex · slot 2 · review')
    expect(entry(roster, 'worker:plus/standard').name).toBe('Chatgpt · Studio Plus · standard')
    const client = await readRoster(services(), { scope: 'client', now: NOW })
    valid(client)
    expect(entry(client, `agent:${CLAUDE}/review`).name).toBe('Claude · slot 1 · review')
    expect(entry(client, 'worker:plus/standard').name).toBe('Chatgpt · plus · standard')
    // No account: the rest of its own id; a model Worker's provider word is its family's.
    const bare = await readRoster(services({}, [descriptor('model:fast', { provider: 'models', family: 'openai', tier: 'standard', locality: 'remote', quotaClass: 'metered' }), descriptor('agent:solo', { family: undefined, tier: 'economy' })]), { scope: 'operator', now: NOW })
    expect(entry(bare, 'model:fast').name).toBe('Openai · fast · standard')
    expect(entry(bare, 'agent:solo').name).toBe('Claude · solo · economy')
    // Ready by its source, with no load, but the engine runs a step on it: busy, and said why.
    const quiet = await readRoster(services({}, [descriptor(`agent:${CLAUDE}/review`, { account: agentAccount(CLAUDE) })]), { scope: 'operator', now: NOW })
    expect(entry(quiet, `agent:${CLAUDE}/review`).availability).toEqual({ state: 'busy', summary: 'busy: it runs 1 step(s) now (its source reports no load)' })
    expect(quiet.counts).toMatchObject({ busy: 1, ready: 0 })
  })

  it('tells each availability apart: ready, busy N of M, resting until its reset, unavailable with why, quarantined', async () => {
    const plain = (worker: string, extra: Partial<RosterDescriptor>) => descriptor(worker, { account: agentAccount(CLAUDE), ...extra })
    const workers = [
      plain('a:ready', {}),
      plain('b:idle', { load: { running: 0, queued: 0, pending: 0, slots: 2 } }),
      plain('c:half', { load: { running: 1, queued: 0, pending: 0, slots: 2 } }),
      plain('d:full', { state: 'busy', load: { running: 2, queued: 3, pending: 1, slots: 2 } }),
      plain('e:busy-no-load', { state: 'busy' }),
      plain('f:rest-account', { state: 'quota-exhausted', account: { ...agentAccount(CLAUDE), limitUntil: '2026-10-24T11:00:00Z' } }),
      plain('g:rest-pool', { state: 'quota-exhausted' }),
      descriptor('h:rest-unknown', { state: 'quota-exhausted', account: { id: 'plus', group: 'chatgpt-web', mode: 'assigned' } }),
      descriptor('i:reauth', { state: 'reauth-required', account: { id: 'plus', group: 'chatgpt-web', mode: 'assigned' } }),
      descriptor('j:quarantined', { state: 'unavailable', account: agentAccount(CODEX) }),
      descriptor('k:no-reason', { state: 'unavailable' }),
    ]
    const closed: RosterPool = { pool: `claude-plan/${CLAUDE}`, account: CLAUDE, kind: 'interactive', available: false, until: '2026-10-24T12:00:00Z', windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18_000 }], readings: [{ window: { id: 'five-hour' }, state: 'limited', resetsAt: '2026-10-24T12:00:00Z', source: 'runtime-result', observedAt: AT }] }
    const roster = await readRoster(services({
      resources: { pools: async () => [closed], usage: async () => ({ records: [] }) },
      accounts: { list: async () => [{ id: 'plus', status: 'reauth-required' }], duplicateIdentities: async () => [] },
    }, workers), { scope: 'operator', now: NOW })
    valid(roster)
    const of = (worker: string) => entry(roster, worker).availability
    expect(of('a:ready')).toEqual({ state: 'ready', summary: 'ready' })
    expect(of('b:idle')).toEqual({ state: 'ready', summary: 'ready' })
    expect(of('c:half')).toEqual({ state: 'busy', summary: 'busy 1 of 2', running: 1, slots: 2 })
    expect(of('d:full')).toEqual({ state: 'busy', summary: 'busy 2 of 2', running: 2, slots: 2 })
    expect(of('e:busy-no-load')).toEqual({ state: 'busy', summary: expect.stringContaining('unknown') })
    expect(of('f:rest-account')).toEqual({ state: 'resting', summary: 'resting at a limit until 2026-10-24T11:00:00Z', until: { value: '2026-10-24T11:00:00Z' } })
    // No reset on the Worker: its account's closed pool says when.
    expect(of('g:rest-pool')).toMatchObject({ state: 'resting', until: { value: '2026-10-24T12:00:00Z' } })
    // One closed pool that names no reset: the account's return is unknown, never the other pool's reset.
    const unsure = await readRoster(services({ resources: { pools: async () => [closed, { ...closed, pool: 'other', until: undefined }], usage: async () => ({ records: [] }) } }, [plain('g:rest-pool', { state: 'quota-exhausted' })]), { scope: 'operator', now: NOW })
    expect(entry(unsure, 'g:rest-pool').availability).toMatchObject({ state: 'resting', until: { unknown: expect.stringContaining('no reset is known') } })
    expect(of('h:rest-unknown')).toMatchObject({ state: 'resting', until: { unknown: expect.stringContaining('no reset is known') } })
    expect(of('i:reauth')).toEqual({ state: 'unavailable', summary: 'unavailable: its account must sign in again (system account login)', reason: { value: 'its account must sign in again (system account login)' } })
    expect(of('j:quarantined')).toEqual({ state: 'quarantined', summary: 'quarantined: changed, since 2026-10-24T08:00:00Z', reason: 'changed', since: '2026-10-24T08:00:00Z', decision: DECISION })
    // Nothing says why: unknown, never a guessed reason.
    expect(of('k:no-reason')).toMatchObject({ state: 'unavailable', reason: { unknown: expect.stringContaining('gives no reason') } })
    expect(roster.counts).toEqual({ ready: 2, busy: 3, resting: 3, unavailable: 2, quarantined: 1 })
  })

  it('reads an unavailable Worker\'s reason from its account: signed out, enrolled and not verified, or one person on two website accounts', async () => {
    const workers = [
      descriptor(`agent:${CLAUDE}/review`, { state: 'unavailable', account: agentAccount(CLAUDE) }),
      descriptor('worker:a/standard', { state: 'unavailable', account: { id: 'a', group: 'chatgpt-web', mode: 'assigned' } }),
      descriptor(`agent:${CODEX}/review`, { state: 'unavailable', account: agentAccount(CODEX) }),
    ]
    const roster = await readRoster(services({
      agentWorkers: { agentAccounts: { list: () => [{ accountId: CLAUDE, provider: 'claude-agent-sdk', slot: 1, status: 'signed-out' }, { accountId: CODEX, provider: 'codex-sdk', slot: 1, status: 'enrolled' }], workersIn: () => [] } },
      accounts: { list: async () => [{ id: 'a', status: 'ready' }, { id: 'b', status: 'ready' }], duplicateIdentities: async () => [['a', 'b']] },
    }, workers), { scope: 'operator', now: NOW })
    expect(entry(roster, `agent:${CLAUDE}/review`).availability).toMatchObject({ reason: { value: 'its account is signed out (system account login)' } })
    expect(entry(roster, `agent:${CODEX}/review`).availability).toMatchObject({ reason: { value: expect.stringContaining('enrolled and not verified') } })
    expect(entry(roster, 'worker:a/standard')).toMatchObject({ account: { value: { record: { value: { sameAs: ['b'] } } } }, availability: { reason: { value: expect.stringContaining('same person as b') } } })
  })

  it('keeps a hand-named Worker that still takes work as its source describes it, its account record saying it is quarantined unverified', async () => {
    const workers = [descriptor('agent:solo', { account: { id: 'antigravity-cli', group: 'antigravity-cli', mode: 'assigned' } })]
    const roster = await readRoster(services({
      agentWorkers: { agentAccounts: { list: () => [{ provider: 'antigravity-cli', slot: 1, status: 'quarantined', quarantine: { reason: 'unverified', since: AT, decision: DECISION } }], workersIn: () => ['agent:solo'] } },
    }, workers), { scope: 'operator', now: NOW })
    valid(roster)
    expect(entry(roster, 'agent:solo')).toMatchObject({ availability: { state: 'ready' }, role: { value: null }, account: { value: { record: { value: { kind: 'agent', status: 'quarantined', quarantine: { reason: 'unverified' } } } } } })
  })

  it('shows a source that cannot be read as unknown with why, never a default, field by field', async () => {
    // Nothing mounted but the Worker registry.
    const bare = await readRoster({ workers: services().workers }, { scope: 'operator', now: NOW })
    valid(bare)
    const review = entry(bare, `agent:${CLAUDE}/review`)
    expect(review.work).toEqual({ unknown: 'the workflow engine (ctx.workflow) is not mounted' })
    expect(review.pools).toEqual({ unknown: 'the resource ledger (ctx.resources) is not mounted' })
    expect(review.role).toEqual({ unknown: expect.stringContaining('the agent accounts could not be read') })
    expect(review.account).toMatchObject({ value: { id: CLAUDE, record: { unknown: expect.stringContaining('could not be read') } } })
    expect(bare.unknownUsage).toEqual({ unknown: 'the resource ledger (ctx.resources) is not mounted' })
    // Each source that throws: its field is unknown with its error, the others still read.
    const fail = (what: string) => () => { throw new Error(`${what} is down`) }
    const broken = await readRoster(services({
      workflow: { usage: fail('the engine') },
      resources: { pools: async () => fail('the ledger')(), usage: async () => ({ records: [] }) },
      agentWorkers: { agentAccounts: { list: fail('the slots'), workersIn: () => [] } },
      board: undefined,
    }), { scope: 'operator', now: NOW })
    valid(broken)
    const one = entry(broken, `agent:${CLAUDE}/review`)
    expect(one.work).toEqual({ unknown: 'it could not be read: the engine is down' })
    expect(one.pools).toEqual({ unknown: 'it could not be read: the ledger is down' })
    expect(one.role).toEqual({ unknown: 'the agent accounts could not be read (it could not be read: the slots is down)' })
    expect(entry(broken, 'worker:plus/standard')).toMatchObject({ role: { value: null }, account: { value: { record: { value: { kind: 'website' } } } } })
    // A board task the board cannot be asked about.
    const noBoard = await readRoster(services({ board: undefined }), { scope: 'operator', now: NOW })
    expect(value(entry(noBoard, `agent:${CLAUDE}/review`).work).items[0]!.task).toEqual({ taskId: 'task-42', board: { unknown: 'the board (ctx.board) is not mounted' } })
    // The Workers themselves: no registry, or a read that fails.
    const none = await readRoster({}, { scope: 'operator', now: NOW })
    valid(none)
    expect([none.workers, none.sources]).toEqual([{ unknown: 'the Worker registry (ctx.workers) is not mounted' }, { unknown: 'the Worker registry (ctx.workers) is not mounted' }])
    const failed = await readRoster({ workers: { list: async () => { throw new Error('source agents: describe threw') }, sources: () => [{ source: 'agents', state: 'failed', at: AT, workers: 0, detail: 'describe threw' }], siblings: () => [] } }, { scope: 'operator', now: NOW })
    valid(failed)
    expect(failed.workers).toEqual({ unknown: 'it could not be read: source agents: describe threw' })
    expect(value(failed.sources)).toEqual([{ source: 'agents', state: 'failed', at: AT, workers: 0, detail: 'describe threw' }])
    expect(formatRoster(failed)).toContain('source agents failed at')
    // A descriptor without an account, family, or load says so.
    const bareWorker = await readRoster(services({}, [descriptor('model:local', { family: undefined })]), { scope: 'operator', now: NOW })
    expect(entry(bareWorker, 'model:local')).toMatchObject({ family: { unknown: expect.any(String) }, account: { unknown: expect.stringContaining('names no account') }, load: { unknown: 'its Worker source reports no load' }, pools: { unknown: expect.any(String) } })
  })

  it('is bounded: Workers, steps per Worker, runs read, board tasks read, and usage entries (INV-9)', async () => {
    const many = Array.from({ length: ROSTER_BOUNDS.workers + 44 }, (_, i) => descriptor(`w:${String(i).padStart(3, '0')}`))
    const listed = await readRoster(services({}, many), { scope: 'operator', now: NOW })
    valid(listed)
    expect([entries(listed).length, listed.unlisted, entries(listed).at(-1)!.worker]).toEqual([256, 44, 'w:255'])
    // One account with more Workers than a roster lists as siblings: unknown, never cut silently.
    const crowd = Array.from({ length: ROSTER_BOUNDS.siblings + 2 }, (_, i) => descriptor(`s:${String(i).padStart(2, '0')}`, { account: agentAccount(CLAUDE) }))
    const crowded = await readRoster(services({}, crowd), { scope: 'operator', now: NOW })
    valid(crowded)
    expect(entries(crowded)[0]!.siblings).toEqual({ unknown: `its account has ${ROSTER_BOUNDS.siblings + 1} other Workers, more than the ${ROSTER_BOUNDS.siblings} a roster lists` })

    const busy = `agent:${CLAUDE}/review`
    const runs: RosterRun[] = Array.from({ length: ROSTER_BOUNDS.runs }, (_, i) => ({ runId: `run_${String(i).padStart(3, '0')}`, template: 'ask', status: 'running', task: { taskId: `task-${String(i).padStart(3, '0')}` }, nodes: [{ nodeId: 'answer', state: 'RUNNING', attempt: 1, worker: i < 40 ? busy : 'w:other' }] }))
    let asked = 0
    const full = await readRoster(services({
      workflow: { usage: (limit) => { expect(limit).toBe(ROSTER_BOUNDS.runs); return runs } },
      board: { task: async (taskId) => { asked += 1; return { taskId, projectId: 'p', title: taskId, state: 'running' } } },
    }), { scope: 'operator', now: NOW })
    valid(full)
    const work = value(entry(full, busy).work)
    expect([work.items.length, work.more, work.unread]).toEqual([ROSTER_BOUNDS.workPerWorker, 8, `only the newest ${ROSTER_BOUNDS.runs} runs were read: an older run still running is not shown`])
    // Board tasks are read only for listed Workers' steps, at most ROSTER_BOUNDS.tasks of them.
    expect(asked).toBe(40)
    const lots: RosterRun[] = runs.map((r) => ({ ...r, nodes: [{ ...r.nodes[0]!, worker: busy }] }))
    asked = 0
    const capped = await readRoster(services({ workflow: { usage: () => lots }, board: { task: async (taskId) => { asked += 1; return { taskId, projectId: 'p', title: taskId, state: 'running' } } } }), { scope: 'operator', now: NOW })
    expect(asked).toBe(ROSTER_BOUNDS.tasks)

    // More pools on one account, or windows in one pool, than a roster lists: unknown, never cut.
    const pool = (i: number, windows = 1): RosterPool => ({ pool: `p${String(i).padStart(2, '0')}`, account: CLAUDE, kind: 'interactive', available: true, windows: Array.from({ length: windows }, (_, w) => ({ id: `w${w}`, kind: 'rolling', seconds: 3600 })), readings: [] })
    const wide = await readRoster(services({ resources: { pools: async () => Array.from({ length: ROSTER_BOUNDS.pools + 1 }, (_, i) => pool(i)), usage: async () => ({ records: [] }) } }), { scope: 'operator', now: NOW })
    valid(wide)
    expect(entry(wide, busy).pools).toEqual({ unknown: `its account has ${ROSTER_BOUNDS.pools + 1} pools, more than the ${ROSTER_BOUNDS.pools} a roster lists` })
    const deep = await readRoster(services({ resources: { pools: async () => [pool(0, ROSTER_BOUNDS.windows + 1)], usage: async () => ({ records: [] }) } }), { scope: 'operator', now: NOW })
    expect(entry(deep, busy).pools).toEqual({ unknown: `the pool p00 has ${ROSTER_BOUNDS.windows + 1} windows, more than the ${ROSTER_BOUNDS.windows} a roster lists` })
    const crowdedSources = await readRoster(services({ workers: { ...services().workers!, sources: () => Array.from({ length: ROSTER_BOUNDS.sources + 1 }, (_, i) => ({ source: `s${i}`, state: 'described' as const, at: AT, workers: 0 })) } }), { scope: 'operator', now: NOW })
    valid(crowdedSources)
    expect(crowdedSources.sources).toEqual({ unknown: `${ROSTER_BOUNDS.sources + 1} Worker sources, more than the ${ROSTER_BOUNDS.sources} a roster lists` })

    // More usage.unknown entries than are read: the pools' counts are unknown, never a partial number.
    const flood = Array.from({ length: 1000 }, (_, i) => ({ seq: i + 1, at: '2026-10-24T09:00:00.000Z', data: { schema: 'usage-unknown@1.0', runId: `arun_${i}`, kind: 'interrupted', account: CLAUDE, pool: `claude-plan/${CLAUDE}`, observedAt: '2026-10-24T09:00:00.000Z', reason: 'stopped' } }))
    const flooded = await readRoster(services({ eventLog: { query: ({ limit }) => flood.slice(0, limit) } }), { scope: 'operator', now: NOW })
    valid(flooded)
    expect(value(entry(flooded, busy).pools)[0]!.unknownUsage).toEqual({ unknown: `more than ${ROSTER_BOUNDS.unknownEntries} usage.unknown entries are in the pools' windows; only the first were read` })
    expect(capped.counts.busy).toBeGreaterThan(0)
  })

  it('is deterministic: the same reads give the same roster, whatever order the sources answer in', async () => {
    const first = await readRoster(services(), { scope: 'operator', now: NOW })
    const reversed = services()
    const listed = await reversed.workers!.list()
    const second = await readRoster({ ...reversed, workers: { ...reversed.workers!, list: async () => [...listed].reverse() } }, { scope: 'operator', now: NOW })
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('gives a client (the lead) no account label: the operator\'s only', async () => {
    const roster = await readRoster(services(), { scope: 'client', now: NOW })
    valid(roster)
    expect(JSON.stringify(roster)).not.toContain('Studio Plus')
    expect(JSON.stringify(roster)).not.toContain('t***@example.com')
    expect(entry(roster, 'worker:plus/standard').account).toMatchObject({ value: { record: { value: { kind: 'website', status: 'ready' } } } })
  })

  it('renders one block per Worker for a terminal, with what could not be read', async () => {
    const roster = await readRoster(services({ board: undefined }), { scope: 'operator', now: NOW })
    const text = formatRoster(roster)
    expect(text.split('\n')[0]).toBe('Roster as of 2026-10-24T09:30:00.000Z: 4 Worker(s): 0 ready, 2 busy, 1 resting, 0 unavailable, 1 quarantined')
    expect(text).toContain(`Claude · t***@example.com, slot 1 · review (agent:${CLAUDE}/review)  busy 1 of 2`)
    expect(text).toContain('Chatgpt · Studio Plus · standard (worker:plus/standard)  resting at a limit until 2026-10-24T11:00:00Z')
    expect(text).toContain(`Codex · slot 2 · review (agent:${CODEX}/review)  quarantined: changed, since 2026-10-24T08:00:00Z`)
    expect(text).toContain('Working on task task-42: agent-review run run_2, step review:1, for 4 min')
    expect(text).toContain('  is         Reviews the studio\'s diffs before they merge')
    expect(text).toContain('  is         chatgpt-web Worker, standard tier, subscription-chat, remote (derived: no description is configured)')
    expect(text).toContain('    window   weekly: unknown, used unknown (no reading yet), resets unknown (no reading yet)')
    expect(text).toContain('unknown usage 1 run(s)')
  })

  it('names each Worker for people, <runtime> · <account> · <role or tier> [<kinds>]: the runtime\'s title, the account\'s label for the operator only, its role and kinds; the id stays the key (mcp-roster@1.4, T103)', async () => {
    const workers = [
      descriptor(`agent:${CLAUDE}/develop`, { account: agentAccount(CLAUDE), kinds: ['code'] }),
      descriptor(`agent:${CLAUDE}/review`, { account: agentAccount(CLAUDE) }),
      descriptor(`agent:${CODEX}/develop-2`, { provider: 'codex-sdk', family: 'codex-sdk', account: agentAccount(CODEX), kinds: ['docs', 'tests'], state: 'unavailable' }),
      descriptor('worker:plus/standard', { provider: 'chatgpt-web', family: 'chatgpt-web', quotaClass: 'subscription-chat', locality: 'remote', account: { id: 'plus', group: 'chatgpt-web', mode: 'assigned' } }),
      descriptor('model:local', { provider: 'openai-compatible', family: 'openai-compatible', quotaClass: 'local' }),
    ]
    const base = services({}, workers)
    const slots = base.agentWorkers!.agentAccounts!
    const labelled = services({
      agentWorkers: {
        agentAccounts: {
          ...slots,
          labelOf: (a: { accountId?: string }) => (a.accountId === CLAUDE ? 'science' : undefined),
          providers: () => [{ provider: 'claude-agent-sdk', title: 'Claude Code' }, { provider: 'codex-sdk', title: 'Codex' }],
        },
      },
    }, workers)
    const operator = await readRoster(labelled, { scope: 'operator', now: NOW })
    valid(operator)
    expect(entries(operator).map((e) => [e.worker, e.name])).toEqual([
      [`agent:${CLAUDE}/develop`, 'Claude Code · science · develop [code]'],
      [`agent:${CLAUDE}/review`, 'Claude Code · science · review'],
      // No label: the masked hint and the slot (none here: the slot only).
      [`agent:${CODEX}/develop-2`, 'Codex · slot 2 · develop-2 [docs, tests]'],
      // No title: the provider's first word (a model Worker's, its family's); no account, the rest of its id.
      ['model:local', 'Openai · local · standard'],
      ['worker:plus/standard', 'Chatgpt · Studio Plus · standard'],
    ])
    // Without a label, the operator reads the masked hint and the slot; a runtime with no title, its provider's first word.
    const plain = await readRoster(base, { scope: 'operator', now: NOW })
    expect(entry(plain, `agent:${CLAUDE}/develop`).name).toBe('Claude · t***@example.com, slot 1 · develop [code]')
    // A client (the lead) gets no label in the name either: the slot, or the account id.
    const client = await readRoster(labelled, { scope: 'client', now: NOW })
    valid(client)
    expect(entries(client).map((e) => e.name)).toEqual(['Claude Code · slot 1 · develop [code]', 'Claude Code · slot 1 · review', 'Codex · slot 2 · develop-2 [docs, tests]', 'Openai · local · standard', 'Chatgpt · plus · standard'])
    expect(JSON.stringify(client)).not.toMatch(/science|Studio Plus|t\*\*\*@example\.com/)
    expect(formatRoster(operator)).toContain(`Claude Code · science · develop [code] (agent:${CLAUDE}/develop)  ready\n`)
  })

  it('says what the reading that quarantined an agent account found, in the availability and its summary (agent-account@1.1, T103)', async () => {
    const detail = 'slot 1 of claude-agent-sdk cannot be verified: found Claude Code 2.1.310 (/usr/bin/claude); its identity reader admits only 2.1.308'
    const roster = await readRoster(services({
      agentWorkers: { agentAccounts: { list: () => [{ accountId: CLAUDE, provider: 'claude-agent-sdk', slot: 1, status: 'quarantined', quarantine: { reason: 'unverified', since: AT, decision: DECISION, detail } }], workersIn: () => [] } },
    }, [descriptor(`agent:${CLAUDE}/review`, { state: 'unavailable', account: agentAccount(CLAUDE) })]), { scope: 'operator', now: NOW })
    valid(roster)
    expect(entry(roster, `agent:${CLAUDE}/review`).availability).toEqual({ state: 'quarantined', summary: `quarantined: unverified (${detail}), since ${AT}`, reason: 'unverified', since: AT, decision: DECISION, detail })
    expect(entry(roster, `agent:${CLAUDE}/review`).account).toMatchObject({ value: { record: { value: { quarantine: { reason: 'unverified', detail } } } } })
  })

  it('the example validates against mcp-roster@1.4, and a record that is not one is refused', async () => {
    const { readFileSync } = await import('node:fs')
    const example = JSON.parse(readFileSync(new URL('../../../schemas/examples/mcp-roster.call.json', import.meta.url), 'utf8')) as { output: Roster }
    valid(example.output)
    expect(() => valid({ ...example.output, workers: { value: [{ ...value(example.output.workers)[0]!, availability: { state: 'ready' } }] } } as Roster)).toThrow()
    expect(() => valid({ ...example.output, workers: { unknown: '' } })).toThrow()
  })
})
