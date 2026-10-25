// Quota drawn per run (PROP-0015 E2, docs/design/resources.md#quota-drawn-per-run): each window's
// draw from its reading before a run and its first after it, only in the same window epoch, never
// negative or estimated; and the figures per kind, template step, and window over clean draws only.
import { describe, expect, it } from 'vitest'
import { drawEntries, drawFigures, drawFigureText, type QuotaDraw, quotaDraw, quotaDrawOf, type QuotaReading, SchemaError } from '../src/index.ts'

const FIVE = { id: 'five-hour', kind: 'rolling', seconds: 18_000 }
const SEVEN = { id: 'seven-day', kind: 'rolling', seconds: 604_800 }
const START = '2026-10-25T09:00:00.000Z'
const END = '2026-10-25T09:20:00.000Z'
const RESET = '2026-10-25T12:00:00.000Z'
const read = (window: string, usedPercentage: number | undefined, observedAt: string, resets: { resetsAt?: string; cooldownUntil?: string } = { resetsAt: RESET }): QuotaReading => ({
  window: { id: window }, state: 'ok', ...(usedPercentage !== undefined ? { usedPercentage } : {}), ...resets, observedAt,
})
const BEFORE = '2026-10-25T08:58:00.000Z'
const AFTER = '2026-10-25T09:20:02.000Z'
const entries = (before: QuotaReading[], after: QuotaReading[], overlapping = 0, windows = [FIVE]) => drawEntries({ windows, before, after, startedAt: START, endedAt: END, overlapping })

