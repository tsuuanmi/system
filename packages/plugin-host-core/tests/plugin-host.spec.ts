import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it } from 'vitest'
import { runSuite } from '../../libs/conformance/runner.ts'
import { FakePluginHost, manifestText, pluginHostSuite } from '../conformance/plugin-host.ts'
import {
  checkComposition, checkHash, compositionHash, type ManifestRead, MANIFEST_MAX_BYTES, pluginRecords, pluginsOf, readManifest, reconcile,
  reconcileChecks, type RecordedCheck, type RecordedLifecycle, satisfies,
} from '../src/index.ts'

// The seam's own fake passes the suite every provider must pass (ADR-0037). It holds no loader, so it
// implements none of 1.2's optional runtime switches, and pins the contract before them.
runSuite(pluginHostSuite, {
  name: 'the fake provider',
  contract: '1.1',
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-plugin-host-'))
    const ctx = new Context()
    const kernel = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {})]
    await Promise.all(kernel)
    const ledger = new Map<string, RecordedLifecycle>()
    const checks = new Map<string, RecordedCheck>()
    let host: ReturnType<Context['plugin']> | undefined
    return {
      start: async (composition) => {
        await host?.dispose()
        host = ctx.plugin(FakePluginHost, { composition, ledger, checks })
        await host
        return ctx
      },
      dispose: async () => {
        await host?.dispose()
        for (const fiber of kernel.reverse()) await fiber.dispose()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})

describe('reading a declared manifest', () => {
  it('takes a valid manifest of the row\'s package with its canonical digest, and refuses one past the size bound (INV-9, INV-14)', () => {
    const read = readManifest(manifestText('@x/a'), '@x/a')
    expect(read).toMatchObject({ state: 'valid', manifest: { name: '@x/a' }, digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) })
    expect((readManifest(` ${manifestText('@x/a')}`, '@x/a') as { digest: string }).digest).toBe((read as { digest: string }).digest)
    expect(readManifest(manifestText('@x/a', { description: 'x'.repeat(MANIFEST_MAX_BYTES) }), '@x/a')).toMatchObject({ state: 'refused', reason: expect.stringMatching(/larger than/) })
    expect(readManifest('[]', '@x/a')).toMatchObject({ state: 'refused', reason: expect.stringMatching(/not a JSON object/) })
  })

  it('keeps @1.1\'s defines out of @1.0, and takes a definition package\'s manifest at @1.1 (INV-14)', () => {
    const defines = [{ seam: 'pluginHost', version: '1.0.0' }]
    expect(readManifest(manifestText('@x/core', { defines }), '@x/core').state).toBe('refused')
    expect(readManifest(manifestText('@x/core', { schema: 'plugin-manifest@1.1', defines }), '@x/core').state).toBe('valid')
  })
})

describe('reconciliation', () => {
  const manifests = (...names: string[]): Map<string, ManifestRead> => new Map(names.map((n) => [n, readManifest(manifestText(n), n)]))

  it('gives the decider the hash of the composition it read, so another composition shows', () => {
    const rows = [{ id: 'a', name: '@x/a', mounted: true }]
    const [change] = reconcile(rows, manifests('@x/a'), new Map()).changes
    expect(change!.decision.decider.hash).toBe(compositionHash(rows))
    expect(compositionHash([{ id: 'a', name: '@x/a', mounted: false }])).not.toBe(compositionHash(rows))
  })

  it('records every lifecycle decision as a valid decision@1.5, whose candidates each say why (INV-13, INV-14)', () => {
    const rows = [{ id: 'a', name: '@x/a', mounted: true }, { id: 'b', name: '@x/b', mounted: false }]
    const recorded = new Map<string, RecordedLifecycle>([['@x/gone', { name: '@x/gone', state: 'default', since: '2026-10-23T00:00:00.000Z', decision: `sha256:${'2'.repeat(64)}`, version: '1.0.0', rows: ['gone'] }]])
    const { changes } = reconcile(rows, manifests('@x/a', '@x/b'), recorded)
    expect(changes.map((c) => [c.name, c.state])).toEqual([['@x/a', 'default'], ['@x/b', 'candidate'], ['@x/gone', 'retired']])
    const schemas = new SchemaRegistry()
    for (const change of changes) {
      expect(() => schemas.assertRecord(change.decision)).not.toThrow()
      expect(change.decision.candidates.filter((c) => c.selected).map((c) => c.option)).toEqual([change.state])
    }
    expect(changes[2]!.decision.inputs).toEqual([`sha256:${'2'.repeat(64)}`])
  })

  it('gives a former name\'s record to the first plugin that renames it only; the other starts its own', () => {
    const recorded = new Map<string, RecordedLifecycle>([['@x/old', { name: '@x/old', state: 'default', since: '2026-10-23T00:00:00.000Z', decision: `sha256:${'3'.repeat(64)}`, version: '1.0.0', rows: ['old'] }]])
    const renaming = (name: string): [string, ManifestRead] => [name, readManifest(manifestText(name, { renames: ['@x/old'] }), name)]
    const rows = [{ id: 'one', name: '@x/one', mounted: true }, { id: 'two', name: '@x/two', mounted: true }]
    const { changes, moves } = reconcile(rows, new Map([renaming('@x/one'), renaming('@x/two')]), recorded)
    expect(moves).toEqual([{ from: '@x/old', to: '@x/one' }])
    expect(changes.map((c) => [c.name, c.state, c.previous?.name])).toEqual([['@x/two', 'default', undefined]])
  })

  it('lists a plugin of several rows once, mounted when any of its rows is', () => {
    expect(pluginsOf([{ id: 'a', name: '@x/a', mounted: false }, { id: 'b', name: '@x/b', mounted: true }, { id: 'a-2', name: '@x/a', mounted: true }]))
      .toEqual([{ name: '@x/a', rows: ['a', 'a-2'], mounted: true }, { name: '@x/b', rows: ['b'], mounted: true }])
  })
})

