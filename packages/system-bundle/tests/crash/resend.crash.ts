/**
 * Crash injection after a resend is decided (D60, ADR-0062, INV-4): a team member's first step the
 * site answered with its own error after the send is resent once, in a new conversation. The engine
 * process is killed with SIGKILL once the `resend` decision is recorded, its session's conversation
 * reset, and the node ready, before the new attempt starts. Started again on the same state, it runs
 * that attempt exactly once, in the new conversation, never resends again, and the team completes.
 * Run with `pnpm test:crash` (it builds first).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'

const HARNESS = fileURLToPath(new URL('./resend-harness.mjs', import.meta.url))

type Started = { id: string; key: string; worker: string; sessionId?: string; conversation?: string }
type Resent = { detail: { failed: { execution: string }; next: { attempt: number; key: string }; sessionId: string }; started: number }
type Done = { status: string; started: Started[]; resets: string[]; resends: number }
interface Engine { child: ChildProcess; runId: Promise<string>; resent: Promise<Resent>; done: Promise<Done> }

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
  const [runId, resent, done] = [settle<string>(), settle<Resent>(), settle<Done>()]
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.startsWith('@@ ')) continue
      const message = JSON.parse(line.slice(3)) as { runId?: string; resent?: Resent; done?: Done }
      if (message.runId) runId.resolve(message.runId)
      if (message.resent) resent.resolve(message.resent)
      if (message.done) done.resolve(message.done)
    }
  })
  return { child, runId: runId.promise, resent: resent.promise, done: done.promise }
}

describe('crash injection after a team member\'s resend is decided (D60, ADR-0062, INV-4)', () => {
  it('a process killed between the resend decision and the new attempt resends exactly once after a restart, in the new conversation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-crash-resend-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = engine([dir, 'start'])
    const runId = await first.runId
    const resent = await first.resent
    // Decided, and the failed attempt the only one of m1's proposals started so far.
    expect(resent.started).toBe(1)
    process.kill(-first.child.pid!, 'SIGKILL')
    if (first.child.exitCode === null && first.child.signalCode === null) await new Promise((resolve) => first.child.once('exit', resolve))
    const second = engine([dir, 'resume', runId])
    const done = await second.done
    expect(done.status).toBe('completed')
    const proposals = done.started.filter((s) => s.key.includes(':team:m1:propose:'))
    expect(proposals).toHaveLength(2)
    expect(proposals[0]!.id).toBe(resent.detail.failed.execution)
    expect(proposals[1]!.key).toBe(resent.detail.next.key)
    // The same member and Worker, in a new conversation; its ballot followed it there.
    expect(proposals[1]!.sessionId).toBe(proposals[0]!.sessionId)
    expect(proposals[1]!.worker).toBe(proposals[0]!.worker)
    expect(proposals[1]!.conversation).not.toBe(proposals[0]!.conversation)
    expect(done.started.find((s) => s.key.includes(':team:m1:ballot:'))!.conversation).toBe(proposals[1]!.conversation)
    expect(done.resets).toEqual([resent.detail.sessionId])
    expect(done.resends).toBe(1)
  }, 300_000)
})
