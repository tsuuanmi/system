import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { runSuite } from '../../libs/conformance/runner.ts'
import { FakeLanding, landingSuite, MemoryRepository } from '../conformance/landing.ts'
import { LANDING_CONTRACT, sameSubject } from '../src/index.ts'

// The seam's own fake passes the suite every provider must pass (ADR-0037).
runSuite(landingSuite, {
  name: 'the fake provider',
  contract: LANDING_CONTRACT,
  boot: async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(FakeLanding)
    await fiber
    return { provider: ctx.landing, world: (ctx.landing as FakeLanding).repository.world(), dispose: async () => void await fiber.dispose() }
  },
})

describe('the memory repository the suite lands in', () => {
  it('merges only at the approved head and base, finds a merge done, and refuses a moved branch (ADR-0060)', () => {
    const repo = new MemoryRepository()
    const t = repo.run()
    expect(repo.merge(t.branch, `${t.head}x`, t.base)).toMatchObject({ outcome: 'refused', cause: 'head-moved' })
    const done = repo.merge(t.branch, t.head, t.base)
    expect(done).toMatchObject({ outcome: 'merged', already: false })
    expect(repo.merge(t.branch, t.head, t.base)).toEqual({ ...done, already: true })
    const u = repo.run()
    repo.advance('main')
    expect(repo.merge(u.branch, u.head, u.base)).toMatchObject({ outcome: 'refused', cause: 'base-moved' })
    expect(repo.merge('system/run/none', u.head, u.base)).toMatchObject({ outcome: 'refused', cause: 'gone' })
  })

  it('compares subjects by type, ref, and version', () => {
    const s = { type: 'git-head' as const, ref: 'b', version: 'v' }
    expect(sameSubject(s, { ...s })).toBe(true)
    expect(sameSubject(s, { ...s, version: 'w' })).toBe(false)
    expect(sameSubject(s, { ...s, ref: 'c' })).toBe(false)
    expect(sameSubject(s, { type: 'git-head', ref: 'b' })).toBe(false)
  })
})
