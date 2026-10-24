import type { ApprovalRequest } from '@tsuuanmi/system-approvals-core'
import type { BoardTask, Project } from '@tsuuanmi/system-board-core'
import { SchemaRegistry, type UsageUnknown } from '@tsuuanmi/system-libs'
import type { UsageRecord } from '@tsuuanmi/system-resources-core'
import { describe, expect, it } from 'vitest'
import { buildReport, type DecisionRead, duration, MAX_PROJECTS, type Period, periodOf, type Recorded, renderReport, ReportError, runsOf, type Sources, type UnknownRead, whole, within } from '../src/index.ts'

// The baseline report's computation (docs/design/reports.md): pure, from what was read; the same
// records and period give the same report.

const schemas = new SchemaRegistry()
const DAY = 86_400_000
/** Noon UTC on day `d` of the period (day 0 is its first). */
const at = (d: number, hour = 12): string => new Date(Date.UTC(2026, 9, 16 + d, hour)).toISOString()
const PERIOD: Period = { since: at(0, 0), until: at(7, 0) }
const ref = (n: number): `sha256:${string}` => `sha256:${n.toString(16).padStart(64, '0')}`

const project = (projectId: string, attention?: { maxBatchesPerDay?: number; maxInterruptionsPerDay?: number }): Project => ({
  schema: 'project@1.0', projectId, title: `project ${projectId}`, state: 'active', createdAt: at(-10), revision: 1,
  charter: { version: 2, intent: 'faster', criteria: [], constraints: {}, stopRules: [], budget: { pools: [], ...(attention ? { attention } : {}) } },
  milestones: [{ id: 'm1', title: 'first', state: 'funded' }],
})
const task = (taskId: string, state: BoardTask['state'], extra: Partial<BoardTask> = {}): BoardTask => ({
  schema: 'board-task@1.0', taskId, projectId: 'p1', title: taskId, goal: 'g', acceptance: [{ id: 'a1', statement: 's' }], dependsOn: [], actionClass: 'workspace-write',
  state, attempts: { count: 1, max: 3 }, createdAt: at(-1), revision: 1, ...extra,
})
const request = (requestId: string, actionClass: ApprovalRequest['action']['class'], createdAt: string, end?: { state: 'approved' | 'rejected'; cause: 'verdict' | 'expired' | 'withdrawn'; at: string }, extra: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  schema: 'approval-request@1.0', requestId, state: end?.state ?? 'open', subject: { type: 'content', ref: requestId, version: 'v' }, action: { class: actionClass, summary: requestId },
  requester: { component: 'board', projectId: 'p1' }, policy: { id: 'studio', version: 1, decision: ref(1) }, classification: 'operator-shared', createdAt, expiresAt: at(30), revision: 1,
  ...(end ? { resolution: { cause: end.cause, decision: ref(2), at: end.at, ...(end.cause === 'verdict' ? { approval: ref(3) } : {}) } } : {}), ...extra,
})
const usage = (requestId: string, pool: string, observedAt: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  schema: 'usage-record@1.0', requestId, source: 'runtime-result', observedAt, account: 'acc', pool,
  usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 800 }, turns: 3, cost: { amount: 0.1, currency: 'USD', basis: 'runtime-estimate' }, outcome: 'completed', ...extra,
})
/** A record whose runtime reported no token counts. */
const untokened = (record: UsageRecord): UsageRecord => {
  const copy = { ...record }
  delete copy.usage
  return copy
}
let seq = 0
const event = (type: string, when: string, data: Record<string, unknown>, extra: Partial<Recorded> = {}): Recorded => ({ seq: ++seq, at: when, type, data, ...extra })
const decision = (createdAt: string, extra: Partial<DecisionRead> = {}): DecisionRead => ({ createdAt, decisionType: 'acceptance', deciderType: 'rule', deciderId: 'workflow.task-acceptance', option: 'accept', ...extra })

