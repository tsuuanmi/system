import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { describe, expect, it } from 'vitest'
import { type Capacity, CAPACITY_BOUNDS, formatCapacity, formatRoster, type Known, readCapacity, readRoster, type RosterDescriptor, type RosterPool, type RosterServices, urgency } from '../src/index.ts'

const NOW = new Date('2026-10-24T09:30:00.000Z')
const AT = '2026-10-24T09:29:58.000Z'
const IN = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString()
const schemas = new SchemaRegistry()
const valid = (c: Capacity): void => schemas.assertDef('mcp-roster@1.7', 'capacity', c)

const value = <T>(k: Known<T>): T => {
  if (!('value' in k)) throw new Error(`unknown: ${k.unknown}`)
  return k.value
}

/** A ready Worker on its own account, offering `answer` and `code` at the standard tier. */
const worker = (account: string, extra: Partial<RosterDescriptor> = {}): RosterDescriptor => ({
  worker: `agent:${account}/develop`, provider: 'claude-agent-sdk', family: 'claude-agent-sdk', tier: 'standard', quotaClass: 'agent-plan', locality: 'local', state: 'ready', observedAt: AT,
  account: { id: account, group: 'claude-agent-sdk', mode: 'assigned' }, load: { running: 0, queued: 0, pending: 0, slots: 2 },
  capabilities: [{ capability: 'answer' }, { capability: 'code' }], ...extra,
})
/** An account's five-hour pool, with a reading (used %, reset) or none. */
const pool = (account: string, reading?: { used?: number; resetsAt?: string; state?: 'ok' | 'limited' }, extra: Partial<RosterPool> = {}): RosterPool => ({
  pool: `plan/${account}`, account, kind: 'interactive', available: true,
  windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18_000 }],
  readings: reading ? [{ window: { id: 'five-hour' }, state: reading.state ?? 'ok', ...(reading.used !== undefined ? { usedPercentage: reading.used } : {}), ...(reading.resetsAt ? { resetsAt: reading.resetsAt } : {}), source: 'usage-report', observedAt: AT }] : [],
  ...extra,
})

function services(workers: RosterDescriptor[], pools: RosterPool[] | undefined, over: Partial<RosterServices> = {}): RosterServices {
  return {
    workers: { list: async () => workers, sources: () => [{ source: 'agents', state: 'described', at: AT, workers: workers.length }], siblings: (w) => [w] },
    agentWorkers: { agentAccounts: { list: () => [], workersIn: () => [] } },
    ...(pools ? { resources: { pools: async () => pools, usage: async () => ({ records: [] }) } } : {}),
    workflow: { usage: () => [] },
    ...over,
  }
}

