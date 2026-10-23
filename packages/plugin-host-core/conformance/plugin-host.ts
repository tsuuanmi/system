/**
 * Conformance suite for `ctx.pluginHost` (ADR-0037; docs/design/plugin-host.md), and a fake provider
 * that passes it. `boot()` gives a host over one durable state: `start(composition)` (re)starts it on
 * a composition, stopping the one before, and returns a context with `ctx.pluginHost` and
 * `ctx.artifacts`. A composition is its rows, and what each row's package ships as its manifest.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { expect } from 'vitest'
import { defineSuite, type Scenario } from '../../libs/conformance/runner.ts'
import {
  type CompositionRow, findPlugin, LIFECYCLE_STATES, type LifecycleDecision, PluginHost, type PluginRecord, pluginRecords, pluginsOf,
  readManifest, reconcile, type RecordedLifecycle,
} from '../src/index.ts'

/** A composition as a host reads it: its rows, and each package's `plugin-manifest.json` text (undefined: it ships none). */
export interface Composition { rows: CompositionRow[]; packages: Record<string, string | undefined> }
export type Boot = () => Promise<{ start: (composition: Composition) => Promise<Context>; dispose: () => Promise<void> }>

const schemas = new SchemaRegistry()

/** A valid declared manifest of `name`, as its package would ship it. */
export function manifestText(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 'plugin-manifest@1.0', name, version: '1.0.0', class: { kind: 'family', family: 'surface' }, provides: [], consumes: [], license: 'UNLICENSED', ...extra })
}

const row = (id: string, name: string, mounted = true): CompositionRow => ({ id, name, mounted })
const A = '@conformance/plugin-a'
const B = '@conformance/plugin-b'
const DSH = '@conformance/no-manifest'

/** Two plugins and a package with no manifest; plugin A has two rows, one of them off. */
const base = (): Composition => ({
  rows: [row('a', A), row('b', B, false), row('a-2', A, false), row('dsh', DSH)],
  packages: { [A]: manifestText(A), [B]: manifestText(B), [DSH]: undefined },
})

type Envelope = { id: string; body: LifecycleDecision & { schema: string } }
const decisions = (ctx: Context): Envelope[] => ctx.artifacts.list({ kind: 'decision', decisionType: 'lifecycle', limit: 1000 }) as unknown as Envelope[]
const byName = (ctx: Context, name: string): PluginRecord => {
  const found = ctx.pluginHost.get(name)
  expect(found, `the host knows ${name}`).toBeDefined()
  return found!
}

/** The decision a record names, checked as every lifecycle decision must be. */
const decisionOf = (ctx: Context, record: PluginRecord): LifecycleDecision => {
  expect(record.lifecycle, `${record.name} has a recorded lifecycle`).toBeDefined()
  const body = ctx.artifacts.get(record.lifecycle!.decision)?.body as (LifecycleDecision & { schema: string }) | undefined
  expect(body, `${record.name}'s lifecycle names a stored decision`).toBeDefined()
  schemas.assertRecord(body!)
  expect(body).toMatchObject({ schema: 'decision@1.5', decisionType: 'lifecycle', decider: { type: 'rule', id: 'plugin-host.composition' }, outcome: { option: record.lifecycle!.state, detail: { plugin: record.name } }, deterministic: true })
  expect(body!.candidates.map((c) => c.option)).toEqual([...LIFECYCLE_STATES])
  expect(body!.candidates.every((c) => c.reasons.some((r) => r.trim() !== '')), 'every candidate says why').toBe(true)
  return body!
}

const scenario = (id: string, title: string, run: (start: (composition: Composition) => Promise<Context>) => Promise<void>): Scenario<Boot> => ({
  id: `pluginHost.${id}`, since: '1.0', title,
  run: async (boot) => {
    const { start, dispose } = await boot()
    try {
      await run(start)
    } finally {
      await dispose()
    }
  },
})

