/**
 * Where a notice goes (docs/design/notifications.md#sinks). Each sink sends one notice once,
 * bounded by a timeout, and says how it went; it never throws, never retries, and never puts a
 * secret (the webhook's URL) in what it says.
 * - `desktop`: `notify-send` from libnotify, when it is on `PATH`; else a no-op whose every notice
 *   fails, so health says so.
 * - `webhook`: a JSON POST of the notice to a URL kept in `ctx.credentials`, only once
 *   `ctx.egress` lets the exact body leave for the `webhook` class (INV-12).
 * @module
 */
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@tsuuanmi/system-egress'
import { desktopBody, type Notice } from './notices.ts'

/** How one delivery went: sent, or failed with why (no secret in it). */
export type Outcome = { sent: true } | { sent: false; reason: string }

export interface Sink {
  readonly name: 'desktop' | 'webhook'
  /** Why the sink can send nothing at all, when it cannot; read at start. */
  readonly unavailable?: string | undefined
  send(notice: Notice, signal: AbortSignal): Promise<Outcome>
}

/** The desktop notifier's command (libnotify): the sink's own tool, named here only. */
export const DESKTOP_COMMAND = 'notify-send'
/** What `notify-send` needs from the environment to reach the session's notification daemon; nothing else is passed. */
const DESKTOP_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'] as const

/** The first executable `name` on `path`, or undefined. */
export function onPath(name: string, path: string | undefined = process.env.PATH): string | undefined {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue
    const file = join(dir, name)
    try {
      accessSync(file, constants.X_OK)
      return file
    } catch {
      // not here
    }
  }
  return undefined
}

const clip = (text: string, max = 200): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export class DesktopSink implements Sink {
  readonly name = 'desktop' as const
  readonly unavailable: string | undefined

  constructor(private readonly command: string | undefined, private readonly timeoutMs: number) {
    this.unavailable = command ? undefined : `${DESKTOP_COMMAND} is not on PATH: desktop notifications are a no-op (install libnotify's ${DESKTOP_COMMAND}, or set desktop: false)`
  }

  send(notice: Notice, signal: AbortSignal): Promise<Outcome> {
    if (!this.command) return Promise.resolve({ sent: false, reason: this.unavailable! })
    const env = Object.fromEntries(DESKTOP_ENV.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]!]))
    const urgency = notice.kind === 'approval.expiring' || notice.kind === 'review.expiring' ? 'critical' : 'normal'
    // `--` ends the options: a title or body that starts with `-` is text, never an option.
    const argv = ['--app-name=system', `--urgency=${urgency}`, '--', notice.title, desktopBody(notice)]
    return new Promise((resolve) => {
      execFile(this.command!, argv, { env, timeout: this.timeoutMs, signal, maxBuffer: 64 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
        if (!error) return resolve({ sent: true })
        const why = (error as NodeJS.ErrnoException & { killed?: boolean }).killed ? `timed out after ${this.timeoutMs} ms` : String(stderr).trim() || error.message
        resolve({ sent: false, reason: clip(`${DESKTOP_COMMAND} failed: ${why}`) })
      })
    })
  }
}

/** Whether a webhook URL may be used: https, or http to this machine only; no credentials in it but its path and query. */
export function webhookProblem(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'the webhook URL is not a URL'
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return 'the webhook URL must be https (or http to this machine)'
  if (url.username || url.password) return 'the webhook URL must not carry a user or password: put a token in its path or query'
  return undefined
}

export class WebhookSink implements Sink {
  readonly name = 'webhook' as const

  constructor(private readonly ctx: Context, private readonly ref: string, private readonly timeoutMs: number) {}

  async send(notice: Notice, signal: AbortSignal): Promise<Outcome> {
    const body = JSON.stringify(notice)
    // INV-12: the exact body is checked before anything leaves, and nothing leaves without the gate.
    const egress = this.ctx.get('egress')
    if (!egress) return { sent: false, reason: 'no egress gate (ctx.egress) is loaded, so nothing leaves the machine' }
    let verdict
    try {
      verdict = await egress.check({ payload: body, classification: 'operator-shared', workerClass: 'webhook' })
    } catch (error) {
      return { sent: false, reason: clip(`the egress check failed: ${(error as Error).message}`) }
    }
    if (!verdict.allowed) return { sent: false, reason: clip(`egress refused (decision ${verdict.decision}): ${verdict.reason}; declare it in the egress row (workerClasses.webhook)`, 400) }
    const credentials = this.ctx.get('credentials')
    if (!credentials) return { sent: false, reason: 'no credential store (ctx.credentials) is loaded, so the webhook URL cannot be read' }
    let url: string | undefined
    try {
      url = (await credentials.resolve(credentialRef(this.ref)))?.value
    } catch (error) {
      return { sent: false, reason: clip(`the webhook URL could not be read from ${this.ref}: ${(error as Error).name}`) }
    }
    if (!url) return { sent: false, reason: `no webhook URL is stored under ${this.ref} (system notify webhook < file)` }
    const problem = webhookProblem(url)
    if (problem) return { sent: false, reason: `${problem} (stored under ${this.ref})` }
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      })
      await response.body?.cancel().catch(() => undefined)
      return response.ok ? { sent: true } : { sent: false, reason: `the webhook answered HTTP ${response.status}` }
    } catch (error) {
      // Never the message: a fetch error can name the URL, which is a secret.
      const err = error as Error & { cause?: { code?: unknown } }
      const code = typeof err.cause?.code === 'string' ? err.cause.code : err.name
      return { sent: false, reason: err.name === 'TimeoutError' ? `the webhook did not answer within ${this.timeoutMs} ms` : `the webhook request failed (${clip(code, 60)})` }
    }
  }
}
