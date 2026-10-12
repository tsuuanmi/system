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
import { afterEach, describe, expect, it } from 'vitest'
import { canRunBrowser, testChrome } from '../../../plugins/browser-patchright/tests/support.ts'
import { FakeChatGpt, type FakeOptions } from '../../../plugins/provider-chatgpt-web/fixtures/fake-chatgpt.ts'

const HARNESS = fileURLToPath(new URL('./crash-harness.mjs', import.meta.url))

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

interface Engine { child: ChildProcess; runId: Promise<string>; done: Promise<{ status: string; answer?: string; error?: { kind: string } }> }

/** One engine process in its own process group, so a crash takes its Xvfb and Chrome with it. */
function engine(dir: string, fake: FakeChatGpt, args: string[]): Engine {
  const child = spawn(process.execPath, [HARNESS, dir, fake.origin, testChrome!, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const crash = (): void => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  cleanups.push(crash)
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

const until = async (check: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function scenario(options: Partial<FakeOptions>, conversation: 'persist' | 'temporary', crashWhen: (fake: FakeChatGpt, dir: string) => boolean) {
  const fake = new FakeChatGpt({ answer: 'The answer, once.', ...options })
  await fake.start()
  cleanups.push(() => fake.stop())
  const dir = mkdtempSync(join(tmpdir(), 'system-crash-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
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

  it('after a temporary chat was sent: it cannot be observed, so the run fails closed as AMBIGUOUS, never resent blind', async () => {
    const { fake, done } = await scenario({ thinkMs: 8000 }, 'temporary', (f) => f.sent.length === 1)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed' } })
    expect(fake.sent).toHaveLength(1)
  }, 300_000)
})
