/**
 * Crash injection between an enrollment slot's allocation and its verification (PROP-0012 phase E,
 * ADR-0051, INV-2): the daemon is killed with SIGKILL while it reads who is signed in to the slot's
 * home. After a restart the slot is `enrolled`, never `ready`: the Workers that run in that home take
 * no work until the operator verifies it, which then makes it `ready`. Run with `pnpm test:crash`
 * (it builds first).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'

const HARNESS = fileURLToPath(new URL('./enroll-harness.mjs', import.meta.url))

type Message = Record<string, unknown>

/** One harness process, and the first message carrying each key. */
function daemon(args: string[]): { child: ChildProcess; message: (key: string) => Promise<Message> } {
  const child = spawn(process.execPath, [HARNESS, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  onTestFinished(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // already gone
    }
  })
  const seen: Message[] = []
  const waiting: Array<{ key: string; resolve: (m: Message) => void }> = []
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.startsWith('@@ ')) continue
      const message = JSON.parse(line.slice(3)) as Message
      seen.push(message)
      for (const w of waiting.filter((w) => w.key in message)) w.resolve(message)
    }
  })
  return {
    child,
    message: (key) => new Promise((resolve) => {
      const found = seen.find((m) => key in m)
      if (found) resolve(found)
      else waiting.push({ key, resolve })
    }),
  }
}

describe('crash injection between an enrollment slot\'s allocation and its verification (REQ-ACC-11, INV-2)', () => {
  it('a daemon killed while it reads the slot\'s identity leaves the slot enrolled, never ready, and its Workers take no work until the operator verifies it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-crash-enroll-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = daemon([dir, 'crash'])
    expect((await first.message('begun')).begun).toMatchObject({ provider: 'scripted', slot: 1, status: 'enrolled' })
    await first.message('reading')
    process.kill(-first.child.pid!, 'SIGKILL')
    if (first.child.exitCode === null && first.child.signalCode === null) await new Promise((resolve) => first.child.once('exit', resolve))
    const second = daemon([dir, 'after'])
    const before = (await second.message('before')).before as { accounts: Array<Record<string, unknown>>; state: string }
    expect(before.accounts).toEqual([expect.objectContaining({ provider: 'scripted', slot: 1, status: 'enrolled' })])
    expect(before.accounts[0]).not.toHaveProperty('accountId')
    expect(before.state).toBe('unavailable')
    const after = (await second.message('after')).after as { verified: Record<string, unknown>; state: string }
    expect(after.verified).toMatchObject({ status: 'ready', accountId: expect.stringMatching(/^scripted:[0-9a-f]{16}$/) })
    expect(after.state).toBe('ready')
  }, 120_000)
})