describe('drawEntries: one entry per window, a draw only in the same epoch', () => {
  it('draws the rise of the used share in percentage points, per window, and keeps both readings', () => {
    expect(entries([read('five-hour', 31, BEFORE), read('seven-day', 40, BEFORE, { resetsAt: '2026-10-29T00:00:00.000Z' })], [read('five-hour', 40, AFTER), read('seven-day', 40.3, AFTER, { resetsAt: '2026-10-29T00:00:00.000Z' })], 0, [FIVE, SEVEN])).toEqual([
      { window: 'five-hour', seconds: 18_000, before: { usedPercentage: 31, resets: RESET, observedAt: BEFORE }, after: { usedPercentage: 40, resets: RESET, observedAt: AFTER }, draw: 9, state: 'clean' },
      { window: 'seven-day', seconds: 604_800, before: { usedPercentage: 40, resets: '2026-10-29T00:00:00.000Z', observedAt: BEFORE }, after: { usedPercentage: 40.3, resets: '2026-10-29T00:00:00.000Z', observedAt: AFTER }, draw: 0.3, state: 'clean' },
    ])
    // No rise is a draw of 0, not a missing one.
    expect(entries([read('five-hour', 31, BEFORE)], [read('five-hour', 31, AFTER)])[0]).toMatchObject({ draw: 0, state: 'clean' })
  })

  it('reads the epoch as accountQuotaOf does: the later of resetsAt and cooldownUntil', () => {
    const cooled = { resetsAt: '2026-10-25T10:00:00.000Z', cooldownUntil: RESET }
    expect(entries([read('five-hour', 50, BEFORE, cooled)], [read('five-hour', 55, AFTER)])[0]).toMatchObject({ before: { resets: RESET }, draw: 5, state: 'clean' })
  })

  it('gives no draw, reset-crossing, when the epochs differ, either reading names no reset, or the share went down', () => {
    const later = { resetsAt: '2026-10-25T17:00:00.000Z' }
    expect(entries([read('five-hour', 72, BEFORE)], [read('five-hour', 80, AFTER, later)])[0]).toMatchObject({ state: 'reset-crossing', why: `the window reset between the readings (${RESET}, then ${later.resetsAt})` })
    expect(entries([read('five-hour', 72, BEFORE, {})], [read('five-hour', 80, AFTER)])[0]).toMatchObject({ state: 'reset-crossing', why: 'the reading before the run names no reset time, so its epoch is not known' })
    expect(entries([read('five-hour', 72, BEFORE)], [read('five-hour', 80, AFTER, {})])[0]).toMatchObject({ state: 'reset-crossing', why: expect.stringContaining('the reading after the run names no reset time') })
    expect(entries([read('five-hour', 72, BEFORE)], [read('five-hour', 70, AFTER)])[0]).toMatchObject({ state: 'reset-crossing', why: 'its used share went down (72 %, then 70 %)' })
    for (const e of [...entries([read('five-hour', 72, BEFORE)], [read('five-hour', 4, AFTER, later)]), ...entries([read('five-hour', 72, BEFORE)], [read('five-hour', 70, AFTER)])]) expect(e).not.toHaveProperty('draw')
  })

  it('gives no draw, no-reading, with a reading missing before or after the run, one from before it ended, or one with no share', () => {
    expect(entries([], [read('five-hour', 40, AFTER)])[0]).toEqual({ window: 'five-hour', seconds: 18_000, after: expect.any(Object), state: 'no-reading', why: 'no reading before the run' })
    expect(entries([read('five-hour', 31, BEFORE)], [])[0]).toMatchObject({ state: 'no-reading', why: 'no reading after the run' })
    // The latest reading is still the one before, or one the run made while it ran: not one after it.
    expect(entries([read('five-hour', 31, BEFORE)], [read('five-hour', 35, '2026-10-25T09:10:00.000Z')])[0]).toMatchObject({ state: 'no-reading', why: 'no reading after the run: the latest, observed 2026-10-25T09:10:00.000Z, is from before it ended' })
    // A reading observed after the run started is not one before it.
    expect(entries([read('five-hour', 31, '2026-10-25T09:00:01.000Z')], [read('five-hour', 40, AFTER)])[0]).toMatchObject({ state: 'no-reading', why: 'no reading before the run' })
    expect(entries([read('five-hour', undefined, BEFORE)], [read('five-hour', 40, AFTER)])[0]).toMatchObject({ state: 'no-reading', why: 'the reading before the run gives no used share' })
    expect(entries([read('five-hour', 31, BEFORE)], [read('five-hour', undefined, AFTER)])[0]).toMatchObject({ state: 'no-reading', why: 'the reading after the run gives no used share' })
  })

  it('marks a draw confounded when other runs on the account overlapped it; one with no draw keeps its own reason', () => {
    expect(entries([read('five-hour', 31, BEFORE)], [read('five-hour', 40, AFTER)], 2)[0]).toMatchObject({ draw: 9, state: 'confounded', why: '2 other runs on the account overlapped it' })
    expect(entries([read('five-hour', 31, BEFORE)], [read('five-hour', 30, AFTER)], 1)[0]).toMatchObject({ state: 'reset-crossing' })
  })
})

const record = (runId: string, kind: string | undefined, step: string | undefined, windows: QuotaDraw['windows']): QuotaDraw => quotaDraw({
  runId, worker: 'agent:a/dev', account: 'a', pool: 'plan/a', ...(kind ? { kind } : {}), ...(step ? { template: 'algorithm-development', step } : {}),
  outcome: 'completed', startedAt: START, endedAt: END, overlapping: 0, windows, observedAt: AFTER,
})
const clean = (window: string, draw: number): QuotaDraw['windows'][number] => ({
  window, before: { usedPercentage: 10, resets: RESET, observedAt: BEFORE }, after: { usedPercentage: 10 + draw, resets: RESET, observedAt: AFTER }, draw, state: 'clean',
})

describe('quota-draw@1.0 records', () => {
  it('are validated when made and read back only when valid (INV-14)', () => {
    const made = record('arun_1', 'code', 'develop', [clean('five-hour', 9)])
    expect(quotaDrawOf(made)).toEqual(made)
    expect(quotaDrawOf({ ...made, overlapping: -1 })).toBeUndefined()
    expect(quotaDrawOf({ ...made, windows: [{ window: 'five-hour', state: 'reset-crossing', draw: 3, why: 'x' }] })).toBeUndefined()
    expect(() => record('arun_1', 'Code', undefined, [clean('five-hour', 9)])).toThrow(SchemaError)
  })
})

