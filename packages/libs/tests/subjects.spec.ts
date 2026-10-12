import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('is undefined outside a repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-nosubject-'))
    dirs.push(dir)
    expect(captureGitSubject(dir)).toBeUndefined()
  })
})
