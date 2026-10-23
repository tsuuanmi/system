/**
 * Crash injection for a board task's spent budget on its last attempt (QA-1, INV-4, ADR-0044): the
 * engine process is killed with SIGKILL while it ends the run, then started again on the same
 * state. Killed inside the transaction that records its decision and fails the run, it decides
 * again once; killed after that committed, as the report reaches the board, it reports once. Either
 * way the task waits for input (`retries-spent`), and nothing is put to the operator. Run with
 * `pnpm test:crash` (it builds first).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const HARNESS = fileURLToPath(new URL('./budget-harness.mjs', import.meta.url))

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

interface Settled {
  run: { runId: string; status: string; error?: { kind: string; message: string }; task?: { phase: string; budget?: { spent?: boolean; blocked?: boolean; lastAttempt?: string }; outcome?: { status: string; state?: string } } }
  task: { state: string; waiting?: { reason: string }; attempts: { count: number; max: number }; funding?: unknown }
  decisions: string[]
  requests: unknown[]
}
/** The run's row as the dead process left it. */
interface Left { status: string; phase: string; budget: { state: string; spent?: boolean; lastAttempt?: string } }
interface Engine { child: ChildProcess; exited: Promise<NodeJS.Signals | number | null>; started: Promise<{ runId: string; taskId: string }>; left: Promise<Left>; settled: Promise<Settled> }

function engine(args: string[]): Engine {
  const child = spawn(process.execPath, [HARNESS, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanups.push(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // already gone
    }
  })
  let resolveStarted!: (value: { runId: string; taskId: string }) => void
  let resolveLeft!: (value: Left) => void
  let resolveSettled!: (value: Settled) => void
  const started = new Promise<{ runId: string; taskId: string }>((resolve) => { resolveStarted = resolve })
  const left = new Promise<Left>((resolve) => { resolveLeft = resolve })
  const settled = new Promise<Settled>((resolve) => { resolveSettled = resolve })
  const exited = new Promise<NodeJS.Signals | number | null>((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code)))
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.startsWith('@@ ')) continue
      const message = JSON.parse(line.slice(3)) as { runId?: string; taskId?: string; left?: Left; settled?: Settled }
      if (message.runId) resolveStarted({ runId: message.runId, taskId: message.taskId! })
      if (message.left) resolveLeft(message.left)
      if (message.settled) resolveSettled(message.settled)
    }
  })
  return { child, exited, started, left, settled }
}

describe('crash injection while a spent budget ends a task\'s last attempt (QA-1, INV-4)', () => {
  for (const [point, when] of [
    ['decision', 'inside the transaction that records the engine\'s decision and fails the run: the restart decides again, once'],
    ['report', 'after that committed, as the report reaches the board: the restart reports it once'],
  ] as const) {
    it(`${when}; the task waits for input (retries-spent), and no funding is asked`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'system-crash-budget-'))
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const first = engine([dir, 'start', point])
      const { runId } = await first.started
      expect(await first.exited).toBe('SIGKILL')
      // Started again on the same state; the dead process's run lease expires first.
      const second = engine([dir, 'resume'])
      // Rolled back whole: the run still running on its spent budget, no decision kept. Committed
      // whole: the run failed with the decision on its row, not yet reported.
      expect(await second.left).toEqual(point === 'decision'
        ? { status: 'running', phase: 'started', budget: expect.not.objectContaining({ lastAttempt: expect.anything() }) }
        : { status: 'failed', phase: 'started', budget: expect.objectContaining({ lastAttempt: expect.any(String) }) })
      expect((await second.left).budget).toMatchObject({ state: 'refused', spent: true })
      const settled = await second.settled
      expect(settled.run).toMatchObject({ status: 'failed', error: { kind: 'budget_spent' }, task: { phase: 'reported', budget: { spent: true }, outcome: { status: 'reconciled', state: 'waiting-for-input' } } })
      expect(settled.run.error!.message).toMatch(/it was the task's last attempt \(attempt 1 of 1\), so no funding was asked/)
      expect(settled.run.task!.budget).not.toHaveProperty('blocked')
      expect(settled.decisions).toEqual([settled.run.task!.budget!.lastAttempt])
      expect(settled.task).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'retries-spent' }, attempts: { count: 1, max: 1 } })
      expect(settled.task.funding).toBeUndefined()
      expect(settled.requests).toEqual([])
      expect(runId).toBe(settled.run.runId)
    }, 300_000)
  }
})
