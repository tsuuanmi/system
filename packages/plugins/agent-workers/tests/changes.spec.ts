/**
 * A workflow run's change as the operator's review reads it (T122, T128): bounded as it reads, every
 * untracked file opened one directory at a time from the worktree's own, each diff paired with its file
 * by its header, and a merged run read against the commit its worktree was cut at.
 *
 * Two seams of the host are wrapped here, passing through unless a test arms them: the file system
 * calls that reach a path (so a test can swap a directory for a link right after one was reached), and
 * the `git` on PATH (so a test can change the worktree right before git reads the patch).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry from '@tsuuanmi/system-agent-runtimes'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import { CHANGE_BOUNDS } from '@tsuuanmi/system-workers-core'
import WorkerRouter from '@tsuuanmi/system-workers'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import AgentWorkers from '../src/index.ts'
import { quotedPath, Worktrees } from '../src/worktrees.ts'

const host = await vi.hoisted(async () => {
  const { execFileSync: run } = await import('node:child_process')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  // git on PATH runs the armed hook once before a diff that reads the patch (not its names or lines), then the real git.
  const real = run('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'system-git-shim-'))
  const hook = path.join(bin, 'before-patch.sh')
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" --numstat "*|*" --name-status "*) ;; *" diff "*) if [ -f ${hook} ]; then sh ${hook}; rm -f ${hook}; fi ;; esac\nexec ${real} "$@"\n`, { mode: 0o755 })
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
  return { hook, reached: undefined as ((path: string) => void) | undefined }
})

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    realpathSync: Object.assign((...args: Parameters<typeof fs.realpathSync>) => {
      const result = fs.realpathSync(...args)
      host.reached?.(String(args[0]))
      return result
    }, { native: fs.realpathSync.native }),
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      host.reached?.(String(args[0]))
      return handle
    },
  }
})

const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim()

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A repository on `main` with `files` committed; never one of the operator's. */
const repository = (files: Record<string, string>): string => {
  const dir = temp('system-change-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** The agents source's store, and the worktrees of a root of its own over it. */
async function boot(): Promise<{ ctx: Context; worktrees: Worktrees }> {
  const dir = temp('system-change-')
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(AgentWorkers, { workers: [], worktreeRoot: join(dir, 'worktrees') }),
  ]
  await Promise.all(fibers)
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return { ctx, worktrees: new Worktrees(ctx as never, join(dir, 'worktrees')) }
}

describe('a run\'s change for the operator\'s review (T122, T128)', { timeout: 120_000 }, () => {
  it('reads thousands of untracked files and a patch past git\'s buffer only up to the bounds: counted past them, read only while room is left, never unreadable (INV-9, INV-2)', async () => {
    const LINES = 300_000
    const repo = repository({ 'big.txt': Array.from({ length: LINES }, (_, i) => `line ${i} of a file whose patch is larger than any buffer\n`).join('') })
    const { worktrees } = await boot()
    const workspace = await worktrees.acquire(repo, 'run_big')
    // Every line changed: a patch of about 36 MB, past the 16 MB git's output was buffered to.
    writeFileSync(join(workspace, 'big.txt'), Array.from({ length: LINES }, (_, i) => `LINE ${i} OF A FILE WHOSE PATCH IS LARGER THAN ANY BUFFER\n`).join(''))
    // Ten untracked files of 64 KB, then 3000 small ones.
    for (let i = 0; i < 10; i++) writeFileSync(join(workspace, `a-${i}.txt`), `${'x'.repeat(99)}\n`.repeat(640))
    mkdirSync(join(workspace, 'many'))
    for (let i = 0; i < 3000; i++) writeFileSync(join(workspace, 'many', `f-${String(i).padStart(4, '0')}.txt`), `${i}\n`)
    // The event loop keeps turning while it reads.
    let last = Date.now()
    let gap = 0
    const tick = setInterval(() => {
      gap = Math.max(gap, Date.now() - last)
      last = Date.now()
    }, 5)
    const [change] = (await worktrees.changes('run_big'))!
    clearInterval(tick)
    expect(gap).toBeLessThan(1000)
    expect(change!.files).toHaveLength(CHANGE_BOUNDS.files)
    expect(change!.more).toBe(1 + 10 + 3000 - CHANGE_BOUNDS.files)
    expect(change!.truncated).toBe(true)
    // The tracked patch reads as cut, never as unreadable.
    const big = change!.files[0]!
    expect(big).toMatchObject({ path: 'big.txt', status: 'modified', added: LINES, removed: LINES, truncated: true })
    expect(big.diff!.startsWith('diff --git a/big.txt b/big.txt\n')).toBe(true)
    expect(big.diff!.length).toBe(CHANGE_BOUNDS.fileChars)
    // Untracked files are read while the bounds leave room, and not at all after.
    const shown = change!.files.reduce((n, f) => n + (f.diff?.length ?? 0), 0)
    expect(shown).toBeLessThanOrEqual(CHANGE_BOUNDS.totalChars)
    const read = change!.files.slice(1).filter((f) => f.diff !== undefined)
    expect(read.length).toBeGreaterThan(0)
    expect(read.length).toBeLessThan(10)
    const past = change!.files.slice(1 + read.length)
    expect(past.map((f) => f.path).slice(-1)).toEqual([`many/f-${String(CHANGE_BOUNDS.files - 1 - 10 - 1).padStart(4, '0')}.txt`])
    for (const file of past) expect(file).toEqual({ path: file.path, status: 'added', truncated: true })
  })

  it('opens an untracked file relative to the directory it opened, so a directory swapped for a link after it was reached is never followed (INV-15)', async () => {
    const repo = repository({ 'calc.py': 'x = 1\n' })
    const outside = temp('system-outside-')
    writeFileSync(join(outside, 'f.txt'), 'outside the run\n')
    const { worktrees } = await boot()
    const workspace = await worktrees.acquire(repo, 'run_swap')
    mkdirSync(join(workspace, 'd'))
    writeFileSync(join(workspace, 'd', 'f.txt'), 'the run wrote this\n')
    // Once the directory was reached, it is moved away and a link out of the worktree put in its place.
    host.reached = (path) => {
      if (!path.endsWith('/d')) return
      host.reached = undefined
      renameSync(join(workspace, 'd'), join(workspace, 'moved'))
      symlinkSync(outside, join(workspace, 'd'))
    }
    onTestFinished(() => void (host.reached = undefined))
    const [change] = (await worktrees.changes('run_swap'))!
    expect(host.reached).toBeUndefined()
    expect(JSON.stringify(change)).not.toContain('outside the run')
    expect(change!.files.find((f) => f.path === 'd/f.txt')).toMatchObject({ status: 'added', diff: 'new file d/f.txt (untracked)\n+the run wrote this' })
  })

  it('pairs each diff with its file by its diff --git line, so a file never shows another\'s diff, whatever order git gives them in (T128)', async () => {
    const repo = repository({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'odd "name"\t.txt': 'o\n', 'é.txt': 'e\n' })
    const { worktrees } = await boot()
    const workspace = await worktrees.acquire(repo, 'run_pairs')
    for (const name of ['a.txt', 'c.txt', 'odd "name"\t.txt', 'é.txt']) writeFileSync(join(workspace, name), `${name} changed\n`)
    // Before git reads the patch, the change moves from a.txt to b.txt: as many files, in another order.
    writeFileSync(host.hook, `cd ${JSON.stringify(workspace)} && printf 'a\\n' > a.txt && printf 'b changed\\n' > b.txt\n`)
    onTestFinished(() => rmSync(host.hook, { force: true }))
    const [change] = (await worktrees.changes('run_pairs'))!
    const byPath = new Map(change!.files.map((f) => [f.path, f]))
    expect([...byPath.keys()].sort()).toEqual(['a.txt', 'c.txt', 'odd "name"\t.txt', 'é.txt'])
    // a.txt's diff is never b.txt's: it has none, and says so.
    expect(byPath.get('a.txt')).toMatchObject({ note: 'git gave no diff for it' })
    expect(byPath.get('a.txt')!.diff).toBeUndefined()
    expect(byPath.get('c.txt')!.diff).toMatch(/^diff --git a\/c.txt b\/c.txt\n[\s\S]*\+c.txt changed$/)
    // A name git quotes in its header is matched as git quotes it.
    expect(byPath.get('odd "name"\t.txt')!.diff).toMatch(/^diff --git "a\/odd \\"name\\"\\t.txt" "b\/odd \\"name\\"\\t.txt"\n/)
    expect(byPath.get('é.txt')!.diff).toMatch(/^diff --git "a\/\\303\\251.txt" "b\/\\303\\251.txt"\n[\s\S]*\+é.txt changed$/)
    expect(quotedPath('a/plain name.txt')).toBe('a/plain name.txt')
  })

  it('reads a run whose branch was merged into the base against the commit its worktree was cut at, so a landed run still shows its change, from its worktree or its branch (T128, INV-2)', async () => {
    const repo = repository({ 'calc.py': 'x = 1\n' })
    const fork = git(repo, 'rev-parse', 'HEAD')
    const { ctx, worktrees } = await boot()
    const workspace = await worktrees.acquire(repo, 'run_landed')
    writeFileSync(join(workspace, 'calc.py'), 'x = 2\n')
    git(workspace, 'commit', '-q', '-am', 'the run\'s change')
    const head = git(workspace, 'rev-parse', 'HEAD')
    // The base moves on, then takes the branch: what a landing's merge does.
    writeFileSync(join(repo, 'other.txt'), 'the base\'s own\n')
    git(repo, 'add', 'other.txt')
    git(repo, 'commit', '-q', '-m', 'the base moves')
    git(repo, 'merge', '--no-ff', '-q', '-m', 'land', 'system/run/run_landed')
    const [landed] = (await worktrees.changes('run_landed'))!
    expect(landed).toMatchObject({ base: { branch: 'main', sha: fork }, head, more: 0 })
    expect(landed!.files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([['calc.py', 'modified', 1, 1]])
    // Not yet merged, with the base merged into the branch: only the run's own change, against where they meet.
    const second = await worktrees.acquire(repo, 'run_open')
    writeFileSync(join(second, 'mine.txt'), 'mine\n')
    git(second, 'add', 'mine.txt')
    git(second, 'commit', '-q', '-m', 'mine')
    writeFileSync(join(repo, 'later.txt'), 'later\n')
    git(repo, 'add', 'later.txt')
    git(repo, 'commit', '-q', '-m', 'later')
    git(second, 'merge', '-q', '--no-edit', 'main')
    const [open] = (await worktrees.changes('run_open'))!
    expect(open!.files.map((f) => f.path)).toEqual(['mine.txt'])
    // Retired after landing: read from its branch, against the same commit.
    const row = ctx.store.db.prepare('SELECT * FROM agent_worktrees WHERE workflow_run_id = ?').get('run_landed') as { path: string }
    git(repo, 'worktree', 'remove', row.path)
    ctx.store.db.prepare('UPDATE agent_worktrees SET removed_at = ? WHERE workflow_run_id = ?').run(new Date().toISOString(), 'run_landed')
    const [kept] = (await worktrees.changes('run_landed'))!
    expect(kept).toMatchObject({ fromBranch: true, base: { sha: fork }, head })
    expect(kept!.files.map((f) => f.path)).toEqual(['calc.py'])
    // Made before the fork was recorded, and merged: it cannot be told, and says so; never no change.
    ctx.store.db.prepare('UPDATE agent_worktrees SET forked_at = NULL WHERE workflow_run_id = ?').run('run_landed')
    await expect(worktrees.changes('run_landed')).rejects.toThrow(/cannot be told from what main holds/)
    // A branch made from the HEAD records the commit it was made at.
    expect((ctx.store.db.prepare('SELECT forked_at FROM agent_worktrees WHERE workflow_run_id = ?').get('run_open') as { forked_at: string }).forked_at).toBe(git(repo, 'rev-parse', 'HEAD~1'))
  })
})
