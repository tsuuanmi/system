import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import Artifacts, { type Decision } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot(): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'system-artifacts-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const store = ctx.plugin(Store, { path: join(dir, 'system.db') })
  const artifacts = ctx.plugin(Artifacts, {})
  await Promise.all([store, artifacts])
  cleanups.push(() => store.dispose())
  return ctx
}

const route: Omit<Decision, 'schema'> = {
  decisionType: 'route',
  question: 'Which Worker runs research:1?',
  inputs: [],
  candidates: [
    { option: 'worker:chatgpt-main/deep-research', selected: true, reasons: ['capabilities proven'] },
    { option: 'worker:chatgpt-2/deep-research', selected: false, reasons: ['reauth-required'] },
  ],
  decider: { type: 'policy', id: 'routing.default', version: '1' },
  outcome: { option: 'worker:chatgpt-main/deep-research' },
  deterministic: true,
}
const producer = { type: 'policy', ref: 'routing.default' } as const

describe('ctx.artifacts', () => {
  it('stores a decision with a computed content id and deduplicates identical content (REQ-ART-2)', async () => {
    const ctx = await boot()
    const first = ctx.artifacts.recordDecision(route, { producer, runId: 'run-1', nodeId: 'research:1' })
    expect(first.id).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(ctx.artifacts.recordDecision(route, { producer, runId: 'run-1', nodeId: 'research:1' }).id).toBe(first.id)
    expect(ctx.artifacts.list({ decisionType: 'route' })).toHaveLength(1)
  })

  it('clamps a decision\'s prose to its schema bounds on whole characters, marked, so a long reason never fails the decision (INV-13)', async () => {
    const ctx = await boot()
    // A reason whose 300th character is a surrogate pair (an emoji) must not be split.
    const reason = `${'r'.repeat(298)}😀😀 and more`
    const long = { ...route, question: `q${'?'.repeat(600)}`, rationale: 'x'.repeat(1200), candidates: route.candidates.map((c) => ({ ...c, reasons: [reason, ...c.reasons] })) }
    const body = ctx.artifacts.recordDecision(long, { producer }).body as { question: string; rationale: string; candidates: Array<{ reasons: string[] }> }
    const stored = body.candidates[0]!.reasons[0]!
    expect([...stored]).toHaveLength(300)
    expect(stored).toBe(`${'r'.repeat(298)}😀…`)
    expect([...body.question]).toHaveLength(500)
    expect([...body.rationale]).toHaveLength(1000)
    expect(body.question.endsWith('…')).toBe(true)
    // Short prose is untouched.
    expect(ctx.artifacts.recordDecision(route, { producer }).body).toMatchObject({ candidates: route.candidates })
  })

  it('rejects a decision whose selected candidate differs from the outcome', async () => {
    const ctx = await boot()
    expect(() => ctx.artifacts.recordDecision({ ...route, outcome: { option: 'worker:chatgpt-2/deep-research' } }, { producer })).toThrow(/outcome/)
  })

  it('rejects a body that does not match its schema (INV-14)', async () => {
    const ctx = await boot()
    expect(() => ctx.artifacts.recordDecision({ ...route, candidates: [] }, { producer })).toThrow(/decision@1.0/)
  })

  it('never classifies a derived artifact below its strictest input', async () => {
    const ctx = await boot()
    const secret = ctx.artifacts.recordDecision(route, { producer, classification: 'local-private' })
    const derived = ctx.artifacts.recordDecision({ ...route, inputs: [secret.id], question: 'derived' }, { producer, classification: 'public' })
    expect(derived.classification).toBe('local-private')
  })

  it('explains the decision chain behind an artifact', async () => {
    const ctx = await boot()
    const tier = ctx.artifacts.recordDecision(
      { ...route, decisionType: 'tier', question: 'tier?', candidates: [{ option: 'frontier', selected: true, reasons: ['profile'] }], outcome: { option: 'frontier' } },
      { producer },
    )
    const routed = ctx.artifacts.recordDecision({ ...route, inputs: [tier.id] }, { producer })
    expect(ctx.artifacts.explain(routed.id)).toMatchObject({
      summary: 'route: worker:chatgpt-main/deep-research',
      inputs: [{ summary: 'tier: frontier', inputs: [] }],
    })
  })
})

