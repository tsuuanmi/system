/**
 * Claude Code's usage report as limit observations (ADR-0059,
 * docs/design/agent-runtimes.md#an-accounts-usage-report). The SDK's
 * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` sends the control request `get_usage`,
 * which the CLI answers without a model turn from the account's usage endpoint, the figures `/usage`
 * renders:
 *
 * ```
 * { "session": {…}, "subscription_type": string | null, "rate_limits_available": boolean,
 *   "rate_limits": null | { "five_hour"?: W | null, "seven_day"?: W | null, "seven_day_oauth_apps"?: W | null,
 *     <a weekly window per model family>?: W | null, <entries that are not windows>?: … },
 *   "behaviors": null }                         W = { "utilization": number (0 to 100) | null, "resets_at": ISO 8601 | null, … }
 * ```
 *
 * Only `rate_limits` is read, and in it only the windows, told by their shape, and the per-model
 * weekly windows of `model_scoped` (`[{ display_name, utilization, resets_at }]`, ADR-0073), each a
 * window named `model_scoped:<display name>`: the other entries (`limits`, an array; `spend`, an
 * object without a `utilization`; `member_dashboard_available`, a boolean) are not, nor is
 * `extra_usage` (by name: it has a `utilization` and no reset), nor are `session`,
 * `subscription_type`, and `behaviors`.
 * @module
 */
import type { LimitObservation, LimitReport } from '@tsuuanmi/system-agent-runtime-core'

/**
 * Claude Code versions whose `get_usage` answer is read. On any other version the report is never
 * asked for, and reads `unreadable`, naming the version (the method is named experimental by its
 * vendor: an upgrade turns the shares unknown until the new version is checked; it never misreads
 * them). Checked from the installed binaries of 2.1.308, 2.1.309, and 2.1.310 (2026-10-24, T101; no
 * account used), whose code here differs only in minified names: the handler validates
 * `skip_behaviors` and answers `{ session, subscription_type, rate_limits_available, rate_limits,
 * behaviors }`; `rate_limits` is the body of `GET /api/oauth/usage` (or a snapshot of it under a
 * minute old, kept per account in the home's `.claude.json` as `cachedUsageUtilization`), with
 * `model_scoped`; the response schema's window is `{ utilization, resets_at }`, "Percentage of the
 * window used, 0-100", which `/usage` prints as `Math.floor(utilization)` "% used", and `resets_at`
 * an ISO string; `rate_limits_available` is false for an API key, a third-party provider, or a token
 * without the profile scope. The read writes no transcript and sends no model request. The endpoint's
 * body changes without a new Claude Code version: on 2026-10-24 (T111) a live answer carried no
 * `model_scoped`, a window with an extra `limit_dollars`, and entries that are not windows (`limits`,
 * `spend`, `member_dashboard_available`, and null ones such as `pace`), so a window is told by its
 * shape, not its name. The fixtures in `tests/fixtures/claude-get-usage.json` hold answers in these
 * shapes. Each version is also a release check on a live account
 * (docs/validation/release-checklist.md).
 */
export const VERIFIED_LIMIT_VERSIONS: readonly string[] = ['2.1.308', '2.1.309', '2.1.310']

/** A reset time further than this from now is not believed. */
const PLAUSIBLE_MS = 400 * 86_400_000
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/**
 * The one entry of `rate_limits` that has a `utilization` and is not a window: the extra usage spend
 * (`{ is_enabled, monthly_limit, used_credits, utilization, currency }`, no reset), not read.
 */
const NOT_WINDOWS = new Set(['extra_usage'])
/**
 * Whether an entry of `rate_limits` is not a window, by its shape: an array, a boolean, a string, or
 * an object without a `utilization` (a per-model list, the spend, a flag). A number is not skipped:
 * it may be a share in a changed shape, so it makes the answer unreadable.
 */
const notWindow = (value: unknown): boolean => Array.isArray(value) || typeof value === 'boolean' || typeof value === 'string' || (isObject(value) && !('utilization' in value))

/**
 * The limit observations a `get_usage` answer gives, read at `observedAt` (ms), or why it cannot be
 * read. Only an answer whose `rate_limits_available` is true with `rate_limits` an object is read:
 * `false` (an API key, a third-party provider, a sign-in without the profile scope) has no plan
 * windows. In it, `model_scoped` gives one observation per model ({@link modelScopedWindow}); a
 * null entry, `extra_usage`, and one that is not a window by its shape are
 * skipped; each other is a window `{ utilization, resets_at }` (further fields ignored), or the
 * whole answer is unreadable (something changed, so nothing in it is believed): an entry that is a
 * number, a `utilization` that is not a number or null, or is negative; a `resets_at` missing, or
 * not a string or null. Each window
 * whose `utilization` is a number is one observation of its name (`five_hour`, `seven_day`, …, the
 * names a `rate_limit_event` uses): `usedPercentage` its utilization (at most 100), `rejected` when
 * it is 100 or more (nothing left), else `allowed`, with `resetsAt` when `resets_at` is an ISO time
 * at most 400 days away and, for a rejection, still ahead. A window whose utilization is null is no
 * reading.
 */
