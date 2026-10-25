import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureGitSubject, ignoredPath, subjectId } from '../src/index.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'system-subject-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(dir, 'calc.py'), 'def add(a, b):\n    return a - b\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return dir
}

describe('exact git subjects (REQ-WF-5)', () => {
  it('identifies a working tree by HEAD and every change on top of it, tracked and untracked', () => {
    const dir = repo()
    const clean = captureGitSubject(dir)!
    expect(clean.subject).toMatchObject({ type: 'git-head', ref: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(subjectId(clean.subject)).toBe(`git:${clean.subject.ref}:${clean.subject.version}`)
    expect(clean.diff).toBe('')
    writeFileSync(join(dir, 'calc.py'), 'def add(a, b):\n    return a + b\n')
    const edited = captureGitSubject(dir)!
    expect(edited.subject.ref).toBe(clean.subject.ref)
    expect(edited.subject.version).not.toBe(clean.subject.version)
    expect(edited.diff).toContain('+    return a + b')
    expect(captureGitSubject(dir)!.subject).toEqual(edited.subject) // stable
    writeFileSync(join(dir, 'notes.md'), 'new')
    const added = captureGitSubject(dir)!
    expect(added.subject.version).not.toBe(edited.subject.version)
    expect(added.diff).toContain('new file notes.md\nnew')
  })

  it('shows an untracked file over the size bound by its size only, and skips one that is not a regular file without waiting on it (REQ-WF-5)', () => {
    const dir = repo()
    writeFileSync(join(dir, 'big.bin'), 'x'.repeat(20))
    // git lists a symlink, not the FIFO it points at; reading the FIFO would wait for a writer.
    const outside = mkdtempSync(join(tmpdir(), 'system-subject-fifo-'))
    dirs.push(outside)
    execFileSync('mkfifo', [join(outside, 'fifo')])
    symlinkSync(join(outside, 'fifo'), join(dir, 'pipe'))
    const captured = captureGitSubject(dir, { maxFileBytes: 10 })!
    expect(captured.diff).toBe('new file big.bin (20 bytes, not shown)')
  })

  it('binds every untracked file\'s whole content, over the display bound too: the same size with its mtime restored is another subject (INV-5)', () => {
    const dir = repo()
    const big = join(dir, 'big.bin')
    // Over the bound shown, read in more than one chunk of the hash.
    const size = 3 * 1024 * 1024 + 17
    writeFileSync(big, Buffer.alloc(size, 'a'))
    // A whole second, so restoring it is exact.
    utimesSync(big, 1_700_000_000, 1_700_000_000)
    const stamp = statSync(big)
    const before = captureGitSubject(dir, { maxFileBytes: 10 })!
    expect(before.diff).toBe(`new file big.bin (${size} bytes, not shown)`)
    // The default bound shows nothing of it either, and binds the same content to the same subject.
    expect(captureGitSubject(dir)!.subject).toEqual(before.subject)
    const changed = Buffer.alloc(size, 'a')
    changed[size - 1] = 0x62
    writeFileSync(big, changed)
    utimesSync(big, 1_700_000_000, 1_700_000_000)
    expect(statSync(big)).toMatchObject({ size, mtimeMs: stamp.mtimeMs })
    const after = captureGitSubject(dir, { maxFileBytes: 10 })!
    expect(after.subject.ref).toBe(before.subject.ref)
    expect(after.subject.version).not.toBe(before.subject.version)
    expect(captureGitSubject(dir)!.subject.version).toBe(after.subject.version)
    // Restored byte for byte, it is the first subject again: content, not time, decides.
    writeFileSync(big, Buffer.alloc(size, 'a'))
    expect(captureGitSubject(dir)!.subject).toEqual(before.subject)
  })

  it('throws when the untracked files pass what a subject hashes: a tree it cannot bind exactly has no subject it can name (INV-2, INV-5)', () => {
    const dir = repo()
    writeFileSync(join(dir, 'big.bin'), 'x'.repeat(64))
    expect(() => captureGitSubject(dir, { maxHashBytes: 63 })).toThrow(/passes the bound on what a subject hashes, so the tree cannot be bound exactly/)
    expect(captureGitSubject(dir, { maxHashBytes: 64 })!.subject.version).toMatch(/^[0-9a-f]{64}$/)
  })

  it('names a path git leaves out of every subject: ignored, holding nothing tracked, taken literally', () => {
    const dir = repo()
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n*.log\n')
    expect(ignoredPath(dir, 'node_modules')).toBe(true)
    expect(ignoredPath(dir, 'node_modules/.vite')).toBe(true)
    expect(ignoredPath(dir, 'build')).toBe(false)
    // Tracked, though its name is ignored now.
    expect(ignoredPath(dir, 'calc.py')).toBe(false)
    writeFileSync(join(dir, 'kept.log'), 'x')
    execFileSync('git', ['-C', dir, 'add', '-f', 'kept.log'])
    expect(ignoredPath(dir, 'kept.log')).toBe(false)
    expect(ignoredPath(dir, 'other.log')).toBe(true)
    // An ignored file is out of every subject as it is.
    writeFileSync(join(dir, 'other.log'), 'x')
    expect(ignoredPath(dir, 'other.log')).toBe(true)
    // Neither a pattern nor pathspec magic is read: such a name is never judged ignored.
    expect(ignoredPath(dir, '*')).toBe(false)
    expect(ignoredPath(dir, 'node_*')).toBe(false)
    expect(ignoredPath(dir, ':/node_modules')).toBe(false)
  })

  it('is undefined outside a repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-nosubject-'))
    dirs.push(dir)
    expect(captureGitSubject(dir)).toBeUndefined()
  })

  it('is undefined for a directory that is gone, so a removed worktree is no subject rather than a failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-gone-'))
    rmSync(dir, { recursive: true })
    expect(captureGitSubject(dir)).toBeUndefined()
  })

  it('throws when git fails otherwise: a subject it cannot read is unknown, never "no subject" (INV-2, INV-5)', async () => {
    const dir = repo()
    const bin = mkdtempSync(join(tmpdir(), 'system-fake-git-'))
    dirs.push(bin)
    // A git that refuses the repository (as for one of another owner), and one that answers it is none.
    const fake = (stderr: string): void => {
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "${stderr}" >&2\nexit 128\n`, { mode: 0o755 })
    }
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path ?? ''}`
    try {
      vi.resetModules()
      const { captureGitSubject: capture } = await import('../src/subjects.ts')
      fake(`fatal: detected dubious ownership in repository at '${dir}'`)
      expect(() => capture(dir)).toThrow(/cannot be read: git rev-parse failed \(fatal: detected dubious ownership/)
      fake('fatal: not a git repository (or any of the parent directories): .git')
      expect(capture(dir)).toBeUndefined()
    } finally {
      process.env.PATH = path
      vi.resetModules()
    }
  })
})
