/**
 * Conformance suite for `ctx.artifacts` (ADR-0013, ADR-0037; docs/design/artifacts.md, and the
 * semantics of `artifact-envelope` and `decision` in docs/reference/schemas.md). It holds a
 * provider to the documented contract through the public `ctx.artifacts` API only.
 *
 * `boot` returns a context that provides `ctx.artifacts` over `ctx.store`, empty, with the
 * provider configured as {@link CONFIG}. Collection's roots are documented as rows of any store
 * table, so the collection scenarios keep ids in a table of their own, as an owning plugin does.
 */
import type { Context } from '@deepseek-ai/cordis'
import { contentId, SchemaRegistry } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'
import { expect } from 'vitest'
import { defineSuite, type Scenario } from '../../../libs/conformance/runner.ts'
import type { Classification, Decision, Envelope, ExplainNode, NewArtifact } from '../src/index.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

/** The configuration every provider under test is booted with. */
export const CONFIG = { explainDepth: 3, explainBudget: 6, collectGraceHours: 24, collectBatch: 2 } as const

type Ref = Envelope['id']
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const schemas = new SchemaRegistry()
const worker = { type: 'worker', ref: 'site-a/account-a' } as const
const policy = { type: 'policy', ref: 'routing.default' } as const

/** A website answer: a `report` whose body has a `text`. */
const answer = (text: string, extra: Partial<NewArtifact> = {}): NewArtifact => ({
  kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'public', producer: worker,
  body: { schema: 'provider-answer@1.0', provider: 'site-a', account: 'account-a', turnId: 'turn_1', conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text },
  ...extra,
})

/** A route decision with one selected candidate equal to its outcome. */
const route = (question: string, inputs: Ref[] = []): Omit<Decision, 'schema'> => ({
  decisionType: 'route', question, inputs,
  candidates: [
    { option: 'worker:a', selected: true, reasons: ['capabilities proven'] },
    { option: 'worker:b', selected: false, reasons: ['reauth-required'] },
  ],
  decider: { type: 'policy', id: 'routing.default', version: '1' },
  outcome: { option: 'worker:a' },
  deterministic: true,
})

const refused = (call: () => unknown): boolean => {
  try {
    call()
    return false
  } catch {
    return true
  }
}

/** The documented id: sha256 of the canonical JSON of the envelope's content fields (docs/reference/schemas.md#artifact-envelope). */
const documentedId = (e: Envelope): string => contentId({
  kind: e.kind, bodySchema: e.bodySchema, body: e.body, blob: e.blob && { ref: e.blob.ref, mediaType: e.blob.mediaType }, inputs: e.inputs, lineage: e.lineage, subject: e.subject,
})

/** Every distinct id in an explain tree, and its depth from the root (the shallowest one). */
const walk = (root: ExplainNode): Map<string, number> => {
  const depth = new Map<string, number>()
  const visit = (node: ExplainNode, at: number): void => {
    if ((depth.get(node.id) ?? Infinity) <= at) return
    depth.set(node.id, at)
    for (const input of node.inputs) visit(input, at + 1)
  }
  visit(root, 0)
  return depth
}

/** A table of an owning plugin that keeps ids in its rows (a collection root). */
const ownerRows = (ctx: Context, ...values: string[]): void => {
  ctx.store.db.exec('CREATE TABLE IF NOT EXISTS conformance_owner (value TEXT)')
  const insert = ctx.store.db.prepare('INSERT INTO conformance_owner (value) VALUES (?)')
  for (const value of values) insert.run(value)
}

const scenario = (id: string, title: string, run: (ctx: Context) => Promise<void>, since: Scenario<Boot>['since'] = '1.0'): Scenario<Boot> => ({
  id: `artifacts.${id}`, since, title,
  run: async (boot) => {
    const { ctx, dispose } = await boot()
    try {
      await run(ctx)
    } finally {
      await dispose()
    }
  },
})

