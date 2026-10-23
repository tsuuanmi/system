/**
 * Conformance suite for `ctx.pluginHost` (ADR-0037; docs/design/plugin-host.md), and a fake provider
 * that passes it. `boot()` gives a host over one durable state: `start(composition)` (re)starts it on
 * a composition, stopping the one before, and returns a context with `ctx.pluginHost` and
 * `ctx.artifacts`. A composition is its rows, what each row's package ships as its manifest, and
 * (1.1) the packages the host's configuration allows without one.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { expect } from 'vitest'
import { defineSuite, type Scenario } from '../../libs/conformance/runner.ts'
import {
  type CompositionRow, findPlugin, LIFECYCLE_STATES, type LifecycleDecision, type ManifestCheckDecision, PluginHost, type PluginRecord, pluginRecords,
  pluginsOf, readManifest, reconcile, reconcileChecks, type RecordedCheck, type RecordedLifecycle,
} from '../src/index.ts'

/**
 * A composition as a host reads it: its rows, each package's `plugin-manifest.json` text (undefined:
 * it ships none), and (1.1) the packages the host's configuration allows without one.
 */
export interface Composition { rows: CompositionRow[]; packages: Record<string, string | undefined>; allowWithoutManifest?: string[] }
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
const P = '@conformance/provider'
const C = '@conformance/consumer'

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

type CheckEnvelope = { id: string; body: ManifestCheckDecision & { schema: string } }
/** The manifest check's decisions. */
const checks = (ctx: Context): CheckEnvelope[] => (ctx.artifacts.list({ kind: 'decision', decisionType: 'gate', limit: 1000 }) as unknown as CheckEnvelope[])
  .filter((d) => d.body.decider.id === 'plugin-host.manifest-check')

/** The decision that recorded a plugin's findings, checked as every manifest check decision must be. */
const checkOf = (ctx: Context, record: PluginRecord): ManifestCheckDecision => {
  expect(record.checked, `${record.name}'s findings name the decision that recorded them`).toBeDefined()
  const body = ctx.artifacts.get(record.checked!.decision)?.body as (ManifestCheckDecision & { schema: string }) | undefined
  expect(body, `${record.name}'s check names a stored decision`).toBeDefined()
  return checked(body!)
}
const checked = (body: ManifestCheckDecision & { schema: string }): ManifestCheckDecision => {
  schemas.assertRecord(body)
  expect(body).toMatchObject({ decisionType: 'gate', decider: { type: 'rule', id: 'plugin-host.manifest-check', version: '1' }, deterministic: true })
  expect(body.candidates.map((c) => c.option)).toEqual(['pass', 'fail'])
  expect(body.candidates.filter((c) => c.selected).map((c) => c.option)).toEqual([body.outcome.option])
  expect(body.candidates.every((c) => c.reasons.some((r) => r.trim() !== '')), 'every candidate says why').toBe(true)
  return body
}

