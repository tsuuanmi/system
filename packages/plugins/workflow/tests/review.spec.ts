import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Engine } from '../src/engine.ts'
import { reviewSubject } from '../src/review.ts'

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
})