describe('review fixes (PR #3 kernel review)', () => {
  const tierOf = (n: number) => ({ ...route, decisionType: 'tier', question: `q${n}`, candidates: [{ option: `t${n}`, selected: true, reasons: [] }], outcome: { option: `t${n}` } })

  it('explains a diamond-shaped graph in linear time with shared nodes', async () => {
    const ctx = await boot()
    let layer = [ctx.artifacts.recordDecision(tierOf(0), { producer }).id]
    let n = 1
    for (let depth = 0; depth < 15; depth++) {
      layer = [0, 1, 2, 3].map(() => ctx.artifacts.recordDecision({ ...tierOf(n++), inputs: layer }, { producer }).id)
    }
    const top = ctx.artifacts.recordDecision({ ...tierOf(n++), inputs: layer }, { producer })
    const started = Date.now()
    const tree = ctx.artifacts.explain(top.id)!
    expect(Date.now() - started).toBeLessThan(1000)
    const unique = new Set<string>()
    const walk = (node: { id: string; inputs: unknown[] }): void => {
      if (unique.has(node.id)) return
      unique.add(node.id)
      for (const input of node.inputs as { id: string; inputs: unknown[] }[]) walk(input)
    }
    walk(tree)
    expect(unique.size).toBe(n)
  })

  it('rejects unknown input references (the classification floor cannot fail open)', async () => {
    const ctx = await boot()
    expect(() => ctx.artifacts.recordDecision({ ...route, inputs: [`sha256:${'9'.repeat(64)}`] }, { producer })).toThrow(/unknown input/)
  })

  it('refuses to downgrade on deduplication', async () => {
    const ctx = await boot()
    ctx.artifacts.recordDecision(route, { producer, classification: 'public' })
    expect(() => ctx.artifacts.recordDecision(route, { producer, classification: 'local-private' })).toThrow(/classification/)
  })

  it('hashes the body schema and treats inputs as a set', async () => {
    const ctx = await boot()
    const a = ctx.artifacts.recordDecision(tierOf(1), { producer })
    const b = ctx.artifacts.recordDecision(tierOf(2), { producer })
    const ab = ctx.artifacts.recordDecision({ ...tierOf(3), inputs: [a.id, b.id] }, { producer })
    const ba = ctx.artifacts.recordDecision({ ...tierOf(3), inputs: [b.id, a.id] }, { producer })
    expect(ba.id).toBe(ab.id)
  })

  it('lists identical content under every run that produced it', async () => {
    const ctx = await boot()
    ctx.artifacts.recordDecision(route, { producer, runId: 'run-1' })
    ctx.artifacts.recordDecision(route, { producer, runId: 'run-2' })
    expect(ctx.artifacts.list({ runId: 'run-2' })).toHaveLength(1)
  })

  it('requires a model decider to be non-deterministic', async () => {
    const ctx = await boot()
    expect(() => ctx.artifacts.recordDecision({ ...route, decider: { type: 'model', id: 'm', version: '1' } }, { producer })).toThrow()
  })

  it('collects only what nothing retained needs: unreferenced, past the grace period, of no run that still exists (INV-9)', async () => {
    const ctx = await boot()
    const day = 24 * 60 * 60_000
    const note = (text: string, extra: { inputs?: string[]; runId?: string } = {}) => ctx.artifacts.put({
      kind: 'finding', bodySchema: 'decision@1.0', body: { ...route, question: text, schema: 'decision@1.0' }, classification: 'public', producer,
      ...(extra.inputs ? { inputs: extra.inputs as never } : {}), ...(extra.runId ? { runId: extra.runId } : {}),
    }).id
    const parent = note('a parent, reached only through an input')
    const kept = note('referenced by a retained row', { inputs: [parent] })
    const live = note('of a run that still exists', { runId: 'run-live' })
    const gone = note('of a deleted run', { runId: 'run-gone' })
    const orphan = note('referenced by nothing')
    const onlyEvents = note('referenced by an event only')
    // A plugin's own table holding ids, as workflow or turns do; and the event log, which is no root.
    ctx.store.db.exec("CREATE TABLE owner_rows (id TEXT, record TEXT); CREATE TABLE events (seq INTEGER, decision TEXT)")
    ctx.store.db.prepare('INSERT INTO owner_rows VALUES (?, ?)').run('run-live', JSON.stringify({ result: kept }))
    ctx.store.db.prepare('INSERT INTO events VALUES (1, ?)').run(onlyEvents)
    // Inside the grace period nothing goes, referenced or not.
    expect(await ctx.artifacts.collect()).toEqual({ removed: 0, kept: 6 })
    expect(await ctx.artifacts.collect(Date.now() + 2 * day)).toEqual({ removed: 3, kept: 3 })
    expect([parent, kept, live].every((id) => ctx.artifacts.get(id))).toBe(true)
    expect([gone, orphan, onlyEvents].some((id) => ctx.artifacts.get(id))).toBe(false)
  })

  it('explains a collected input as expired, keeping its id (REQ-ART-3)', async () => {
    const ctx = await boot()
    const input = ctx.artifacts.recordDecision(route, { producer })
    const child = ctx.artifacts.recordDecision({ ...route, question: 'Which Worker runs research:2?', inputs: [input.id] }, { producer })
    ctx.store.db.prepare('DELETE FROM artifacts WHERE id = ?').run(input.id)
    expect(ctx.artifacts.explain(child.id)!.inputs).toEqual([{ id: input.id, kind: 'expired', summary: 'expired: collected by retention', inputs: [] }])
  })

  it('keeps a candidate that something written after the scan names, deletes in short batches, and reads every page (INV-9)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-artifacts-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const ctx = new Context()
    const store = ctx.plugin(Store, { path: join(dir, 'system.db') })
    const artifacts = ctx.plugin(Artifacts, { collectBatch: 2 })
    await Promise.all([store, artifacts])
    cleanups.push(() => store.dispose())
    const day = 24 * 60 * 60_000
    const note = (text: string) => ctx.artifacts.recordDecision({ ...route, question: text }, { producer }).id
    const orphans = Array.from({ length: 5 }, (_, i) => note(`orphan ${i}`))
    // More rows than one page of the scan, all holding no artifact id.
    ctx.store.db.exec('CREATE TABLE filler (v TEXT)')
    const fill = ctx.store.db.prepare('INSERT INTO filler VALUES (?)')
    // One transaction: 2500 separate commits each sync, which alone can outlast the test's timeout.
    ctx.store.db.exec('BEGIN')
    for (let i = 0; i < 2500; i++) fill.run(`row ${i}`)
    ctx.store.db.exec('COMMIT')
    ctx.store.db.prepare("UPDATE artifacts SET created_at = '2000-01-01T00:00:00.000Z'").run()
    // After the scan, a writer records a decision naming orphan 0 and keeps its id in a row, as an
    // owning plugin does: orphan 0 must stay, now and later.
    ctx.store.db.exec('CREATE TABLE owner_rows (decision TEXT)')
    const late = () => {
      const id = ctx.artifacts.recordDecision({ ...route, question: 'late', inputs: [orphans[0]!] }, { producer }).id
      ctx.store.db.prepare('INSERT INTO owner_rows VALUES (?)').run(id)
    }
    const first = await ctx.artifacts.collect(Date.now() + 2 * day, { afterScan: late })
    // Every other orphan goes, two per transaction; the one named after the scan stays, then and later.
    expect(first.removed).toBe(4)
    expect(orphans.filter((id) => ctx.artifacts.get(id))).toEqual([orphans[0]])
    expect((await ctx.artifacts.collect(Date.now() + 2 * day)).removed).toBe(0)
    expect(ctx.artifacts.get(orphans[0]!)).toBeDefined()
  })
})