export const pluginHostSuite = defineSuite<Boot>({
  seam: 'pluginHost',
  contract: '1.0',
  scenarios: [
    scenario('lists-the-composition', 'lists every plugin of the composition once, in the order of its first row, mounted or not, each valid manifest with the host\'s lifecycle in _meta, and a package that ships none as absent with no lifecycle (REQ-HOST-7, INV-14)', async (start) => {
      const ctx = await start(base())
      const listed = ctx.pluginHost.list()
      expect(listed.map((p) => [p.name, p.rows, p.mounted, p.manifestState])).toEqual([[A, ['a', 'a-2'], true, 'valid'], [B, ['b'], false, 'valid'], [DSH, ['dsh'], true, 'absent']])
      for (const plugin of listed.filter((p) => p.manifestState === 'valid')) {
        schemas.assertRecord(plugin.manifest!)
        expect(plugin.manifest!._meta).toEqual({ lifecycle: plugin.lifecycle })
      }
      expect(listed[2]).toMatchObject({ reason: expect.stringMatching(/ships no plugin-manifest\.json/) })
      expect(listed[2]!.lifecycle).toBeUndefined()
      expect(byName(ctx, A)).toEqual(listed[0])
      expect(ctx.pluginHost.get('@conformance/unknown')).toBeUndefined()
    }),

    scenario('records-each-state-once', 'records one lifecycle decision per plugin with a valid manifest before its state, default for a mounted one and candidate for one whose rows are off, and none again on a restart over the same composition or a new version of a plugin (REQ-HOST-7, INV-13)', async (start) => {
      let ctx = await start(base())
      expect(decisions(ctx)).toHaveLength(2)
      const first = new Map(ctx.pluginHost.list().map((p) => [p.name, p.lifecycle]))
      expect([first.get(A)?.state, first.get(B)?.state]).toEqual(['default', 'candidate'])
      expect(decisionOf(ctx, byName(ctx, A))).toMatchObject({ inputs: [], outcome: { detail: { version: '1.0.0', rows: ['a', 'a-2'], from: null } } })
      expect(decisionOf(ctx, byName(ctx, B)).candidates.find((c) => c.selected)!.reasons[0]).toMatch(/off in the composition/)
      ctx = await start(base())
      expect(decisions(ctx)).toHaveLength(2)
      expect(new Map(ctx.pluginHost.list().map((p) => [p.name, p.lifecycle]))).toEqual(first)
      const upgraded = base()
      upgraded.packages[A] = manifestText(A, { version: '1.1.0' })
      ctx = await start(upgraded)
      expect(decisions(ctx)).toHaveLength(2)
      expect(byName(ctx, A)).toMatchObject({ manifest: { version: '1.1.0' }, lifecycle: first.get(A) })
    }),

    scenario('records-a-change', 'records a row switched off or on as one lifecycle decision for that plugin only, chained to the decision before it, and leaves every other plugin\'s record as it was (REQ-HOST-7, INV-13)', async (start) => {
      let ctx = await start(base())
      const a = byName(ctx, A).lifecycle!
      const b = byName(ctx, B).lifecycle!
      const off = base()
      off.rows[0] = row('a', A, false)
      ctx = await start(off)
      expect(decisions(ctx)).toHaveLength(3)
      const switched = byName(ctx, A)
      expect(switched).toMatchObject({ mounted: false, lifecycle: { state: 'candidate' } })
      expect(decisionOf(ctx, switched)).toMatchObject({ inputs: [a.decision], outcome: { detail: { from: 'default' } } })
      expect(byName(ctx, B).lifecycle).toEqual(b)
      ctx = await start(base())
      expect(decisions(ctx)).toHaveLength(4)
      const back = byName(ctx, A)
      expect(back.lifecycle!.state).toBe('default')
      expect(decisionOf(ctx, back)).toMatchObject({ inputs: [switched.lifecycle!.decision], outcome: { detail: { from: 'candidate' } } })
    }),

    scenario('retires-a-removed-plugin', 'records a plugin no row names any more as retired, once, and still lists it with no row; a row that names it again brings it back with a decision chained to its retirement (REQ-HOST-7, INV-13)', async (start) => {
      let ctx = await start(base())
      const b = byName(ctx, B).lifecycle!
      const without = base()
      without.rows = without.rows.filter((r) => r.name !== B)
      ctx = await start(without)
      expect(decisions(ctx)).toHaveLength(3)
      const retired = byName(ctx, B)
      expect(retired).toMatchObject({ rows: [], mounted: false, manifestState: 'absent', lifecycle: { state: 'retired' } })
      expect(ctx.pluginHost.list().at(-1)!.name).toBe(B)
      expect(decisionOf(ctx, retired)).toMatchObject({ inputs: [b.decision], outcome: { detail: { rows: [], from: 'candidate' } } })
      ctx = await start(without)
      expect(decisions(ctx)).toHaveLength(3)
      ctx = await start(base())
      expect(decisions(ctx)).toHaveLength(4)
      expect(decisionOf(ctx, byName(ctx, B))).toMatchObject({ inputs: [retired.lifecycle!.decision], outcome: { option: 'candidate', detail: { from: 'retired' } } })
    }),

    scenario('refuses-what-it-cannot-read', 'refuses, with why and with no lifecycle decision, a manifest that declares the host\'s _meta, is not JSON, is not a valid plugin-manifest@1.x (another record, an unknown major), or names another package; a recorded plugin whose manifest becomes refused keeps its record (INV-14, INV-2)', async (start) => {
      const bad: Record<string, string> = {
        '@conformance/meta': manifestText('@conformance/meta', { _meta: { lifecycle: { state: 'default', since: '2026-10-23T00:00:00Z', decision: `sha256:${'1'.repeat(64)}` } } }),
        '@conformance/not-json': '{ "schema": ',
        '@conformance/invalid': manifestText('@conformance/invalid', { class: { kind: 'core' } }),
        '@conformance/major': manifestText('@conformance/major', { schema: 'plugin-manifest@2.0' }),
        '@conformance/other-record': JSON.stringify({ schema: 'decision@1.0' }),
        '@conformance/other-name': manifestText('@conformance/someone-else'),
      }
      const composition = base()
      for (const name of Object.keys(bad)) composition.rows.push(row(name.split('/')[1]!, name))
      Object.assign(composition.packages, bad)
      let ctx = await start(composition)
      expect(decisions(ctx)).toHaveLength(2)
      for (const name of Object.keys(bad)) expect(byName(ctx, name), name).toMatchObject({ manifestState: 'refused', reason: expect.any(String) })
      expect(byName(ctx, '@conformance/meta').reason).toMatch(/_meta/)
      expect(byName(ctx, '@conformance/other-name').reason).toMatch(/names @conformance\/someone-else/)
      const recorded = byName(ctx, A).lifecycle
      const broken = base()
      broken.packages[A] = manifestText(A, { schema: 'plugin-manifest@1.0', defines: [{ seam: 'x', version: '1.0.0' }] })
      broken.rows[0] = row('a', A, false)
      ctx = await start(broken)
      expect(decisions(ctx)).toHaveLength(2)
      expect(byName(ctx, A)).toMatchObject({ manifestState: 'refused', lifecycle: recorded })
      expect(byName(ctx, A).manifest).toBeUndefined()
    }),

    scenario('follows-a-rename', 'carries a renamed plugin\'s record over from the name its manifest renames, with no decision while its state stays, finds it by either name, and records its next change chained to the old record (REQ-HOST-7)', async (start) => {
      const NEW = '@conformance/plugin-a-renamed'
      let ctx = await start(base())
      const old = byName(ctx, A).lifecycle!
      const renamed = (mounted: boolean): Composition => ({
        rows: [row('a', NEW, mounted), row('b', B, false)],
        packages: { [NEW]: manifestText(NEW, { renames: [A] }), [B]: manifestText(B) },
      })
      ctx = await start(renamed(true))
      expect(decisions(ctx)).toHaveLength(2)
      expect(byName(ctx, NEW).lifecycle).toEqual(old)
      expect(byName(ctx, A).name).toBe(NEW)
      expect(ctx.pluginHost.list().map((p) => p.name)).toEqual([NEW, B])
      ctx = await start(renamed(false))
      expect(decisions(ctx)).toHaveLength(3)
      expect(decisionOf(ctx, byName(ctx, NEW))).toMatchObject({ inputs: [old.decision], outcome: { option: 'candidate', detail: { from: 'default' } } })
    }),
  ],
})