describe('drawFigures: clean draws per kind (or template step) and window, with the median, p90, and counts', () => {
  const twelve = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 30].map((d, i) => record(`arun_${i}`, 'code', i % 2 ? 'develop' : 'fix', [clean('five-hour', d), clean('seven-day', d / 10)]))
  const excluded = [
    record('arun_x1', 'code', 'develop', [{ ...clean('five-hour', 50), state: 'confounded', why: '1 other run on the account overlapped it' }, { window: 'seven-day', state: 'reset-crossing', why: 'reset' }]),
    record('arun_x2', 'code', 'develop', [{ window: 'five-hour', state: 'no-reading', why: 'no reading after the run' }, clean('seven-day', 0.5)]),
    record('arun_d1', 'docs', undefined, [clean('five-hour', 2), clean('seven-day', 0.1)]),
    record('arun_n1', undefined, undefined, [clean('five-hour', 4)]),
  ]

  it('per kind and window: the count of clean draws, their median and p90 (nearest rank), and the entries left out by state', () => {
    const figures = drawFigures([...twelve, ...excluded])
    expect(figures).toEqual([
      { kind: 'code', window: 'five-hour', draws: 12, median: 6.5, p90: 11, excluded: { confounded: 1, 'reset-crossing': 0, 'no-reading': 1 } },
      { kind: 'code', window: 'seven-day', draws: 13, median: 0.6, p90: 1.1, excluded: { confounded: 0, 'reset-crossing': 1, 'no-reading': 0 } },
      { kind: 'docs', window: 'five-hour', draws: 1, median: 2, p90: 2, excluded: { confounded: 0, 'reset-crossing': 0, 'no-reading': 0 } },
      { kind: 'docs', window: 'seven-day', draws: 1, median: 0.1, p90: 0.1, excluded: { confounded: 0, 'reset-crossing': 0, 'no-reading': 0 } },
      { window: 'five-hour', draws: 1, median: 4, p90: 4, excluded: { confounded: 0, 'reset-crossing': 0, 'no-reading': 0 } },
    ])
    // A confounded draw of 50 is never in a figure.
    expect(Math.max(...figures.map((f) => f.p90 ?? 0))).toBeLessThan(50)
  })

  it('per kind, template step, and window; a run counted once, by its first record', () => {
    const figures = drawFigures([...twelve, twelve[0]!], 'step').filter((f) => f.window === 'five-hour')
    expect(figures).toEqual([
      { kind: 'code', template: 'algorithm-development', step: 'develop', window: 'five-hour', draws: 6, median: 7, p90: 30, excluded: { confounded: 0, 'reset-crossing': 0, 'no-reading': 0 } },
      { kind: 'code', template: 'algorithm-development', step: 'fix', window: 'five-hour', draws: 6, median: 6, p90: 11, excluded: { confounded: 0, 'reset-crossing': 0, 'no-reading': 0 } },
    ])
  })

  it('a group with no clean draw has no median, and says so in words', () => {
    const [only] = drawFigures([excluded[0]!].map((r) => ({ ...r, windows: [r.windows[0]!] })))
    expect(only).toEqual({ kind: 'code', window: 'five-hour', draws: 0, excluded: { confounded: 1, 'reset-crossing': 0, 'no-reading': 0 } })
    expect(drawFigureText(only!, '5 h')).toBe('code · 5 h: no clean draw (excluded: 1 confounded)')
    expect(drawFigureText(drawFigures(twelve, 'step')[0]!, '5 h')).toBe('code · algorithm-development:develop · 5 h: 6 draws, median 7 points, p90 30 points')
  })
})
