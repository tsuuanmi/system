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

interface Reconciled { option: string; verdict: string; reasons: string[] }
interface Engine { child: ChildProcess; runId: Promise<string>; done: Promise<{ status: string; error?: { kind: string; message: string } }>; reconciled: Promise<Reconciled[]> }

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
  let resolveReconciled!: (decisions: Reconciled[]) => void
  const runId = new Promise<string>((resolve) => { resolveRun = resolve })
  const done = new Promise<never>((resolve) => { resolveDone = resolve })
  const reconciled = new Promise<Reconciled[]>((resolve) => { resolveReconciled = resolve })
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.startsWith('@@ ')) continue
      const message = JSON.parse(line.slice(3)) as { runId?: string; done?: never; reconciled?: Reconciled[] }
      if (message.runId) resolveRun(message.runId)
      if (message.reconciled) resolveReconciled(message.reconciled)
      if (message.done) resolveDone(message.done)
    }
  })
  return { child, runId, done, reconciled }
}

const until = async (check: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const starts = (dir: string): number => (existsSync(join(dir, 'agent-started')) ? readFileSync(join(dir, 'agent-started'), 'utf8').split('\n').filter(Boolean).length : 0)

/** Start an agent run, kill its engine process group (the agent's process with it) while the agent runs, and start the engine again on the same state. */
async function crashed(agentProcess: 'process' | 'none'): Promise<{ dir: string; second: Engine }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-crash-agent-'))
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const first = engine([dir, workspace, 'start', 'Review the change for correctness', agentProcess])
  const runId = await first.runId
  await until(() => starts(dir) === 1, 60_000)
  process.kill(-first.child.pid!, 'SIGKILL')
  if (first.child.exitCode === null && first.child.signalCode === null) await new Promise((resolve) => first.child.once('exit', resolve))
  // Started again on the same state; the dead process's leases expire first.
  return { dir, second: engine([dir, workspace, 'resume', runId, agentProcess]) }
}

describe('crash injection while an agent Worker runs (QA-1, INV-4)', () => {
  it('after the agent started, before it finished: the run fails closed as reconciliation_failed on a dead verdict, and the agent never starts again (REQ-WRK-16)', async () => {
    const { dir, second } = await crashed('process')
    expect(await second.done).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed' } })
    expect(starts(dir)).toBe(1)
    // Gone on evidence (PROP-0013): its holder and its agent process positively gone, and quiet past the bound.
    const [decision, ...more] = await second.reconciled
    expect(more).toEqual([])
    expect(decision).toMatchObject({ option: 'dead', verdict: 'dead' })
    expect(decision!.reasons).toEqual([
      expect.stringMatching(/^the holder's lease: lapsed/), expect.stringMatching(/^the holder's process: gone \(no process \d+ exists\)$/),
      expect.stringMatching(/^the agent process: gone \(no process \d+ exists\)$/), expect.stringMatching(/^activity: the latest \d+ s ago$/),
    ])
  }, 300_000)

  it('when the runtime reported no agent process, the run is never declared dead: it goes to the operator as unknown, and the agent never starts again (REQ-WRK-16)', async () => {
    const { dir, second } = await crashed('none')
    const done = await second.done
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed' } })
    expect(done.error!.message).toContain('it is not declared dead')
    expect(starts(dir)).toBe(1)
    const [decision] = await second.reconciled
    expect(decision).toMatchObject({ option: 'operator', verdict: 'unknown' })
    expect(decision!.reasons).toContain('the agent process: unknown (never reported)')
  }, 300_000)
})
