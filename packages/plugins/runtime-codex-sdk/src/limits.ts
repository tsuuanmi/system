/**
 * Codex's usage-limit message as a limit observation (docs/design/agent-runtimes.md#metering).
 * `codex exec --experimental-json`, which the SDK drives, emits no rate-limit event (its events
 * are `thread.started`, `turn.*`, `item.*`, and `error`); a turn that hits the account's usage limit
 * fails with Codex's own message, which names when to try again:
 * `You’ve hit your usage limit. … try again at 3:04 PM.` (the reset is today) or
 * `… try again at Oct 25th, 2026 3:04 PM.`, in the Codex process's local time to the minute, or
 * `… try again later.` when Codex knows no reset. The runtime starts Codex with `TZ=UTC`, so that
 * time is UTC. The message names no window, so the observation's window is `*`, which no
 * configuration maps: the ledger closes every window of the pool until the reset.
 * @module
 */
import type { LimitObservation } from '@tsuuanmi/system-agent-runtime-core'

/**
 * Codex versions whose usage-limit message is read. 0.164.0 (2026-10-24, the installed
 * `@openai/codex` 0.164.0, `codex-linux-x64`): its binary holds the message's parts
 * (`You’ve hit your usage limit`, ` Try again at `, ` or try again at `, ` or try again later.`) and
 * the reset's two formats (`%-I:%M %p` for a reset today, `%b %-d` + day suffix + `, %Y %-I:%M %p`
 * otherwise), formatted in local time; `tests/fixtures/codex-0.164.0-limit-messages.json` holds
 * messages in that shape. On any other version the message is not read, and the run's error says so.
 */
export const VERIFIED_LIMIT_VERSIONS: readonly string[] = ['0.164.0']

/** The message of a turn that hit the account's usage limit (Codex writes a typographic apostrophe). */
const USAGE_LIMIT = /hit your usage limit/
/** `try again at <time>.`: an optional `Mon D(st|nd|rd|th), YYYY ` date, then `H:MM AM|PM`. */
const TRY_AGAIN = /\b[Tt]ry again at (?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) )?(\d{1,2}):(\d{2}) ([AP]M)\./
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** The message gives the reset to the minute, truncated: the window opens before the next one. */
const MINUTE_MS = 60_000
/** A reset time further than this from now is not believed. */
const PLAUSIBLE_MS = 400 * 86_400_000

/**
 * The usage limit `message` names, as a `rejected` observation of window `*` with its reset time,
 * read at `observedAt` (ms). Undefined when the message is not Codex's usage-limit message, names no
 * reset (`try again later`), names one that does not parse, or one that is not ahead of `observedAt`
 * or more than 400 days ahead: a reset that cannot be read is no reading, and the run's limit then
 * closes the pool for the Worker's cooldown (never open). A reset written as a time of day is taken
 * on `observedAt`'s UTC date: a message written just before midnight and read after it reads a day
 * late, never early.
 */
export function limitFromMessage(message: string, observedAt: number): LimitObservation | undefined {
  if (!USAGE_LIMIT.test(message)) return undefined
  const at = TRY_AGAIN.exec(message)
  if (!at) return undefined
  const [, month, day, year, hour, minute, half] = at
  const h = Number(hour)
  const min = Number(minute)
  if (h < 1 || h > 12 || min > 59) return undefined
  const hours = (h % 12) + (half === 'PM' ? 12 : 0)
  const observed = new Date(observedAt)
  let reset: number
  if (month === undefined) {
    reset = Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth(), observed.getUTCDate(), hours, min)
  } else {
    const m = MONTHS.indexOf(month)
    const d = Number(day)
    if (m < 0 || d < 1) return undefined
    reset = Date.UTC(Number(year), m, d, hours, min)
    // `Feb 31st` is no date (Date.UTC would roll it into March).
    if (new Date(reset).getUTCDate() !== d) return undefined
  }
  const resetsAt = reset + MINUTE_MS
  if (resetsAt <= observedAt || resetsAt - observedAt > PLAUSIBLE_MS) return undefined
  return { window: '*', status: 'rejected', resetsAt: new Date(resetsAt).toISOString(), observedAt: observed.toISOString() }
}
