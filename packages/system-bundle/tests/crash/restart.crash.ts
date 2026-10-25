/**
 * Crash injection (QA-1, INV-4, release-scope "Reliability"): the engine process is killed with
 * SIGKILL at each reconcile point of a website turn, then started again on the same state (the
 * assembled packages, built: `pnpm test:crash` builds first). The
 * provider must see the prompt exactly once, and the run must end correctly: recovered, or failed
 * closed when the conversation cannot be observed. Run with `pnpm test:crash`.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { canRunBrowser, testChrome } from '../../../plugins/browser-patchright/tests/support.ts'
import { FakeChatGpt, type FakeOptions } from '../../../plugins/provider-chatgpt-web/fixtures/fake-chatgpt.ts'
import { FakeGemini } from '../../../plugins/provider-gemini-web/fixtures/fake-gemini.ts'

const HARNESS = fileURLToPath(new URL('./crash-harness.mjs', import.meta.url))
/** A session-bound account (ADR-0030): its turns run in its login profile. */
const PROFILE_HARNESS = fileURLToPath(new URL('./profile-harness.mjs', import.meta.url))

interface Engine { child: ChildProcess; runId: Promise<string>; done: Promise<{ status: string; answer?: string; error?: { kind: string } }> }

/** One engine process in its own process group, so a crash takes its Xvfb and Chrome with it. */
function engine(dir: string, fake: { origin: string }, args: string[], harness = HARNESS): Engine {
  const child = spawn(process.execPath, [harness, dir, fake.origin, testChrome!, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const crash = (): void => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  onTestFinished(crash)
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

/** SIGKILL the whole process group, and wait until it is gone. */
async function crash(e: Engine): Promise<void> {
  process.kill(-e.child.pid!, 'SIGKILL')
  if (e.child.exitCode === null && e.child.signalCode === null) await new Promise((resolve) => e.child.once('exit', resolve))
}

const until = (check: () => boolean, ms: number): Promise<void> => vi.waitFor(() => {
  if (!check()) throw new Error('timed out')
}, { timeout: ms, interval: 20 })

async function scenario(options: Partial<FakeOptions>, conversation: 'persist' | 'temporary', crashWhen: (fake: FakeChatGpt, dir: string) => boolean) {
  const fake = new FakeChatGpt({ answer: 'The answer, once.', ...options })
  await fake.start()
  onTestFinished(() => fake.stop())
  const dir = mkdtempSync(join(tmpdir(), 'system-crash-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  const first = engine(dir, fake, ['start', conversation, 'survive a crash'])
  const runId = await first.runId
  await until(() => crashWhen(fake, dir), 90_000)
  await crash(first)
  // Started again on the same state; the dead process's leases expire first.
  const second = engine(dir, fake, ['resume', runId])
  return { fake, done: await second.done }
}

/** The engine recorded the turn's conversation binding (its URL showed the id): read from its store. */
const bound = (dir: string): boolean => {
  try {
    const db = new DatabaseSync(join(dir, 'system.db'), { readOnly: true })
    try {
      return (db.prepare('SELECT COUNT(*) AS n FROM turns WHERE binding IS NOT NULL').get() as { n: number }).n > 0
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

/** The ledger's state of every recorded conversation, read from the store. */
const ledger = (dir: string): string[] => {
  try {
    const db = new DatabaseSync(join(dir, 'system.db'), { readOnly: true })
    try {
      return (db.prepare('SELECT state FROM turn_conversations').all() as Array<{ state: string }>).map((r) => r.state)
    } catch {
      return []
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

const answered = (fake: FakeChatGpt): boolean => [...fake.conversations.values()].some((c) => c.turns.some((t) => t.role === 'assistant'))

describe.runIf(canRunBrowser)('crash injection at every reconcile point of a website turn (QA-1, INV-4)', () => {
  it('after the prompt was sent and its conversation bound, before the answer: the conversation is observed, the answer adopted, nothing resent', async () => {
    const { fake, done } = await scenario({ thinkMs: 8000 }, 'persist', (f, dir) => f.sent.length === 1 && bound(dir))
    expect(done).toMatchObject({ status: 'completed', answer: 'The answer, once.' })
    expect(fake.sent).toHaveLength(1)
  }, 300_000)

  it('after the answer was complete, before it was committed: the answer is recovered, nothing resent', async () => {
    const { fake, done } = await scenario({ thinkMs: 300 }, 'persist', answered)
    expect(done).toMatchObject({ status: 'completed', answer: 'The answer, once.' })
    expect(fake.sent).toHaveLength(1)
  }, 300_000)

  it('after the prompt was sent, before its conversation was bound: it cannot be found, so the run fails closed as AMBIGUOUS', async () => {
    const { fake, done } = await scenario({ thinkMs: 8000 }, 'persist', (f, dir) => f.sent.length === 1 && !bound(dir))
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed' } })
    expect(fake.sent).toHaveLength(1)
  }, 300_000)

  it('after a deletion was clicked on the site, before it was recorded: the site shows it gone, so it is recorded deleted and never clicked again (PROP-0004 Phase 5)', async () => {
    const fake = new FakeChatGpt({ answer: 'Delete me later.' })
    await fake.start()
    onTestFinished(() => fake.stop())
    const dir = mkdtempSync(join(tmpdir(), 'system-crash-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
    const first = engine(dir, fake, ['delete', 'a chat to delete'])
    await first.runId
    // The site took the deletion; the ledger still says it is due.
    await until(() => fake.deleteRequests.length === 1 && ledger(dir).includes('due'), 180_000)
    await crash(first)
    const second = spawn(process.execPath, [HARNESS, dir, fake.origin, testChrome!, 'settle'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    onTestFinished(() => {
      try {
        process.kill(-second.pid!, 'SIGKILL')
      } catch {
        // already gone
      }
    })
    let out = ''
    second.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    await new Promise((resolve) => second.once('exit', resolve))
    const settled = JSON.parse(out.split('\n').find((l) => l.startsWith('@@ {"conversations"'))!.slice(3)) as { conversations: Array<{ state: string; reason?: string }> }
    expect(settled.conversations).toEqual([expect.objectContaining({ state: 'deleted', reason: 'already gone from the site' })])
    expect(fake.deleteRequests).toHaveLength(1)
  }, 400_000)

  it('a run that failed beside a running node, superseded after a restart: the orphaned turn is cancelled before the node runs again, and its prompt is never resent (INV-4)', async () => {
    const fake = new FakeChatGpt({ thinkMs: 40_000, answer: (prompt) => (prompt.startsWith('Context for') ? 'the old context' : 'a slow answer') })
    await fake.start()
    onTestFinished(() => fake.stop())
    const dir = mkdtempSync(join(tmpdir(), 'system-crash-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
    const first = engine(dir, fake, ['fan-out', 'a question'])
    const runId = await first.runId
    const slow = (context: string) => fake.sent.filter((s) => s.prompt.startsWith(`Slow step on: ${context}`))
    // The slow step was sent and bound; its sibling failed at routing; the run waits on the slow one.
    await until(() => slow('the old context').length === 1 && bound(dir), 180_000)
    await crash(first)
    const second = engine(dir, fake, ['supersede', runId, 'the new context'])
    const done = await second.done
    // The run failed again on the step no Worker can run, after the slow step ran on the new context.
    expect(done).toMatchObject({ status: 'failed' })
    expect(slow('the old context')).toHaveLength(1)
    expect(slow('the new context')).toHaveLength(1)
    const db = new DatabaseSync(join(dir, 'system.db'), { readOnly: true })
    try {
      const turns = db.prepare("SELECT status, error, cancel_requested_at FROM turns WHERE prompt LIKE 'Slow step on: %' ORDER BY created_at").all() as Array<{ status: string; error: string | null; cancel_requested_at: string | null }>
      expect(turns.map((t) => [t.status, t.error && (JSON.parse(t.error) as { kind: string }).kind, !!t.cancel_requested_at])).toEqual([['failed', 'aborted', true], ['completed', null, false]])
      const node = db.prepare("SELECT state FROM workflow_nodes WHERE run_id = ? AND node_id = 'slow:1'").get(runId) as { state: string }
      expect(node.state).toBe('COMPLETED')
    } finally {
      db.close()
    }
  }, 400_000)

  it('a session-bound account, killed after the prompt was sent and bound: the restart clears the dead browser\'s profile lock, reopens the conversation in the profile, and adopts the answer (ADR-0030)', async () => {
    const fake = new FakeGemini({ startOnSpark: false, deviceBound: true, answer: `${'Slowly streamed words. '.repeat(80)}Done.` })
    await fake.start()
    onTestFinished(() => fake.stop())
    const dir = mkdtempSync(join(tmpdir(), 'system-crash-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
    const first = engine(dir, fake, ['start', 'survive a crash in the profile'], PROFILE_HARNESS)
    const runId = await first.runId
    await until(() => fake.sent.length === 1 && bound(dir), 120_000)
    await crash(first)
    // The site finishes the answer the dead engine never saw before the restart looks. A page opened
    // while it streams shows the prompt alone, which is AMBIGUOUS (resending would duplicate it), and
    // whether the restart's first look came before the last word was a race on a loaded host.
    await until(() => [...fake.conversations.values()].some((turns) => turns.some((turn) => turn.role === 'answer')), 120_000)
    const second = engine(dir, fake, ['resume', runId], PROFILE_HARNESS)
    const done = await second.done
    expect(done).toMatchObject({ status: 'completed', answer: expect.stringMatching(/Done\.$/) })
    expect(fake.sent).toHaveLength(1)
    // Still the profile's own session after the crash: no copy was ever used.
    expect(fake.deviceChecks.length).toBeGreaterThan(1)
    expect(fake.deviceChecks.every(Boolean)).toBe(true)
  }, 300_000)

  it('after a temporary chat was sent: it cannot be observed, so the run fails closed as AMBIGUOUS, never resent blind', async () => {
    const { fake, done } = await scenario({ thinkMs: 8000 }, 'temporary', (f) => f.sent.length === 1)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed' } })
    expect(fake.sent).toHaveLength(1)
  }, 300_000)
})
