/**
 * The quota score (`quota-score@2`, PROP-0014, ADR-0064): how much of each window of an account's
 * pools a Worker may still draw on, and the order in which Workers are offered work by quota. A pure
 * rule over the resource ledger's recorded readings and the operator's quota settings, pinned by
 * version as `livenessOf` is: the same inputs always give the same order.
 *
 * **One implementation** (T185, PROP-0014 D3): an account's headroom is {@link accountQuotaOf}, and
 * its place in the use-it-or-lose-it order is {@link headroomOrderOf} ({@link headroomKeysOf},
 * {@link compareHeadroom}). Dispatch's score ({@link quotaScoreOf}), routing's order (`ctx.workers`,
 * every step of every run), and the roster's capacity summary (`gateway-core`) all call them; none
 * computes headroom itself.
 *
 * - A window is **known** when its latest reading is at most `staleReadingSeconds` old, reads `ok`,
 *   gives a used share, and its reset (when it names one) is still ahead. Anything else (no reading
 *   yet, a stale, `unknown`, or `limited` reading, a reading with no used share, one from before its
 *   reset) is not known, and an unknown window never counts as headroom (INV-2).
 * - Its **headroom** is `100 − used − reservePercent`: what work may draw, the reserve (20 % of each
 *   window by default, D63) kept for the operator's own use of the plan. Its **reset** is the later of
 *   `resetsAt` and `cooldownUntil`. A window read now as `limited`, or known with no headroom left, is
 *   **over the reserve**: its account is used above `100 − reservePercent` %.
 * - An account is **free** by its quota when every pool of it is available, every window is known, and
 *   every window has headroom above the reserve (above 0). A pool available only because it is
 *   configured `unknown: available` is never read as having headroom.
 * - The headroom order: an account over its reserve last while another one is free; then known before
 *   assumed before unknown; then the window that resets soonest (within `useSoonMinutes`, with at
 *   least `minHeadroomPercent` left) first, the earlier reset first; then the most headroom, in buckets.
 * - Candidates are ordered by that order's reserve key, tier, quota class (metered last), the rest of
 *   the headroom order, then load, the priority list, and id; the chosen one is the first that is free.
 *   Every candidate says why, in words a decision records (INV-13).
 *
 * The rule names no vendor, model, or tool (INV-11): it compares opaque pools, classes, and ids. Which
 * windows an account has is the operator's pool configuration: an account's canonical gauge is the
 * windows its pool lists (D70: a Claude Code plan's five-hour window only).
 */

/**
 * The rule's version, as a decision that applies it names it. A change of behavior is a new version.
 * 2 (T185): a reading from before its reset is not known; an account over its reserve ranks last
 * while another is free.
 */
export const QUOTA_SCORE = 'quota-score@2'

/** The operator's quota settings (the resource ledger's `quota`, ADR-0064), each a whole number in its range. */
export interface QuotaSettings {
  /** Share of every window kept free of dispatched work, for the operator's own use (0 to 90). */
  reservePercent: number
  /** A window that resets within this many minutes is used first (0 to 1440; 0: no such key). */
  useSoonMinutes: number
  /** The binding window's headroom a window about to reset needs to be used first (1 to 100). */
  minHeadroomPercent: number
  /** Headroom is compared in buckets this wide, so readings a few points apart do not reorder (1 to 25). */
  headroomBucketPercent: number
  /** A reading older than this many seconds is stale, so its window is not known (60 to 86400). */
  staleReadingSeconds: number
}

/** The defaults (D63: the reserve is 20 % of every window). */
export const QUOTA_DEFAULTS: Readonly<QuotaSettings> = Object.freeze({
  reservePercent: 20, useSoonMinutes: 90, minHeadroomPercent: 10, headroomBucketPercent: 5, staleReadingSeconds: 1800,
})

/** Each setting's range, both ends included (INV-9). */
export const QUOTA_RANGES: Readonly<Record<keyof QuotaSettings, readonly [number, number]>> = Object.freeze({
  reservePercent: [0, 90], useSoonMinutes: [0, 1440], minHeadroomPercent: [1, 100], headroomBucketPercent: [1, 25], staleReadingSeconds: [60, 86_400],
})