/** One week of a project: two results accepted (one by the operator), approvals of three classes, two pools, digests. */
function week(): Sources {
  return {
    asOf: at(7, 1),
    projects: [project('p1', { maxInterruptionsPerDay: 2, maxBatchesPerDay: 1 })],
    tasks: [
      task('t1', 'done', { result: { artifacts: [ref(10)], subject: { type: 'artifact', ref: ref(10) }, acceptance: ref(20) } }),
      task('t2', 'done', { createdAt: at(1), result: { artifacts: [ref(11)], subject: { type: 'artifact', ref: ref(11) }, acceptance: ref(21) } }),
      task('t3', 'done', { result: { artifacts: [ref(12)], subject: { type: 'artifact', ref: ref(12) }, acceptance: ref(22) } }),
      task('t4', 'review', { createdAt: at(2), run: { runId: 'run-4', startedAt: at(2) }, result: { artifacts: [ref(13)], subject: { type: 'artifact', ref: ref(13) } }, waiting: { reason: 'operator-review', since: at(2), expiresAt: at(3) } }),
      task('t5', 'cancelled', { cancellation: { reason: 'lead', at: at(3) } }),
      task('t6', 'ready'),
    ],
    requests: [
      request('apr-1', 'charter', at(0, 0), { state: 'approved', cause: 'verdict', at: at(0, 0) }),
      request('apr-2', 'remediation', at(1, 10), { state: 'approved', cause: 'verdict', at: at(1, 12) }, { batchId: 'b1' }),
      request('apr-3', 'remediation', at(1, 11), { state: 'rejected', cause: 'verdict', at: at(1, 21) }, { batchId: 'b1' }),
      request('apr-4', 'command', at(2), { state: 'rejected', cause: 'expired', at: at(3) }),
      request('apr-5', 'command', at(4)),
      request('apr-6', 'charter', at(7, 0)),
      request('apr-0', 'charter', at(-1), { state: 'approved', cause: 'verdict', at: at(-1, 13) }),
    ],
    usage: [
      usage('r2', 'b.pool', at(2)),
      usage('r1', 'a.pool', at(1), { outcome: 'failed' }),
      usage('r3', 'a.pool', at(3), { cost: { amount: 0.2000004, currency: 'USD', basis: 'runtime-estimate' } }),
      untokened(usage('r4', 'a.pool', at(4), { turns: 1 })),
      usage('r0', 'a.pool', at(-2)),
    ],
    events: [
      event('workflow.task.reported', at(1), { taskId: 't1', status: 'accepted' }, { runId: 'run-1', decision: ref(30) }),
      event('workflow.task.reported', at(2), { taskId: 't4', status: 'review' }, { runId: 'run-4', decision: ref(31) }),
      event('workflow.task.reported', at(2, 13), { taskId: 't2', status: 'rejected' }, { runId: 'run-2', decision: ref(32) }),
      event('workflow.task.reported', at(3), { taskId: 't2', status: 'reconciled' }, { runId: 'run-2b', decision: ref(33) }),
      event('workflow.task.reported', at(-1), { taskId: 't3', status: 'accepted' }, { runId: 'run-3' }),
      event('workflow.graph.grown', at(1), { steps: [], plan: ref(40), cycle: 2 }, { runId: 'run-1' }),
      event('workflow.graph.grown', at(1), { steps: [], plan: ref(41) }, { runId: 'run-1' }),
      event('workflow.gate.opened', at(1, 13), { plan: ref(40), by: 'queue' }, { runId: 'run-1' }),
      event('workflow.gate.closed', at(1, 22), { plan: ref(40), by: 'queue', kind: 'plan_rejected' }, { runId: 'run-2' }),
      event('workflow.gate.closed', at(1, 22), { plan: ref(40), by: 'rule' }, { runId: 'run-2' }),
      event('approvals.batched', at(1, 11), { batchId: 'b1', requests: ['apr-2', 'apr-3'] }),
      event('workflow.task.digest', at(1, 14), { taskId: 't1', state: 'attached', requestId: 'dg-1', digest: ref(50) }, { runId: 'run-1' }),
      event('workflow.task.digest', at(2, 14), { taskId: 't4', state: 'bypassed', reason: 'no Worker' }, { runId: 'run-4' }),
    ],
    decisions: new Map([
      [ref(20), decision(at(1))], [ref(21), decision(at(3), { deciderType: 'operator', deciderId: 'operator.review' })], [ref(22), decision(at(-1))],
      [ref(30), decision(at(1), { checks: { review: true } })], [ref(31), decision(at(2), { checks: { review: true, schema: true } })],
      [ref(32), decision(at(2), { option: 'reject', checks: { review: false } })], [ref(33), decision(at(3), { decisionType: 'reconciliation', deciderId: 'workflow.task-report', option: 'report' })],
    ]),
    digests: new Map([['dg-1', { kept: 4, dropped: 1, escalated: true }]]),
    notes: [],
  }
}

