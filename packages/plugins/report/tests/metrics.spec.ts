import type { ApprovalRequest } from '@tsuuanmi/system-approvals-core'
import type { BoardTask } from '@tsuuanmi/system-board-core'
import { type QuotaDraw, SchemaRegistry } from '@tsuuanmi/system-libs'
import type { UsageRecord } from '@tsuuanmi/system-resources-core'
import { describe, expect, it } from 'vitest'
import { buildMetrics, buildReport, type DecisionRead, METRIC_IDS, type Metric, type MetricId, type MetricSources, type Period, type Recorded, renderMetrics, renderReport, type RunDecision } from '../src/index.ts'

// The maturity metrics of PROP-0016 §1, computed (docs/design/maturity-metrics.md): pure, from what
// was read, over fixed instants (no clock is read).

const schemas = new SchemaRegistry()
/** Noon UTC (or `hour`) on day `d` of the window (day 0 is its first). */
const at = (d: number, hour = 12): string => new Date(Date.UTC(2026, 8, 26 + d, hour)).toISOString()
const WINDOW: Period = { since: at(0, 0), until: at(30, 0) }
const ref = (n: number): `sha256:${string}` => `sha256:${n.toString(16).padStart(64, '0')}`

const task = (taskId: string, state: BoardTask['state'], acceptance?: number): BoardTask => ({
  schema: 'board-task@1.0', taskId, projectId: 'p1', title: taskId, goal: 'g', acceptance: [{ id: 'a1', statement: 's' }], dependsOn: [], actionClass: 'workspace-write',
  state, attempts: { count: 1, max: 3 }, createdAt: at(-1), revision: 1,
  ...(acceptance !== undefined ? { result: { artifacts: [ref(100 + acceptance)], subject: { type: 'artifact', ref: ref(100 + acceptance) }, acceptance: ref(acceptance) } } : {}),
})
const request = (requestId: string, actionClass: ApprovalRequest['action']['class'], when: string, cause: 'verdict' | 'expired', requester: Partial<ApprovalRequest['requester']>): ApprovalRequest => ({
  schema: 'approval-request@1.0', requestId, state: cause === 'verdict' ? 'approved' : 'rejected', subject: { type: 'content', ref: requestId, version: 'v' }, action: { class: actionClass, summary: requestId },
  requester: { component: 'board', projectId: 'p1', ...requester }, policy: { id: 'studio', version: 1, decision: ref(1) }, classification: 'operator-shared', createdAt: when, expiresAt: at(40), revision: 1,
  resolution: { cause, decision: ref(2), at: when, ...(cause === 'verdict' ? { approval: ref(3) } : {}) },
})
const usage = (requestId: string, observedAt: string, runId?: string): UsageRecord => ({
  schema: 'usage-record@1.0', requestId, source: 'runtime-result', observedAt, account: 'acc', pool: 'a.pool', ...(runId ? { runId } : {}),
  usage: { inputTokens: 1000, outputTokens: 100 }, turns: 3, cost: { amount: 0.1, currency: 'USD', basis: 'runtime-estimate' }, outcome: 'completed',
})
/** An agent run's quota draw, recorded at day 4: its kind, and one entry per window. */
const draw = (runId: string, kind: string | undefined, windows: QuotaDraw['windows']): QuotaDraw => ({
  schema: 'quota-draw@1.0', runId, worker: 'w1', account: 'acc', pool: 'a.pool', ...(kind ? { kind } : {}), outcome: 'completed',
  startedAt: at(3), endedAt: at(4), overlapping: 0, windows, observedAt: at(4),
})
let seq = 0
const event = (type: string, when: string, data: Record<string, unknown>, extra: Partial<Recorded> = {}): Recorded => ({ seq: ++seq, at: when, type, data, ...extra })
const started = (runId: string, when: string, taskId?: string, startedBy?: string): Recorded =>
  event('workflow.run.started', when, { template: 'algorithm-development', ...(taskId ? { taskId } : {}), ...(startedBy ? { startedBy } : {}) }, { runId })