/** Every problem of a quota settings object, by path (`quota.<key>`); empty when it is valid. */
export function quotaSettingsProblems(value: unknown, path = 'quota'): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} must be an object of ${Object.keys(QUOTA_RANGES).join(', ')}`]
  const problems: string[] = []
  const given = value as Record<string, unknown>
  for (const key of Object.keys(given)) if (!(key in QUOTA_RANGES)) problems.push(`${path}.${key} is not a quota setting (${Object.keys(QUOTA_RANGES).join(', ')})`)
  for (const [key, [min, max]] of Object.entries(QUOTA_RANGES)) {
    const v = given[key]
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) problems.push(`${path}.${key} must be a whole number from ${min} to ${max}, not ${JSON.stringify(v)}`)
  }
  return problems
}

/** A pool window, as the ledger configures it. */
export interface QuotaWindow {
  id: string
  kind: string
  seconds?: number
}

/** A window's latest reading, as the ledger records it (`limit-state@1.0`). */
export interface QuotaReading {
  window: { id: string }
  state: 'ok' | 'limited' | 'unknown'
  usedPercentage?: number
  resetsAt?: string
  cooldownUntil?: string
  observedAt: string
}

/** A pool now, as the ledger's `pools()` gives it (`PoolState`). */
export interface QuotaPool {
  pool: string
  kind: string
  available: boolean
  until?: string
  unknown?: 'available' | 'unavailable'
  windows: readonly QuotaWindow[]
  readings: readonly QuotaReading[]
}

/** One window as the rule reads it. */
export interface WindowQuota {
  pool: string
  window: string
  seconds?: number
  /** Its latest reading's state, or `none` before any reading. */
  state: 'ok' | 'limited' | 'unknown' | 'none'
  known: boolean
  /** Why it is not known, in words; absent when known. */
  unknown?: string
  /** The used share, in percent, when the reading gives one. */
  used?: number
  /** `100 − used − reservePercent`, when the used share is given (may be 0 or less). */
  headroom?: number
  /** When its unused share is lost: the later of `resetsAt` and `cooldownUntil`. */
  resets?: string
  /** Whole minutes until `resets`, when that is still ahead. */
  resetsInMinutes?: number
  observedAt?: string
  /** Read now (not stale, its reset ahead) as `limited`, or known with no headroom above the reserve. */
  overReserve?: true
}

/** The pools of one account as the rule reads them. */
export interface AccountQuota {
  pools: Array<{ pool: string; available: boolean; until?: string; windows: WindowQuota[] }>
  /** `known`: every window of every pool known; `assumed`: some pool available only by its `unknown: available` configuration; `unknown`: anything else, no pool included. */
  knowledge: 'known' | 'assumed' | 'unknown'
  /** The known window with the least headroom, when every window is known. */
  binding?: WindowQuota
  /** The known window that resets soonest (ahead of now), when every window is known. */
  soonest?: WindowQuota
  /** Every pool available, every window known with headroom above the reserve. */
  free: boolean
  /** The first window (by pool, then window) read now above `100 − reservePercent` %, or at its limit: the account is over its reserve. */
  over?: WindowQuota
  /** Why it is not free by its quota, in words; empty when free. */
  why: string[]
  /**
   * No window of a pool configured `unknown: available` has ever been read, and nothing else holds the
   * account back (T294): a caller may admit it at a bounded concurrency. A reading replaces this.
   */
  unread?: true
  /** The lines of `why` that only say the account is unread; a caller that admits it at its bound leaves them out. */
  unreadWhy?: string[]
}

const round1 = (n: number): number => Math.round(n * 10) / 10
const later = (a: string | undefined, b: string | undefined): string | undefined => (a === undefined ? b : b === undefined ? a : Date.parse(a) >= Date.parse(b) ? a : b)
/** Code-point order, independent of locale. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** A window by its length as people read it ("5 h", "7 days"), else its id. */
export function windowName(w: { window?: string; id?: string; seconds?: number }): string {
  const s = w.seconds
  const id = w.window ?? w.id ?? '?'
  if (s === undefined || s <= 0) return id
  if (s % 86_400 === 0) return `${s / 86_400} day${s === 86_400 ? '' : 's'}`
  if (s % 3600 === 0) return `${s / 3600} h`
  if (s % 60 === 0) return `${s / 60} min`
  return id
}

/** Minutes in words: "40 min", "2 h 5 min", "3 days". */
function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
  return `${Math.floor(minutes / 1440)} days`
}

/** One window of a pool as the rule reads it at `now`. */
function windowOf(pool: QuotaPool, w: QuotaWindow, settings: QuotaSettings, now: number): WindowQuota {
  const base: WindowQuota = { pool: pool.pool, window: w.id, ...(w.seconds !== undefined ? { seconds: w.seconds } : {}), state: 'none', known: false }
  const r = pool.readings.find((reading) => reading.window.id === w.id)
  if (!r) return { ...base, unknown: 'no reading yet' }
  const resets = later(r.resetsAt, r.cooldownUntil)
  const ahead = resets !== undefined && Date.parse(resets) > now ? Math.floor((Date.parse(resets) - now) / 60_000) : undefined
  const used = r.usedPercentage === undefined || !Number.isFinite(r.usedPercentage) ? undefined : Math.min(100, Math.max(0, r.usedPercentage))
  const read: WindowQuota = {
    ...base, state: r.state, observedAt: r.observedAt, ...(used !== undefined ? { used: round1(used), headroom: round1(100 - used - settings.reservePercent) } : {}),
    ...(resets !== undefined ? { resets } : {}), ...(ahead !== undefined ? { resetsInMinutes: ahead } : {}),
  }
  const age = now - Date.parse(r.observedAt)
  const current = Number.isFinite(age) && age <= settings.staleReadingSeconds * 1000
  const past = resets !== undefined && !(Date.parse(resets) > now)
  const unknown = !Number.isFinite(age) ? 'its latest reading has no valid time'
    : !current ? `its latest reading is ${minutesText(Math.floor(age / 60_000))} old, more than ${minutesText(Math.floor(settings.staleReadingSeconds / 60))} (stale)`
      : past ? `its latest reading is from before its reset at ${resets}, so its used share is no longer current`
        : r.state === 'limited' ? `it is at its limit${resets ? ` until ${resets}` : ''}`
          : r.state === 'unknown' ? 'its latest reading is unknown'
            : used === undefined ? 'its latest reading gives no used share' : undefined
  // Over the reserve: read now as at its limit, or known with no headroom left above the reserve.
  const over = current && !past && (r.state === 'limited' || (unknown === undefined && read.headroom! <= 0))
  return { ...read, ...(unknown ? { unknown } : { known: true }), ...(over ? { overReserve: true as const } : {}) }
}

/**
 * The pools of one account as the rule reads them at `now` (undefined, or `{unknown}`: the ledger could
 * not tell; an empty list: the account has no pool). Pure: the same pools, settings, and time give the
 * same answer. A caller that shows an account's capacity reads its headroom and reset from here, so it
 * is computed once, by one rule.
 */
export function accountQuotaOf(pools: readonly QuotaPool[] | { unknown: string } | undefined, settings: QuotaSettings, now: Date): AccountQuota {
  if (pools === undefined || !Array.isArray(pools)) {
    const why = pools === undefined ? 'its Worker names no account, so no pool can be told to be its' : (pools as { unknown: string }).unknown
    return { pools: [], knowledge: 'unknown', free: false, why: [`its quota is unknown: ${why}`] }
  }
  const list = pools as readonly QuotaPool[]
  if (!list.length) return { pools: [], knowledge: 'unknown', free: false, why: ['its account has no pool on the resource ledger, so its quota is unknown'] }
  const at = now.getTime()
  const read = [...list].sort((a, b) => compare(a.pool, b.pool)).map((p) => ({ pool: p, windows: p.windows.map((w) => windowOf(p, w, settings, at)) }))
  const windows = read.flatMap((p) => p.windows)
  const why: string[] = []
  // Each window's own reason first: a pool's unavailability follows from it.
  for (const w of windows) if (!w.known) why.push(`${windowName(w)} window of ${w.pool}: ${w.unknown}`)
  for (const { pool, windows: ws } of read) {
    if (!ws.length) why.push(`pool ${pool.pool} has no window, so its quota is unknown`)
    if (!pool.available) why.push(`pool ${pool.pool} is not available${pool.until ? ` until ${pool.until}` : ''}`)
  }
  const assumed = read.some(({ pool, windows: ws }) => pool.unknown === 'available' && ws.some((w) => !w.known))
  const assumedLine = 'a pool is available only because it is configured unknown: available; its windows are not known, so it is never read as having headroom'
  if (assumed) why.push(assumedLine)
  // Unread: every window of the account has no reading at all (one read window, known or not, ends it), in pools available by `unknown: available`.
  const notKnown = read.flatMap(({ pool, windows: ws }) => ws.filter((w) => !w.known).map((w) => ({ pool, w })))
  const unread = assumed && read.every((p) => p.windows.length > 0 && p.pool.available && p.pool.unknown === 'available') && windows.every((w) => w.state === 'none')
  const unreadWhy = unread ? [...notKnown.map(({ w }) => `${windowName(w)} window of ${w.pool}: ${w.unknown}`), assumedLine] : []
  const allKnown = windows.length > 0 && windows.every((w) => w.known) && read.every((p) => p.windows.length > 0)
  for (const w of allKnown ? windows : []) {
    if (w.headroom! <= 0) why.push(`${windowName(w)} window of ${w.pool}: used ${w.used} %, no headroom above the ${settings.reservePercent} % reserve`)
  }
  const knowledge = allKnown ? 'known' : assumed ? 'assumed' : 'unknown'
  const binding = allKnown ? [...windows].sort((a, b) => a.headroom! - b.headroom! || compare(a.pool, b.pool) || compare(a.window, b.window))[0] : undefined
  const ahead = allKnown ? windows.filter((w) => w.resetsInMinutes !== undefined).sort((a, b) => a.resetsInMinutes! - b.resetsInMinutes! || compare(a.pool, b.pool) || compare(a.window, b.window)) : []
  const over = windows.find((w) => w.overReserve)
  return {
    pools: read.map(({ pool, windows: ws }) => ({ pool: pool.pool, available: pool.available, ...(pool.until ? { until: pool.until } : {}), windows: ws })),
    knowledge, ...(binding ? { binding } : {}), ...(ahead[0] ? { soonest: ahead[0] } : {}), free: why.length === 0, ...(over ? { over } : {}), why,
    ...(unread ? { unread: true as const, unreadWhy } : {}),
  }
}

/** An account's place in the headroom order (use it or lose it), each key lower first. */
export interface HeadroomKeys {
  /** 1 when the account is over its reserve while another account compared with it is free; else 0. */
  reserve: number
  /** 0 known, 1 assumed (`unknown: available`), 2 unknown. */
  knowledge: number
  /** 0 when a window resets within `useSoonMinutes` with at least `minHeadroomPercent` headroom; else 1. */
  useSoon: number
  /** Minutes to that reset, among those used soon; 0 otherwise. */
  resetsIn: number
  /** Minus the binding window's headroom bucket (more headroom first); 0 when not known. */
  headroom: number
}

/** The headroom order's keys, in the order they are compared. */
export const HEADROOM_KEYS: ReadonlyArray<keyof HeadroomKeys> = ['reserve', 'knowledge', 'useSoon', 'resetsIn', 'headroom']

const KNOWLEDGE = { known: 0, assumed: 1, unknown: 2 } as const

/**
 * An account's keys in the headroom order. `othersFree`: whether another account it is compared with is
 * free by its quota; only then does an account over its reserve rank last (it gets no new work while
 * another account has headroom, and still ranks by its readings when none has).
 */
export function headroomKeysOf(quota: AccountQuota, settings: QuotaSettings, othersFree: boolean): HeadroomKeys {
  const soon = settings.useSoonMinutes > 0 && quota.knowledge === 'known' && quota.soonest !== undefined && quota.soonest.resetsInMinutes! <= settings.useSoonMinutes
    && quota.binding !== undefined && quota.binding.headroom! >= settings.minHeadroomPercent
  return {
    reserve: quota.over && othersFree ? 1 : 0, knowledge: KNOWLEDGE[quota.knowledge],
    useSoon: soon ? 0 : 1, resetsIn: soon ? quota.soonest!.resetsInMinutes! : 0,
    headroom: quota.knowledge === 'known' && quota.binding ? -Math.floor(Math.max(0, quota.binding.headroom!) / settings.headroomBucketPercent) : 0,
  }
}

/** The headroom order: negative when `a` comes first, 0 when the keys tie (the caller's next key decides). */
export function compareHeadroom(a: HeadroomKeys, b: HeadroomKeys): number {
  for (const key of HEADROOM_KEYS) if (a[key] !== b[key]) return a[key] - b[key]
  return 0
}

/**
 * Many accounts in the headroom order at once: each one's quota and keys, an account over its reserve
 * keyed last when another one of them is free. The one way any caller orders accounts by quota.
 */
export function headroomOrderOf<T>(items: readonly T[], poolsOf: (item: T) => readonly QuotaPool[] | { unknown: string } | undefined, settings: QuotaSettings, now: Date): Array<{ item: T; quota: AccountQuota; keys: HeadroomKeys }> {
  const quotas = items.map((item) => ({ item, quota: accountQuotaOf(poolsOf(item), settings, now) }))
  return quotas.map(({ item, quota }) => ({ item, quota, keys: headroomKeysOf(quota, settings, quotas.some((o) => o.quota !== quota && o.quota.free)) }))
}

/** An account's quota in one clause: "known, 5 h: used 10 %, resets in 40 min, headroom 70" (its binding and soonest windows). */
export function headroomLine(quota: AccountQuota): string {
  const parts: string[] = [quota.unread ? 'unread' : quota.knowledge]
  const shown = [quota.binding, quota.soonest].filter((w, i, all): w is WindowQuota => w !== undefined && all.findIndex((x) => x?.pool === w.pool && x?.window === w.window) === i)
  for (const w of shown) parts.push(`${windowName(w)}: used ${w.used} %${w.resetsInMinutes !== undefined ? `, resets in ${minutesText(w.resetsInMinutes)}` : ''}`)
  if (quota.binding) parts.push(`headroom ${quota.binding.headroom}`)
  if (quota.over && !quota.binding) parts.push(`${windowName(quota.over)} over the reserve${quota.over.used !== undefined ? ` (used ${quota.over.used} %)` : ' (at its limit)'}`)
  return parts.join(', ')
}

/**
 * Why `first` comes before `other` on the first headroom key that differs, in words; undefined when
 * every headroom key ties.
 */
export function headroomReason(first: { who: string; quota: AccountQuota; keys: HeadroomKeys }, other: { quota: AccountQuota; keys: HeadroomKeys }, settings: QuotaSettings): string | undefined {
  const who = first.who
  const key = HEADROOM_KEYS.find((k) => first.keys[k] !== other.keys[k])
  switch (key) {
    case 'reserve': {
      const w = other.quota.over!
      return `${who}'s account has headroom; this one's ${windowName(w)} window is ${w.used !== undefined ? `used ${w.used} %, above ${100 - settings.reservePercent} % (the ${settings.reservePercent} % reserve)` : 'at its limit'}, so it ranks last while another has headroom`
    }
    case 'knowledge': return `${who}'s windows are ${first.quota.knowledge === 'known' ? 'all known' : 'assumed available by configuration'}; this one's are ${other.quota.knowledge}`
    case 'useSoon': return `${who}'s ${windowName(first.quota.soonest!)} window resets in ${minutesText(first.keys.resetsIn)}, within ${settings.useSoonMinutes} min, with headroom ${first.quota.binding!.headroom}: its unused share is used before it is lost`
    case 'resetsIn': return `${who}'s window resets sooner (in ${minutesText(first.keys.resetsIn)}; this one in ${minutesText(other.keys.resetsIn)})`
    case 'headroom': return `${who} has more headroom (${first.quota.binding!.headroom} against ${other.quota.binding!.headroom}, in ${settings.headroomBucketPercent}-point buckets)`
    default: return undefined
  }
}

