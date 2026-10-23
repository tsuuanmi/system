import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import { MANIFEST_MAX_BYTES } from '@tsuuanmi/system-plugin-host-core'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import { manifestText } from '../../../plugin-host-core/conformance/plugin-host.ts'
import StorePluginHost, { compositionOf, type LoaderView, packageBases, packageDir, packageManifest } from '../src/index.ts'
import { install, stubLoader } from './composition.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'system-plugin-host-'))
  dirs.push(dir)
  return dir
}

describe('the composition, from the DSH loader', () => {
  it('takes every plugin entry, mounted or not, by its own id, and no group or include that carries rows (REQ-HOST-4, REQ-HOST-7)', () => {
    const loader: LoaderView = {
      ctx: {},
      *entries() {
        yield { options: { id: 'store', name: '@x/store' }, disabled: false }
        yield { options: { id: 'group-1', name: 'cordis:group', group: true }, disabled: false }
        yield { options: { id: 'bundle', name: '@deepseek-ai/cordis-plugin-include' }, disabled: false, subtree: {} }
        yield { options: { id: 'codex', name: '@x/codex' }, disabled: true }
      },
    }
    expect(compositionOf(loader)).toEqual([{ id: 'store', name: '@x/store', mounted: true }, { id: 'codex', name: '@x/codex', mounted: false }])
  })
})

describe('finding a row\'s package', () => {
  it('looks in the profile, then in each bundle composed into it, as the launcher resolves a bundle\'s rows', () => {
    const profile = join(temp(), 'profile')
    install(profile, { '@x/own': manifestText('@x/own') })
    const bundle = join(profile, 'node_modules', '@x', 'bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: '@x/bundle' }))
    install(bundle, { '@x/plugin': manifestText('@x/plugin') })
    const loader = stubLoader(profile, [])
    expect(packageBases(loader, undefined)).toEqual([`${profile}/`])
    const bases = packageBases(loader, { startedBundles: ['@x/bundle', '@x/not-installed'] })
    expect(bases).toEqual([`${profile}/`, bundle])
    expect(packageDir('@x/plugin', bases)).toBe(join(bundle, 'node_modules', '@x', 'plugin'))
    expect(packageDir('@x/own', bases)).toBe(join(profile, 'node_modules', '@x', 'own'))
    expect(packageDir('@x/plugin', [`${profile}/`])).toBeUndefined()
    expect(packageDir('./local-plugin.js', bases)).toBeUndefined()
    expect(packageDir('cordis:group', bases)).toBeUndefined()
    expect(packageManifest('@x/missing', bases)).toEqual({ state: 'absent', reason: 'the package @x/missing cannot be found from the profile' })
  })

  it('refuses a manifest past the size bound without reading it whole (INV-9)', () => {
    const profile = temp()
    install(profile, { '@x/big': ' '.repeat(MANIFEST_MAX_BYTES + 1) })
    expect(packageManifest('@x/big', [profile])).toMatchObject({ state: 'refused', reason: expect.stringMatching(/larger than 65536 bytes/) })
  })
})

describe('recording', () => {
  it('records both every decision and every state, or neither: a decision that cannot be recorded leaves the records as they were, and the host does not start (INV-13, INV-2)', async () => {
    const dir = temp()
    const profile = join(dir, 'profile')
    install(profile, { '@x/a': manifestText('@x/a'), '@x/b': manifestText('@x/b') })
    const ctx = new Context()
    const kernel = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {})]
    await Promise.all(kernel)
    const loader = stubLoader(profile, [{ id: 'a', name: '@x/a', mounted: true }, { id: 'b', name: '@x/b', mounted: true }])
    const provided = ctx.plugin({ name: 'loader', apply: (c: Context) => void c.provide('loader', loader) })
    await provided
    const record = ctx.artifacts.recordDecision.bind(ctx.artifacts)
    let calls = 0
    ctx.artifacts.recordDecision = (decision, meta) => {
      if (++calls === 2) throw new TypeError('the store refused the decision')
      return record(decision, meta)
    }
    const host = ctx.plugin(StorePluginHost)
    await expect((async () => host)()).rejects.toThrow(/the store refused the decision/)
    expect(ctx.get('pluginHost')).toBeUndefined()
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'lifecycle' })).toEqual([])
    expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM plugin_lifecycle').get()).toEqual({ n: 0 })
    ctx.artifacts.recordDecision = record
    await host.dispose()
    const again = ctx.plugin(StorePluginHost)
    await again
    expect(ctx.pluginHost.list().map((p) => p.lifecycle?.state)).toEqual(['default', 'default'])
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'lifecycle' })).toHaveLength(2)
    for (const fiber of [again, provided, ...kernel.reverse()]) await fiber.dispose()
  })

  it('keeps every lifecycle decision through the artifacts\' retention: the record names the latest, and each decision the one before it (INV-13)', async () => {
    const dir = temp()
    const profile = join(dir, 'profile')
    install(profile, { '@x/a': manifestText('@x/a') })
    const boot = async (mounted: boolean): Promise<{ ctx: Context; stop: () => Promise<void> }> => {
      const ctx = new Context()
      const loader = stubLoader(profile, [{ id: 'a', name: '@x/a', mounted }])
      const fibers = [
        ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, { collectGraceHours: 1 }),
        ctx.plugin({ name: 'loader', apply: (c: Context) => void c.provide('loader', loader) }), ctx.plugin(StorePluginHost),
      ]
      await Promise.all(fibers)
      return { ctx, stop: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
    }
    for (const mounted of [true, false]) await (await boot(mounted)).stop()
    const { ctx, stop } = await boot(true)
    const decisions = ctx.artifacts.list({ kind: 'decision', decisionType: 'lifecycle' })
    expect(decisions).toHaveLength(3)
    // Collect as if every decision were past its grace period.
    ctx.store.db.prepare('UPDATE artifacts SET created_at = ?').run('2000-01-01T00:00:00.000Z')
    await ctx.artifacts.collect()
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'lifecycle' })).toHaveLength(3)
    await stop()
  })
})

// The URL the stub loader gives is the one DSH's root context carries: the profile directory, with a slash.
it('reads the profile from the loader\'s base URL', () => {
  const profile = temp()
  expect(packageBases({ ctx: { baseUrl: pathToFileURL(`${profile}/`).href }, entries: () => [] }, { dir: '/elsewhere' })).toEqual([`${profile}/`])
  expect(packageBases({ ctx: {}, entries: () => [] }, { dir: profile })).toEqual([profile])
  expect(packageBases({ ctx: {}, entries: () => [] }, undefined)).toEqual([])
})
