/**
 * Codex's usage-limit message as a limit observation (docs/design/agent-runtimes.md#metering).
 * `codex exec --experimental-json`, which the SDK drives, emits no rate-limit event (its events
 * are `thread.started`, `turn.*`, `item.*`, and `error`); a turn that hits the account's usage limit
 * fails with Codex's own message, which names when to try again:
 * `You’ve hit your usage limit. … try again at 3:04 PM.` (the reset is today) or
 * `… try again at Oct 25th, 2026 3:04 PM.`, in the Codex process's local time to the minute, or
 * `… try again later.` when Codex knows no reset. That time is read in the zone the Codex child ran
 * in (`childTimeZone`: its `TZ`, else the host's zone), never early. The message names no window,
 * so the observation's window is `*`, which no configuration maps: the ledger closes every window
 * of the pool until the reset.
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

/** A zone's offset changes at most once a day: the offsets a wall-clock time can have are around it. */
const DAY_MS = 86_400_000

/**
 * The IANA time zone a Codex child ran in, from the `TZ` of its environment (`tz`; undefined when it
 * has none, so the host's zone as Node resolves it), or undefined when that is no zone this reads
 * as the child would: an empty `TZ`, a POSIX rule (`UTC0`), an offset (`+05:00`, which Intl reads
 * as a zone but `TZ` does not), a name Intl does not know, or one it knows only in another case
 * (`europe/berlin`: the zone files are case-sensitive, so the child falls back to UTC). A leading
 * `:` (`:Europe/Berlin`) is the same name.
 */
export function childTimeZone(tz: string | undefined): string | undefined {
  const name = tz === undefined ? new Intl.DateTimeFormat().resolvedOptions().timeZone : tz.replace(/^:/, '')
  if (!/^[A-Za-z]/.test(name)) return undefined
  let resolved: string
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
  return resolved !== name && resolved.toLowerCase() === name.toLowerCase() ? undefined : name
}

/** The wall-clock time `format`'s zone shows at instant `t` (ms, to the second), as if it were UTC. */
function wallClock(format: Intl.DateTimeFormat, t: number): number {
  const part: Record<string, number> = {}
  for (const { type, value } of format.formatToParts(t)) part[type] = Number(value)
  return Date.UTC(part.year!, part.month! - 1, part.day!, part.hour!, part.minute!, part.second!)
}

/**
 * The instant at which `format`'s zone shows `wall` (a wall-clock time as if UTC, ms): the later of
 * the two in an overlap (a clock set back), and in a gap (a clock set forward, a time the zone never
 * shows) the later of the offsets either side gives, so a reset is never read early.
 */
function instantOf(format: Intl.DateTimeFormat, wall: number): number {
  const offsets = new Set([-DAY_MS, 0, DAY_MS].map((d) => wallClock(format, wall + d) - (wall + d)))
  const candidates = [...offsets].map((offset) => wall - offset)
  const exact = candidates.filter((t) => wallClock(format, t) === wall)
  return Math.max(...(exact.length ? exact : candidates))
}

/**
 * The usage limit `message` names, as a `rejected` observation of window `*` with its reset time,
 * read at `observedAt` (ms) in `timeZone`, the IANA zone the Codex child ran in (`childTimeZone`).
 * Undefined when the message is not Codex's usage-limit message, names no reset (`try again later`),
 * names one that does not parse, or one that is not ahead of `observedAt` or more than 400 days
 * ahead, or when `timeZone` is no zone: a reset that cannot be read is no reading, and the run's
 * limit then closes the pool for the Worker's cooldown (never open). A reset written as a time of
 * day is taken on the zone's date at `observedAt`: a message written just before the child's
 * midnight and read after it reads a day late, never early.
 */
export function limitFromMessage(message: string, observedAt: number, timeZone: string): LimitObservation | undefined {
  if (!USAGE_LIMIT.test(message)) return undefined
  const at = TRY_AGAIN.exec(message)
  if (!at) return undefined
  const [, month, day, year, hour, minute, half] = at
  const h = Number(hour)
  const min = Number(minute)
  if (h < 1 || h > 12 || min > 59) return undefined
  const hours = (h % 12) + (half === 'PM' ? 12 : 0)
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
  } catch {
    return undefined
  }
  let wall: number
  if (month === undefined) {
    const today = new Date(wallClock(format, observedAt))
    wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hours, min)
  } else {
    const m = MONTHS.indexOf(month)
    const d = Number(day)
    if (m < 0 || d < 1) return undefined
    wall = Date.UTC(Number(year), m, d, hours, min)
    // `Feb 31st` is no date (Date.UTC would roll it into March).
    if (new Date(wall).getUTCDate() !== d) return undefined
  }
  const resetsAt = instantOf(format, wall) + MINUTE_MS
  if (resetsAt <= observedAt || resetsAt - observedAt > PLAUSIBLE_MS) return undefined
  return { window: '*', status: 'rejected', resetsAt: new Date(resetsAt).toISOString(), observedAt: new Date(observedAt).toISOString() }
}