/** One Worker as the score takes it: routing's admission of it, and what the caller knows of it. */
export interface QuotaCandidate {
  worker: string
  /** Why routing refused it, in the router's words; absent or empty: admitted. */
  refused?: readonly string[]
  tier: string
  /** Its tier's rank, lowest first (routing's own rule: the lowest admissible tier first). */
  tierRank: number
  quotaClass: string
  /** Its quota class's place in the caller's order (`budget.preferQuota`, then `quotaPreference`). */
  quotaRank: number
  /** Metered (an API key, a credit): ordered after every other class, and never free (D65). */
  metered: boolean
  /** Its load as its source reports it; undefined when it reports none. */
  load?: { running: number; queued: number; pending: number; slots: number }
  /** Its place in the configured priority list (its length when absent). */
  priorityRank: number
  /** Its account's pools on the ledger; undefined when it names no account; `{unknown}` when they could not be read. */
  pools: readonly QuotaPool[] | { unknown: string } | undefined
  /** Why it is not free besides its quota, in words (the caller's: its state, a step on it, a bound of its account or repository). */
  busy?: readonly string[]
  /**
   * The bound an unread account is admitted at (T294): `running` dispatched runs or asks its account
   * has now, at most `limit`. Absent: an unread account is not admitted.
   */
  unreadBound?: { running: number; limit: number }
}

