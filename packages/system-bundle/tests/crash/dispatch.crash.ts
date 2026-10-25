/**
 * Crash injection in the dispatch pass (ADR-0063, INV-4, INV-5): the engine process is killed with
 * SIGKILL right after the approval queue took a dispatch request and before the engine recorded it
 * on its row; started again on the same state, its pass adopts that request and asks nothing more.
 * Then, approved, it is killed right after the board recorded the dispatched run and before the ask's
 * row says it started; started again, the pass finds that run as the ask's, starts no second one, and
 * the run's step starts once, on the chosen Worker. Run with `pnpm test:crash` (it builds first).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'

const HARNESS = fileURLToPath(new URL('./dispatch-harness.mjs', import.meta.url))

type Request = { requestId: string; state: string; subject: { ref: string; version: string } }
type Row = { ask_id: string; state: string; request_id: string | null; run_id: string | null; worker: string }
type Report = { status: { asks: Array<{ askId: string; state: string; requestId?: string; worker: string }> }; rows: Row[]; requests: Request[]; started: Array<{ id: string; key: string; worker: string; runId: string }> }
interface Engine { child: ChildProcess; messages: Array<Record<string, unknown>>; next: (key: string) => Promise<unknown> }

function engine(args: string[]): Engine {
  const child = spawn(process.execPath, [HARNESS, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  onTestFinished(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // already gone
    }
  })
  const messages: Array<Record<string, unknown>> = []
  const waiting = new Map<string, (value: unknown) => void>()
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.startsWith('@@ ')) continue
      const message = JSON.parse(line.slice(3)) as Record<string, unknown>
      messages.push(message)
      for (const [key, resolve] of waiting) if (key in message) resolve(message[key])
    }
  })
  const next = (key: string): Promise<unknown> => {
    const seen = messages.find((m) => key in m)
    return seen ? Promise.resolve(seen[key]) : new Promise((resolve) => waiting.set(key, resolve))
  }
  return { child, messages, next }
}

const exited = async (e: Engine): Promise<void> => {
  if (e.child.exitCode === null && e.child.signalCode === null) await new Promise((resolve) => e.child.once('exit', resolve))
}

describe('crash injection in the dispatch pass (ADR-0063, INV-4)', () => {
  it('a process killed between the request and its record asks once after a restart, and one killed between the run\'s record and the ask\'s starts no second run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-crash-dispatch-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const asking = engine([dir, 'ask-crash'])
    const killed = await asking.next('killed') as { request: string }
    await exited(asking)
    expect(asking.child.signalCode).toBe('SIGKILL')
    // Started again: the killed process left its ask asking, the request unrecorded on it; the pass
    // adopts the request on its subject, and the queue holds exactly that one.
    const adopting = engine([dir, 'adopt'])
    expect(await adopting.next('before')).toEqual([expect.objectContaining({ state: 'asking', request_id: null, worker: 'w:max' })])
    const adopted = await adopting.next('status') as Report['status']
    const report = adopting.messages.find((m) => 'rows' in m) as unknown as Report
    await exited(adopting)
    expect(report.requests).toEqual([expect.objectContaining({ requestId: killed.request, state: 'open' })])
    expect(adopted.asks).toEqual([expect.objectContaining({ state: 'asked', requestId: killed.request, worker: 'w:max' })])
    expect(report.rows).toHaveLength(1)
    // Approved, and killed once the board recorded the run, before the ask's row says it started.
    const approving = engine([dir, 'approve-crash'])
    const run = (await approving.next('killed') as { run: string }).run
    await exited(approving)
    const finishing = engine([dir, 'finish'])
    // The killed process left the ask starting, its run admitted and recorded by the board.
    expect(await finishing.next('before')).toEqual([expect.objectContaining({ state: 'starting', request_id: killed.request, run_id: null })])
    await finishing.next('status')
    const done = finishing.messages.find((m) => 'rows' in m) as unknown as Report
    await exited(finishing)
    expect(done.rows).toEqual([expect.objectContaining({ state: 'started', run_id: run, request_id: killed.request })])
    expect(done.status.asks).toEqual([])
    // The run's one step started once, on the chosen Worker, in that run.
    expect(done.started).toEqual([expect.objectContaining({ worker: 'w:max', runId: run })])
    expect(done.requests.map((r) => r.state)).toEqual(['approved'])
  }, 300_000)
})
