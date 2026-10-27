/**
 * Conformance suite for `ctx.digests` (ADR-0037; docs/design/digests.md), and a fake provider that
 * passes it. `boot(drafter)` returns a context that provides `ctx.digests` and `ctx.artifacts`,
 * nothing digested yet, in which a digest Worker on each tier answers each request as `drafter`
 * says (given the request's sources, in order, and the tier of the Worker asked); with no drafter,
 * no Worker can serve a digest at all.
 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-ledger-core'
import { extractJson, SchemaRegistry } from '@tsuuanmi/system-libs'
import { expect } from 'vitest'
import { defineSuite, type Scenario } from '../../libs/conformance/runner.ts'
import { type ArtifactRef, checkedRequest, type DigestBody, DigestError, type DigestRequest, Digests, type DigestView, type EscalationDecision, escalation, ESCALATION_TIER, quoteCheck, type QuoteCheck, settlement, type SettlementDecision } from '../src/index.ts'

/**
 * How the digest Worker of a tier answers a request: the text of its answer, or a failure of its
 * run. A scripted Worker also gives it the prompt its brief rendered to, when it has one.
 */
export type Drafter = (sources: readonly ArtifactRef[], tier: 'economy' | 'standard' | 'frontier', prompt?: string) => { text: string } | { fail: string }
export type Boot = (drafter: Drafter | undefined) => Promise<{ ctx: Context; dispose: () => Promise<void> }>

const schemas = new SchemaRegistry()

/** Raw artifacts a scenario digests: a test log and a benchmark note, as Worker answers. */
export const LOG = 'PASS tests/align/basic.spec.ts\nFAIL tests/align/end-gaps.spec.ts (2 failed)\nTests: 41 passed, 2 failed'
export const BENCH = 'Benchmark bench/align: median speed-up 2.4x over the reference, n=30.'

const raw = (ctx: Context, text: string, classification: 'public' | 'operator-shared' | 'local-private'): ArtifactRef => ctx.artifacts.put({
  kind: 'report', bodySchema: 'provider-answer@1.0', classification, producer: { type: 'worker', ref: 'w:raw' },
  body: { schema: 'provider-answer@1.0', provider: 'raw', account: 'raw', turnId: `t-${randomBytes(4).toString('hex')}`, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text },
}).id as ArtifactRef

type Claim = { id: string; kind: string; text: string; citation: { artifact: string; quote: string; offset?: number } }