describe('capacity now: the Right now summary, made once on the server from the roster and the board (T152)', () => {
  it('lists first the free Worker whose quota would be lost unused soonest: 10 % used resetting in 40 min before 85 % used resetting in 4 h', async () => {
    // The ids sort the other way, so the order is the quota's, not the id's.
    const soon = 'b-soon'
    const late = 'a-late'
    const c = await readCapacity(services([worker(late), worker(soon)], [pool(soon, { used: 10, resetsAt: IN(40) }), pool(late, { used: 85, resetsAt: IN(240) })]), { scope: 'operator', now: NOW })
    valid(c)
    expect(value(c.free).items.map((f) => f.worker)).toEqual([`agent:${soon}/develop`, `agent:${late}/develop`])
    // No agent account is enrolled here, so the Worker serves no role: it is named by its tier.
    expect(value(c.free).items[0]).not.toHaveProperty('role')
    expect(value(c.free).items[0]).toMatchObject({ name: `Claude · ${soon} · standard`, account: soon, tier: 'standard', load: { value: { running: 0, slots: 2 } }, quota: { pool: `plan/${soon}`, window: 'five-hour', seconds: 18_000, used: 10, left: 90, resetsAt: IN(40) } })
    expect(urgency(value(c.free).items[0]!.quota!, NOW)).toBeGreaterThan(urgency(value(c.free).items[1]!.quota!, NOW))
    // Each account takes work now, and says why.
    expect(value(c.accounts).items.map((a) => [a.account, a.canWork])).toEqual([[late, { value: true }], [soon, { value: true }]])
    expect(value(c.accounts).items[1]!.summary).toBe(`1 of its Worker(s) take work now; 90 % left of five-hour (used 10 %), resets ${IN(40)}`)
    // Ties: the same quota on both accounts, ordered by id.
    const tie = await readCapacity(services([worker('y'), worker('x')], [pool('x', { used: 50, resetsAt: IN(60) }), pool('y', { used: 50, resetsAt: IN(60) })]), { scope: 'operator', now: NOW })
    expect(value(tie.free).items.map((f) => f.account)).toEqual(['x', 'y'])
    // A Worker no account quota applies to (it names no account, or its account has no pool) comes after every one that has a quota.
    const mixed = await readCapacity(services([worker('q'), worker('none', { worker: 'model:fast', account: undefined }), worker('bare')], [pool('q', { used: 99, resetsAt: IN(600) })]), { scope: 'operator', now: NOW })
    expect(value(mixed.free).items.map((f) => [f.worker, f.quota === null])).toEqual([['agent:q/develop', false], ['agent:bare/develop', true], ['model:fast', true]])
  })

  it('never counts an unknown reading as free capacity (INV-2): no reading, no used share, a reset already past, or no ledger', async () => {
    const workers = [worker('read'), worker('none'), worker('noshare'), worker('stale')]
    const c = await readCapacity(services(workers, [
      pool('read', { used: 20, resetsAt: IN(120) }), pool('none'), pool('noshare', { resetsAt: IN(30) }), pool('stale', { used: 5, resetsAt: IN(-10) }),
    ]), { scope: 'operator', now: NOW })
    valid(c)
    expect(value(c.free).items.map((f) => f.account)).toEqual(['read'])
    expect(value(c.quotaUnknown).items.map((u) => u.account)).toEqual(['none', 'noshare', 'stale'])
    expect(value(c.quotaUnknown).items[0]!.why).toContain('no window of its account has a current reading')
    const accounts = new Map(value(c.accounts).items.map((a) => [a.account, a]))
    for (const id of ['none', 'noshare', 'stale']) expect(accounts.get(id)!.canWork, id).toEqual({ unknown: expect.stringContaining('no window of its account has a current reading') })
    // Each window is shown as read, the unknown ones with why.
    expect(value(accounts.get('none')!.windows)).toEqual([{ pool: 'plan/none', id: 'five-hour', seconds: 18_000, state: 'unknown', used: { unknown: 'no reading yet' }, resets: { unknown: 'no reading yet' } }])
    // No ledger: every ready Worker's quota is unknown, none of them free.
    const blind = await readCapacity(services(workers, undefined), { scope: 'operator', now: NOW })
    valid(blind)
    expect(value(blind.free).items).toEqual([])
    expect(value(blind.quotaUnknown).items.map((u) => u.why)).toEqual(Array(4).fill('the resource ledger (ctx.resources) is not mounted'))
    expect(value(blind.accounts).items.every((a) => 'unknown' in a.canWork && 'unknown' in a.windows)).toBe(true)
    // No Workers known: every list is unknown, never empty.
    const none = await readCapacity({}, { scope: 'operator', now: NOW })
    valid(none)
    for (const list of [none.accounts, none.free, none.quotaUnknown, none.stalled, none.noQuota, none.cannotWork]) expect(list).toEqual({ unknown: 'the Workers are unknown (the Worker registry (ctx.workers) is not mounted)' })
  })

  it('names the accounts with no quota left and until when, the Workers that cannot work and why, and the stalled runs', async () => {
    const workers = [
      worker('limit', { state: 'quota-exhausted', account: { id: 'limit', group: 'g', mode: 'assigned', limitUntil: IN(90) } }),
      worker('closed'),
      worker('window'),
      worker('down', { state: 'unavailable' }),
      worker('ok'),
    ]
    const c = await readCapacity(services(workers, [
      pool('closed', { used: 100, resetsAt: IN(20), state: 'limited' }, { available: false, until: IN(20) }),
      pool('window', { used: 100, state: 'limited' }),
      pool('ok', { used: 30, resetsAt: IN(60) }),
    ], {
      workers: {
        list: async () => workers, siblings: (w) => [w],
        liveness: async () => ({ runs: [{ execution: 'arun_1', worker: 'agent:ok/develop', state: 'stalled', since: IN(-15), holds: [], runId: 'run_1' }, { execution: 'arun_2', worker: 'agent:ok/develop', state: 'looking', since: IN(-1), holds: [] }], counts: { stalled: 1, looking: 1, unknown: 0 }, unread: [] }),
      },
    }), { scope: 'operator', now: NOW })
    valid(c)
    expect(value(c.noQuota).items).toEqual([
      { account: 'closed', name: 'Claude · closed', until: { value: IN(20) } },
      { account: 'limit', name: 'Claude · limit', until: { value: IN(90) } },
      { account: 'window', name: 'Claude · window', until: { unknown: expect.stringContaining('no reset is known') } },
    ])
    // A Worker ready by its source on an account at a limit is not free.
    expect(value(c.free).items.map((f) => f.account)).toEqual(['ok'])
    expect(value(c.accounts).items.find((a) => a.account === 'closed')).toMatchObject({ canWork: { value: false }, summary: `at its limit until ${IN(20)}` })
    expect(value(c.accounts).items.find((a) => a.account === 'down')).toMatchObject({ canWork: { value: false }, summary: 'none of its 1 Worker(s) takes work now (unavailable)' })
    expect(value(c.cannotWork).items).toEqual([{ worker: 'agent:down/develop', name: 'Claude · down · standard', state: 'unavailable', reason: expect.stringContaining('unavailable: unknown') }])
    expect(value(c.stalled)).toEqual({ items: [{ worker: 'agent:ok/develop', name: 'Claude · ok · standard', execution: 'arun_1', runId: 'run_1', since: IN(-15) }], more: 0 })
    // A source that cannot tell liveness is said, never read as no stalled run.
    const untold = await readCapacity(services([worker('ok')], [pool('ok', { used: 30, resetsAt: IN(60) })], {
      workers: { list: async () => [worker('ok')], siblings: (w) => [w], liveness: async () => { throw new Error('no router') } },
    }), { scope: 'operator', now: NOW })
    expect(value(untold.stalled)).toEqual({ items: [], more: 0, unread: 'the liveness of 1 Worker(s) could not be told (it could not be read: no router)' })
  })

  it('lists the ready tasks of the active projects, each with the Worker a start would most likely go to, as the start preview tells it', async () => {
    const workers = [worker('soon'), worker('late'), worker('econ', { tier: 'economy', capabilities: [{ capability: 'answer' }] }), worker('docs', { kinds: ['docs'] })]
    const pools = [pool('soon', { used: 10, resetsAt: IN(40) }), pool('late', { used: 85, resetsAt: IN(240) }), pool('econ', { used: 0, resetsAt: IN(10) }), pool('docs', { used: 0, resetsAt: IN(5) })]
    const steps: Record<string, Array<{ capabilities: string[]; tier: 'economy' | 'standard' | 'frontier'; kind?: string; source?: true }>> = {
      develop: [{ capabilities: [], tier: 'economy', source: true }, { capabilities: ['code'], tier: 'standard' }],
      big: [{ capabilities: ['answer'], tier: 'frontier' }],
      write: [{ capabilities: ['answer'], tier: 'standard', kind: 'docs' }],
    }
    const tasks = [
      { taskId: 't-2', projectId: 'alpha', title: 'Fix the parser', state: 'ready', template: 'develop', createdAt: '2026-10-24T08:00:00.000Z' },
      { taskId: 't-1', projectId: 'alpha', title: 'Needs a frontier Worker', state: 'ready', template: 'big', createdAt: '2026-10-24T09:00:00.000Z' },
      { taskId: 't-3', projectId: 'beta', title: 'No template', state: 'ready', createdAt: '2026-10-24T07:00:00.000Z' },
      { taskId: 't-4', projectId: 'beta', title: 'Gone template', state: 'ready', template: 'retired', createdAt: '2026-10-24T07:30:00.000Z' },
      { taskId: 't-5', projectId: 'beta', title: 'Write the guide', state: 'ready', template: 'write', createdAt: '2026-10-24T07:40:00.000Z' },
    ]
    const asked: string[] = []
    const board: NonNullable<RosterServices['board']> = {
      task: async () => undefined,
      projects: async (filter) => { asked.push(`projects:${filter?.state}`); return [{ projectId: 'beta' }, { projectId: 'alpha' }] },
      tasks: async ({ projectId, states }) => { asked.push(`${projectId}:${states?.join(',')}`); return tasks.filter((t) => t.projectId === projectId) },
    }
    const c = await readCapacity(services(workers, pools, { board, workflow: { usage: () => [], templateSteps: (name) => steps[name] } }), { scope: 'operator', now: NOW })
    valid(c)
    expect(asked).toEqual(['projects:active', 'alpha:ready', 'beta:ready'])
    // The docs Worker takes only docs work; the economy one is below the step's tier: the most urgent able one is soon.
    expect(value(c.ready)).toEqual({
      items: [
        { projectId: 'alpha', taskId: 't-2', title: 'Fix the parser', template: 'develop', likely: { value: { worker: 'agent:soon/develop', name: 'Claude · soon · standard' } } },
        { projectId: 'alpha', taskId: 't-1', title: 'Needs a frontier Worker', template: 'big', likely: { value: null } },
        { projectId: 'beta', taskId: 't-3', title: 'No template', likely: { unknown: 'it names no template: the lead starts it with one it chooses' } },
        { projectId: 'beta', taskId: 't-4', title: 'Gone template', template: 'retired', likely: { unknown: 'its template retired is not served now' } },
        { projectId: 'beta', taskId: 't-5', title: 'Write the guide', template: 'write', likely: { value: { worker: 'agent:docs/develop', name: 'Claude · docs · standard [docs]' } } },
      ],
      more: 0,
    })
    // No board, or one that cannot list: unknown, never no task ready.
    expect((await readCapacity(services(workers, pools), { scope: 'operator', now: NOW })).ready).toEqual({ unknown: 'the board (ctx.board) is not mounted' })
    expect((await readCapacity(services(workers, pools, { board: { task: async () => undefined } }), { scope: 'operator', now: NOW })).ready).toEqual({ unknown: 'the board does not list its projects and their tasks' })
    // An engine that previews no steps: each task's Worker unknown.
    const blind = await readCapacity(services(workers, pools, { board }), { scope: 'operator', now: NOW })
    expect(value(blind.ready).items[0]!.likely).toEqual({ unknown: 'the workflow engine does not preview a template\'s steps' })
  })

  it('is bounded (INV-9): each list at most 16, the rest counted in more; active projects read at most 32', async () => {
    const many = Array.from({ length: CAPACITY_BOUNDS.list + 4 }, (_, i) => `acct-${String(i).padStart(2, '0')}`)
    const c = await readCapacity(services(many.map((a) => worker(a)), many.map((a, i) => pool(a, { used: 10, resetsAt: IN(30 + i) }))), { scope: 'operator', now: NOW })
    valid(c)
    expect([value(c.free).items.length, value(c.free).more]).toEqual([16, 4])
    expect([value(c.accounts).items.length, value(c.accounts).more]).toEqual([16, 4])
    // The soonest reset first: the bound keeps the most urgent.
    expect(value(c.free).items[0]!.account).toBe('acct-00')
    const down = await readCapacity(services(many.map((a) => worker(a, { state: 'unavailable' })), []), { scope: 'operator', now: NOW })
    expect([value(down.cannotWork).items.length, value(down.cannotWork).more]).toEqual([16, 4])
    const projects = Array.from({ length: CAPACITY_BOUNDS.projects + 3 }, (_, i) => ({ projectId: `p${String(i).padStart(2, '0')}` }))
    let read = 0
    const board: NonNullable<RosterServices['board']> = {
      task: async () => undefined, projects: async () => projects,
      tasks: async ({ projectId }) => { read += 1; return [{ taskId: `${projectId}-t`, projectId, title: projectId, state: 'ready' }] },
    }
    const wide = await readCapacity(services([worker('a')], [], { board }), { scope: 'operator', now: NOW })
    valid(wide)
    expect(read).toBe(CAPACITY_BOUNDS.projects)
    expect(value(wide.ready)).toMatchObject({ more: CAPACITY_BOUNDS.projects - 16, unread: `only the first ${CAPACITY_BOUNDS.projects} of ${CAPACITY_BOUNDS.projects + 3} active projects were read: a ready task of another is not listed` })
    expect(value(wide.ready).items).toHaveLength(16)
  })

  it('is the roster\'s now, valid against mcp-roster@1.7, the same in its terminal rendering, and gives a client no account label', async () => {
    const workers = [worker('a')]
    const pools = [pool('a', { used: 10, resetsAt: IN(40) })]
    const labelled: Partial<RosterServices> = { agentWorkers: { agentAccounts: { list: () => [{ accountId: 'a', provider: 'claude-agent-sdk', slot: 1, status: 'ready', hint: 't***@example.com' }], workersIn: () => ['agent:a/develop'], labelOf: () => 'science' } } }
    const roster = await readRoster(services(workers, pools, labelled), { scope: 'operator', now: NOW })
    schemas.assertDef('mcp-roster@1.7', 'roster-output', roster)
    expect(roster.now).toEqual(await readCapacity(services(workers, pools, labelled), { scope: 'operator', now: NOW }))
    expect(value(roster.now!.free).items[0]!.name).toBe('Claude · science · develop')
    const text = formatRoster(roster)
    expect(text.endsWith(formatCapacity(roster.now!).join('\n'))).toBe(true)
    expect(text).toContain(`\nRight now (as of ${NOW.toISOString()}):\n  free         Claude · science · develop (agent:a/develop; 90 % left of five-hour, resets ${IN(40)})`)
    const client = await readRoster(services(workers, pools, labelled), { scope: 'client', now: NOW })
    expect(JSON.stringify(client.now)).not.toMatch(/science|t\*\*\*@example\.com/)
    expect(value(client.now!.free).items[0]!.name).toBe('Claude · slot 1 · develop')
  })
})
