/**
 * Crash injection for a board task's spent budget on its last attempt (QA-1, INV-4, ADR-0044): the
 * engine process is killed with SIGKILL while it ends the run, then started again on the same
 * state. Killed inside the transaction that records its decision and fails the run, it decides
 * again once; killed after that committed, as the report reaches the board, it reports once. Either
 * way the task waits for input (`retries-spent`), and nothing is put to the operator. A two-step run
 * reserves before each step (ADR-0047, step 1): killed once its first step's reservation is on the
 * run's row but before that step started, the restart releases it and reserves again, never holding
 * two; killed once the second step's refusal committed, the restart reserves nothing more. Either
 * way the first step runs once and the second never. Run with `pnpm test:crash` (it builds first).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  /** The ledger's decisions on the run's reservations, and those of them still held. */
  budgets: string[]
  held: string[]
  nodes: Array<[string, string]>
}
/** The run's row as the dead process left it. */
interface Left { status: string; phase: string; budget: { state: string; spent?: boolean; lastAttempt?: string; holds?: Array<{ step: string }> }; nodes: Array<[string, string]> }
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
        ? { status: 'running', phase: 'started', budget: expect.not.objectContaining({ lastAttempt: expect.anything() }), nodes: [['ask:1', 'READY']] }
        : { status: 'failed', phase: 'started', budget: expect.objectContaining({ lastAttempt: expect.any(String) }), nodes: [['ask:1', 'READY']] })
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

describe('crash injection while a two-step run reserves its task\'s budget per step (ADR-0047, QA-1, INV-4)', () => {
  for (const [point, when] of [
    ['hold', 'once the first step\'s reservation is on the run\'s row, as its execution starts: the restart releases it, reserves again, and runs the step once'],
    ['end', 'once the second step\'s refusal committed: the restart reserves nothing more and ends the run'],
  ] as const) {
    it(`${when}; the second step never starts, and the task's last attempt ends with no funding asked (retries-spent)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'system-crash-steps-'))
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const started = (): string[] => (existsSync(join(dir, 'started')) ? readFileSync(join(dir, 'started'), 'utf8').split('\n').filter(Boolean) : [])
      const first = engine([dir, 'steps', point])
      const { runId } = await first.started
      expect(await first.exited).toBe('SIGKILL')
      expect(started()).toHaveLength(point === 'hold' ? 0 : 1)
      const second = engine([dir, 'resume', 'steps'])
      const left = await second.left
      if (point === 'hold') {
        // The step's hold committed before its start, which did not: the step never started.
        expect(left).toMatchObject({ status: 'running', phase: 'started', budget: { state: 'reserved', holds: [{ step: 'a:1:0' }] }, nodes: [['a', 'READY'], ['b', 'WAITING']] })
      } else {
        // The first step ran and its hold was released; the second's refusal is on the row.
        expect(left).toMatchObject({ status: 'running', phase: 'started', budget: { state: 'refused', spent: true }, nodes: [['a', 'COMPLETED'], ['b', 'READY']] })
        expect(left.budget.holds).toBeUndefined()
      }
      const settled = await second.settled
      expect(settled.run).toMatchObject({ status: 'failed', error: { kind: 'budget_spent' }, task: { phase: 'reported', budget: { state: 'refused', spent: true }, outcome: { status: 'reconciled', state: 'waiting-for-input' } } })
      expect(settled.run.error!.message).toMatch(/no step of this run started after the 1 that ran before the refusal; it was the task's last attempt \(attempt 1 of 1\), so no funding was asked/)
      expect(settled.nodes).toEqual([['a', 'COMPLETED'], ['b', 'READY']])
      // The first step ran once: started again after the crash at its start, never twice.
      expect(started()).toHaveLength(1)
      // Each reservation is the ledger's own decision; the one the crash left is released, and none is still held.
      expect([...settled.budgets].sort()).toEqual(point === 'hold' ? ['refused', 'reserved', 'reserved'] : ['refused', 'reserved'])
      expect(settled.held).toEqual([])
      expect(settled.decisions).toHaveLength(1)
      expect(settled.task).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'retries-spent' }, attempts: { count: 1, max: 1 } })
      expect(settled.requests).toEqual([])
      expect(runId).toBe(settled.run.runId)
    }, 300_000)
  }
})
