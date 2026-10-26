import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Engine } from '../src/engine.ts'
import { notRunNote, reportUnreadNote, reviewSubject } from '../src/review.ts'

const H = (c: string) => `sha256:${c.repeat(64)}` as const
/** reviewSubject reads only artifacts: an engine that holds one agent result. */
const engineWith = (body: unknown) => ({ ctx: { artifacts: { get: () => ({ body }) } } }) as unknown as Engine

describe('the subject a review binds to (REQ-WF-5)', () => {
  it('reports an agent\'s working tree that can no longer be captured, so the review fails closed instead of running unbound (INV-2, INV-5)', () => {
    const gone = mkdtempSync(join(tmpdir(), 'system-review-gone-'))
    rmSync(gone, { recursive: true, force: true })
    const result = { schema: 'agent-result@1.1', workspace: gone, subject: { type: 'git-head', ref: 'HEAD', version: 'x' } }
    expect(reviewSubject(engineWith(result), [H('a')], 'Fix add()')).toEqual({ missing: gone })
  })

  it('binds no subject when no dependency is an agent\'s change', () => {
    expect(reviewSubject(engineWith({ schema: 'provider-answer@1.0', text: 'an answer' }), [H('b')], 'Review this')).toBeUndefined()
  })

  it('tells the review what the run that wrote the change did not run, its browser tests, before the subject, or that it is not known; and says nothing when it ran them all (T265)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'system-review-not-run-'))
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' })
      git('init', '-q')
      writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
      git('add', 'a.ts')
      git('commit', '-q', '-m', 'base')
      writeFileSync(join(repo, 'a.ts'), 'export const a = 2\n')
      const subject = { type: 'git-head', ref: 'HEAD', version: 'x' }
      const result = { schema: 'agent-result@1.5', workspace: repo, subject, notRun: 'its browser tests (58 browser tests skipped: no usable Chrome)' }
      const told = reviewSubject(engineWith(result), [H('c')], 'Rework the page') as { block: string }
      expect(told.block.startsWith(notRunNote(result.notRun))).toBe(true)
      expect(told.block).toContain('without running its browser tests (58 browser tests skipped: no usable Chrome)')
      expect(told.block).toContain('## The exact subject of this review')
      const ran = reviewSubject(engineWith({ schema: 'agent-result@1.2', workspace: repo, subject }), [H('d')], 'Rework the page') as { block: string }
      expect(ran.block).not.toContain('without running')
      expect(ran.block).not.toContain('is not known')
      // A report that could not be made or read is said as such, never taken for one naming no skip.
      const unread = reviewSubject(engineWith({ schema: 'agent-result@1.5', workspace: repo, subject, reportUnread: 'its report file cannot be read: EACCES' }), [H('e')], 'Rework the page') as { block: string }
      expect(unread.block.startsWith(reportUnreadNote('its report file cannot be read: EACCES'))).toBe(true)
      expect(unread.block).toContain('whether its browser tests ran is not known')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