/** A digest draft over the two sources, as a Worker writes it: a ```json block after some prose. */
export function draft(log: ArtifactRef, bench: ArtifactRef, claims?: Claim[], extra: Record<string, unknown> = {}): string {
  const body = {
    status: 'partial', summary: 'The banded kernel is in; two end-gap tests fail, and it is 2.4x faster.',
    claims: claims ?? [
      { id: 'C1', kind: 'failure', text: 'Two end-gap tests fail.', citation: { artifact: log, quote: 'FAIL tests/align/end-gaps.spec.ts (2 failed)', offset: LOG.indexOf('FAIL') } },
      { id: 'C2', kind: 'finding', text: 'The median speed-up is 2.4x.', citation: { artifact: bench, quote: 'median speed-up 2.4x over the reference' } },
    ],
    nextActions: ['Fix end-gap scoring'], ...extra,
  }
  return `Here is the digest.\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``
}

const failureOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call
    return 'resolved'
  } catch (error) {
    return error instanceof DigestError ? error.failure : `not a DigestError: ${String(error)}`
  }
}

type Decision = { decisionType: string; decider: { id: string }; inputs: string[]; outcome: { option: string; detail: { kept: number; dropped: Array<{ claim: string; why: string }>; reason?: string } }; candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
const decisionOf = (ctx: Context, view: DigestView): Decision => {
  expect(view.decision, `request ${view.requestId} names the decision that settled it`).toBeDefined()
  const body = ctx.artifacts.get(view.decision!)!.body as Decision & { schema: string }
  schemas.assertRecord(body)
  expect(body).toMatchObject({ decisionType: 'acceptance', decider: { id: 'digests.quote-check' }, outcome: { option: view.state } })
  expect(body.candidates.every((c) => c.reasons.length > 0)).toBe(true)
  return body
}
const settled = async (ctx: Context, view: DigestView): Promise<DigestView> => {
  const done = await ctx.digests.wait(view.requestId, 60_000)
  expect(done.state, `request ${view.requestId} settled`).not.toBe('pending')
  schemas.assertDef('mcp-digests@1.0', 'request', done)
  return done
}
type Escalation = { decisionType: string; decider: { id: string }; inputs: string[]; outcome: { option: string; detail: { from: string; to: string } }; candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
const escalationOf = (ctx: Context, view: DigestView): Escalation => {
  expect(view.escalation, `request ${view.requestId} names the decision that escalated it`).toBeDefined()
  const body = ctx.artifacts.get(view.escalation!)!.body as Escalation & { schema: string }
  schemas.assertRecord(body)
  expect(body).toMatchObject({ decisionType: 'escalation', decider: { id: 'digests.escalation' }, outcome: { option: 'escalate', detail: { from: 'economy', to: 'standard' } } })
  expect(body.candidates.every((c) => c.reasons.length > 0)).toBe(true)
  return body
}
/** The tiers of the Workers a scenario's drafter was asked by, in order (reset at each boot). */
const asked: string[] = []
/** Claims whose quotes are in neither source: none survives the quote check. */
const misquoted = (log: ArtifactRef, bench: ArtifactRef): Claim[] => [
  { id: 'C1', kind: 'failure', text: 'Three tests fail.', citation: { artifact: log, quote: 'FAIL tests/align/end-gaps.spec.ts (3 failed)' } },
  { id: 'C2', kind: 'finding', text: 'Paraphrased.', citation: { artifact: bench, quote: 'the median speed-up was 2.4x' } },
]
const digests = (ctx: Context): number => ctx.artifacts.list({ kind: 'report', limit: 1000 }).filter((a) => a.bodySchema === 'digest@1.0').length

interface Harness { ctx: Context; log: ArtifactRef; bench: ArtifactRef }

const scenario = (id: string, title: string, drafter: ((h: { log: () => ArtifactRef; bench: () => ArtifactRef }) => Drafter) | undefined, run: (h: Harness) => Promise<void>, since: '1.0' | '1.1' | '1.2' = '1.0'): Scenario<Boot> => ({
  id: `digests.${id}`, since, title,
  run: async (boot) => {
    const refs: { log?: ArtifactRef; bench?: ArtifactRef } = {}
    asked.length = 0
    const given = drafter?.({ log: () => refs.log!, bench: () => refs.bench! })
    const { ctx, dispose } = await boot(given && ((sources, tier) => {
      asked.push(tier)
      return given(sources, tier)
    }))
    try {
      refs.log = raw(ctx, LOG, 'public')
      refs.bench = raw(ctx, BENCH, 'operator-shared')
      await run({ ctx, log: refs.log, bench: refs.bench })
    } finally {
      await dispose()
    }
  },
})

export const digestsSuite = defineSuite<Boot>({
  seam: 'digests',
  contract: '1.2',
  scenarios: [
    scenario('written', 'writes a digest@1.0 report whose every claim quotes the artifact it cites verbatim, over exactly the requested sources, at least as strict as they are, settled by an acceptance decision (INV-12, INV-13, INV-14)', (h) => () => ({ text: draft(h.log(), h.bench()) }), async ({ ctx, log, bench }) => {
      const view = await settled(ctx, await ctx.digests.request({ sources: [log, bench] }))
      expect(view).toMatchObject({ state: 'written', sources: [log, bench], claims: { kept: 2, dropped: 0 } })
      const envelope = ctx.artifacts.get(view.digest!)!
      expect(envelope).toMatchObject({ kind: 'report', bodySchema: 'digest@1.0', classification: 'operator-shared' })
      expect(envelope.inputs).toEqual([log, bench].sort())
      const digest = envelope.body as DigestBody
      schemas.assertRecord(digest)
      expect(digest).toMatchObject({ sources: [log, bench], status: 'partial', nextActions: ['Fix end-gap scoring'] })
      expect(digest.claims.map((c) => [c.id, c.citation.artifact])).toEqual([['C1', log], ['C2', bench]])
      expect(digest.dropped).toBeUndefined()
      const decision = decisionOf(ctx, view)
      expect(decision.inputs).toEqual(expect.arrayContaining([log, bench]))
      expect(decision.outcome.detail).toMatchObject({ kept: 2, dropped: [] })
    }),

    scenario('drops-unchecked-claims', 'drops, and records with why, every claim whose quote is not verbatim in the artifact it cites, not at the offset it gives, or that cites an artifact not digested, and keeps the claims that pass', (h) => () => ({
      text: draft(h.log(), h.bench(), [
        { id: 'C1', kind: 'failure', text: 'Two end-gap tests fail.', citation: { artifact: h.log(), quote: 'FAIL tests/align/end-gaps.spec.ts (2 failed)' } },
        { id: 'C2', kind: 'finding', text: 'The speed-up is 2.5x.', citation: { artifact: h.bench(), quote: 'median speed-up 2.5x over the reference' } },
        { id: 'C3', kind: 'finding', text: 'Basic tests pass.', citation: { artifact: h.log(), quote: 'PASS tests/align/basic.spec.ts', offset: 3 } },
        { id: 'C4', kind: 'risk', text: 'Uncited.', citation: { artifact: `sha256:${'f'.repeat(64)}`, quote: 'anything' } },
      ]),
    }), async ({ ctx, log, bench }) => {
      const view = await settled(ctx, await ctx.digests.request({ sources: [log, bench] }))
      expect(view).toMatchObject({ state: 'written', claims: { kept: 1, dropped: 3 } })
      const digest = ctx.artifacts.get(view.digest!)!.body as DigestBody
      expect(digest.claims.map((c) => c.id)).toEqual(['C1'])
      expect(digest.dropped!.map((d) => d.what)).toEqual(['claim C2', 'claim C3', 'claim C4'])
      expect(digest.dropped![0]!.why).toMatch(/not verbatim/)
      expect(digest.dropped![1]!.why).toMatch(/at offset 3/)
      expect(digest.dropped![2]!.why).toMatch(/not one of the digested artifacts/)
      expect(decisionOf(ctx, view).outcome.detail.dropped.map((d) => d.claim)).toEqual(['C2', 'C3', 'C4'])
    }),

    scenario('nothing-survives', 'writes no digest when no claim survives the quote check, and settles the request not-written with why (INV-13)', (h) => () => ({
      text: draft(h.log(), h.bench(), misquoted(h.log(), h.bench())),
    }), async ({ ctx, log, bench }) => {
      const view = await settled(ctx, await ctx.digests.request({ sources: [log, bench] }))
      expect(view).toMatchObject({ state: 'not-written', claims: { kept: 0, dropped: 2 } })
      expect(view.digest).toBeUndefined()
      expect(view.reason).toMatch(/no claim survived the quote check/)
      expect(digests(ctx)).toBe(0)
      expect(decisionOf(ctx, view).outcome.detail.reason).toMatch(/no claim survived/)
    }),

    scenario('no-digest-in-answer', 'writes no digest from an answer that holds none, and settles the request not-written', () => () => ({ text: 'I could not read the artifacts.' }), async ({ ctx, log }) => {
      const view = await settled(ctx, await ctx.digests.request({ sources: [log] }))
      expect(view).toMatchObject({ state: 'not-written' })
      expect(view.reason).toMatch(/no JSON object/)
      expect(digests(ctx)).toBe(0)
      decisionOf(ctx, view)
    }),

    scenario('fails-open-without-worker', 'settles a request no Worker can serve as bypassed, recorded with why, without refusing it or writing anything: a digest fails open (ADR-0036)', undefined, async ({ ctx, log, bench }) => {
      const view = await settled(ctx, await ctx.digests.request({ sources: [log, bench] }))
      expect(view).toMatchObject({ state: 'bypassed', sources: [log, bench] })
      expect(view.reason).toBeTruthy()
      expect(view.digest).toBeUndefined()
      expect(digests(ctx)).toBe(0)
      expect(decisionOf(ctx, view).candidates.find((c) => c.option === 'bypassed')!.reasons.join(' ')).toMatch(/fails open/)
    }),

    scenario('fails-open-on-worker-failure', 'settles a request whose Worker run failed as bypassed, recorded with why, and writes nothing (ADR-0036)', () => () => ({ fail: 'timeout' }), async ({ ctx, log }) => {
      const view = await settled(ctx, await ctx.digests.request({ sources: [log] }))
      expect(view).toMatchObject({ state: 'bypassed' })
      expect(view.reason).toMatch(/timeout/)
      expect(digests(ctx)).toBe(0)
      decisionOf(ctx, view)
    }),

    scenario('refuses-invalid-input', 'refuses, recording nothing, a request with no source, a repeated source, more than 64, or a source that is not a stored artifact (INV-2, INV-9)', (h) => () => ({ text: draft(h.log(), h.bench()) }), async ({ ctx, log }) => {
      const before = ctx.artifacts.list({ kind: 'decision', limit: 1000 }).length
      const refused = (input: DigestRequest) => failureOf(ctx.digests.request(input))
      expect(await refused({ sources: [] })).toBe('invalid')
      expect(await refused({ sources: [log, log] })).toBe('invalid')
      expect(await refused({ sources: Array.from({ length: 65 }, (_, i) => `sha256:${i.toString(16).padStart(64, '0')}` as ArtifactRef) })).toBe('invalid')
      expect(await refused({ sources: [`sha256:${'e'.repeat(64)}`] })).toBe('invalid')
      expect(await refused({ sources: ['not-a-ref' as ArtifactRef] })).toBe('invalid')
      expect(ctx.artifacts.list({ kind: 'decision', limit: 1000 })).toHaveLength(before)
    }),

    scenario('idempotent-by-key', 'returns the same request for the same key, and refuses the key for other sources', (h) => () => ({ text: draft(h.log(), h.bench()) }), async ({ ctx, log, bench }) => {
      const first = await ctx.digests.request({ sources: [log, bench], key: 'k1' })
      const again = await ctx.digests.request({ sources: [log, bench], key: 'k1' })
      expect(again.requestId).toBe(first.requestId)
      expect(await failureOf(ctx.digests.request({ sources: [log], key: 'k1' }))).toBe('invalid')
      const other = await ctx.digests.request({ sources: [log, bench] })
      expect(other.requestId).not.toBe(first.requestId)
      await settled(ctx, first)
      await settled(ctx, other)
    }),

    scenario('unknown-request', 'reads no request for an unknown id, and refuses to wait on one', undefined, async ({ ctx }) => {
      expect(await ctx.digests.get('dig-unknown')).toBeUndefined()
      expect(await failureOf(ctx.digests.wait('dig-unknown', 10))).toBe('unknown-request')
    }),

    scenario('escalates-once', 'writes a request whose every economy claim failed the quote check once more on the standard tier, recording the escalation decision before it, and settles it on that answer (PROP-0008, INV-13)', (h) => (_sources, tier) => ({
      text: draft(h.log(), h.bench(), tier === 'economy' ? misquoted(h.log(), h.bench()) : undefined),
    }), async ({ ctx, log, bench }) => {
      const view = await settled(ctx, await ctx.digests.request({ sources: [log, bench] }))
      expect(asked).toEqual(['economy', 'standard'])
      expect(view).toMatchObject({ state: 'written', claims: { kept: 2, dropped: 0 } })
      const escalated = escalationOf(ctx, view)
      expect(escalated.inputs).toEqual(expect.arrayContaining([log, bench]))
      expect(decisionOf(ctx, view).inputs).toContain(view.escalation)
      expect((ctx.artifacts.get(view.digest!)!.body as DigestBody).claims.map((c) => c.id)).toEqual(['C1', 'C2'])
    }, '1.1'),

    scenario('gives-up-after-one-escalation', 'gives up after one escalation, never asking a tier above standard: a request whose claims fail the quote check on both tiers settles not-written, with why (INV-9, INV-13)', (h) => () => ({
      text: draft(h.log(), h.bench(), misquoted(h.log(), h.bench())),
    }), async ({ ctx, log, bench }) => {
      const view = await settled(ctx, await ctx.digests.request({ sources: [log, bench] }))
      expect(asked).toEqual(['economy', 'standard'])
      expect(view).toMatchObject({ state: 'not-written', claims: { kept: 0, dropped: 2 } })
      expect(view.reason).toMatch(/no claim survived the quote check.*standard/)
      escalationOf(ctx, view)
      expect(digests(ctx)).toBe(0)
      const decision = decisionOf(ctx, view)
      expect(decision.inputs).toContain(view.escalation)
      expect(decision.outcome.detail.reason).toMatch(/standard/)
    }, '1.1'),

    scenario('escalates-only-on-the-quote-check', 'does not escalate an answer that gives no digest for another reason than the quote check (no JSON, no claim): it settles not-written on the economy answer alone', () => () => ({ text: 'I could not read the artifacts.' }), async ({ ctx, log }) => {
      const view = await settled(ctx, await ctx.digests.request({ sources: [log] }))
      expect(asked).toEqual(['economy'])
      expect(view).toMatchObject({ state: 'not-written' })
      expect(view.escalation).toBeUndefined()
    }, '1.1'),

    scenario('checks-before-recording', 'runs a request\'s check on the request as it would return it before it is recorded: one that throws records nothing, takes no key, and asks no Worker, and its error is the call\'s; one that passes saw what the call returned (INV-2, INV-14)', (h) => () => ({ text: draft(h.log(), h.bench()) }), async ({ ctx, log, bench }) => {
      const decisions = ctx.artifacts.list({ kind: 'decision', limit: 1000 }).length
      const seen: DigestView[] = []
      const defect = new Error('the output its schema refuses')
      const refused = ctx.digests.request({ sources: [log, bench], key: 'k-checked', check: (view) => {
        seen.push(view)
        throw defect
      } })
      await expect(refused).rejects.toBe(defect)
      expect(seen).toEqual([expect.objectContaining({ state: 'pending', sources: [log, bench] })])
      expect(await ctx.digests.get(seen[0]!.requestId)).toBeUndefined()
      expect(asked).toEqual([])
      expect(ctx.artifacts.list({ kind: 'decision', limit: 1000 })).toHaveLength(decisions)
      // The key was not taken: the same key now makes the request, and a check that passes saw what came back.
      const passed: DigestView[] = []
      const made = await ctx.digests.request({ sources: [log, bench], key: 'k-checked', check: (view) => passed.push(view) })
      expect(passed).toHaveLength(1)
      expect(passed[0]!.requestId).toBe(made.requestId)
      expect(made.requestId).not.toBe(seen[0]!.requestId)
      // Asked again under its key, the check sees the request the key names, and refuses that call alone.
      await expect(ctx.digests.request({ sources: [log, bench], key: 'k-checked', check: (view) => {
        expect(view.requestId).toBe(made.requestId)
        throw defect
      } })).rejects.toBe(defect)
      expect((await settled(ctx, made)).state).toBe('written')
    }, '1.2'),
  ],
})

/**
 * The seam's fake provider: requests in memory, each settled at once by asking `drafter` (no
 * drafter: no Worker), then the same quote check, escalation, and settlement decision as any
 * provider: an economy answer whose every claim failed is asked once more of the standard tier.
 */
export class FakeDigests extends Digests {
  static inject = ['artifacts']
  private readonly requests = new Map<string, DigestView>()
  private readonly keys = new Map<string, { id: string; sources: string }>()

  constructor(ctx: Context, private readonly config: { drafter?: Drafter } = {}) {
    super(ctx)
  }

  async request(input: DigestRequest): Promise<DigestView> {
    const sources = [...input.sources]
    if (!sources.length || sources.length > 64 || new Set(sources).size !== sources.length) throw new DigestError('invalid', 'a request digests 1 to 64 distinct artifacts')
    for (const ref of sources) {
      if (!/^sha256:[0-9a-f]{64}$/.test(ref) || !this.ctx.artifacts.get(ref)) throw new DigestError('invalid', `${String(ref).slice(0, 80)} is not a stored artifact`)
    }
    if (input.key !== undefined) {
      const known = this.keys.get(input.key)
      if (known && known.sources !== JSON.stringify(sources)) throw new DigestError('invalid', `key ${input.key} was used for other sources`)
      if (known) return checkedRequest(input, this.requests.get(known.id)!)
    }
    const at = new Date().toISOString()
    const requestId = `dig-${randomBytes(12).toString('hex')}`
    // Seen as it is recorded, pending, before anything is: a check that throws leaves no trace (1.2).
    checkedRequest(input, { requestId, state: 'pending', sources, createdAt: at, updatedAt: at })
    if (input.key !== undefined) this.keys.set(input.key, { id: requestId, sources: JSON.stringify(sources) })
    const answer = this.config.drafter?.(sources, 'economy')
    const settle = (view: Omit<DigestView, 'requestId' | 'sources' | 'createdAt' | 'updatedAt'>): DigestView => {
      const done: DigestView = { requestId, sources, ...view, createdAt: at, updatedAt: new Date().toISOString() }
      this.requests.set(requestId, done)
      return done
    }
    const record = (decision: SettlementDecision | EscalationDecision): ArtifactRef => this.ctx.artifacts.recordDecision(decision, { producer: { type: 'system', ref: 'digests' } }).id as ArtifactRef
    if (!answer || 'fail' in answer) {
      const reason = answer ? `the digest Worker's run failed (${answer.fail})` : 'no Worker can serve a digest (none is admitted)'
      return settle({ state: 'bypassed', reason, decision: record(settlement({ requestId, sources }, { state: 'bypassed', reason })) })
    }
    const answerOf = (text: string): ArtifactRef => this.ctx.artifacts.put({
      kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'public', producer: { type: 'worker', ref: 'fake' },
      body: { schema: 'provider-answer@1.0', provider: 'fake', account: 'fake', turnId: `${requestId}-${randomBytes(4).toString('hex')}`, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text },
    }).id as ArtifactRef
    const checkOf = (text: string): QuoteCheck => quoteCheck(extractJson(text), sources, (ref) => this.ctx.artifacts.get(ref))
    let check = checkOf(answer.text)
    let inputs: ArtifactRef[] = [answerOf(answer.text)]
    let escalated: ArtifactRef | undefined
    let reason = check.reason
    const decided = escalation({ requestId, sources, tier: 'economy', escalated: false }, check, inputs[0]!)
    if (decided) {
      escalated = record(decided)
      const again = this.config.drafter!(sources, ESCALATION_TIER)
      if ('fail' in again) {
        reason = `${check.reason}; the escalation to ${ESCALATION_TIER} failed (${again.fail}), so the economy answer stands`
        inputs = [...inputs, escalated]
      } else {
        check = checkOf(again.text)
        inputs = [answerOf(again.text), escalated]
        reason = check.digest ? undefined : `${check.reason}, on ${ESCALATION_TIER} too, after one escalation: given up`
      }
    }
    const claims = { kept: check.kept, dropped: check.dropped.length }
    const more = escalated ? { escalation: escalated } : {}
    if (!check.digest) {
      return settle({ state: 'not-written', reason: reason!, claims, ...more, decision: record(settlement({ requestId, sources }, { state: 'not-written', check, reason: reason!, inputs })) })
    }
    const digest = this.ctx.artifacts.put({ kind: 'report', bodySchema: 'digest@1.0', body: check.digest, inputs: sources, classification: 'public', producer: { type: 'worker', ref: 'fake' } }).id as ArtifactRef
    return settle({ state: 'written', digest, claims, ...more, decision: record(settlement({ requestId, sources }, { state: 'written', check, inputs: [...inputs, digest] })) })
  }

  async get(requestId: string): Promise<DigestView | undefined> {
    return this.requests.get(requestId)
  }

  async wait(requestId: string): Promise<DigestView> {
    const view = this.requests.get(requestId)
    if (!view) throw new DigestError('unknown-request', `no digest request ${requestId}`)
    return view
  }
}

