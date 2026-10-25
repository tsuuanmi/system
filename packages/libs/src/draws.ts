/**
 * Quota drawn per run (PROP-0015 E2, docs/design/resources.md#quota-drawn-per-run): what one agent run
 * drew from each window of its account's pool, from the window's last reading before the run and its
 * first reading after it, as a `quota-draw@1.0` record. Its Worker source stores it as an `evidence`
 * artifact and appends one `quota.draw` event whose data is the record; `system usage` and the report
 * read the events back into figures per kind of work, template step, and window.
 *
 * - A draw is the rise of the window's used share, in percentage points, so it compares with headroom
 *   (`100 − used − reserve`, also points). It is recorded only when both readings give a used share
 *   and belong to the same window epoch: the same reset, read as `accountQuotaOf` reads it (the later
 *   of `resetsAt` and `cooldownUntil`).
 * - `reset-crossing`, with no draw: the epochs differ, either reading names no reset, or the used share
 *   went down. `no-reading`, with no draw: a reading before or after is missing or gives no used share.
 *   `confounded`: another run on the account overlapped this one, so the rise is not this run's alone;
 *   its draw is kept, out of the figures. Only `clean` draws are counted in a median or a percentile.
 * - Nothing is estimated (resources rule 3): a missing reading leaves no draw, and a draw is never
 *   negative.
 */
import type { QuotaReading, QuotaWindow } from './quota.ts'
import { SchemaRegistry } from './schemas.ts'

/** The event type of a run's quota draw; its data is the `quota-draw@1.0` record. */
export const QUOTA_DRAW_EVENT = 'quota.draw'

/** A window entry's state: only `clean` draws enter the figures. */
export type DrawState = 'clean' | 'confounded' | 'reset-crossing' | 'no-reading'
export const DRAW_STATES: readonly DrawState[] = ['clean', 'confounded', 'reset-crossing', 'no-reading']

/** A reading as a draw keeps it: its used share, its epoch, and when it was observed. */
export interface DrawReading {
  usedPercentage?: number
  /** The later of `resetsAt` and `cooldownUntil`; absent when it names neither. */
  resets?: string
  observedAt: string
}

/** One window's draw. */
export interface DrawEntry {
  window: string
  seconds?: number
  before?: DrawReading
  after?: DrawReading
  /** Percentage points; only for `clean` and `confounded`. */
  draw?: number
  state: DrawState
  why?: string
}

/** `quota-draw@1.0`; the schema in `schemas/` is canonical. */
export interface QuotaDraw {
  schema: 'quota-draw@1.0'
  runId: string
  worker: string
  account: string
  pool: string
  workflowRunId?: string
  template?: string
  step?: string
  kind?: string
  projectId?: string
  taskId?: string
  outcome: 'completed' | 'failed' | 'aborted'
  startedAt: string
  endedAt: string
  /** Other runs on the same account that ran at some time while this one did. */
  overlapping: number
  windows: DrawEntry[]
  observedAt: string
}

/** The most windows a record holds (the schema's bound). */
export const MAX_DRAW_WINDOWS = 16

let registry: SchemaRegistry | undefined
const schemas = (): SchemaRegistry => (registry ??= new SchemaRegistry())

const later = (a: string | undefined, b: string | undefined): string | undefined => (a === undefined ? b : b === undefined ? a : Date.parse(a) >= Date.parse(b) ? a : b)
const used = (r: QuotaReading | undefined): number | undefined => (r?.usedPercentage === undefined || !Number.isFinite(r.usedPercentage) ? undefined : Math.min(100, Math.max(0, r.usedPercentage)))
/** Thousandths of a point: readings are shares, so float noise never reads as a draw. */
const points = (n: number): number => Math.round(n * 1000) / 1000

function kept(r: QuotaReading): DrawReading {
  const share = used(r)
  const resets = later(r.resetsAt, r.cooldownUntil)
  return { ...(share !== undefined ? { usedPercentage: share } : {}), ...(resets !== undefined ? { resets } : {}), observedAt: r.observedAt }
}

/**
 * Each window's entry of one run, in the pool's window order: `before` is each window's latest reading
 * when the run was submitted (`startedAt`), `after` its latest once the account's usage report after
 * the run was recorded; an `after` reading observed before `endedAt` is not one after the run.
 * `overlapping`: the other runs on the account that ran while this one did. Pure.
 */
export function drawEntries(input: {
  windows: readonly QuotaWindow[]
  before: readonly QuotaReading[]
  after: readonly QuotaReading[]
  startedAt: string
  endedAt: string
  overlapping: number
}): DrawEntry[] {
  const started = Date.parse(input.startedAt)
  const ended = Date.parse(input.endedAt)
  return input.windows.slice(0, MAX_DRAW_WINDOWS).map((w): DrawEntry => {
    const base = { window: w.id, ...(w.seconds !== undefined ? { seconds: w.seconds } : {}) }
    const b = input.before.find((r) => r.window.id === w.id && !(Date.parse(r.observedAt) > started))
    const a = input.after.find((r) => r.window.id === w.id)
    const before = b ? kept(b) : undefined
    const after = a && !(Date.parse(a.observedAt) < ended) ? kept(a) : undefined
    const read = { ...base, ...(before ? { before } : {}), ...(after ? { after } : {}) }
    if (!before) return { ...read, state: 'no-reading', why: 'no reading before the run' }
    if (!after) return { ...read, state: 'no-reading', why: a ? `no reading after the run: the latest, observed ${a.observedAt}, is from before it ended` : 'no reading after the run' }
    if (before.usedPercentage === undefined) return { ...read, state: 'no-reading', why: 'the reading before the run gives no used share' }
    if (after.usedPercentage === undefined) return { ...read, state: 'no-reading', why: 'the reading after the run gives no used share' }
    if (before.resets === undefined || after.resets === undefined) return { ...read, state: 'reset-crossing', why: `the reading ${before.resets === undefined ? 'before' : 'after'} the run names no reset time, so its epoch is not known` }
    if (Date.parse(before.resets) !== Date.parse(after.resets)) return { ...read, state: 'reset-crossing', why: `the window reset between the readings (${before.resets}, then ${after.resets})` }
    const rise = points(after.usedPercentage - before.usedPercentage)
    if (rise < 0) return { ...read, state: 'reset-crossing', why: `its used share went down (${before.usedPercentage} %, then ${after.usedPercentage} %)` }
    if (input.overlapping > 0) return { ...read, draw: rise, state: 'confounded', why: `${input.overlapping} other run${input.overlapping === 1 ? '' : 's'} on the account overlapped it` }
    return { ...read, draw: rise, state: 'clean' }
  })
}

