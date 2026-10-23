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
import { compositionHash, type ManifestRead, MANIFEST_MAX_BYTES, PLUGIN_HOST_CONTRACT, pluginsOf, readManifest, reconcile, type RecordedLifecycle } from '../src/index.ts'

// The seam's own fake passes the suite every provider must pass (ADR-0037).
runSuite(pluginHostSuite, {
  name: 'the fake provider',
  contract: PLUGIN_HOST_CONTRACT,
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-plugin-host-'))
    const ctx = new Context()
    const kernel = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {})]
    await Promise.all(kernel)
    const ledger = new Map<string, RecordedLifecycle>()
    let host: ReturnType<Context['plugin']> | undefined
    return {
      start: async (composition) => {
        await host?.dispose()
        host = ctx.plugin(FakePluginHost, { composition, ledger })
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
