/**
 * The Codex app server's account rate limits as limit observations (ADR-0059,
 * docs/design/agent-runtimes.md#an-accounts-usage-report). `codex exec`, which the SDK drives, emits
 * no rate-limit event, but `codex app-server` answers `account/rateLimits/read` for the account
 * signed in to its `CODEX_HOME`, without a thread or a turn. It speaks JSON-RPC over stdio, one JSON
 * message per line, without the `jsonrpc` member: the client asks `initialize` (with its
 * `clientInfo`), notifies `initialized`, then asks `account/rateLimits/read`, whose result is
 *
 * ```
 * { "rateLimits": { "primary": W | null, "secondary": W | null, … } }
 *     W = { "usedPercent": number (0 to 100), "windowDurationMins": integer | null, "resetsAt": Unix seconds | null }
 * ```
 *
 * Which of `primary` and `secondary` is the five-hour window is not fixed by name, so each window is
 * named by its length, `<windowDurationMins>m` (`300m`, `10080m`).
 * @module
 */
import type { ChildProcess } from 'node:child_process'
import type { LimitObservation, LimitReport } from '@tsuuanmi/system-agent-runtime-core'
import { isRecord } from '@tsuuanmi/system-libs'

/**
 * Codex versions whose app server's rate limits are read. 0.164.0 (2026-10-24, the installed
 * `@openai/codex` 0.164.0, `codex-linux-x64`): `codex app-server generate-ts` shows the methods
 * `initialize` and `account/rateLimits/read` and the `RateLimitSnapshot` above (`primary` and
 * `secondary` windows, each `usedPercent`, `windowDurationMins`, `resetsAt` in Unix seconds)
 * (docs/design/agent-runtimes.md#limit-readings). The exchange is read strictly: an answer in any
 * other shape is unreadable, never a reading; `tests/fixtures/codex-0.164.0-rate-limits.json` holds
 * answers in that shape. On any other version the app server is never started, and the report
 * reads `unreadable`, naming the version. Also a release check on a live account.
 */
export const VERIFIED_RATE_LIMITS_VERSIONS: readonly string[] = ['0.164.0']

/** The app server's subcommand; the runtime's `--config` overrides follow it, as a probe's follow `exec`. */
export const APP_SERVER_ARGS: readonly string[] = ['app-server']

/** The client this runtime names itself as in `initialize`. */
const CLIENT_INFO = { name: 'system', title: 'system agent runtime codex-sdk', version: '0' }
/** The longest line of the app server read; a longer one fails the read. */
const MAX_LINE = 1 << 20
/** After SIGTERM, how long before SIGKILL. */
const KILL_MS = 5000
/** A reset time further than this from now is not believed. */
const PLAUSIBLE_MS = 400 * 86_400_000


/**
 * The limit observations an `account/rateLimits/read` result gives, read at `observedAt` (ms), or why
 * it cannot be read. A result not in the shape above (no `rateLimits` object; a window that is not
 * null and not `{ usedPercent, windowDurationMins, resetsAt }` with a number, a positive whole number
 * or null, and a number or null; a negative share) is unreadable as a whole. Each window that is not
 * null is one observation of the window its length names: `usedPercentage` its `usedPercent` (at
 * most 100), `rejected` at 100 or more, else `allowed`, with `resetsAt` when it is at most 400 days
 * away and, for a rejection, still ahead. A window of no stated length is reported only when used
 * up, as window `*`, which no configuration maps, so the ledger closes every window of the pool.
 */