export const artifactsSuite = defineSuite<Boot>({
  seam: 'artifacts',
  contract: '1.1',
  scenarios: [
    scenario('id-from-content', 'computes the id from the canonical content alone, never trusting the producer\'s id or time (REQ-ART-2)', async (ctx) => {
      const forged = `sha256:${'f'.repeat(64)}`
      const stored = ctx.artifacts.put({ ...answer('one'), id: forged, createdAt: '2000-01-01T00:00:00.000Z' } as NewArtifact)
      expect(stored.id).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(stored.id).not.toBe(forged)
      expect(stored.id).toBe(documentedId(stored))
      expect(stored.createdAt).not.toBe('2000-01-01T00:00:00.000Z')
      expect(ctx.artifacts.get(forged)).toBeUndefined()
      // Each content field changes the id; a subject is part of it too.
      const subject = { type: 'git-head', ref: 'repo', version: 'abc123' } as const
      const others = [answer('two'), answer('one', { kind: 'finding' }), answer('one', { subject }), answer('one', { inputs: [stored.id] })].map((a) => ctx.artifacts.put(a))
      for (const other of others) expect(other.id).toBe(documentedId(other))
      expect(new Set([stored.id, ...others.map((o) => o.id)]).size).toBe(5)
      // A blob ref is content by its ref and media type; its byte count is not.
      const blob = (bytes: number) => ({ kind: 'evidence', bodySchema: 'source-snapshot@1.0', blob: { ref: `sha256:${'b'.repeat(64)}`, bytes, mediaType: 'text/plain' }, classification: 'public', producer: worker }) as NewArtifact
      const big = ctx.artifacts.put(blob(10))
      expect(big.id).toBe(documentedId(big))
      expect(ctx.artifacts.put(blob(20)).id).toBe(big.id)
    }),
    scenario('dedup', 'stores identical content once, whoever produced it and in whichever run, and lists it under every run that produced it (REQ-ART-2)', async (ctx) => {
      const first = ctx.artifacts.put(answer('same', { runId: 'run-1', nodeId: 'n1' }))
      const again = ctx.artifacts.put(answer('same', { producer: { type: 'node', ref: 'other' }, runId: 'run-2', nodeId: 'n2' }))
      expect(again).toEqual(first)
      expect(ctx.artifacts.list({ kind: 'report' }).map((e) => e.id)).toEqual([first.id])
      expect(ctx.artifacts.list({ runId: 'run-1' }).map((e) => e.id)).toEqual([first.id])
      expect(ctx.artifacts.list({ runId: 'run-2', nodeId: 'n2' }).map((e) => e.id)).toEqual([first.id])
      // Inputs are a set: deduplicated, sorted, and their order never changes the id.
      const [a, b] = [ctx.artifacts.put(answer('a')).id, ctx.artifacts.put(answer('b')).id]
      const ab = ctx.artifacts.put(answer('derived', { inputs: [a, b] }))
      const ba = ctx.artifacts.put(answer('derived', { inputs: [b, a, b] }))
      expect(ba.id).toBe(ab.id)
      expect(ab.inputs).toEqual([a, b].sort())
    }),
    scenario('schema-validated', 'validates the body against its bodySchema and the envelope against artifact-envelope@1.0, and refuses an invalid one, storing nothing (INV-14)', async (ctx) => {
      const stored = ctx.artifacts.put(answer('valid'))
      schemas.assertRecord(stored)
      expect(stored).toMatchObject({ schema: 'artifact-envelope@1.0', classification: 'public', producer: worker, inputs: [], lineage: {} })
      const body = answer('x').body as Record<string, unknown>
      const invalid: NewArtifact[] = [
        answer('x', { body: { ...body, text: 42 } }), // the body does not match its schema
        answer('x', { body: { ...body, extra: true } }),
        answer('x', { bodySchema: 'provider-answer@2.0' }), // an unknown major
        answer('x', { bodySchema: 'no-such-schema@1.0' }),
        answer('x', { kind: 'no-such-kind' as NewArtifact['kind'] }),
        { ...answer('x'), blob: { ref: `sha256:${'b'.repeat(64)}`, bytes: 1, mediaType: 'text/plain' } }, // both body and blob
        { kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'public', producer: worker }, // neither
      ]
      for (const artifact of invalid) expect(refused(() => ctx.artifacts.put(artifact)), JSON.stringify(artifact).slice(0, 120)).toBe(true)
      expect(ctx.artifacts.list().map((e) => e.id)).toEqual([stored.id])
    }),
    scenario('classification-floor', 'classifies a derived artifact at least as its strictest input or lineage reference, and refuses an unknown reference (INV-12, INV-2)', async (ctx) => {
      const secret = ctx.artifacts.put(answer('secret', { classification: 'local-private' }))
      const shared = ctx.artifacts.put(answer('shared', { classification: 'operator-shared' }))
      const open = ctx.artifacts.put(answer('open'))
      expect(ctx.artifacts.put(answer('from inputs', { inputs: [open.id, secret.id] })).classification).toBe('local-private')
      expect(ctx.artifacts.put(answer('supersedes', { lineage: { supersedes: [shared.id] } })).classification).toBe('operator-shared')
      expect(ctx.artifacts.put(answer('invalidates', { lineage: { invalidates: [secret.id] } })).classification).toBe('local-private')
      expect(ctx.artifacts.recordDecision(route('derived', [secret.id]), { producer: policy, classification: 'public' }).classification).toBe('local-private')
      // A request stricter than its inputs keeps its own classification.
      expect(ctx.artifacts.put(answer('stricter', { classification: 'local-private', inputs: [open.id] })).classification).toBe('local-private')
      const before = ctx.artifacts.list({ limit: 1000 }).length
      const unknown = `sha256:${'9'.repeat(64)}` as Ref
      for (const extra of [{ inputs: [unknown] }, { lineage: { supersedes: [unknown] } }, { lineage: { invalidates: [unknown] } }]) {
        expect(refused(() => ctx.artifacts.put(answer('dangling', extra))), JSON.stringify(extra)).toBe(true)
      }
      expect(refused(() => ctx.artifacts.recordDecision(route('dangling', [unknown]), { producer: policy }))).toBe(true)
      expect(ctx.artifacts.list({ limit: 1000 })).toHaveLength(before)
    }),
    scenario('no-downgrade', 'never downgrades a stored artifact\'s classification, and refuses deduplication that would need a stricter one (INV-12)', async (ctx) => {
      const order: Classification[] = ['public', 'operator-shared', 'local-private']
      for (const [i, stored] of order.entries()) {
        const first = ctx.artifacts.put(answer(`text ${i}`, { classification: stored }))
        for (const requested of order) {
          const call = () => ctx.artifacts.put(answer(`text ${i}`, { classification: requested }))
          if (order.indexOf(requested) > i) expect(refused(call), `${stored} then ${requested}`).toBe(true)
          else expect(call().classification, `${stored} then ${requested}`).toBe(stored)
        }
        expect(ctx.artifacts.get(first.id)?.classification).toBe(stored)
      }
    }),
    scenario('decision-outcome', 'records a decision only when exactly one candidate is selected and it equals the outcome, operator-shared by default (INV-13, REQ-ART-1)', async (ctx) => {
      const base = route('Which Worker runs research:1?')
      const recorded = ctx.artifacts.recordDecision(base, { producer: policy, runId: 'run-1', nodeId: 'research:1' })
      expect(recorded).toMatchObject({ kind: 'decision', classification: 'operator-shared', producer: policy, runId: 'run-1', nodeId: 'research:1' })
      const body = recorded.body as Decision
      schemas.assertRecord(body)
      expect(recorded.bodySchema).toBe(body.schema)
      expect(body).toMatchObject({ decisionType: 'route', outcome: { option: 'worker:a' }, candidates: base.candidates, decider: base.decider })
      expect(ctx.artifacts.get(recorded.id)).toEqual(recorded)
      const wrong: Array<Omit<Decision, 'schema'> & { schema?: Decision['schema'] }> = [
        { ...base, outcome: { option: 'worker:b' } }, // the selected candidate is not the outcome
        { ...base, candidates: base.candidates.map((c) => ({ ...c, selected: false })) }, // none selected
        { ...base, candidates: base.candidates.map((c) => ({ ...c, selected: true })) }, // two selected
        { ...base, outcome: { option: 'worker:c' } }, // an outcome no candidate offers
        { ...base, candidates: [] },
        { ...base, decider: { type: 'model', id: 'decision-model', version: '1' }, modelAnswers: [{}] }, // a model decision is never deterministic
        { ...base, schema: 'decision@1.0', decisionType: 'autonomy' }, // a type of a later minor needs that minor
      ]
      for (const decision of wrong) expect(refused(() => ctx.artifacts.recordDecision(decision, { producer: policy })), JSON.stringify(decision).slice(0, 160)).toBe(true)
      expect(ctx.artifacts.list({ kind: 'decision' }).map((e) => e.id)).toEqual([recorded.id])
      // Its inputs are a set too.
      const [a, b] = [ctx.artifacts.put(answer('a')).id, ctx.artifacts.put(answer('b')).id]
      const ab = ctx.artifacts.recordDecision(route('with inputs', [a, b]), { producer: policy })
      const ba = ctx.artifacts.recordDecision(route('with inputs', [b, a]), { producer: policy })
      expect(ba.id).toBe(ab.id)
      expect((ab.body as Decision).inputs).toEqual([a, b].sort())
      expect(ab.inputs).toEqual([a, b].sort())
    }),
    scenario('decision-reasons', 'refuses a decision with a candidate that gives no reason: every rejected candidate says why it lost, and the selected one why it won, not only the winner (INV-13)', async (ctx) => {
      const base = route('Which Worker runs research:2?')
      const without = (option: string, reasons: string[]) => ({ ...base, candidates: base.candidates.map((c) => (c.option === option ? { ...c, reasons } : c)) })
      const wrong = [
        without('worker:b', []), // a rejected candidate without a reason
        without('worker:b', ['', '  ']), // only blank reasons
        without('worker:a', []), // the selected candidate without a reason
        { ...base, candidates: [...base.candidates, { option: 'worker:c', selected: false, reasons: [] }] },
      ]
      for (const decision of wrong) expect(refused(() => ctx.artifacts.recordDecision(decision, { producer: policy })), JSON.stringify(decision.candidates)).toBe(true)
      expect(ctx.artifacts.list({ kind: 'decision' })).toEqual([])
      // With a reason on every candidate it is recorded, the reasons as given.
      const body = ctx.artifacts.recordDecision(base, { producer: policy }).body as Decision
      expect(body.candidates).toEqual(base.candidates)
    }),
    scenario('decision-prose-clamped', 'clamps a decision\'s question (500), reasons (300), and rationale (1000) to whole characters ending in an ellipsis, so long prose never fails its decision (INV-13, INV-9)', async (ctx) => {
      // The 300th character of the reason is an emoji (a surrogate pair): it is never split.
      const reason = `${'r'.repeat(298)}😀😀 and more`
      const base = route('short')
      const long = {
        ...base, question: `q${'?'.repeat(600)}`, rationale: 'x'.repeat(1200),
        candidates: base.candidates.map((c) => ({ ...c, reasons: [reason, ...c.reasons] })),
      }
      const body = ctx.artifacts.recordDecision(long, { producer: policy }).body as Decision
      schemas.assertRecord(body)
      expect([...body.question]).toHaveLength(500)
      expect(body.question).toBe(`q${'?'.repeat(498)}…`)
      expect(body.rationale).toBe(`${'x'.repeat(999)}…`)
      expect(body.candidates[0]!.reasons[0]).toBe(`${'r'.repeat(298)}😀…`)
      expect(body.candidates[0]!.reasons[1]).toBe('capabilities proven')
      // Prose within its bounds is kept as given.
      const exact = { ...base, question: 'q'.repeat(500), rationale: 'x'.repeat(1000) }
      expect(ctx.artifacts.recordDecision(exact, { producer: policy }).body).toMatchObject({ question: exact.question, rationale: exact.rationale, candidates: base.candidates })
    }),
    scenario('immutable', 'never changes a stored artifact: a repeat, a stricter or laxer request, or a change to a returned object leaves it as stored, and a correction is a new artifact (REQ-ART-2)', async (ctx) => {
      const input = answer('original', { classification: 'operator-shared', runId: 'run-1' })
      const stored = ctx.artifacts.put(input)
      const snapshot = structuredClone(stored)
      ;(input.body as { text: string }).text = 'changed after put'
      ;(stored.body as { text: string }).text = 'changed on the returned envelope'
      stored.inputs.push(`sha256:${'1'.repeat(64)}`)
      const read = ctx.artifacts.get(snapshot.id)!
      ;(read.body as { text: string }).text = 'changed on a read'
      ctx.artifacts.put(answer('original', { classification: 'public', producer: { type: 'operator', ref: 'operator' }, runId: 'run-2' }))
      expect(ctx.artifacts.get(snapshot.id)).toEqual(snapshot)
      // A correction supersedes the original, which stays as it was.
      const correction = ctx.artifacts.put(answer('corrected', { lineage: { supersedes: [snapshot.id] } }))
      expect(correction.id).not.toBe(snapshot.id)
      expect(correction.lineage).toEqual({ supersedes: [snapshot.id] })
      expect(ctx.artifacts.get(snapshot.id)).toEqual(snapshot)
    }),
    scenario('list-filters', 'lists artifacts by kind, decision type, run, and node, within a limit (INV-9)', async (ctx) => {
      const report = ctx.artifacts.put(answer('r', { runId: 'run-1', nodeId: 'n1' }))
      const finding = ctx.artifacts.put(answer('f', { kind: 'finding', runId: 'run-1', nodeId: 'n2' }))
      const routed = ctx.artifacts.recordDecision(route('route?'), { producer: policy, runId: 'run-2', nodeId: 'n1' })
      const tier = ctx.artifacts.recordDecision({ ...route('tier?'), decisionType: 'tier', candidates: [{ option: 'frontier', selected: true, reasons: ['lowest admitted tier'] }], outcome: { option: 'frontier' } }, { producer: policy, runId: 'run-1', nodeId: 'n1' })
      const ids = (filter: Parameters<Context['artifacts']['list']>[0]) => ctx.artifacts.list(filter).map((e) => e.id).sort()
      expect(ids({})).toEqual([report.id, finding.id, routed.id, tier.id].sort())
      expect(ids({ kind: 'finding' })).toEqual([finding.id])
      expect(ids({ kind: 'decision' })).toEqual([routed.id, tier.id].sort())
      expect(ids({ decisionType: 'tier' })).toEqual([tier.id])
      expect(ids({ runId: 'run-1' })).toEqual([report.id, finding.id, tier.id].sort())
      expect(ids({ runId: 'run-1', nodeId: 'n1' })).toEqual([report.id, tier.id].sort())
      expect(ids({ nodeId: 'n1', kind: 'decision' })).toEqual([routed.id, tier.id].sort())
      expect(ids({ runId: 'run-3' })).toEqual([])
      expect(ctx.artifacts.list({ limit: 2 })).toHaveLength(2)
    }),
    scenario('list-newest', 'lists newest first on asking, the latest within the limit: the exact reverse of the stored order (INV-9)', async (ctx) => {
      const stored = []
      for (const text of ['first', 'second', 'third']) {
        stored.push(ctx.artifacts.put(answer(text, { runId: 'run-1' })).id)
        // A later millisecond: stored later reads as newer.
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(ctx.artifacts.list({ runId: 'run-1' }).map((e) => e.id)).toEqual(stored)
      expect(ctx.artifacts.list({ runId: 'run-1', newest: true }).map((e) => e.id)).toEqual([...stored].reverse())
      expect(ctx.artifacts.list({ runId: 'run-1', newest: true, limit: 2 }).map((e) => e.id)).toEqual([stored[2], stored[1]])
      expect(ctx.artifacts.list({ kind: 'report', newest: false, limit: 1 }).map((e) => e.id)).toEqual([stored[0]])
    }, '1.1'),
    scenario('read-window', 'reads an artifact\'s header and a window of its text, else its JSON, in whole characters within bounds, and refuses anything but a content id (INV-9, INV-12)', async (ctx) => {
      const stored = ctx.artifacts.put(answer('a😀b😀c', { classification: 'local-private', runId: 'run-1', nodeId: 'review:1' }))
      expect(ctx.artifacts.read(stored.id)).toMatchObject({
        id: stored.id, state: 'stored', kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'local-private', producer: worker,
        runId: 'run-1', nodeId: 'review:1', createdAt: stored.createdAt, inputs: [], content: 'text', chars: 5, offset: 0, truncated: false, text: 'a😀b😀c',
      })
      expect(ctx.artifacts.read(stored.id, { offset: 1, max: 1 })).toMatchObject({ chars: 5, offset: 1, truncated: true, text: '😀' })
      expect(ctx.artifacts.read(stored.id, { offset: 3, max: 10 })).toMatchObject({ offset: 3, truncated: false, text: '😀c' })
      expect(ctx.artifacts.read(stored.id, { offset: 99 })).toMatchObject({ chars: 5, truncated: false, text: '' })
      // The default window is 20,000 characters.
      const long = ctx.artifacts.put(answer('y'.repeat(25_000)))
      expect(ctx.artifacts.read(long.id)).toMatchObject({ chars: 25_000, offset: 0, truncated: true, text: 'y'.repeat(20_000) })
      expect(ctx.artifacts.read(long.id, { max: 200_000 })).toMatchObject({ truncated: false, text: 'y'.repeat(25_000) })
      // A body with no text reads as its JSON.
      const decision = ctx.artifacts.recordDecision(route('json?'), { producer: policy })
      const json = ctx.artifacts.read(decision.id)
      expect(json).toMatchObject({ state: 'stored', kind: 'decision', content: 'json', truncated: false })
      expect(JSON.parse((json as { text: string }).text)).toEqual(decision.body)
      for (const window of [{ max: 0 }, { max: 200_001 }, { offset: -1 }, { offset: 1.5 }]) expect(refused(() => ctx.artifacts.read(stored.id, window)), JSON.stringify(window)).toBe(true)
      for (const id of ['run_1', `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(64)}%`, ` sha256:${'a'.repeat(64)}`]) {
        expect(refused(() => ctx.artifacts.read(id)), id).toBe(true)
      }
      const none = `sha256:${'a'.repeat(64)}`
      expect(ctx.artifacts.read(none)).toMatchObject({ id: none, state: 'unknown' })
    }),
    scenario('explain-bounded', 'explains an artifact by walking its inputs, each shared ancestor once, within explainDepth and explainBudget (REQ-ART-3, INV-9)', async (ctx) => {
      // A chain longer than explainDepth (3): root <- c1 <- c2 <- c3 <- c4.
      let chain: Ref[] = [ctx.artifacts.put(answer('root')).id]
      for (let i = 1; i <= 4; i++) chain = [...chain, ctx.artifacts.put(answer(`c${i}`, { inputs: [chain.at(-1)!] })).id]
      const deep = walk(ctx.artifacts.explain(chain.at(-1)!)!)
      expect([...deep.keys()]).toEqual([...chain].reverse().slice(0, CONFIG.explainDepth + 1))
      expect(Math.max(...deep.values())).toBe(CONFIG.explainDepth)
      // A diamond: shared ancestors are visited once.
      const base = ctx.artifacts.put(answer('base')).id
      const left = ctx.artifacts.put(answer('left', { inputs: [base] })).id
      const right = ctx.artifacts.put(answer('right', { inputs: [base] })).id
      const top = ctx.artifacts.recordDecision(route('diamond', [left, right]), { producer: policy })
      const tree = ctx.artifacts.explain(top.id)!
      expect(tree).toMatchObject({ id: top.id, kind: 'decision' })
      expect([...walk(tree).keys()].sort()).toEqual([top.id, left, right, base].sort())
      expect(tree.inputs.map((n) => n.id).sort()).toEqual([left, right].sort())
      // Wider than explainBudget (6): at most 6 distinct artifacts.
      const wide = Array.from({ length: 10 }, (_, i) => ctx.artifacts.put(answer(`leaf ${i}`)).id)
      const visited = walk(ctx.artifacts.explain(ctx.artifacts.put(answer('wide', { inputs: wide })).id)!)
      expect(visited.size).toBeGreaterThan(1)
      expect(visited.size).toBeLessThanOrEqual(CONFIG.explainBudget)
      expect(ctx.artifacts.explain(`sha256:${'c'.repeat(64)}`)).toBeUndefined()
    }),
    scenario('collect-retention', 'collects only artifacts past collectGraceHours that no store row reaches through inputs or lineage and no remaining run links, and reads a collected one still named as expired (INV-9, REQ-ART-3)', async (ctx) => {
      const parent = ctx.artifacts.put(answer('reached through an input')).id
      const superseded = ctx.artifacts.put(answer('reached through lineage')).id
      const kept = ctx.artifacts.put(answer('kept by a row', { inputs: [parent], lineage: { supersedes: [superseded] } })).id
      const live = ctx.artifacts.put(answer('of a run that still exists', { runId: 'run-live' })).id
      const gone = ctx.artifacts.put(answer('of a run that is gone', { runId: 'run-gone' })).id
      const orphan = ctx.artifacts.put(answer('referenced by nothing')).id
      // Named in another artifact's body only: not a reference that keeps it.
      const named = ctx.artifacts.put(answer('named in a body only')).id
      const naming = ctx.artifacts.recordDecision({ ...route('acceptance?'), decisionType: 'acceptance', candidates: [{ option: 'accepted', selected: true, reasons: ['every check passed'] }], outcome: { option: 'accepted', detail: { result: named } } }, { producer: policy })
      ownerRows(ctx, JSON.stringify({ result: kept }), 'run-live', naming.id)
      // Inside the grace period nothing goes, referenced or not.
      expect((await ctx.artifacts.collect()).removed).toBe(0)
      expect(ctx.artifacts.list({ limit: 1000 })).toHaveLength(8)
      const pass = await ctx.artifacts.collect(Date.now() + CONFIG.collectGraceHours * HOUR + DAY)
      expect(pass.removed).toBe(3)
      for (const id of [parent, superseded, kept, live, naming.id]) expect(ctx.artifacts.get(id), id).toBeDefined()
      for (const id of [gone, orphan, named]) expect(ctx.artifacts.get(id), id).toBeUndefined()
      expect((await ctx.artifacts.collect(Date.now() + 2 * CONFIG.collectGraceHours * HOUR)).removed).toBe(0)
      expect(ctx.artifacts.read(named)).toMatchObject({ id: named, state: 'expired', referencedBy: { id: naming.id, kind: 'decision', createdAt: naming.createdAt } })
      expect(ctx.artifacts.read(orphan)).toMatchObject({ id: orphan, state: 'unknown' })
    }),
    scenario('collect-keeps-referenced', 'never collects an artifact while a stored artifact references it through its inputs or lineage, whatever keeps that one (REQ-ART-3)', async (ctx) => {
      // Kept by a run that still exists: its input and the artifact it supersedes stay with it.
      const input = ctx.artifacts.put(answer('input of a run\'s artifact')).id
      const old = ctx.artifacts.put(answer('superseded by a run\'s artifact')).id
      const ofRun = ctx.artifacts.put(answer('of a live run', { runId: 'run-live', inputs: [input], lineage: { supersedes: [old] } })).id
      ownerRows(ctx, 'run-live')
      // Kept by the grace period: an artifact recorded now on an old input keeps that input.
      const oldInput = ctx.artifacts.put(answer('an old input')).id
      await new Promise((resolve) => setTimeout(resolve, 20))
      const recent = ctx.artifacts.put(answer('recorded on it, not yet referenced', { inputs: [oldInput] }))
      // Collect when `recent` is just inside the grace period and everything before it is past it.
      await ctx.artifacts.collect(Date.parse(recent.createdAt) + CONFIG.collectGraceHours * HOUR - 5)
      expect(ctx.artifacts.get(recent.id)).toBeDefined()
      expect(ctx.artifacts.get(ofRun)).toBeDefined()
      for (const id of [input, old, oldInput]) expect(ctx.artifacts.get(id), id).toBeDefined()
      for (const id of [ofRun, recent.id]) expect(ctx.artifacts.explain(id)!.inputs.every((n) => n.kind !== 'expired')).toBe(true)
    }),
  ],
})