export function limitsFromUsage(answer: unknown, observedAt: number): LimitReport {
  if (!isObject(answer)) return { unreadable: 'its answer is not an object' }
  if (typeof answer.rate_limits_available !== 'boolean') return { unreadable: 'its answer is not in the checked shape (no rate_limits_available)' }
  if (!answer.rate_limits_available) return { unreadable: 'the account reports no plan limits (an API key, a third-party provider, or a sign-in without the profile scope)' }
  const windows = answer.rate_limits
  if (!isObject(windows)) return { unreadable: 'it reports plan limits, and its rate_limits is not an object' }
  const observed = new Date(observedAt).toISOString()
  const limits: LimitObservation[] = []
  for (const name of Object.keys(windows).sort()) {
    const window = windows[name]
    // The per-model weekly windows (ADR-0073), a list, each read as a window of its own.
    if (name === MODEL_SCOPED && Array.isArray(window)) {
      limits.push(...modelScoped(window, observedAt, observed))
      continue
    }
    if (window === null || NOT_WINDOWS.has(name) || notWindow(window)) continue
    if (!isObject(window) || !(window.utilization === null || typeof window.utilization === 'number') || !(window.resets_at === null || typeof window.resets_at === 'string')) {
      return { unreadable: `its window ${name.slice(0, 64)} is not in the checked shape ({ utilization, resets_at })` }
    }
    if (window.utilization === null) continue
    if (!Number.isFinite(window.utilization) || window.utilization < 0) return { unreadable: `its window ${name.slice(0, 64)} reports a used share that is not a percentage` }
    limits.push(observationOf(name, window.utilization, window.resets_at, observedAt, observed))
  }
  return { limits }
}

/** The entry of `rate_limits` that lists the per-model weekly windows: `[{ display_name, utilization, resets_at }]`. */
const MODEL_SCOPED = 'model_scoped'
/** A per-model window's name: `model_scoped:` and the model's display name, lower-cased, each run of other characters than letters, digits, `.`, `_`, and `-` one `-`, at most 64 characters in all. */
export const modelScopedWindow = (displayName: string): string =>
  `${MODEL_SCOPED}:${displayName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 64)

/** One window's observation: its share (at most 100), rejected at 100 or more, and its reset when believed. */
function observationOf(name: string, utilization: number, resetsAt: unknown, observedAt: number, observed: string): LimitObservation {
  const used = Math.min(100, Math.round(utilization * 100) / 100)
  const status = used >= 100 ? 'rejected' : 'allowed'
  const reset = typeof resetsAt === 'string' && ISO.test(resetsAt) ? Date.parse(resetsAt) : Number.NaN
  const believed = Number.isFinite(reset) && Math.abs(reset - observedAt) <= PLAUSIBLE_MS && (status !== 'rejected' || reset > observedAt)
  return { window: name, status, ...(believed ? { resetsAt: new Date(reset).toISOString() } : {}), usedPercentage: used, observedAt: observed }
}

/**
 * The per-model weekly windows (ADR-0073), each `{ display_name, utilization, resets_at }`, as
 * observations named {@link modelScopedWindow}: the operator maps a model's to its pool's window
 * (`modelPools[].windows`). A list in any other shape (an entry that is not such an object, a name
 * that is not text or reads as nothing, a share that is not a percentage, a name twice) gives no
 * per-model reading at all, while the account's own windows are still read: their windows keep their
 * last readings, never an invented one (INV-2). An entry whose share is null is no reading.
 */
function modelScoped(list: readonly unknown[], observedAt: number, observed: string): LimitObservation[] {
  const out: LimitObservation[] = []
  const names = new Set<string>()
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.display_name !== 'string' || !(entry.utilization === null || typeof entry.utilization === 'number') || !(entry.resets_at === null || entry.resets_at === undefined || typeof entry.resets_at === 'string')) return []
    const name = modelScopedWindow(entry.display_name)
    if (name === `${MODEL_SCOPED}:` || names.has(name)) return []
    names.add(name)
    if (entry.utilization === null) continue
    if (!Number.isFinite(entry.utilization) || entry.utilization < 0) return []
    out.push(observationOf(name, entry.utilization, entry.resets_at, observedAt, observed))
  }
  return out
}