/** The `quota-draw@1.0` record of `fields`; throws a `SchemaError` when it is not one. */
export function quotaDraw(fields: Omit<QuotaDraw, 'schema'>): QuotaDraw {
  const record: QuotaDraw = { schema: 'quota-draw@1.0', ...fields }
  schemas().assert(record.schema, record)
  return record
}

/** A `quota.draw` entry's data as its record, or undefined when it is not a valid `quota-draw@1.0` (a reader never guesses, INV-14). */
export function quotaDrawOf(data: unknown): QuotaDraw | undefined {
  try {
    schemas().assert('quota-draw@1.0', data)
    return data as QuotaDraw
  } catch {
    return undefined
  }
}

/** The figures of one group of window entries: clean draws counted, their median and 90th percentile, and the entries left out by why. */
export interface DrawFigure {
  /** The kind of work; absent: runs admitted for no kind. */
  kind?: string
  /** With `by: 'step'`: the template and step; absent: runs that served no workflow step. */
  template?: string
  step?: string
  window: string
  /** Clean draws: the only ones in `median` and `p90`. */
  draws: number
  /** Percentage points; absent with no clean draw. */
  median?: number
  p90?: number
  /** Entries left out of the figures, by state. */
  excluded: { confounded: number; 'reset-crossing': number; 'no-reading': number }
}

/** The 90th percentile by nearest rank: the smallest draw at or above 90 % of them. */
function nearestRank(sorted: readonly number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : points((sorted[mid - 1]! + sorted[mid]!) / 2)
}

const order = (a: string | undefined, b: string | undefined): number => (a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a < b ? -1 : 1)

/**
 * The figures of `records` per kind and window (`by: 'kind'`), or per kind, template step, and window
 * (`by: 'step'`): each group's clean draws counted, their median (the middle one, or the mean of the
 * two middle ones) and 90th percentile (nearest rank), and the entries left out by state. A run's
 * record counts once, by its first (`runId`). Ordered by kind, template, step, then window; a group
 * with no kind or step last. Pure.
 */
export function drawFigures(records: readonly QuotaDraw[], by: 'kind' | 'step' = 'kind'): DrawFigure[] {
  const groups = new Map<string, { figure: DrawFigure; values: number[] }>()
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.runId)) continue
    seen.add(record.runId)
    const step: { template?: string; step?: string } = by === 'step' && record.step !== undefined ? { ...(record.template !== undefined ? { template: record.template } : {}), step: record.step } : {}
    for (const entry of record.windows) {
      const key = JSON.stringify([record.kind ?? null, step.template ?? null, step.step ?? null, entry.window])
      const group = groups.get(key) ?? groups.set(key, {
        figure: { ...(record.kind !== undefined ? { kind: record.kind } : {}), ...step, window: entry.window, draws: 0, excluded: { confounded: 0, 'reset-crossing': 0, 'no-reading': 0 } },
        values: [],
      }).get(key)!
      if (entry.state === 'clean' && entry.draw !== undefined) group.values.push(entry.draw)
      else if (entry.state !== 'clean') group.figure.excluded[entry.state] += 1
    }
  }
  return [...groups.values()].map(({ figure, values }) => {
    const sorted = [...values].sort((a, b) => a - b)
    return { ...figure, draws: sorted.length, ...(sorted.length ? { median: median(sorted), p90: nearestRank(sorted, 0.9) } : {}) }
  }).sort((a, b) => order(a.kind, b.kind) || order(a.template, b.template) || order(a.step, b.step) || order(a.window, b.window))
}

/** A figure as one line: "code · 5 h window five-hour: 12 draws, median 4 points, p90 9 points (excluded: 2 confounded, 1 reset-crossing)". */
export function drawFigureText(f: DrawFigure, windowLabel: string = f.window): string {
  const what = [f.kind ?? 'no kind', ...(f.step !== undefined ? [`${f.template ?? '?'}:${f.step}`] : [])].join(' · ')
  const figures = f.draws ? `${f.draws} draw${f.draws === 1 ? '' : 's'}, median ${f.median} points, p90 ${f.p90} points` : 'no clean draw'
  const excluded = (Object.entries(f.excluded) as Array<[string, number]>).filter(([, n]) => n).map(([state, n]) => `${n} ${state}`)
  return `${what} · ${windowLabel}: ${figures}${excluded.length ? ` (excluded: ${excluded.join(', ')})` : ''}`
}
