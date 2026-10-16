import { readFileSync } from 'node:fs'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { describe, expect, it } from 'vitest'
import { voteRepository } from '../src/teams.ts'

describe('a review vote names the repository it read as decision@1.2 allows', () => {
  it('keeps url, ref, and commit of a snapshot that also records how it was pinned (live run_feaf612780ffaf04)', () => {
    const snapshot = { url: 'https://github.com/o/r', ref: 'main', commit: 'a'.repeat(40), pinnedBy: 'ref' as const }
    expect(voteRepository(snapshot)).toEqual({ url: 'https://github.com/o/r', ref: 'main', commit: 'a'.repeat(40) })
    expect(voteRepository({ url: 'https://github.com/o/r', commit: 'b'.repeat(40), pinnedBy: 'sha' })).toEqual({ url: 'https://github.com/o/r', commit: 'b'.repeat(40) })
    // The final vote decision of a repository review, with it, validates.
    const example = JSON.parse(readFileSync(new URL('../../../../schemas/examples/decision.review-blocking.json', import.meta.url), 'utf8')) as { vote: Record<string, unknown> }
    const record = { ...example, vote: { ...example.vote, repository: voteRepository(snapshot) } }
    expect(() => new SchemaRegistry().assert('decision@1.2', record)).not.toThrow()
    // The snapshot itself would not: the record keeps only what the schema names.
    expect(() => new SchemaRegistry().assert('decision@1.2', { ...example, vote: { ...example.vote, repository: snapshot } })).toThrow(/additional properties/)
  })
})
