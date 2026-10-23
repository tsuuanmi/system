import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it } from 'vitest'
import { runSuite } from '../../libs/conformance/runner.ts'
import { digestsSuite, FakeDigests, LOG } from '../conformance/digests.ts'
import { type ArtifactRef, DIGESTS_CONTRACT, escalation, quoteCheck, settlement } from '../src/index.ts'

// The seam's own fake passes the suite every provider must pass (ADR-0037).
runSuite(digestsSuite, {
  name: 'the fake provider',
  contract: DIGESTS_CONTRACT,
  boot: async (drafter) => {
    const dir = mkdtempSync(join(tmpdir(), 'system-digests-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(FakeDigests, drafter ? { drafter } : {})]
    await Promise.all(fibers)
    return {
      ctx,
      dispose: async () => {
        for (const fiber of fibers.reverse()) await fiber.dispose()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})

describe('the quote check', () => {
  const log = `sha256:${'1'.repeat(64)}` as ArtifactRef
  const json = `sha256:${'2'.repeat(64)}` as ArtifactRef
  const bodies: Record<string, { body: unknown }> = { [log]: { body: { text: LOG } }, [json]: { body: { b: [1], a: 'median speed-up 2.4x' } } }
  const read = (ref: ArtifactRef) => bodies[ref]
  const claim = (id: string, artifact: ArtifactRef, quote: string, offset?: number) => ({ id, kind: 'finding', text: 't', citation: { artifact, quote, ...(offset !== undefined ? { offset } : {}) } })
  const base = { status: 'passed', summary: 's' }

  it('keeps a verbatim quote, at its offset in code points, and checks a body with no text as its canonical JSON', () => {
    const emoji = `sha256:${'3'.repeat(64)}` as ArtifactRef
    bodies[emoji] = { body: { text: '😀 ok' } }
    const check = quoteCheck({ ...base, claims: [claim('C1', log, 'FAIL tests', LOG.indexOf('FAIL')), claim('C2', json, '"a":"median speed-up 2.4x"'), claim('C3', emoji, 'ok', 2)] }, [log, json, emoji], read)
    expect(check.dropped).toEqual([])
    expect(check.digest!.claims.map((c) => c.id)).toEqual(['C1', 'C2', 'C3'])
  })

  it('drops a quote altered by one character, a reused id, a claim past the bound, and unchecked drafts give no digest', () => {
    const check = quoteCheck({ ...base, claims: [claim('C1', log, 'FAIL tests/align/end-gaps.spec.ts (2 failed).'), claim('C2', log, 'PASS'), claim('C2', log, 'FAIL'), claim('C3', log, 'Tests'), claim('C4', log, 'PASS')] }, [log], read, 2)
    expect(check.digest!.claims.map((c) => c.id)).toEqual(['C2', 'C3'])
    expect(check.dropped.map((d) => d.claim)).toEqual(['C1', 'C2', 'C4'])
    expect(check.dropped.map((d) => d.why)).toEqual([expect.stringMatching(/not verbatim/), expect.stringMatching(/taken by an earlier claim/), expect.stringMatching(/past the 2 claims/)])
    expect(check.digest!.dropped!.map((d) => d.what)).toEqual(['claim C1', 'claim C2', 'claim C4'])
    expect(quoteCheck({ ...base, claims: [claim('C1', log, 'nowhere')] }, [log], read)).toMatchObject({ kept: 0, reason: expect.stringMatching(/no claim survived/) })
    expect(quoteCheck({ claims: [] }, [log], read).reason).toMatch(/no status/)
    expect(quoteCheck(undefined, [log], read).reason).toMatch(/no JSON object/)
    const many = quoteCheck({ ...base, claims: Array.from({ length: 52 }, (_, i) => claim(`C${i + 1}`, log, 'PASS')) }, [log], read)
    expect(many.kept).toBe(50)
    expect(many.dropped).toEqual([{ claim: 'claims 51 to 52', why: expect.stringMatching(/at most 50/) }])
  })

  it('never takes the draft\'s sources: the digest is over the requested ones', () => {
    const check = quoteCheck({ ...base, sources: [json], claims: [claim('C1', log, 'PASS')] }, [log], read)
    expect(check.digest!.sources).toEqual([log])
  })

  it('settles with one decision whose every candidate says why', () => {
    const decision = settlement({ requestId: 'dig-1', sources: [log] }, { state: 'bypassed', reason: 'no Worker' })
    expect(decision.candidates.map((c) => [c.option, c.selected, c.reasons.length > 0])).toEqual([['written', false, true], ['not-written', false, true], ['bypassed', true, true]])
    expect(decision.outcome).toEqual({ option: 'bypassed', detail: { requestId: 'dig-1', kept: 0, dropped: [], reason: 'no Worker' } })
  })

  it('names why a draft gave no digest, and escalates only an economy answer whose every claim failed, once, to standard', () => {
    const answer = `sha256:${'4'.repeat(64)}` as ArtifactRef
    const failed = quoteCheck({ ...base, claims: [claim('C1', log, 'nowhere')] }, [log], read)
    expect(failed.failure).toBe('quote-check')
    expect(quoteCheck({ ...base, claims: [] }, [log], read).failure).toBe('no-claim')
    expect(quoteCheck({ claims: [] }, [log], read).failure).toBe('no-status')
    expect(quoteCheck(undefined, [log], read).failure).toBe('no-object')
    expect(quoteCheck({ ...base, claims: [claim('C1', log, 'PASS')] }, [log], read).failure).toBeUndefined()
    const request = { requestId: 'dig-1', sources: [log], tier: 'economy', escalated: false }
    const decision = escalation(request, failed, answer)!
    expect(decision).toMatchObject({ decisionType: 'escalation', decider: { id: 'digests.escalation' }, outcome: { option: 'escalate', detail: { from: 'economy', to: 'standard' } }, inputs: [log, answer] })
    expect(decision.candidates.map((c) => [c.option, c.selected, c.reasons.length > 0])).toEqual([['escalate', true, true], ['give-up', false, true]])
    expect(escalation({ ...request, escalated: true }, failed, answer)).toBeUndefined()
    expect(escalation({ ...request, tier: 'standard' }, failed, answer)).toBeUndefined()
    expect(escalation(request, quoteCheck({ ...base, claims: [] }, [log], read), answer)).toBeUndefined()
  })
})
