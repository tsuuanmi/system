import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureGitSubject, subjectId } from '../src/index.ts'

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
