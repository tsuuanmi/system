/**
 * Crash injection between a carried worktree's cut and the reading of the earlier tree into it
 * (ADR-0061, T127 item 2, INV-2, INV-4): the daemon is killed with SIGKILL after `git worktree add
 * --no-checkout` made the new run's worktree, its index empty and every file of its base staged as
 * deleted, and before `git read-tree` gave it the earlier tree. After a restart the worktree is still
 * marked as cut for that work, and no agent runs in it; past the retention it is put back to its base
 * and removed with nothing committed on its branch, so the run's agent later works on the base's files,
 * never on a tree of deletions. Run with `pnpm test:crash` (it builds first).
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'

const HARNESS = fileURLToPath(new URL('./carry-harness.mjs', import.meta.url))
const ORIGINAL = 'def add(a, b):\n    return a - b\n'

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

describe('crash injection between a carried worktree\'s cut and the reading of its tree (ADR-0061, INV-2, INV-4)', () => {
  it('a daemon killed before the earlier tree is read into the new worktree leaves it marked, no agent run in it; past the retention it is put back to its base and removed with nothing committed, and the run\'s agent later works on the base\'s files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-crash-carry-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const repo = join(dir, 'repo')
    const git = (...args: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim()
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    writeFileSync(join(repo, 'calc.py'), ORIGINAL)
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    const head = git('rev-parse', 'HEAD')

    const first = daemon([dir, 'crash'])
    expect((await first.message('wrote')).wrote).toMatchObject({ status: 'completed' })
    expect((await first.message('cut')).cut).toMatchObject({ carried_from: 'run_p', carried_commit: null, removed_at: null })
    process.kill(-first.child.pid!, 'SIGKILL')
    if (first.child.exitCode === null && first.child.signalCode === null) await new Promise((resolve) => first.child.once('exit', resolve))

    const second = daemon([dir, 'after'])
    const before = (await second.message('before')).before as { path: string; row: Record<string, unknown>; status: string }
    // As the crash left it: marked, its index empty, the base's file staged as deleted.
    expect(before.row).toEqual({ carried_from: 'run_p', carried_commit: null, removed_at: null })
    expect(before.status).toBe('D  calc.py')
    const swept = (await second.message('swept')).swept as { removed: string[]; kept: string[]; tip: string; head: string; row: Record<string, unknown>; exists: boolean }
    expect(swept.removed).toContain(before.path)
    expect(swept.kept).toEqual([])
    // Nothing committed on the run's branch: still the base it was cut at.
    expect(swept.tip).toBe(head)
    expect(swept.head).toBe(head)
    expect(swept.row).toEqual({ carried_from: null, carried_commit: null })
    expect(swept.exists).toBe(false)
    // The run's agent, added again from that branch: the base's files.
    expect((await second.message('ran')).ran).toEqual({ workspace: before.path, calc: ORIGINAL })
    expect((await second.message('rerun')).rerun).toEqual({ status: 'completed' })
  }, 120_000)
})
