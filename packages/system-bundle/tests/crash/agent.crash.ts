/**
 * Crash injection for an agent run (QA-1, INV-4, release-scope "Reliability"): the engine
 * process is killed with SIGKILL while a scripted agent Worker is running, then started again on
 * the same state. An agent that started may already have acted on the workspace, so the run
 * must fail closed as `reconciliation_failed` and the agent must never start a second time.
 * Run with `pnpm test:crash` (it builds first).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const HARNESS = fileURLToPath(new URL('./agent-harness.mjs', import.meta.url))

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

interface Engine { child: ChildProcess; runId: Promise<string>; done: Promise<{ status: string; error?: { kind: string } }> }

function engine(args: string[]): Engine {
  const child = spawn(process.execPath, [HARNESS, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanups.push(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // already gone
    }
  })
  let resolveRun!: (id: string) => void
  let resolveDone!: (view: never) => void
  const runId = new Promise<string>((resolve) => { resolveRun = resolve })
  const done = new Promise<never>((resolve) => { resolveDone = resolve })
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.startsWith('@@ ')) continue
      const message = JSON.parse(line.slice(3)) as { runId?: string; done?: never }
      if (message.runId) resolveRun(message.runId)
      if (message.done) resolveDone(message.done)
    }
  })
  return { child, runId, done }
}

const until = async (check: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const starts = (dir: string): number => (existsSync(join(dir, 'agent-started')) ? readFileSync(join(dir, 'agent-started'), 'utf8').split('\n').filter(Boolean).length : 0)

describe('crash injection while an agent Worker runs (QA-1, INV-4)', () => {
  it('after the agent started, before it finished: the run fails closed as reconciliation_failed, and the agent never starts again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-crash-agent-'))
    const workspace = join(dir, 'workspace')
    mkdirSync(workspace)
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = engine([dir, workspace, 'start', 'Review the change for correctness'])
    const runId = await first.runId
    await until(() => starts(dir) === 1, 60_000)
    process.kill(-first.child.pid!, 'SIGKILL')
    if (first.child.exitCode === null && first.child.signalCode === null) await new Promise((resolve) => first.child.once('exit', resolve))
    // Started again on the same state; the dead process's leases expire first.
    const second = engine([dir, workspace, 'resume', runId])
    expect(await second.done).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed' } })
    expect(starts(dir)).toBe(1)
  }, 300_000)
})