describe('the manifest check (1.1)', () => {
  const read = (name: string, extra: Record<string, unknown> = {}): [string, ManifestRead] => [name, readManifest(manifestText(name, extra), name)]

  it('matches a caret range as semver does for a major above zero, and reads no other form', () => {
    expect([satisfies('1.3.0', '^1.0.0'), satisfies('1.3.0', '^1.3.1'), satisfies('1.3.2', '^1.3.1'), satisfies('2.0.0', '^1.0.0')]).toEqual([true, false, true, false])
    expect([satisfies('1.0.0', '1.0.0'), satisfies('1.0.0', '>=1'), satisfies('0.2.0', '^0.2.0'), satisfies('x', '^1.0.0')]).toEqual([undefined, undefined, undefined, undefined])
  })

  it('accepts no pre-release under a caret range, as semver does, and reads no version or range with more than major.minor.patch (INV-2)', () => {
    expect([satisfies('1.2.3-rc.1', '^1.2.3'), satisfies('1.3.0-rc.1', '^1.2.3'), satisfies('2.0.0-rc.1', '^1.0.0')]).toEqual([false, false, false])
    expect([satisfies('1.2.3garbage', '^1.2.3'), satisfies('1.2.3.4', '^1.2.3'), satisfies('01.2.3', '^1.2.3'), satisfies('1.2.3', '^01.2.3'), satisfies('1.2.3', '^1.2.3-rc.1')]).toEqual([undefined, undefined, undefined, undefined, undefined])
    const rows = [{ id: 'p', name: '@x/p', mounted: true }, { id: 'c', name: '@x/c', mounted: true }]
    const manifests = new Map([read('@x/p', { provides: [{ seam: 'thing', version: '1.1.0-rc.1' }] }), read('@x/c', { consumes: [{ seam: 'thing', range: '^1.1.0' }] })])
    expect(checkComposition(rows, manifests).get('@x/c')).toEqual([{ kind: 'unsatisfied', seam: 'thing', range: '^1.1.0', provider: '@x/p', version: '1.1.0-rc.1', reason: expect.stringMatching(/does not satisfy/) }])
  })

  it('allows no package without a manifest whose manifest was not read: only one read as absent (INV-2)', () => {
    const rows = [{ id: 'dsh', name: '@x/dsh', mounted: true }]
    expect(checkComposition(rows, new Map(), ['@x/dsh']).get('@x/dsh')).toEqual([{ kind: 'no-manifest', manifest: 'absent', reason: expect.stringMatching(/was not read/) }])
    expect(checkComposition(rows, new Map([['@x/dsh', { state: 'absent', reason: 'it ships none' }]]), ['@x/dsh']).get('@x/dsh')).toBeUndefined()
  })

  it('finds a range the host cannot read, never passing it (INV-2)', () => {
    const rows = [{ id: 'p', name: '@x/p', mounted: true }, { id: 'c', name: '@x/c', mounted: true }]
    const manifests = new Map([read('@x/p', { provides: [{ seam: 'thing', version: '1.0.0' }] }), read('@x/c', { consumes: [{ seam: 'thing', range: '>=1.0.0' }] })])
    expect(checkComposition(rows, manifests).get('@x/c')).toEqual([{ kind: 'unsatisfied', seam: 'thing', range: '>=1.0.0', provider: '@x/p', version: '1.0.0', reason: expect.stringMatching(/not a caret range/) }])
  })

  it('gives the decider the hash of what it read: the rows, each manifest, and the packages allowed without one', () => {
    const rows = [{ id: 'dsh', name: '@x/dsh', mounted: true }]
    const absent = new Map<string, ManifestRead>([['@x/dsh', { state: 'absent', reason: '@x/dsh ships no plugin-manifest.json' }]])
    expect(checkHash(rows, absent, [])).not.toBe(checkHash(rows, absent, ['@x/dsh']))
    expect(checkHash(rows, absent, ['@x/b', '@x/dsh'])).toBe(checkHash(rows, absent, ['@x/dsh', '@x/b']))
    expect(checkHash(rows, new Map([read('@x/dsh')]), [])).not.toBe(checkHash(rows, absent, []))
  })

  it('records each decision as a valid decision@1.0 gate decision, its fail reasons bounded to what a candidate holds (INV-13, INV-14)', () => {
    // 32 seams consumed (the most a manifest declares): the first from two providers, the others from none.
    const consumes = Array.from({ length: 32 }, (_, i) => ({ seam: `seam${i}`, range: '^2.0.0' }))
    const provides = [{ seam: 'seam0', version: '1.0.0' }]
    const rows = [{ id: 'p', name: '@x/p', mounted: true }, { id: 'p-2', name: '@x/p2', mounted: true }, { id: 'c', name: '@x/c', mounted: true }]
    const manifests = new Map([read('@x/p', { provides }), read('@x/p2', { provides }), read('@x/c', { consumes })])
    const { findings, changes } = reconcileChecks(rows, manifests, [], new Map())
    expect(findings.get('@x/c')).toHaveLength(33)
    expect(changes.map((c) => c.name)).toEqual(['@x/c'])
    const schemas = new SchemaRegistry()
    expect(() => schemas.assertRecord(changes[0]!.decision)).not.toThrow()
    const fail = changes[0]!.decision.candidates.find((c) => c.option === 'fail')!.reasons
    expect(fail).toHaveLength(32)
    expect(fail.at(-1)).toBe('and 2 more finding(s), each in the outcome\'s detail')
  })

  it('records a reworded finding as the same one, and clears a recorded plugin no row names any more with one pass', () => {
    const rows = [{ id: 'dsh', name: '@x/dsh', mounted: true }]
    const manifests = new Map<string, ManifestRead>([['@x/dsh', { state: 'absent', reason: 'it ships none' }]])
    const recorded = (reason: string): Map<string, RecordedCheck> => new Map([['@x/dsh', { name: '@x/dsh', findings: [{ kind: 'no-manifest', manifest: 'absent', reason }], since: '2026-10-23T00:00:00.000Z', decision: `sha256:${'4'.repeat(64)}` }]])
    expect(reconcileChecks(rows, manifests, [], recorded('worded otherwise before')).changes).toEqual([])
    const [cleared] = reconcileChecks([], new Map(), [], recorded('it ships none')).changes
    expect(cleared).toMatchObject({ name: '@x/dsh', findings: [], decision: { inputs: [`sha256:${'4'.repeat(64)}`], outcome: { option: 'pass', detail: { rows: [], from: 'fail' } } } })
    expect(cleared!.decision.candidates[0]!.reasons[0]).toMatch(/no row of the composition mounts it/)
  })

  it('records the same findings in another order as the same ones: a reordered composition or manifest records nothing (INV-4)', () => {
    const provides = [{ seam: 'one', version: '1.0.0' }, { seam: 'two', version: '1.0.0' }]
    const consumes = [{ seam: 'one', range: '^2.0.0' }, { seam: 'two', range: '^2.0.0' }]
    const rows = [{ id: 'p', name: '@x/p', mounted: true }, { id: 'p-2', name: '@x/p2', mounted: true }, { id: 'c', name: '@x/c', mounted: true }]
    const first = reconcileChecks(rows, new Map([read('@x/p', { provides }), read('@x/p2', { provides }), read('@x/c', { consumes })]), [], new Map())
    const recorded = new Map<string, RecordedCheck>([['@x/c', { name: '@x/c', findings: first.findings.get('@x/c')!, since: '2026-10-23T00:00:00.000Z', decision: `sha256:${'6'.repeat(64)}` }]])
    const reordered = new Map([read('@x/p', { provides }), read('@x/p2', { provides }), read('@x/c', { consumes: [...consumes].reverse() })])
    const again = reconcileChecks([rows[1]!, rows[0]!, rows[2]!], reordered, [], recorded)
    expect(again.findings.get('@x/c')).toHaveLength(4)
    expect(again.findings.get('@x/c')).not.toEqual(first.findings.get('@x/c'))
    expect(again.changes).toEqual([])
  })

  it('lists a plugin\'s findings with the decision that recorded them, and nothing for one without', () => {
    const rows = [{ id: 'dsh', name: '@x/dsh', mounted: true }, { id: 'a', name: '@x/a', mounted: true }]
    const manifests = new Map<string, ManifestRead>([['@x/dsh', { state: 'absent', reason: 'it ships none' }], read('@x/a')])
    const findings = checkComposition(rows, manifests)
    const record: RecordedCheck = { name: '@x/dsh', findings: findings.get('@x/dsh')!, since: '2026-10-23T00:00:00.000Z', decision: `sha256:${'5'.repeat(64)}` }
    const [dsh, a] = pluginRecords(rows, manifests, new Map(), { findings, recorded: new Map([['@x/dsh', record]]) })
    expect(dsh).toMatchObject({ findings: record.findings, checked: { since: record.since, decision: record.decision } })
    expect(a!.findings).toBeUndefined()
    expect(a!.checked).toBeUndefined()
  })
})