/** The keys a candidate is ordered by, each lower first: the headroom order's, with routing's own around them. */
export interface QuotaKeys extends HeadroomKeys {
  /** 1 for an account admitted only at the unread bound: after every account with a reading, whatever its tier. */
  unread: number
  tier: number
  /** 1 for metered, then the quota class's rank. */
  metered: number
  quota: number
  load: number
  priority: number
}

/** One candidate as the score ranks it. */
export interface ScoredCandidate {
  worker: string
  admitted: boolean
  free: boolean
  /** Its place among the admitted candidates, from 1, in order. */
  place?: number
  quota?: AccountQuota
  keys?: QuotaKeys
  /** Its quota in one line: "tier standard, agent-plan, known, 5 h: used 0 %, resets in 40 min, headroom 80, load 0 of 1". */
  line: string
  /** Why it won, why it lost to the chosen one, why it is not free, or why routing refused it. */
  reasons: string[]
}

export interface QuotaScore {
  version: typeof QUOTA_SCORE
  /** The first free candidate in order; absent when none is free. */
  chosen?: string
  /** The admitted candidates in order, then the refused ones by id. */
  candidates: ScoredCandidate[]
}

const loadOf = (load: QuotaCandidate['load']): number => (load ? load.running + load.queued + load.pending : 0)

