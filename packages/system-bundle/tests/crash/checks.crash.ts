/**
 * Crash injection while a run's required check runs (ADR-0063, T151, INV-4): the daemon is killed
 * with SIGKILL while the `tests` check of a completed run runs, confined, in the run's worktree,
 * before its acceptance is decided. A check is never run again to replace what it came to (T164):
 * after a restart the engine advances the run again, the source answers the check the crash
 * interrupted with a stored `error`, not a second run (which would pass now), and the acceptance is
 * decided once, the check pending. Run with `pnpm test:crash` (it builds first).
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'

const HARNESS = fileURLToPath(new URL('./checks-harness.mjs', import.meta.url))

type Message = Record<string, unknown>

function findBwrap(): string | undefined {
  try {
    return execFileSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}
// CI requires the real bubblewrap, so a missing one fails instead of skipping silently.
const CONFINES = !!findBwrap() || process.env.SYSTEM_REQUIRE_BWRAP === '1'

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

describe.skipIf(!CONFINES)('crash injection while a run\'s required check runs (ADR-0063, INV-4)', () => {
  it('a daemon killed while the tests check runs leaves the run unaccepted; the restart never runs the check again: it is an error, pending, and the run is accepted once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-crash-checks-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const repo = join(dir, 'repo')
    const git = (...args: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim()
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    writeFileSync(join(repo, 'calc.py'), 'def add(a, b):\n    return a - b\n')
    writeFileSync(join(repo, '.gitignore'), 'hang\n')
    // The check: hangs while `hang` is there; else passes when add() adds.
    writeFileSync(join(repo, 'tests.mjs'), [
      "import { existsSync, readFileSync } from 'node:fs'",
      "if (existsSync('hang')) setInterval(() => {}, 1000)",
      "else { const ok = readFileSync('calc.py', 'utf8').includes('a + b'); console.log(ok ? 'tests: passed' : 'tests: failed'); process.exit(ok ? 0 : 1) }",
      '',
    ].join('\n'))
    git('add', '.')
    git('commit', '-q', '-m', 'init')

    const first = daemon([dir, 'start'])
    const { runId } = await first.message('runId') as { runId: string }
    const checking = (await first.message('checking')).checking as { worktree: string; status: string }
    // The run's steps completed, and it waits on its check: nothing is accepted yet.
    expect(checking.status).toBe('running')
    process.kill(-first.child.pid!, 'SIGKILL')
    if (first.child.exitCode === null && first.child.signalCode === null) await new Promise((resolve) => first.child.once('exit', resolve))

    const second = daemon([dir, 'resume', runId, checking.worktree])
    const done = (await second.message('done')).done as { status: string; acceptances: number; detail: { checks: Record<string, boolean>; pendingChecks: string[]; checkRun: { outcome: string } } }
    expect(done.status).toBe('completed')
    expect(done.acceptances).toBe(1)
    // The interrupted check is an error, never replaced by a second run's pass: it stays pending.
    expect(done.detail).toMatchObject({ pendingChecks: ['tests'], checkRun: { outcome: 'checked', asked: ['tests'], results: [{ check: 'tests', outcome: 'error' }] } })
    expect(done.detail.checks).not.toHaveProperty('tests')
  }, 180_000)
})
