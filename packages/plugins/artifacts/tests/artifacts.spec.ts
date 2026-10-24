import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished } from 'vitest'
import Artifacts, { type Decision } from '../src/index.ts'

async function boot(): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'system-artifacts-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const store = ctx.plugin(Store, { path: join(dir, 'system.db') })
  const artifacts = ctx.plugin(Artifacts, {})
  await Promise.all([store, artifacts])
  onTestFinished(() => store.dispose())
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

// The seam's contract is held by its conformance suite (conformance.spec.ts); these tests pin what
// only this provider does.
describe('ctx.artifacts', () => {
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
  const tierOf = (n: number) => ({ ...route, decisionType: 'tier', question: `q${n}`, candidates: [{ option: `t${n}`, selected: true, reasons: ['the only tier'] }], outcome: { option: `t${n}` } })

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

  describe('read, for the operator', () => {
    const answer = (text: string) => ({
      kind: 'report' as const, bodySchema: 'provider-answer@1.0', classification: 'local-private' as const, producer: { type: 'worker' as const, ref: 'chatgpt-web/chatgpt-main' },
      body: { schema: 'provider-answer@1.0', provider: 'chatgpt-web', account: 'chatgpt-main', turnId: 'turn_1', conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text },
    })

    it('explains and reads a collected input as expired, keeping its id and naming what still names it, and reads one nothing names as unknown, never as an error (REQ-ART-3)', async () => {
      const ctx = await boot()
      const input = ctx.artifacts.recordDecision(route, { producer })
      const child = ctx.artifacts.recordDecision({ ...route, question: 'Which Worker runs research:2?', inputs: [input.id] }, { producer })
      ctx.store.db.prepare('DELETE FROM artifacts WHERE id = ?').run(input.id)
      expect(ctx.artifacts.explain(child.id)!.inputs).toEqual([{ id: input.id, kind: 'expired', summary: 'expired: collected by retention', inputs: [] }])
      expect(ctx.artifacts.read(input.id)).toEqual({
        id: input.id, state: 'expired', referencedBy: { id: child.id, kind: 'decision', createdAt: child.createdAt },
        note: `expired: collected by retention; its content is gone (still named by decision ${child.id}, recorded ${child.createdAt})`,
      })
      const none = `sha256:${'a'.repeat(64)}`
      expect(ctx.artifacts.read(none)).toMatchObject({ id: none, state: 'unknown', note: expect.stringMatching(/^unknown: /) })
    })

    it('refuses an id that is not a content id before any lookup, and a window out of bounds (INV-9)', async () => {
      const ctx = await boot()
      const prepare = ctx.store.db.prepare.bind(ctx.store.db)
      let lookups = 0
      ctx.store.db.prepare = ((sql: string) => {
        lookups++
        return prepare(sql)
      }) as typeof ctx.store.db.prepare
      for (const id of ['run_b1e912c9c25d8a79', `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(64)}%`, `x sha256:${'a'.repeat(64)}`]) {
        expect(() => ctx.artifacts.read(id), id).toThrow(/^not a content id/)
      }
      expect(lookups).toBe(0)
      ctx.store.db.prepare = prepare
      const id = ctx.artifacts.put(answer('x')).id
      expect(() => ctx.artifacts.read(id, { max: 0 })).toThrow(/^max must be/)
      expect(() => ctx.artifacts.read(id, { max: 200_001 })).toThrow(/^max must be/)
      expect(() => ctx.artifacts.read(id, { offset: -1 })).toThrow(/^offset must be/)
      expect(ctx.artifacts.read(id, { max: 200_000 })).toMatchObject({ text: 'x' })
    })
  })

  it('keeps a candidate that something written after the scan names, deletes in short batches, and reads every page (INV-9)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-artifacts-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const ctx = new Context()
    const store = ctx.plugin(Store, { path: join(dir, 'system.db') })
    const artifacts = ctx.plugin(Artifacts, { collectBatch: 2 })
    await Promise.all([store, artifacts])
    onTestFinished(() => store.dispose())
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
