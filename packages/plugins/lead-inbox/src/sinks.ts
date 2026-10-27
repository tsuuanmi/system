/**
 * Where a project's lead notice is pushed (docs/design/notifications.md#the-leads-inbox). Each sink
 * sends one notice once, bounded, and says how it went; it never throws, never retries, and never
 * blocks the producer of the event (the inbox sends after its own commit, on its own clock).
 * - `command`: a configured program, an argv list with no shell, given the notice as JSON on stdin;
 *   bounded in time and output. System knows only the argv (INV-11).
 * - `file`: the notice as one JSON line appended to a file under the coordination directory.
 * - `wait`: the `system lead wait` long-poll; the inbox wakes its waiters itself, so this sends nothing.
 * @module
 */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { LeadNotice } from './notices.ts'

export type Outcome = { sent: true } | { sent: false; reason: string }

export interface Sink {
  readonly name: 'command' | 'file' | 'wait'
  send(notice: LeadNotice, signal: AbortSignal): Promise<Outcome>
}

/** One sink as the row configures it. */
export interface SinkConfig {
  type: 'command' | 'file' | 'wait'
  /** `command`: the program and its arguments. */
  argv?: string[]
  /** `file`: the file, absolute or relative to the coordination directory, and within it. */
  path?: string
  /** `command`: the longest it may run, in seconds (default 10). */
  timeoutSeconds?: number
}

/** The environment a command gets: what a desktop or terminal tool needs to reach its session, never a credential (INV-8). */
const COMMAND_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'] as const
/** Output a command may write (stdout and stderr each) and a file may grow to: past them the delivery fails (INV-9). */
const MAX_OUTPUT = 64 * 1024
const MAX_FILE = 5 * 1024 * 1024
const MAX_ARGV = 32
export const DEFAULT_TIMEOUT_SECONDS = 10

const clip = (text: string, max = 200): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** The path a file sink writes, inside `root`; undefined when it escapes the directory. */
export function filePath(root: string, path: string): string | undefined {
  const full = resolve(root, path)
  const rel = relative(root, full)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? undefined : full
}

/** Every problem of the sinks one project configures that the schema cannot state. */
export function sinkProblems(project: string, sinks: readonly SinkConfig[], coordinationDir: string | undefined): string[] {
  const problems: string[] = []
  for (const [i, sink] of sinks.entries()) {
    const at = `projects.${project}.sinks[${i}]`
    if (sink.type === 'command') {
      if (!sink.argv?.length) problems.push(`${at}: a command sink needs argv, the program and its arguments (never a shell line)`)
      else if (sink.argv.length > MAX_ARGV || sink.argv.some((a) => typeof a !== 'string' || a.length > 1000 || a.includes('\0'))) problems.push(`${at}: argv holds at most ${MAX_ARGV} strings of at most 1000 characters`)
    } else if (sink.type === 'file') {
      if (!coordinationDir || !isAbsolute(coordinationDir)) problems.push(`${at}: a file sink needs coordinationDir, an absolute directory`)
      else if (!sink.path || !filePath(coordinationDir, sink.path)) problems.push(`${at}: path must name a file under coordinationDir`)
    }
  }
  return problems
}

export function commandSink(argv: readonly string[], timeoutMs: number, project: string): Sink {
  return {
    name: 'command',
    send(notice, signal) {
      const env: Record<string, string> = Object.fromEntries(COMMAND_ENV.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]!]))
      env.SYSTEM_LEAD_PROJECT = project
      env.SYSTEM_LEAD_NOTICE = notice.id
      return new Promise((done) => {
        const child = execFile(argv[0]!, argv.slice(1), { env, timeout: timeoutMs, signal, maxBuffer: MAX_OUTPUT, windowsHide: true, shell: false }, (error, _stdout, stderr) => {
          if (!error) return done({ sent: true })
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed
          done({ sent: false, reason: clip(killed ? `the command did not end within ${timeoutMs} ms or wrote more than ${MAX_OUTPUT} bytes` : `the command failed: ${String(stderr).trim() || error.message}`) })
        })
        // A program that does not read its stdin closes it early: never an unhandled error.
        child.stdin?.on('error', () => undefined)
        child.stdin?.end(`${JSON.stringify(notice)}\n`)
      })
    },
  }
}

export function fileSink(root: string, path: string): Sink {
  return {
    name: 'file',
    async send(notice) {
      const full = filePath(root, path)
      if (!full) return { sent: false, reason: 'the file is not under the coordination directory' }
      try {
        await mkdir(dirname(full), { recursive: true })
        // Neither the directory nor the file may lead out of the coordination directory by a link.
        const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dirname(full))])
        if (relative(realRoot, realDir).startsWith('..')) return { sent: false, reason: 'the file\'s directory leads out of the coordination directory' }
        const handle = await open(full, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
        try {
          if ((await handle.stat()).size >= MAX_FILE) return { sent: false, reason: `the file holds ${MAX_FILE} bytes already: empty or rotate it` }
          await handle.write(`${JSON.stringify(notice)}\n`)
        } finally {
          await handle.close()
        }
        return { sent: true }
      } catch (error) {
        return { sent: false, reason: clip(`the file could not be appended: ${(error as Error).message}`) }
      }
    },
  }
}

/** The long-poll: waiters are woken by the inbox when the notice commits, so there is nothing to send. */
export const waitSink: Sink = { name: 'wait', send: () => Promise.resolve({ sent: true }) }