const decision = (createdAt: string, extra: Partial<DecisionRead> = {}): DecisionRead => ({ createdAt, decisionType: 'acceptance', deciderType: 'rule', deciderId: 'workflow.task-acceptance', option: 'accept', ...extra })
const person = (id: number, createdAt: string, deciderType: RunDecision['deciderType'], decisionType = 'vote'): RunDecision => ({ id: ref(id), createdAt, deciderType, decisionType, option: 'O1' })

/**
 * Thirty days of a project. t1: started by dispatch, untouched, merged (its merge approval aside);
 * t2: started by the lead, then by dispatch, a lead's vote and an operator's decision on its runs,
 * accepted by the operator, merged; t3: started by the lead, an operator's remediation verdict; t4:
 * its run's started entry names no starter (recorded before startedBy); t5: accepted before the
 * window; t6 ready. One run serves no task; two stall entries of one run and one held agent run.
 */
function month(): MetricSources {
  return {
    asOf: at(30, 1),
    tasks: [task('t1', 'done', 20), task('t2', 'done', 21), task('t3', 'done', 22), task('t4', 'done', 23), task('t5', 'done', 24), task('t6', 'ready')],
    requests: [
      request('apr-m1', 'merge', at(6, 13), 'verdict', { taskId: 't1' }),
      request('apr-r3', 'remediation', at(14), 'verdict', { taskId: 't3' }),
      request('apr-x', 'command', at(16), 'expired', {}),
      request('apr-old', 'charter', at(-5), 'verdict', {}),
    ],
    usage: [usage('u1', at(4), 'arun-1'), usage('u2', at(9)), usage('u0', at(-3))],
    draws: [
      draw('arun-1', 'develop', [{ window: 'five-hour', draw: 4, state: 'clean' }, { window: 'weekly', draw: 1, state: 'clean' }]),
      { ...draw('arun-0', 'develop', [{ window: 'five-hour', draw: 9, state: 'clean' }]), observedAt: at(-3) },
    ],
    events: [
      started('run-1', at(3), 't1', 'dispatch'),
      started('run-2a', at(8), 't2', 'lead'),
      event('workflow.task.reported', at(8, 20), { taskId: 't2', status: 'rejected' }, { runId: 'run-2a', decision: ref(32) }),
      started('run-2b', at(9), 't2', 'dispatch'),
      started('run-x', at(12)),
      started('run-3', at(14), 't3', 'lead'),
      started('run-4', at(18), 't4'),
      started('run-5', at(-4), 't5', 'dispatch'),
      event('workflow.task.landing', at(6), { taskId: 't1', state: 'committed' }, { runId: 'run-1' }),
      event('workflow.task.landing', at(6, 12), { taskId: 't1', state: 'merged', commit: 'c1' }, { runId: 'run-1' }),
      event('workflow.task.landing', at(10, 12), { taskId: 't2', state: 'merged', commit: 'c2' }, { runId: 'run-2b' }),
      event('workflow.task.landing', at(-1), { taskId: 't5', state: 'merged', commit: 'c5' }, { runId: 'run-5' }),
      event('agent-workers.run.stalled', at(9), { agentRun: 'arun-1', worker: 'w1' }, { runId: 'run-2b' }),
      event('agent-workers.run.stalled', at(9, 13), { agentRun: 'arun-1', worker: 'w1' }, { runId: 'run-2b' }),
      event('agent-workers.run.unknown', at(20), { agentRun: 'arun-9', worker: 'w2' }),
    ],
    decisions: new Map([
      [ref(20), decision(at(5))], [ref(21), decision(at(10), { deciderType: 'operator', deciderId: 'operator.review' })], [ref(22), decision(at(15))],
      [ref(23), decision(at(20))], [ref(24), decision(at(-2))], [ref(32), decision(at(8, 20), { option: 'reject' })],
    ]),
    runDecisions: new Map([['run-2a', [person(40, at(8, 10), 'client')]], ['run-2b', [person(41, at(9, 14), 'operator', 'gate')]]]),
    readyAt: new Map([['t1', at(2)], ['t2', at(7, 0)], ['t3', at(13)]]),
    notes: [],
  }
}

