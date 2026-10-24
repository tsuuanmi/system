/**
 * Crash injection for a model call (QA-1, INV-4, REQ-WRK-10): the engine process is killed with
 * SIGKILL while an API model Worker is answering, then started again on the same state. A model
 * call has no effect beyond its cost, so it is safe to repeat with a bounded cost: the call is
 * sent exactly once more, and the run completes. Run with `pnpm test:crash` (it builds first).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { fakeOpenAi } from '../../../plugins/models/tests/fake-openai.ts'

const HARNESS = fileURLToPath(new URL('./model-harness.mjs', import.meta.url))

interface Engine { child: ChildProcess; runId: Promise<string>; done: Promise<{ status: string; answer?: string; error?: { kind: string } }> }

function engine(args: string[]): Engine {
  const child = spawn(process.execPath, [HARNESS, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SYSTEM_CRASH_MODEL_KEY: 'sk-crash-0123456789' } })
  onTestFinished(() => {
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

const until = (check: () => boolean, ms: number): Promise<void> => vi.waitFor(() => {
  if (!check()) throw new Error('timed out')
}, { timeout: ms, interval: 20 })

describe('crash injection while a model Worker answers (QA-1, INV-4)', () => {
  it('after the call was sent, before the answer: the call is sent exactly once more and the run completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-crash-model-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const server = await fakeOpenAi()
    onTestFinished(() => server.close())
    // The first send is held open until the process is killed; the next one answers.
    server.script.push({ holdMs: 120_000 })
    const first = engine([dir, server.baseURL, 'start', 'What is two plus two?'])
    const runId = await first.runId
    await until(() => server.requests.length === 1, 60_000)
    process.kill(-first.child.pid!, 'SIGKILL')
    if (first.child.exitCode === null && first.child.signalCode === null) await new Promise((resolve) => first.child.once('exit', resolve))
    // Started again on the same state; the dead process's leases expire first.
    const second = engine([dir, server.baseURL, 'resume', runId])
    expect(await second.done).toMatchObject({ status: 'completed', answer: 'echo: What is two plus two?' })
    expect(server.requests).toHaveLength(2)
  }, 300_000)
})