/** The reserve key first (an account over its reserve last while another has headroom), then routing's tier and class, the rest of the headroom order, then load and priority. */
const KEY_ORDER: ReadonlyArray<keyof QuotaKeys> = ['unread', 'reserve', 'tier', 'metered', 'quota', 'knowledge', 'useSoon', 'resetsIn', 'headroom', 'load', 'priority']

function lineOf(c: QuotaCandidate, quota: AccountQuota): string {
  const parts = [`tier ${c.tier}`, c.quotaClass + (c.metered ? ' (metered)' : ''), headroomLine(quota)]
  parts.push(c.load ? `load ${c.load.running} of ${c.load.slots}${c.load.queued ? `, ${c.load.queued} queued` : ''}${c.load.pending ? `, ${c.load.pending} pending` : ''}` : 'no load reported')
  return parts.join(', ')
}

/** Why `chosen` comes before `other`: the first key that differs, in words. */
function beats(chosen: { c: QuotaCandidate; q: AccountQuota; k: QuotaKeys }, other: { c: QuotaCandidate; q: AccountQuota; k: QuotaKeys }, settings: QuotaSettings): string {
  const who = chosen.c.worker
  const key = KEY_ORDER.find((k) => chosen.k[k] !== other.k[k])
  switch (key) {
    case 'unread': return `${who}'s account has a reading; this one is unread, admitted only at the unread bound, so it comes after every account with headroom`
    case 'tier': return `${who} has the lower tier ${chosen.c.tier}`
    case 'metered': return `${who} is not metered; metered pools come last`
    case 'quota': return `${who} has the preferred quota class ${chosen.c.quotaClass}`
    case 'load': return `${who} is less busy (${loadOf(chosen.c.load)} running, queued, or pending; this one ${loadOf(other.c.load)})`
    case 'priority': return `${who} comes first in the configured priority list`
    case undefined: return `${who} comes first by id`
    default: return headroomReason({ who, quota: chosen.q, keys: chosen.k }, { quota: other.q, keys: other.k }, settings)!
  }
}

