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
 *     <a weekly window per model family>?: W | null, "model_scoped"?: […], "extra_usage"?: {…} | null },
 *   "behaviors": null }                         W = { "utilization": number (0 to 100) | null, "resets_at": ISO 8601 | null }
 * ```
 *
 * Only `rate_limits` is read; `session`, `subscription_type`, `model_scoped`, `extra_usage`, and
 * `behaviors` are not.
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
 * without the profile scope. The read writes no transcript and sends no model request. The fixtures
 * in `tests/fixtures/claude-get-usage.json` hold answers in that shape. Each version is also a
 * release check on a live account (docs/validation/release-checklist.md).
 */
export const VERIFIED_LIMIT_VERSIONS: readonly string[] = ['2.1.308', '2.1.309', '2.1.310']

/** Entries of `rate_limits` that are not a window: the per-model list and the extra usage spend (not read). */
const NOT_WINDOWS = new Set(['model_scoped', 'extra_usage'])
/** A reset time further than this from now is not believed. */
const PLAUSIBLE_MS = 400 * 86_400_000
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The limit observations a `get_usage` answer gives, read at `observedAt` (ms), or why it cannot be
 * read. Only an answer whose `rate_limits_available` is true with `rate_limits` an object is read:
 * `false` (an API key, a third-party provider, a sign-in without the profile scope) has no plan
 * windows. In it, each named window that is not null is `{ utilization, resets_at }`, or the whole
 * answer is unreadable (something changed, so nothing in it is believed): a `utilization` that is
 * not a number or null, or is negative; a `resets_at` that is not a string or null. Each window
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
    if (NOT_WINDOWS.has(name) || window === null) continue
    if (!isObject(window) || !(window.utilization === null || typeof window.utilization === 'number') || !(window.resets_at === null || typeof window.resets_at === 'string')) {
      return { unreadable: `its window ${name.slice(0, 64)} is not in the checked shape ({ utilization, resets_at })` }
    }
    if (window.utilization === null) continue
    if (!Number.isFinite(window.utilization) || window.utilization < 0) return { unreadable: `its window ${name.slice(0, 64)} reports a used share that is not a percentage` }
    const used = Math.min(100, Math.round(window.utilization * 100) / 100)
    const status = used >= 100 ? 'rejected' : 'allowed'
    const reset = typeof window.resets_at === 'string' && ISO.test(window.resets_at) ? Date.parse(window.resets_at) : Number.NaN
    const believed = Number.isFinite(reset) && Math.abs(reset - observedAt) <= PLAUSIBLE_MS && (status !== 'rejected' || reset > observedAt)
    limits.push({ window: name, status, ...(believed ? { resetsAt: new Date(reset).toISOString() } : {}), usedPercentage: used, observedAt: observed })
  }
  return { limits }
}