/** The fake's configuration: the composition it reads, and the map that stands for its durable state across restarts. */
export interface FakeConfig { composition: Composition; ledger: Map<string, RecordedLifecycle> }

/**
 * A fake `ctx.pluginHost` over a given composition (no loader, no package files), its records in the
 * `ledger` map its caller keeps across restarts. It reconciles as every provider does: each decision
 * through `ctx.artifacts` first, then the records.
 */
export class FakePluginHost extends PluginHost {
  static inject = ['artifacts']
  private readonly records: PluginRecord[]

  constructor(ctx: Context, config: FakeConfig) {
    super(ctx)
    const { rows, packages } = config.composition
    const manifests = new Map(pluginsOf(rows).map((p) => [p.name, readManifest(packages[p.name], p.name)]))
    const { changes, moves } = reconcile(rows, manifests, config.ledger)
    const since = new Date().toISOString()
    const recorded = changes.map((change) => ({ change, decision: ctx.artifacts.recordDecision(change.decision, { producer: { type: 'system', ref: 'plugin-host' } }).id }))
    for (const { from, to } of moves) {
      config.ledger.set(to, { ...config.ledger.get(from)!, name: to })
      config.ledger.delete(from)
    }
    for (const { change, decision } of recorded) {
      if (change.previous && change.previous.name !== change.name) config.ledger.delete(change.previous.name)
      config.ledger.set(change.name, { name: change.name, state: change.state, since, decision: decision as RecordedLifecycle['decision'], version: change.version, rows: change.rows })
    }
    this.records = pluginRecords(rows, manifests, config.ledger)
  }

  list(): PluginRecord[] {
    return this.records
  }

  get(name: string): PluginRecord | undefined {
    return findPlugin(this.records, name)
  }
}