export function limitsFromRateLimits(result: unknown, observedAt: number): LimitReport {
  if (!isRecord(result) || !isRecord(result.rateLimits)) return { unreadable: 'its answer holds no rateLimits object' }
  const snapshot = result.rateLimits
  const observed = new Date(observedAt).toISOString()
  const limits: LimitObservation[] = []
  for (const name of ['primary', 'secondary'] as const) {
    const window = snapshot[name]
    if (window === null || window === undefined) continue
    const minutes = isRecord(window) ? window.windowDurationMins : undefined
    const resets = isRecord(window) ? window.resetsAt : undefined
    if (!isRecord(window) || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)
      || !(minutes === null || minutes === undefined || (typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0))
      || !(resets === null || resets === undefined || (typeof resets === 'number' && Number.isFinite(resets)))) {
      return { unreadable: `its ${name} window is not in the checked shape ({ usedPercent, windowDurationMins, resetsAt })` }
    }
    if (window.usedPercent < 0) return { unreadable: `its ${name} window reports a used share that is not a percentage` }
    const used = Math.min(100, Math.round(window.usedPercent * 100) / 100)
    const status = used >= 100 ? 'rejected' : 'allowed'
    const id = typeof minutes === 'number' ? `${minutes}m` : status === 'rejected' ? '*' : undefined
    if (!id) continue
    const reset = typeof resets === 'number' ? resets * 1000 : Number.NaN
    const believed = Number.isFinite(reset) && Math.abs(reset - observedAt) <= PLAUSIBLE_MS && (status !== 'rejected' || reset > observedAt)
    limits.push({ window: id, status, ...(believed ? { resetsAt: new Date(reset).toISOString() } : {}), usedPercentage: used, observedAt: observed })
  }
  return { limits }
}

/**
 * Ask a started app server for the account's rate limits: `initialize`, the `initialized`
 * notification, then `account/rateLimits/read`. Resolves that request's result; rejects with why when
 * the server answers an error, writes a line longer than it reads or one that is not a JSON object,
 * ends before it answers, or `signal` aborts. Notifications and the server's own requests are not
 * answered (nothing here grants anything). The caller ends the process.
 */
export function askRateLimits(child: ChildProcess, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = ''
    let settled = false
    const finish = (error: Error | undefined, result?: unknown): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      child.stdout?.off('data', data)
      if (error) reject(error)
      else resolve(result)
    }
    const aborted = (): void => finish(new Error('the read was stopped'))
    const send = (message: Record<string, unknown>): void => {
      child.stdin?.write(`${JSON.stringify(message)}\n`)
    }
    const answer = (message: Record<string, unknown>): void => {
      if (message.id === undefined || message.method !== undefined) return
      if (message.error !== undefined) {
        const said = isRecord(message.error) && typeof message.error.message === 'string' ? message.error.message : JSON.stringify(message.error)
        finish(new Error(`the app server refused ${message.id === 1 ? 'initialize' : 'account/rateLimits/read'}: ${said.slice(0, 200)}`))
        return
      }
      if (message.id === 1) {
        send({ method: 'initialized' })
        send({ method: 'account/rateLimits/read', id: 2 })
      } else if (message.id === 2) finish(undefined, message.result)
    }
    const data = (chunk: Buffer | string): void => {
      buffered += chunk.toString()
      let end = buffered.indexOf('\n')
      while (end >= 0 && !settled) {
        const line = buffered.slice(0, end).trim()
        buffered = buffered.slice(end + 1)
        end = buffered.indexOf('\n')
        if (!line) continue
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          finish(new Error('the app server wrote a line that is not JSON'))
          return
        }
        if (!isRecord(message)) {
          finish(new Error('the app server wrote a line that is not a JSON object'))
          return
        }
        answer(message)
      }
      if (buffered.length > MAX_LINE) finish(new Error(`the app server wrote a line longer than ${MAX_LINE} bytes`))
    }
    if (signal.aborted) {
      aborted()
      return
    }
    signal.addEventListener('abort', aborted, { once: true })
    child.stdout?.on('data', data)
    child.once('error', (error) => finish(new Error(`the app server could not be started: ${error.message.slice(0, 200)}`)))
    child.once('close', (code, sig) => finish(new Error(`the app server ended before it answered (exit ${code ?? sig ?? 'unknown'})`)))
    child.stdin?.on('error', () => undefined)
    send({ method: 'initialize', id: 1, params: { clientInfo: CLIENT_INFO } })
  })
}

/** End an app server: its input closed, SIGTERM, then SIGKILL if it is still there after a grace period. */
export function endAppServer(child: ChildProcess, killMs: number = KILL_MS): void {
  child.stdin?.end()
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, killMs)
  timer.unref()
  child.once('close', () => clearTimeout(timer))
}