describe('the baseline report, computed (docs/design/reports.md)', () => {
  it('names its period by until and since or days: by default the 7 days before now, at most 366, never empty or both', () => {
    const now = new Date('2026-10-23T09:30:00.000Z')
    expect(periodOf({}, now)).toEqual({ since: '2026-10-16T09:30:00.000Z', until: '2026-10-23T09:30:00.000Z' })
    expect(periodOf({ days: 1, until: '2026-10-20T00:00:00Z' }, now)).toEqual({ since: '2026-10-19T00:00:00.000Z', until: '2026-10-20T00:00:00.000Z' })
    expect(periodOf({ since: '2026-10-01T00:00:00+02:00' }, now)).toEqual({ since: '2026-09-30T22:00:00.000Z', until: '2026-10-23T09:30:00.000Z' })
    for (const [input, why] of [
      [{ since: '2026-10-01T00:00:00Z', days: 3 }, /not both/], [{ since: '2026-10-24T00:00:00Z' }, /empty/], [{ since: '2025-10-01T00:00:00Z' }, /at most 366 days/],
      [{ until: 'yesterday' }, /ISO 8601/],
    ] as const) {
      expect(() => periodOf(input, now)).toThrow(why)
      expect(() => periodOf(input, now)).toThrow(ReportError)
    }
  })

  it('counts a project\'s week from its records: tasks, attempts and their reviews, remediation, approvals and waits, attention per day against the charter, usage per pool, digests, and the baseline', () => {
    const report = buildReport(PERIOD, week(), 'p1')
    expect(() => schemas.assertDef('mcp-report@1.0', 'report-output', report)).not.toThrow()
    expect(report.projects).toEqual([{
      projectId: 'p1', title: 'project p1', state: 'active', charterVersion: 2, milestones: [{ id: 'm1', title: 'first', state: 'funded' }],
      attention: { maxInterruptionsPerDay: 2, maxBatchesPerDay: 1 }, tasks: { ...report.tasks.now },
    }])
    // Done in the period by the accepting decision's time, not before it; created and cancelled likewise.
    expect(report.tasks).toEqual({
      now: { proposed: 0, ready: 1, claimed: 0, running: 0, review: 1, 'waiting-for-input': 0, 'waiting-for-approval': 0, done: 3, cancelled: 1 },
      created: 2, done: 2, doneByOperator: 1, cancelled: 1,
    })
    expect(report.attempts).toEqual({ reported: 4, accepted: 1, rejected: 1, heldForOperator: 1, reconciled: 1, other: 0, review: { passed: 2, failed: 1, none: 1 } })
    expect(report.remediation).toEqual({ cycles: 1, fixesOpened: 1, fixesClosed: 1 })
    // A request made at the period's start counts; one made at its end belongs to the next period.
    expect(report.approvals).toEqual({
      asked: 5, approved: 2, rejected: 1, expired: 1, withdrawn: 0, openNow: 2,
      byClass: [
        { actionClass: 'charter', asked: 1, approved: 1, rejected: 0, expired: 0, withdrawn: 0 },
        { actionClass: 'command', asked: 2, approved: 0, rejected: 0, expired: 1, withdrawn: 0 },
        { actionClass: 'remediation', asked: 2, approved: 1, rejected: 1, expired: 0, withdrawn: 0 },
      ],
      // Verdicts after 0 s, 2 h, and 10 h: nearest-rank median and 90th percentile.
      wait: { answered: 3, medianSeconds: 7200, p90Seconds: 36_000, maxSeconds: 36_000 },
    })
    // Interruptions: requests asked, and the review held for the operator; batches: the queue's, and a verdict given alone.
    expect(report.attention).toEqual({
      interruptions: 6, batches: 2,
      days: [
        { date: '2026-10-16', interruptions: 1, batches: 1 }, { date: '2026-10-17', interruptions: 2, batches: 1 },
        { date: '2026-10-18', interruptions: 2, batches: 0 }, { date: '2026-10-20', interruptions: 1, batches: 0 },
      ],
      threshold: { maxInterruptionsPerDay: 2, maxBatchesPerDay: 1 }, daysOver: 0,
    })
    // The record with no token counts is counted, and a tokens cap counts it as 0 (D25): said per pool.
    expect(report.usage).toEqual({
      total: { records: 4, inputTokens: 3000, outputTokens: 300, cacheReadInputTokens: 2400, cacheCreationInputTokens: 0, turns: 10, costUsd: 0.5, withoutTokens: 1 },
      pools: [
        { pool: 'a.pool', records: 3, inputTokens: 2000, outputTokens: 200, cacheReadInputTokens: 1600, cacheCreationInputTokens: 0, turns: 7, costUsd: 0.4, withoutTokens: 1 },
        { pool: 'b.pool', records: 1, inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 800, cacheCreationInputTokens: 0, turns: 3, costUsd: 0.1 },
      ],
      byOutcome: { completed: 3, failed: 1, aborted: 0, unknown: 0 },
    })
    expect(report.digests).toEqual({ attached: 1, bypassed: 1, claimsKept: 4, claimsDropped: 1, escalated: 1 })
    expect(report.baseline).toEqual({ acceptedResults: 2, interruptions: 6, attempts: 4, perAcceptedResult: { tokens: 1650, costUsd: 0.25, turns: 5, interruptions: 3, attempts: 2 } })
    // A record with no token counts is counted, and said to be.
    expect(report.notes).toEqual(['1 usage record(s) carry no token counts (the runtime reported none): tokens count the others only'])
  })

  it('flags each day over the charter\'s attention budget, for a report on that project only', () => {
    const sources = week()
    sources.projects = [project('p1', { maxInterruptionsPerDay: 1 })]
    const report = buildReport(PERIOD, sources, 'p1')
    expect(report.attention.days.filter((d) => d.over).map((d) => d.date)).toEqual(['2026-10-17', '2026-10-18'])
    expect(report.attention).toMatchObject({ threshold: { maxInterruptionsPerDay: 1 }, daysOver: 2 })
    // The studio report names no threshold: a charter's budget is its project's.
    expect(buildReport(PERIOD, sources)).not.toHaveProperty('attention.threshold')
  })

  it('gives the same report for the same records, whatever order they were read in, and renders it the same', () => {
    const one = week()
    const two = week()
    for (const key of ['projects', 'tasks', 'requests', 'usage', 'events'] as const) (two[key] as unknown[]).reverse()
    const a = buildReport(PERIOD, one, 'p1')
    const b = buildReport(PERIOD, two, 'p1')
    expect(b).toEqual(a)
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    expect(renderReport(b)).toBe(renderReport(a))
  })

  it('divides nothing with no accepted result, counts nothing outside the period, and lists at most 100 projects, counting the rest', () => {
    const empty = buildReport({ since: at(-30), until: at(-20) }, week(), 'p1')
    expect(empty).toMatchObject({ tasks: { created: 0, done: 0, cancelled: 0 }, attempts: { reported: 0 }, approvals: { asked: 0, openNow: 2 }, attention: { interruptions: 0, batches: 0, days: [], daysOver: 0 }, baseline: { acceptedResults: 0 } })
    expect(empty.baseline).not.toHaveProperty('perAcceptedResult')
    expect(empty.approvals).not.toHaveProperty('wait')
    expect(empty.usage.pools).toEqual([])
    expect(renderReport(empty)).toContain('No accepted result in the period')
    const many = { ...week(), projects: Array.from({ length: MAX_PROJECTS + 1 }, (_, i) => project(`p${String(i).padStart(3, '0')}`)) }
    const studio = buildReport(PERIOD, many)
    expect(studio.projects).toHaveLength(MAX_PROJECTS)
    expect(studio.projects[0]!.projectId).toBe('p000')
    expect(studio.projectsOmitted).toBe(1)
    expect(() => schemas.assertDef('mcp-report@1.0', 'report-output', studio)).not.toThrow()
    // More pools than one report lists refuses it, never truncates it (INV-9).
    const pools = { ...week(), usage: Array.from({ length: 65 }, (_, i) => usage(`r${i}`, `pool-${i}`, at(1))) }
    expect(() => buildReport(PERIOD, pools)).toThrow(/name 65 pools, more than 64/)
  })

  it('classes an attempt reported with reconcileRun by where it left its task: done is accepted, review is held for the operator', () => {
    const sources = { ...week(), events: [
      event('workflow.task.reported', at(1), { taskId: 't1', status: 'reconciled', state: 'done' }, { runId: 'r-a' }),
      event('workflow.task.reported', at(1), { taskId: 't2', status: 'reconciled', state: 'review' }, { runId: 'r-b' }),
      event('workflow.task.reported', at(1), { taskId: 't3', status: 'reconciled', state: 'ready' }, { runId: 'r-c' }),
      event('workflow.task.reported', at(1), { taskId: 't4', status: 'moved-on', state: 'cancelled' }, { runId: 'r-d' }),
    ] }
    const report = buildReport(PERIOD, sources, 'p1')
    expect(report.attempts).toMatchObject({ reported: 4, accepted: 1, heldForOperator: 1, reconciled: 1, other: 1, review: { none: 4 } })
    expect(report.attention.interruptions).toBe(5 + 1)
  })

  it('leaves the digests\' claims out with no digest provider to read them', () => {
    const { digests: _, ...sources } = week()
    expect(buildReport(PERIOD, sources, 'p1').digests).toEqual({ attached: 1, bypassed: 1 })
  })

  it('scopes a project\'s report to what names it, its tasks, and the runs and executions that served them; the studio report counts everything', () => {
    const tasks = [task('t1', 'done'), task('t2', 'running', { run: { runId: 'run-live', startedAt: at(1) } })]
    const reported = [event('workflow.task.reported', at(1), { taskId: 't1', status: 'accepted' }, { runId: 'run-1' }), event('workflow.task.reported', at(1), { taskId: 'other', status: 'accepted' }, { runId: 'run-x' })]
    const runs = runsOf(tasks, reported)
    expect([...runs].sort()).toEqual(['run-1', 'run-live'])
    const scope = { projectId: 'p1', tasks: new Set(['t1', 't2']), runs: new Set([...runs, 'agent-run-7']) }
    expect([
      usage('a', 'p', at(1), { projectId: 'p1' }), usage('b', 'p', at(1), { taskId: 't2' }), usage('c', 'p', at(1), { runId: 'agent-run-7' }), usage('d', 'p', at(1), { runId: 'run-x' }), usage('e', 'p', at(1)),
    ].filter((u) => within.usage(scope, u)).map((u) => u.requestId)).toEqual(['a', 'b', 'c'])
    expect([
      request('r1', 'charter', at(1)), request('r2', 'command', at(1), undefined, { requester: { component: 'worker', runId: 'agent-run-7', sessionId: 's' } }),
      request('r3', 'command', at(1), undefined, { requester: { component: 'worker', runId: 'elsewhere', sessionId: 's' } }), request('r4', 'charter', at(1), undefined, { requester: { component: 'board', projectId: 'p2' } }),
    ].filter((r) => within.request(scope, r)).map((r) => r.requestId)).toEqual(['r1', 'r2'])
    const ids = new Set(['r1', 'r2'])
    expect([
      event('workflow.task.digest', at(1), { taskId: 't2', state: 'attached' }), event('workflow.gate.opened', at(1), { by: 'queue' }, { runId: 'run-1' }),
      event('workflow.gate.opened', at(1), { by: 'queue' }, { runId: 'run-x' }), event('approvals.batched', at(1), { batchId: 'b', requests: ['r9', 'r2'] }),
      event('approvals.batched', at(1), { batchId: 'c', requests: ['r9'] }),
    ].filter((e) => within.event(scope, e, ids)).map((e) => e.seq)).toEqual([seq - 4, seq - 3, seq - 1])
    const studio = { tasks: new Set<string>(), runs: new Set<string>() }
    expect(within.usage(studio, usage('e', 'p', at(1))) && within.request(studio, request('r4', 'charter', at(1))) && within.event(studio, reported[1]!, new Set())).toBe(true)
  })

  it('renders one screen for the operator, its numbers written without a locale', () => {
    expect([whole(0), whole(999), whole(1000), whole(1234567), whole(1650.5)]).toEqual(['0', '999', '1,000', '1,234,567', '1,650.5'])
    expect([duration(0), duration(45), duration(725), duration(10_920), duration(187_200), duration(DAY / 1000)]).toEqual(['0s', '45s', '12m 5s', '3h 2m', '2d 4h', '1d'])
    const text = renderReport(buildReport(PERIOD, week(), 'p1'))
    expect(text.split('\n')[0]).toBe('# Report: project p1 (project p1)')
    for (const heading of ['## Progress', '## Results', '## Attention', '## Resources', '## Baseline', '## Digests', '## Not counted']) expect(text).toContain(`\n${heading}\n`)
    expect(text).toContain('- Asked of you: 6 (5 approval requests, 1 review held for you), in 2 batches.')
    expect(text).toContain('- Your verdicts took: median 2h, 90th percentile 10h, longest 10h (3 verdicts).')
    expect(text).toContain('- Charter allows 2 interruptions and 1 batch a day: never over it.')
    expect(text).toContain('- Per accepted result: 1,650 tokens, $0.2500, 5 turns, 2 attempts, 3 interruptions.')
    expect(text).toContain('- all pools: 3,000 tokens in (2,400 cache reads, 0 cache writes), 300 out; 10 turns; $0.5000; 4 records; not counted: 1 record without token counts.')
    expect(text).toContain('- b.pool: 1,000 tokens in (800 cache reads, 0 cache writes), 100 out; 3 turns; $0.1000; 1 record.')
  })

  it('counts the runs whose usage the ledger could not count, each once per pool by its first entry, those counted since, and the records without a figure (D25)', () => {
    const fact = (runId: string, pool: string, kind: UsageUnknown['kind'], extra: Partial<UsageUnknown> = {}): UsageUnknown => ({
      schema: 'usage-unknown@1.0', runId, kind, account: 'acc', pool, observedAt: at(1), reason: 'why', ...(kind === 'refused' ? { failure: 'invalid' as const } : {}), ...extra,
    })
    const unknowns: UnknownRead[] = [
      { at: at(1), fact: fact('arun-1', 'a.pool', 'not-reported', { projectId: 'p1' }), reconciled: false },
      // The same run again (a restart found it interrupted): once, by its first entry.
      { at: at(1, 13), fact: fact('arun-1', 'a.pool', 'interrupted', { projectId: 'p1' }), reconciled: false },
      { at: at(2), runId: 'run-1', fact: fact('arun-2', 'a.pool', 'refused'), reconciled: false },
      // The ledger has counted a record of it since: reconciled, so no figure misses it.
      { at: at(3), fact: fact('arun-3', 'a.pool', 'failed', { taskId: 't1' }), reconciled: true },
      // A pool with no counted record in the period still gets its line.
      { at: at(4), fact: fact('arun-4', 'c.pool', 'interrupted', { projectId: 'p1' }), reconciled: false },
      // Outside the period, and outside the project.
      { at: at(8), fact: fact('arun-5', 'a.pool', 'not-reported', { projectId: 'p1' }), reconciled: false },
      { at: at(2), fact: fact('arun-6', 'a.pool', 'not-reported', { projectId: 'p2' }), reconciled: false },
    ]
    // A record with no cost and no turns: a usd or turns cap counts it as 0 of them.
    const { cost: _, turns: __, ...bare } = usage('r5', 'b.pool', at(2))
    const sources = { ...week(), usage: [...week().usage, bare] }
    const scope = { projectId: 'p1', tasks: new Set(['t1']), runs: new Set(['run-1']) }
    const report = buildReport(PERIOD, { ...sources, unknowns: unknowns.filter((u) => within.unknown(scope, u)) }, 'p1')
    expect(() => schemas.assertDef('mcp-report@1.1', 'report-output', report)).not.toThrow()
    expect(report.usage.unknown).toEqual({ runs: 4, reconciled: 1, notReported: 1, interrupted: 1, refused: 1, failed: 1 })
    expect(report.usage.total).toMatchObject({ records: 5, withoutTokens: 1, withoutCost: 1, withoutTurns: 1, unknownRuns: 3 })
    expect(report.usage.pools.map((p) => [p.pool, p.records, p.unknownRuns, p.withoutCost])).toEqual([['a.pool', 3, 2, undefined], ['b.pool', 2, undefined, 1], ['c.pool', 0, 1, undefined]])
    expect(report.notes).toEqual([
      '1 usage record(s) carry no token counts (the runtime reported none): tokens count the others only',
      '1 usage record(s) carry no cost (the runtime reported none): cost counts the others only',
      '1 usage record(s) carry no turn count: turns count the others only',
      '3 run(s) whose usage the ledger could not count, and has not counted since: no figure counts them, and a cap counts them as 0 (4 recorded in the period: 1 not-reported, 1 interrupted, 1 refused, 1 failed, 1 of them counted since; system events --type usage.unknown)',
    ])
    const text = renderReport(report)
    expect(text).toContain('- a.pool: 2,000 tokens in (1,600 cache reads, 0 cache writes), 200 out; 7 turns; $0.4000; 3 records; not counted: 2 runs whose usage is unknown, 1 record without token counts.')
    expect(text).toContain('- c.pool: 0 tokens in (0 cache reads, 0 cache writes), 0 out; 0 turns; $0.0000; 0 records; not counted: 1 run whose usage is unknown.')
    expect(text).toContain('- Usage the ledger could not count: 4 runs (1 not reported, 1 interrupted, 1 refused by the ledger, 1 failed to record), 1 of them counted since; a cap counts the others as 0.')
    // The same entries in another order give the same report; none gives no such field.
    expect(buildReport(PERIOD, { ...sources, unknowns: [...unknowns].reverse().filter((u) => within.unknown(scope, u)) }, 'p1')).toEqual(report)
    expect(buildReport(PERIOD, week(), 'p1').usage).not.toHaveProperty('unknown')
    // The studio report counts every one of the period, the other project's included.
    expect(buildReport(PERIOD, { ...sources, unknowns }).usage.unknown).toMatchObject({ runs: 5, notReported: 2 })
  })

  it('shows the agent runs whose liveness asked for the operator in its attention, and those still held, never counting them as interruptions (PROP-0013)', () => {
    const live = (type: string, when: string, agentRun: string, extra: Record<string, unknown> = {}) => event(`agent-workers.run.${type}`, when, { agentRun, worker: 'agent:dev', ...extra }, { runId: 'run-1' })
    const sources = { ...week(), events: [
      ...week().events,
      live('stalled', at(1), 'arun-1', { quietSeconds: 400, stallSeconds: 300 }),
      live('unknown', at(2), 'arun-2', { verdict: 'unknown', looks: 3, cause: 'holder' }),
      live('unknown', at(3), 'arun-3', { verdict: 'unknown', looks: 0, cause: 'cancel' }),
      live('freed', at(4), 'arun-2', { again: false, worktrees: 1 }),
      // Freed again for its worktree: one run freed, once.
      live('freed', at(5), 'arun-2', { again: true, worktrees: 1 }),
      // Outside the period.
      live('unknown', at(8), 'arun-4', { verdict: 'unknown', looks: 3, cause: 'holder' }),
    ] }
    const report = buildReport(PERIOD, sources, 'p1')
    expect(() => schemas.assertDef('mcp-report@1.2', 'report-output', report)).not.toThrow()
    expect(report.attention.liveness).toEqual({ stalled: 1, unknown: 2, freed: 1, held: [{ agentRun: 'arun-3', worker: 'agent:dev', at: at(3), runId: 'run-1' }] })
    // Interruptions keep their meaning: approval requests and reviews held for the operator.
    expect(report.attention.interruptions).toBe(buildReport(PERIOD, week(), 'p1').attention.interruptions)
    const text = renderReport(report)
    expect(text).toContain('- Agent runs: 1 stalled, 2 ended without being known to be gone (their session and worktree held until you free them), 1 freed by you.')
    expect(text).toContain('- Still held: arun-3 on agent:dev (run run-1); system explain <run> says why, and system free <run> --agent-gone frees one once its agent is gone.')
    // None: no such field, no such line.
    expect(buildReport(PERIOD, week(), 'p1').attention).not.toHaveProperty('liveness')
    expect(renderReport(buildReport(PERIOD, week(), 'p1'))).not.toContain('Agent runs')
  })
})