const scenario = (id: string, title: string, run: (start: (composition: Composition) => Promise<Context>) => Promise<void>, since: '1.0' | '1.1' = '1.0'): Scenario<Boot> => ({
  id: `pluginHost.${id}`, since, title,
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
  contract: '1.1',
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

    scenario('finds-a-row-without-a-manifest', 'finds a plugin a row mounts whose package ships no manifest, or one the host refuses, and lists the finding with the gate decision that recorded it (fail) before the listing; finds nothing in a plugin whose rows are off, and records no lifecycle from a manifest it could not read (REQ-HOST-7, INV-2, INV-13)', async (start) => {
      const composition = base()
      const refused = '@conformance/refused'
      composition.rows.push(row('off-dsh', '@conformance/off-no-manifest', false), row('refused', refused), row('off-refused', '@conformance/off-refused', false))
      Object.assign(composition.packages, { '@conformance/off-no-manifest': undefined, [refused]: manifestText(refused, { _meta: {} }), '@conformance/off-refused': '{' })
      const ctx = await start(composition)
      const found = ctx.pluginHost.list().filter((p) => p.findings)
      expect(found.map((p) => [p.name, p.findings!.map((f) => (f.kind === 'no-manifest' ? `${f.kind}:${f.manifest}` : f.kind))])).toEqual([[DSH, ['no-manifest:absent']], [refused, ['no-manifest:refused']]])
      expect(byName(ctx, DSH).findings![0]!.reason).toMatch(/ships no plugin-manifest\.json/)
      expect(byName(ctx, refused).findings![0]!.reason).toMatch(/_meta/)
      expect(checks(ctx)).toHaveLength(2)
      const dsh = byName(ctx, DSH)
      expect(checkOf(ctx, dsh)).toMatchObject({ inputs: [], outcome: { option: 'fail', detail: { plugin: DSH, rows: ['dsh'], findings: dsh.findings, from: null } } })
      expect(checkOf(ctx, dsh).candidates.find((c) => c.option === 'fail')!.reasons).toEqual([dsh.findings![0]!.reason])
      expect([dsh.lifecycle, byName(ctx, refused).lifecycle]).toEqual([undefined, undefined])
      expect(decisions(ctx)).toHaveLength(2)
      for (const name of [A, B, '@conformance/off-no-manifest', '@conformance/off-refused']) expect(byName(ctx, name).findings, name).toBeUndefined()
    }, '1.1'),

    scenario('allows-a-package-the-configuration-names', 'finds nothing in a plugin whose package ships no manifest when the host\'s configuration allows it (the DSH rows), and still lists it absent; the allowance never covers a manifest the host refuses (REQ-HOST-7, INV-6, INV-14)', async (start) => {
      let ctx = await start({ ...base(), allowWithoutManifest: [DSH] })
      expect(byName(ctx, DSH)).toMatchObject({ manifestState: 'absent', mounted: true })
      expect(ctx.pluginHost.list().filter((p) => p.findings)).toEqual([])
      expect(checks(ctx)).toEqual([])
      const broken = { ...base(), allowWithoutManifest: [DSH] }
      broken.packages[DSH] = '{ "schema": '
      ctx = await start(broken)
      expect(byName(ctx, DSH).findings).toEqual([{ kind: 'no-manifest', manifest: 'refused', reason: expect.stringMatching(/not JSON/) }])
      expect(checks(ctx)).toHaveLength(1)
    }, '1.1'),

    scenario('finds-an-unsatisfied-range', 'finds each seam a mounted plugin consumes whose mounted provider declares a version its range does not accept, naming the provider and its version; a required seam no mounted plugin declares is taken at contract 1.0, an optional one is not checked, and a plugin whose rows are off is neither checked nor a provider (REQ-HOST-7, INV-2)', async (start) => {
      const OFF_PROVIDER = '@conformance/off-provider'
      const OFF_CONSUMER = '@conformance/off-consumer'
      const ctx = await start({
        rows: [row('p', P), row('c', C), row('w', OFF_PROVIDER, false), row('c-off', OFF_CONSUMER, false)],
        packages: {
          [P]: manifestText(P, { provides: [{ seam: 'thing', version: '1.0.0' }] }),
          [OFF_PROVIDER]: manifestText(OFF_PROVIDER, { provides: [{ seam: 'other', version: '1.2.0' }] }),
          [C]: manifestText(C, { consumes: [{ seam: 'thing', range: '^2.0.0' }, { seam: 'other', range: '^1.2.0' }, { seam: 'launcher', range: '^1.0.0' }, { seam: 'gone', range: '^3.0.0', optional: true }] }),
          [OFF_CONSUMER]: manifestText(OFF_CONSUMER, { consumes: [{ seam: 'thing', range: '^9.0.0' }] }),
        },
      })
      const consumer = byName(ctx, C)
      expect(consumer.findings).toEqual([
        { kind: 'unsatisfied', seam: 'thing', range: '^2.0.0', provider: P, version: '1.0.0', reason: expect.stringMatching(/ctx\.thing in the range \^2\.0\.0, which @conformance\/provider does not satisfy: it provides 1\.0\.0/) },
        { kind: 'unsatisfied', seam: 'other', range: '^1.2.0', version: '1.0.0', reason: expect.stringMatching(/no plugin of the composition declares it/) },
      ])
      for (const name of [P, OFF_PROVIDER, OFF_CONSUMER]) expect(byName(ctx, name).findings, name).toBeUndefined()
      expect(checks(ctx)).toHaveLength(1)
      expect(checkOf(ctx, consumer)).toMatchObject({ outcome: { option: 'fail', detail: { plugin: C, rows: ['c'], version: '1.0.0', manifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), findings: consumer.findings } } })
      expect(checkOf(ctx, consumer).candidates.find((c) => c.option === 'fail')!.reasons).toHaveLength(2)
      // The check is not a lifecycle state: the composition still gives the plugin its state.
      expect(consumer.lifecycle!.state).toBe('default')
    }, '1.1'),

    scenario('passes-a-satisfied-range', 'finds nothing, and records nothing, in a plugin whose every consumed seam each mounted provider declares at a version its range accepts, or that no plugin declares and its range accepts at 1.0; each mounted provider of a seam is checked (REQ-HOST-7)', async (start) => {
      const P2 = '@conformance/provider-2'
      const satisfied = (second: string): Composition => ({
        rows: [row('p', P), row('p-2', P2), row('c', C)],
        packages: {
          [P]: manifestText(P, { provides: [{ seam: 'thing', version: '1.3.1' }] }),
          [P2]: manifestText(P2, { provides: [{ seam: 'thing', version: second }] }),
          [C]: manifestText(C, { consumes: [{ seam: 'thing', range: '^1.3.0' }, { seam: 'launcher', range: '^1.0.0' }, { seam: 'gone', range: '^1.0.0', optional: true }] }),
        },
      })
      let ctx = await start(satisfied('1.4.0'))
      expect(ctx.pluginHost.list().filter((p) => p.findings)).toEqual([])
      expect(checks(ctx)).toEqual([])
      ctx = await start(satisfied('2.0.0'))
      expect(byName(ctx, C).findings).toEqual([expect.objectContaining({ seam: 'thing', provider: P2, version: '2.0.0' })])
    }, '1.1'),

    scenario('records-a-finding-once', 'records a finding once: a restart over the same composition records nothing, another finding is recorded chained to the one before, and a finding cleared (fixed, or no row mounts the plugin any more) is recorded once as pass, chained to it (INV-4, INV-13)', async (start) => {
      const composition = (version: string, mounted = true): Composition => ({
        rows: [row('p', P), row('c', C, mounted)],
        packages: { [P]: manifestText(P, { provides: [{ seam: 'thing', version }] }), [C]: manifestText(C, { consumes: [{ seam: 'thing', range: '^2.0.0' }] }) },
      })
      let ctx = await start(composition('1.0.0'))
      const first = byName(ctx, C).checked!
      expect(checks(ctx)).toHaveLength(1)
      ctx = await start(composition('1.0.0'))
      expect(checks(ctx)).toHaveLength(1)
      expect(byName(ctx, C).checked).toEqual(first)
      ctx = await start(composition('1.5.0'))
      expect(checks(ctx)).toHaveLength(2)
      const second = byName(ctx, C)
      expect(checkOf(ctx, second)).toMatchObject({ inputs: [first.decision], outcome: { option: 'fail', detail: { from: 'fail', findings: [{ version: '1.5.0' }] } } })
      ctx = await start(composition('2.1.0'))
      expect(checks(ctx)).toHaveLength(3)
      expect(byName(ctx, C).findings).toBeUndefined()
      const passed = checks(ctx).find((d) => d.body.outcome.option === 'pass')!
      expect(checked(passed.body)).toMatchObject({ inputs: [second.checked!.decision], outcome: { detail: { plugin: C, findings: [], from: 'fail' } } })
      ctx = await start(composition('2.1.0'))
      expect(checks(ctx)).toHaveLength(3)
      ctx = await start(composition('1.0.0'))
      expect(checks(ctx)).toHaveLength(4)
      expect(checkOf(ctx, byName(ctx, C))).toMatchObject({ inputs: [passed.id], outcome: { option: 'fail', detail: { from: 'pass' } } })
      ctx = await start(composition('1.0.0', false))
      expect(checks(ctx)).toHaveLength(5)
      expect(byName(ctx, C).findings).toBeUndefined()
      ctx = await start(composition('1.0.0', false))
      expect(checks(ctx)).toHaveLength(5)
    }, '1.1'),
  ],
})