/**
 * Rank the Workers routing admits for one step by quota, and choose the first free one
 * (`quota-score@2`). Refused candidates keep routing's reasons and are never ranked or chosen; an
 * admitted candidate that is not free is ranked anyway, so the decision says why it lost. Pure and
 * total: the same candidates, settings, and time always give the same order and choice.
 */
export function quotaScoreOf(candidates: readonly QuotaCandidate[], settings: QuotaSettings, now: Date): QuotaScore {
  const problems = quotaSettingsProblems(settings)
  if (problems.length) throw new RangeError(`quotaScoreOf: ${problems.join('; ')}`)
  const admitted = headroomOrderOf(candidates.filter((c) => !c.refused?.length), (c) => c.pools, settings, now).map(({ item: c, quota: q, keys }) => ({
    c, q, k: { ...keys, unread: q.unread && c.unreadBound ? 1 : 0, tier: c.tierRank, metered: c.metered ? 1 : 0, quota: c.quotaRank, load: loadOf(c.load), priority: c.priorityRank } as QuotaKeys,
  }))
  admitted.sort((a, b) => {
    for (const key of KEY_ORDER) if (a.k[key] !== b.k[key]) return a.k[key] - b.k[key]
    return compare(a.c.worker, b.c.worker)
  })
  /** An unread account the caller bounds is admitted at that bound: its unread lines drop out, unless the bound is reached. */
  const unreadOf = (a: (typeof admitted)[number]): { bound: NonNullable<QuotaCandidate['unreadBound']> } | undefined => (a.q.unread && a.c.unreadBound ? { bound: a.c.unreadBound } : undefined)
  const notFree = (a: (typeof admitted)[number]): string[] => {
    const bound = unreadOf(a)?.bound
    return [
      ...(a.c.metered ? ['metered: dispatch never starts work on a metered pool by itself (D65)'] : []),
      ...(a.c.busy ?? []),
      ...(bound ? a.q.why.filter((w) => !a.q.unreadWhy!.includes(w)) : a.q.why),
      ...(bound && bound.running >= bound.limit ? [`unread: its account has ${bound.running} dispatched run(s) or ask(s), the unread bound is ${bound.limit}`] : []),
    ]
  }
  const chosen = admitted.find((a) => notFree(a).length === 0)
  const ranked: ScoredCandidate[] = admitted.map((a, i) => {
    const why = notFree(a)
    const line = lineOf(a.c, a.q)
    const bound = unreadOf(a)?.bound
    const reasons = a === chosen && bound ? [`unread, admitted at the unread bound (${bound.running} of ${bound.limit} dispatched run(s) or ask(s) on its account): no window has been read yet`, line, `first in the quota order (${QUOTA_SCORE})`]
      : a === chosen ? [`free: every window has headroom above the ${settings.reservePercent} % reserve`, line, `first in the quota order (${QUOTA_SCORE})`]
      : why.length ? [...why.map((w) => `not free: ${w}`), line]
        : [`free, but ${beats(chosen!, a, settings)}`, line]
    return { worker: a.c.worker, admitted: true, free: why.length === 0, place: i + 1, quota: a.q, keys: a.k, line, reasons }
  })
  const refused: ScoredCandidate[] = candidates.filter((c) => c.refused?.length).sort((a, b) => compare(a.worker, b.worker))
    .map((c) => ({ worker: c.worker, admitted: false, free: false, line: `tier ${c.tier}, ${c.quotaClass}`, reasons: c.refused!.map((r) => `refused by routing: ${r}`) }))
  return { version: QUOTA_SCORE, ...(chosen ? { chosen: chosen.c.worker } : {}), candidates: [...ranked, ...refused] }
}
