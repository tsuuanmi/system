/**
 * Crash injection while a node waits for an assigned account's limit (ADR-0052, INV-4, INV-9): the
 * engine process is killed with SIGKILL during the wait, then started again on the same state. The
 * wait is on the node's row, so the new process waits on until the reset, sends nothing before it,
 * spends no attempt on it, and then runs the node once, on the limited account. Run with
 * `pnpm test:crash` (it builds first).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'

const HARNESS = fileURLToPath(new URL('./wait-harness.mjs', import.meta.url))

type Done = { status: string; answer?: string; nodes: Array<{ attempt: number }>; started: string[] }
interface Engine { child: ChildProcess; runId: Promise<string>; waiting: Promise<{ until: string; attempt: number; started: string[] }>; done: Promise<Done> }

function engine(args: string[]): Engine {
  const child = spawn(process.execPath, [HARNESS, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  onTestFinished(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // already gone
    }
  })
  const settle = <T>() => {
    let resolve!: (value: T) => void
    return { promise: new Promise<T>((r) => { resolve = r }), resolve: (value: T) => resolve(value) }
  }
  const [runId, waiting, done] = [settle<string>(), settle<{ until: string; attempt: number; started: string[] }>(), settle<Done>()]
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.startsWith('@@ ')) continue
      const message = JSON.parse(line.slice(3)) as { runId?: string; waiting?: never; done?: never }
      if (message.runId) runId.resolve(message.runId)
      if (message.waiting) waiting.resolve(message.waiting)
      if (message.done) done.resolve(message.done)
    }
  })
  return { child, runId: runId.promise, waiting: waiting.promise, done: done.promise }
}

describe('crash injection while a node waits for an assigned account\'s limit (REQ-ACC-10, INV-4)', () => {
  it('a waiting node killed mid-wait waits on after a restart, sends nothing before the reset, and then runs once on that account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-crash-wait-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    // Long enough to outlast the kill and the dead process's 30 s leases (leases.mjs), with more of
    // the wait left after the restart takes the run than the 60 s leases left before, short enough
    // for the suite.
    const reset = new Date(Date.now() + 50_000).toISOString()
    const first = engine([dir, reset, 'start'])
    const runId = await first.runId
    expect(await first.waiting).toEqual({ until: reset, attempt: 0, started: [] })
    process.kill(-first.child.pid!, 'SIGKILL')
    if (first.child.exitCode === null && first.child.signalCode === null) await new Promise((resolve) => first.child.once('exit', resolve))
    const second = engine([dir, reset, 'resume', runId])
    const done = await second.done
    expect(done).toMatchObject({ status: 'completed', answer: 'answer from w:g-a', nodes: [{ attempt: 1 }], started: ['w:g-a'] })
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(reset))
  }, 300_000)
})