const metricOf = (metrics: Metric[], id: MetricId): Metric => metrics.find((m) => m.id === id)!

describe('the maturity metrics, computed (docs/design/maturity-metrics.md)', () => {
  it('lists every metric of PROP-0016 §1 in its order, each with its sources and its L3 line, valid against mcp-report@1.6', () => {
    const read = buildMetrics(WINDOW, month(), 'p1')
    expect(() => schemas.assertDef('mcp-report@1.6', 'metrics-output', read)).not.toThrow()
    expect(read.metrics.map((m) => m.id)).toEqual(METRIC_IDS)
    expect(read.days).toBe(30)
    for (const m of read.metrics) {
      expect(m.sources.length, m.id).toBeGreaterThan(0)
      expect(m.l3.line, m.id).not.toBe('')
    }
  })

  it('counts a lead\'s starts and its decisions on a task\'s runs as touches, a lower bound, a task whose starter is not recorded counting what is recorded', () => {
    const lead = metricOf(buildMetrics(WINDOW, month(), 'p1').metrics, 'lead-touches')
    // t1 0 (dispatch), t2 2 (a lead start and a lead vote), t3 1 (a lead start), t4 0 recorded (its starter unknown).
    expect(lead).toMatchObject({ state: 'measured', value: 0.5, sample: 4, sampleOf: 'finished tasks', bound: 'lower', figures: { p90: 2, mean: 0.75, starts: 2, decisions: 1, unattributed: 1 } })
    expect(lead.reason).toMatch(/coordination board/)
    expect(lead.reason).toMatch(/1 finished task\(s\) count only the touches recorded/)
    // A lower bound that meets "median ≤ 1" does not show the line is met.
    expect(lead.l3).toEqual({ line: 'median ≤ 1', status: 'unproven' })
  })

  it('counts nothing at or after the window\'s end: a later start, decision, or verdict leaves an earlier window\'s touches as they were', () => {
    const later = month()
    later.events.push(started('run-1b', at(30, 3), 't1', 'lead'), event('workflow.task.reported', at(31), { taskId: 't1', status: 'accepted' }, { runId: 'run-1b' }))
    later.requests.push(request('apr-late', 'remediation', at(30, 2), 'verdict', { taskId: 't1' }))
    later.runDecisions = new Map([...later.runDecisions, ['run-1', [person(42, at(30, 5), 'client'), person(43, at(31), 'operator')]]])
    const read = buildMetrics(WINDOW, later, 'p1')
    expect(metricOf(read.metrics, 'lead-touches')).toMatchObject({ value: 0.5, figures: { starts: 2, decisions: 1 } })
    expect(metricOf(read.metrics, 'unattended-completion')).toMatchObject({ value: 0.25, figures: { untouched: 1 } })
    expect(metricOf(read.metrics, 'operator-decisions')).toMatchObject({ sample: 4 })
  })

  it('keeps its bounds with tasks whose starters are not recorded: one touched task among many unknown ones is not read as a miss', () => {
    const unknown = (taskId: string, n: number): BoardTask => task(taskId, 'done', n)
    const sources: MetricSources = {
      ...month(),
      tasks: [task('k', 'done', 60), unknown('u1', 61), unknown('u2', 62), unknown('u3', 63)],
      requests: [],
      events: [
        started('run-k', at(3), 'k', 'lead'), started('run-u1', at(3), 'u1'), started('run-u2', at(3), 'u2'), started('run-u3', at(3), 'u3'),
        ...['k', 'u1', 'u2', 'u3'].map((id) => event('workflow.task.landing', at(6), { taskId: id, state: 'merged' }, { runId: `run-${id}` })),
      ],
      decisions: new Map([60, 61, 62, 63].map((n) => [ref(n), decision(at(5))])),
      runDecisions: new Map([['run-k', [person(44, at(4), 'client')]]]),
      readyAt: new Map(['k', 'u1', 'u2', 'u3'].map((id) => [id, at(2)])),
    }
    const read = buildMetrics(WINDOW, sources, 'p1')
    // Every task counts what is recorded: k 2, the others 0 at least; the median 0 is a lower bound, unproven, never a miss.
    expect(metricOf(read.metrics, 'lead-touches')).toMatchObject({ value: 0, sample: 4, bound: 'lower', figures: { unattributed: 3 }, l3: { status: 'unproven' } })
    // The unknown ones count as unattended unless a touch is known: 3 of 4 at most, unproven.
    expect(metricOf(read.metrics, 'unattended-completion')).toMatchObject({ value: 0.75, sample: 4, bound: 'upper', figures: { untouched: 3, notAttributed: 3 }, l3: { status: 'unproven' } })
  })

  it('reads unattended completion over every finished task: one not landed is never unattended, and a run the operator started is a touch', () => {
    const operatorStarted = month()
    operatorStarted.events = operatorStarted.events.map((e) => (e.runId === 'run-1' && e.type === 'workflow.run.started' ? started('run-1', e.at, 't1', 'operator') : e))
    const unattended = metricOf(buildMetrics(WINDOW, operatorStarted, 'p1').metrics, 'unattended-completion')
    expect(unattended).toMatchObject({ value: 0, sample: 4, figures: { untouched: 0, finishedNotLanded: 2 } })
    expect(unattended.l3.status).toBe('misses')
    // With no merged landing before the window's end, nothing finished went from ready to landed: 0 of 4, said.
    const unlanded = month()
    unlanded.events = unlanded.events.filter((e) => e.type !== 'workflow.task.landing')
    expect(metricOf(buildMetrics(WINDOW, unlanded, 'p1').metrics, 'unattended-completion')).toMatchObject({
      value: 0, sample: 4, figures: { finishedNotLanded: 4 }, reason: expect.stringMatching(/4 finished task\(s\) had no merged landing/), l3: { status: 'misses' },
    })
    // Ten finished, one landed untouched: 10 %, never the one landed task's 100 %.
    const ten: MetricSources = {
      ...month(), requests: [],
      tasks: Array.from({ length: 10 }, (_, i) => task(`x${i}`, 'done', 70 + i)),
      events: [started('run-x0', at(3), 'x0', 'dispatch'), event('workflow.task.landing', at(6), { taskId: 'x0', state: 'merged' }, { runId: 'run-x0' }),
        ...Array.from({ length: 9 }, (_, i) => started(`run-x${i + 1}`, at(3), `x${i + 1}`, 'dispatch'))],
      decisions: new Map(Array.from({ length: 10 }, (_, i) => [ref(70 + i), decision(at(5))] as const)), runDecisions: new Map(), readyAt: new Map([['x0', at(2)]]),
    }
    expect(metricOf(buildMetrics(WINDOW, ten, 'p1').metrics, 'unattended-completion')).toMatchObject({ value: 0.1, sample: 10, figures: { untouched: 1, finishedNotLanded: 9 } })
    // A landed task with no move to ready read still counts, so the share stays an upper bound.
    const unread = { ...ten, readyAt: new Map<string, string>() }
    expect(metricOf(buildMetrics(WINDOW, unread, 'p1').metrics, 'unattended-completion')).toMatchObject({ value: 0.1, bound: 'upper', figures: { readyNotRead: 1 } })
  })

  it('reads a time to landed whose first move to ready may be older than the moves read as a lower bound, never as meeting the line', () => {
    const quick: MetricSources = {
      ...month(), requests: [], tasks: [task('q', 'done', 80)],
      events: [started('run-q', at(5, 11), 'q', 'dispatch'), event('workflow.task.landing', at(5, 12), { taskId: 'q', state: 'merged' }, { runId: 'run-q' })],
      decisions: new Map([[ref(80), decision(at(5, 11))]]), runDecisions: new Map(), readyAt: new Map([['q', at(5, 11)]]),
    }
    // Read whole: one hour, which meets the line.
    expect(metricOf(buildMetrics(WINDOW, quick, 'p1').metrics, 'ready-to-landed')).toMatchObject({ value: 1, l3: { status: 'meets' } })
    // The moves read from day 4 on only; q was created before then, so it may have been ready earlier: a lower bound, unproven.
    const truncated = metricOf(buildMetrics(WINDOW, { ...quick, readyReadFrom: at(4) }, 'p1').metrics, 'ready-to-landed')
    expect(truncated).toMatchObject({ value: 1, bound: 'lower', figures: { earlierReady: 1 }, reason: expect.stringMatching(/read from .* on only/), l3: { status: 'unproven' } })
    // A task created after the first move read has its whole history read: exact.
    expect(metricOf(buildMetrics(WINDOW, { ...quick, readyReadFrom: at(-2) }, 'p1').metrics, 'ready-to-landed')).toMatchObject({ value: 1, l3: { status: 'meets' } })
  })

  it('says when decisions on runs may not all have been read: the operator\'s count is then a lower bound', () => {
    const truncated = metricOf(buildMetrics(WINDOW, { ...month(), truncatedRuns: ['run-2b'] }, 'p1').metrics, 'operator-decisions')
    expect(truncated).toMatchObject({ value: 0.13, bound: 'lower', reason: expect.stringMatching(/^1 run\(s\) hold more decisions than one reading takes/) })
    expect(truncated.l3.status).toBe('unproven')
    const unread = metricOf(buildMetrics(WINDOW, { ...month(), unreadDecisions: 'a decision before the 1000 latest is not read' }, 'p1').metrics, 'operator-decisions')
    expect(unread).toMatchObject({ bound: 'lower', reason: expect.stringMatching(/1000 latest/) })
    // A task whose run's decisions were not all read counts only its recorded touches.
    expect(metricOf(buildMetrics(WINDOW, { ...month(), truncatedRuns: ['run-3'] }, 'p1').metrics, 'lead-touches')).toMatchObject({ figures: { unattributed: 2 } })
  })

  it('counts the operator\'s decisions of the window per day: verdicts, acceptances, and decisions on runs, each once', () => {
    const operator = metricOf(buildMetrics(WINDOW, month(), 'p1').metrics, 'operator-decisions')
    // apr-m1 and apr-r3 (verdicts in the window), t2's acceptance, the decision on run-2b; not the expiry, not apr-old.
    expect(operator).toMatchObject({ state: 'measured', value: 0.13, sample: 4, figures: { decisions: 4, verdicts: 2, acceptances: 1, onRuns: 1 } })
    expect(operator.l3.status).toBe('meets')
  })

  it('reads unattended completion as the share of finished tasks that landed with no touch but the merge approval, an upper bound', () => {
    const unattended = metricOf(buildMetrics(WINDOW, month(), 'p1').metrics, 'unattended-completion')
    // Of t1 to t4, only t1 went from ready to merged untouched (its merge verdict is the touch allowed); t2 was touched; t3 and t4 never landed.
    expect(unattended).toMatchObject({ state: 'measured', value: 0.25, sample: 4, sampleOf: 'finished tasks', bound: 'upper', figures: { untouched: 1, notAttributed: 0, readyNotRead: 0, finishedNotLanded: 2 } })
    // An upper bound below "≥ 50 %" misses it whatever the records miss.
    expect(unattended.l3.status).toBe('misses')
  })

  it('times ready to landed from a task\'s first move to ready to its merged landing, for the merges of the window', () => {
    const landed = metricOf(buildMetrics(WINDOW, month(), 'p1').metrics, 'ready-to-landed')
    // t1: day 2 noon to day 6 noon, 96 h; t2: day 7 midnight to day 10 noon, 84 h; t5 merged before the window.
    expect(landed).toMatchObject({ state: 'measured', value: 90, sample: 2, figures: { p90: 96 } })
    expect(landed.l3.status).toBe('misses')
  })

  it('counts stalls per 100 runs started, each run once, and board coverage over every project', () => {
    const studio = buildMetrics(WINDOW, month())
    // Six runs started in the window; run-2b stalled twice (one run), arun-9 held: 2 of 6.
    expect(metricOf(studio.metrics, 'stalls')).toMatchObject({ state: 'measured', value: 33.33, sample: 6, figures: { stalledOrHeld: 2 } })
    expect(metricOf(studio.metrics, 'board-coverage')).toMatchObject({ state: 'measured', value: 0.8333, sample: 6, figures: { bound: 5 } })
    // A project's runs all serve its tasks by construction: read for every project only.
    expect(metricOf(buildMetrics(WINDOW, month(), 'p1').metrics, 'board-coverage')).toMatchObject({ state: 'not-measurable', reason: expect.stringMatching(/every project/) })
  })

  it('divides the window\'s counted usage and quota drawn by the results accepted in it, in all and by kind', () => {
    const cost = metricOf(buildMetrics(WINDOW, month(), 'p1').metrics, 'cost-per-accepted-result')
    // u1 and u2 (u0 is before the window), 2,200 tokens over t1 to t4; arun-1's clean draws, 4 and 1 points.
    expect(cost).toMatchObject({ state: 'measured', unit: 'tokens', value: 550, sample: 4, figures: { costUsd: 0.05, turns: 1.5, usageRecords: 2, quotaPoints: 1.25, quotaDraws: 1 } })
    expect(cost.bound).toBeUndefined()
    // u1 is arun-1's, whose draw names its kind; u2 has no draw, so its kind is not known (listed last, with no kind).
    expect(cost.byKind).toEqual([
      { kind: 'develop', tokens: 275, costUsd: 0.025, turns: 0.75, usageRecords: 1, quota: [
        { window: 'five-hour', points: 1, cleanDraws: 1, excluded: { confounded: 0, 'reset-crossing': 0, 'no-reading': 0 } },
        { window: 'weekly', points: 0.25, cleanDraws: 1, excluded: { confounded: 0, 'reset-crossing': 0, 'no-reading': 0 } },
      ] },
      { tokens: 275, costUsd: 0.025, turns: 0.75, usageRecords: 1, quota: [] },
    ])
    expect(cost.reason).toBe('1 usage record(s) have no kind known (no quota draw of their run names one): listed under no kind')
    const unknown = metricOf(buildMetrics(WINDOW, { ...month(), usageUnknown: 1 }, 'p1').metrics, 'cost-per-accepted-result')
    expect(unknown).toMatchObject({ bound: 'lower', reason: expect.stringMatching(/1 run\(s\) of the window/) })
    expect(unknown.l3.status).toBe('meets')
    // A draw that is not clean is counted by state, its quota not known (no points, never 0); with no draw at all, the quota is not known.
    const confounded = month()
    confounded.draws = [draw('arun-1', 'develop', [{ window: 'five-hour', draw: 4, state: 'confounded' }])]
    const shared = metricOf(buildMetrics(WINDOW, confounded, 'p1').metrics, 'cost-per-accepted-result')
    expect(shared).toMatchObject({ value: 550, reason: expect.stringMatching(/1 window draw\(s\) are not clean.*no window draw is clean/) })
    expect(shared.figures).not.toHaveProperty('quotaPoints')
    expect(shared.byKind![0]!.quota).toEqual([{ window: 'five-hour', cleanDraws: 0, excluded: { confounded: 1, 'reset-crossing': 0, 'no-reading': 0 } }])
    const undrawn = metricOf(buildMetrics(WINDOW, { ...month(), draws: [] }, 'p1').metrics, 'cost-per-accepted-result')
    expect(undrawn).toMatchObject({ value: 550, reason: expect.stringMatching(/no run recorded a quota draw/) })
    expect(Object.keys(undrawn.figures!)).toEqual(['costUsd', 'turns', 'usageRecords'])
  })

  it('never makes a cost component no record carries a 0: no usage leaves the value not known and keeps the quota drawn; a record without cost or turns is said', () => {
    // Quota drawn, no usage counted: tokens, cost, and turns not known; the quota points stay.
    const drawnOnly = metricOf(buildMetrics(WINDOW, { ...month(), usage: [] }, 'p1').metrics, 'cost-per-accepted-result')
    expect(drawnOnly).toMatchObject({ state: 'not-measurable', figures: { usageRecords: 0, quotaPoints: 1.25, quotaDraws: 1 }, reason: expect.stringMatching(/^the ledger counted no usage in the window: tokens, cost, and turns are not known/) })
    expect(drawnOnly.value).toBeUndefined()
    expect(drawnOnly.figures).not.toHaveProperty('costUsd')
    expect(drawnOnly.byKind).toEqual([{ kind: 'develop', usageRecords: 0, quota: [
      { window: 'five-hour', points: 1, cleanDraws: 1, excluded: { confounded: 0, 'reset-crossing': 0, 'no-reading': 0 } },
      { window: 'weekly', points: 0.25, cleanDraws: 1, excluded: { confounded: 0, 'reset-crossing': 0, 'no-reading': 0 } },
    ] }])
    // Records without a cost or a turn count: those figures are not known, never 0; tokens still measured.
    const bare = (u: UsageRecord): UsageRecord => {
      const copy = { ...u }
      delete copy.cost
      delete copy.turns
      return copy
    }
    const noCost = month()
    noCost.usage = noCost.usage.map(bare)
    const read = metricOf(buildMetrics(WINDOW, noCost, 'p1').metrics, 'cost-per-accepted-result')
    expect(read).toMatchObject({ value: 550, reason: expect.stringMatching(/no usage record carries cost: cost is not known; no usage record carries turn count: turns is not known/) })
    expect(read.figures).not.toHaveProperty('costUsd')
    expect(read.figures).not.toHaveProperty('turns')
    expect(read.byKind![0]).not.toHaveProperty('costUsd')
    // One of two without a cost: the cost counts the other only, said.
    const half = month()
    half.usage = [half.usage[0]!, bare(half.usage[1]!), half.usage[2]!]
    expect(metricOf(buildMetrics(WINDOW, half, 'p1').metrics, 'cost-per-accepted-result')).toMatchObject({ figures: { costUsd: 0.025 }, reason: expect.stringMatching(/1 of 2 usage record\(s\) carry no cost: cost counts the others only/) })
    const read2 = buildMetrics(WINDOW, { ...month(), usage: [] }, 'p1')
    expect(() => schemas.assertDef('mcp-report@1.6', 'metrics-output', read2)).not.toThrow()
  })

  it('says why escaped defects, Worker availability, quota idle, traced landings, and gate coverage are not measurable yet, never 0', () => {
    const read = buildMetrics(WINDOW, month(), 'p1')
    for (const id of ['escaped-defects', 'worker-availability', 'quota-idle', 'traced-landings', 'gate-coverage'] as const) {
      const m = metricOf(read.metrics, id)
      expect(m.state, id).toBe('not-measurable')
      expect(m.value, id).toBeUndefined()
      expect(m.reason, id).toMatch(/\w/)
      expect(m.l3.status, id).toBe('not-read')
    }
  })

  it('reads L3 as not shown, with every reason: too few tasks, the lines missed, the bounds, and the metrics not measurable', () => {
    const { level } = buildMetrics(WINDOW, month(), 'p1')
    expect(level).toMatchObject({ l3: 'not-shown', finishedTasks: 4, minTasks: 30, days: 30 })
    expect(level.missed).toEqual(['unattended-completion', 'ready-to-landed', 'stalls'])
    expect(level.unproven).toEqual(['lead-touches'])
    expect(level.met).toEqual(['operator-decisions', 'cost-per-accepted-result'])
    expect(level.notRead).toEqual(['traced-landings', 'gate-coverage', 'board-coverage', 'escaped-defects', 'worker-availability', 'quota-idle'])
    expect(level.reasons[0]).toBe('too few: 4 finished task(s), a level needs 30')
  })

  it('reads an empty log as nothing measurable: no metric has a value, and no level is shown', () => {
    const read = buildMetrics(WINDOW, { asOf: at(30, 1), tasks: [], requests: [], usage: [], events: [], decisions: new Map(), runDecisions: new Map(), readyAt: new Map(), notes: [] })
    expect(() => schemas.assertDef('mcp-report@1.6', 'metrics-output', read)).not.toThrow()
    for (const m of read.metrics) {
      expect(m.state, m.id).toBe('not-measurable')
      expect(m.value, m.id).toBeUndefined()
      expect(m.reason, m.id).toMatch(/\w/)
    }
    expect(read.level).toMatchObject({ l3: 'not-shown', finishedTasks: 0, met: [], missed: [], unproven: [] })
    const text = renderMetrics(read).join('\n')
    for (const m of read.metrics) expect(text).toContain(`- ${m.name}: not measurable; L3 ${m.l3.line}: not-read.`)
    expect(text).toMatch(/L3: not shown/)
  })

  it('counts what falls at the window\'s start and leaves out what falls at its end', () => {
    const edge: MetricSources = {
      asOf: at(30, 1),
      tasks: [task('a', 'done', 50), task('b', 'done', 51)],
      requests: [request('apr-a', 'command', WINDOW.since, 'verdict', {}), request('apr-b', 'command', WINDOW.until, 'verdict', {})],
      usage: [usage('ua', WINDOW.since), usage('ub', WINDOW.until)],
      events: [
        started('run-a', WINDOW.since, 'a', 'dispatch'), started('run-b', WINDOW.until, 'b', 'dispatch'),
        event('workflow.task.landing', WINDOW.since, { taskId: 'a', state: 'merged' }, { runId: 'run-a' }),
        event('workflow.task.landing', WINDOW.until, { taskId: 'b', state: 'merged' }, { runId: 'run-b' }),
        event('agent-workers.run.stalled', WINDOW.until, { agentRun: 'arun-b', worker: 'w' }, { runId: 'run-b' }),
      ],
      // a accepted at the window's first instant, b at its end (exclusive).
      decisions: new Map([[ref(50), decision(WINDOW.since)], [ref(51), decision(WINDOW.until)]]),
      runDecisions: new Map(),
      readyAt: new Map([['a', at(-1, 0)], ['b', at(29)]]),
      notes: [],
    }
    const read = buildMetrics(WINDOW, edge)
    expect(read.level.finishedTasks).toBe(1)
    expect(metricOf(read.metrics, 'lead-touches')).toMatchObject({ value: 0, sample: 1 })
    expect(metricOf(read.metrics, 'operator-decisions')).toMatchObject({ sample: 1, figures: { verdicts: 1 } })
    expect(metricOf(read.metrics, 'cost-per-accepted-result')).toMatchObject({ value: 1100, sample: 1, figures: { usageRecords: 1 } })
    expect(metricOf(read.metrics, 'ready-to-landed')).toMatchObject({ value: 24, sample: 1 })
    expect(metricOf(read.metrics, 'stalls')).toMatchObject({ value: 0, sample: 1 })
    expect(metricOf(read.metrics, 'board-coverage')).toMatchObject({ value: 1, sample: 1 })
    // A window shorter than 30 days is read, but no level is shown on it.
    const week = buildMetrics({ since: at(23, 0), until: WINDOW.until }, edge)
    expect(week.days).toBe(7)
    expect(week.level.reasons[0]).toBe('the window is 7 day(s): a level is read over 30')
  })

  it('is the weekly report\'s maturity section, valid against mcp-report@1.6, rendered after the advice', () => {
    const report = buildReport({ since: at(23, 0), until: WINDOW.until }, { asOf: at(30, 1), projects: [], tasks: [], requests: [], usage: [], events: [], decisions: new Map(), notes: [] })
    const withMaturity = { ...report, maturity: buildMetrics(WINDOW, month()) }
    expect(() => schemas.assertDef('mcp-report@1.6', 'report-output', withMaturity)).not.toThrow()
    const text = renderReport(withMaturity)
    expect(text).toMatch(/## Maturity metrics: every project/)
    expect(text).toMatch(/- Stalls per 100 runs: 33\.33 per 100 \(stalledOrHeld 2\); over 6 runs started; L3 ≤ 5 per 100 runs: misses\./)
    expect(text).toMatch(/L3: not shown/)
    // Without it (the metrics could not be read), the report is as at 1.5.
    expect(renderReport(report)).not.toMatch(/Maturity/)
  })
})