/**
 * The fake's configuration: the composition it reads, and the maps that stand for its durable state
 * across restarts, its lifecycle records (`ledger`) and (1.1) its manifest checks (`checks`; a fresh
 * one when omitted, so nothing of the check is kept across restarts).
 */
export interface FakeConfig { composition: Composition; ledger: Map<string, RecordedLifecycle>; checks?: Map<string, RecordedCheck> }

/**
 * A fake `ctx.pluginHost` over a given composition (no loader, no package files), its records in the
 * maps its caller keeps across restarts. It reconciles as every provider does: each decision through
 * `ctx.artifacts` first, then the records.
 */
export class FakePluginHost extends PluginHost {
  static inject = ['artifacts']
  private readonly records: PluginRecord[]

  constructor(ctx: Context, config: FakeConfig) {
    super(ctx)
    const { rows, packages, allowWithoutManifest = [] } = config.composition
    const ledger = config.ledger
    const checked = config.checks ?? new Map<string, RecordedCheck>()
    const manifests = new Map(pluginsOf(rows).map((p) => [p.name, readManifest(packages[p.name], p.name)]))
    const { changes, moves } = reconcile(rows, manifests, ledger)
    const check = reconcileChecks(rows, manifests, allowWithoutManifest, checked)
    const since = new Date().toISOString()
    const producer = { producer: { type: 'system', ref: 'plugin-host' } } as const
    const recorded = changes.map((change) => ({ change, decision: ctx.artifacts.recordDecision(change.decision, producer).id }))
    const recordedChecks = check.changes.map((change) => ({ change, decision: ctx.artifacts.recordDecision(change.decision, producer).id }))
    for (const { from, to } of moves) {
      ledger.set(to, { ...ledger.get(from)!, name: to })
      ledger.delete(from)
    }
    for (const { change, decision } of recorded) {
      if (change.previous && change.previous.name !== change.name) ledger.delete(change.previous.name)
      ledger.set(change.name, { name: change.name, state: change.state, since, decision: decision as RecordedLifecycle['decision'], version: change.version, rows: change.rows })
    }
    for (const { change, decision } of recordedChecks) checked.set(change.name, { name: change.name, findings: change.findings, since, decision: decision as RecordedCheck['decision'] })
    this.records = pluginRecords(rows, manifests, ledger, { findings: check.findings, recorded: checked })
  }

  list(): PluginRecord[] {
    return this.records
  }

  get(name: string): PluginRecord | undefined {
    return findPlugin(this.records, name)
  }
}
