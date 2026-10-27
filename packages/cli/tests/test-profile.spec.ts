// The system-test profile (T323): the profile every live update runs on first, apart from the live one.
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { LIVE_PROFILE, stagePatch, stateDir, TEST_OFF_ROWS, TEST_PORT, TEST_PROFILE, testOffPackages, testProfileManifest, testProfilePatch, useProfile } from '../src/index.ts'

const BUNDLE_PATCH = resolve(dirname(fileURLToPath(import.meta.url)), '../../system-bundle/cordis.patch.yml')
const HOME = '/home/operator/.dsh'

interface Row { id: string; name?: string; config?: Record<string, unknown>; disabled?: boolean }

/** The live bundle's rows, and the test profile's patch of a live patch that holds accounts. */
const bundleRows = (): Row[] => (parse(readFileSync(BUNDLE_PATCH, 'utf8')) as Array<{ insert: Row[] }>).flatMap((p) => p.insert)
const LIVE_PATCH: unknown[] = [
  { id: 'accounts', config: { catalog: [{ provider: 'chatgpt-web', slot: 1 }] } },
  { id: 'agent-workers', config: { workers: [{ name: 'developer', account: 'claude-1' }] } },
  { id: 'login', config: { profilesDir: '/home/operator/.dsh/system/login-profiles' } },
  { id: 'workflow', config: { retries: 3 } },
  { id: 'models', config: { catalog: [{ id: 'api-model' }] } },
  // An operator's own row, and a second agent-workers instance on another account: the first is a mechanism switched on, the second signs in.
  { insert: [{ id: 'operator-row', name: 'operator-plugin' }, { id: 'agents-2', name: '@tsuuanmi/system-agent-workers', config: { workers: [{ name: 'reviewer', account: 'codex-2' }] } }] },
  { id: 'agents-2', config: { workers: [{ name: 'reviewer', account: 'codex-3' }] } },
]
const offPackages = (): Set<string> => testOffPackages(resolve(dirname(BUNDLE_PATCH)))
const testPatch = (): Array<Row & { insert?: Row[] }> => parse(testProfilePatch(`${HOME}/${TEST_PROFILE}`, LIVE_PATCH, offPackages())) as Array<Row & { insert?: Row[] }>

afterEach(() => useProfile(LIVE_PROFILE))

describe('the system-test profile', () => {
  it('keeps its data directory and its port apart from the live profile', () => {
    useProfile(LIVE_PROFILE)
    const live = stateDir(HOME)
    useProfile(TEST_PROFILE)
    const test = stateDir(HOME)
    expect(live).toBe(join(HOME, 'system'))
    expect(test).toBe(join(HOME, 'system-test'))
    // Neither directory is inside the other.
    expect(relative(live, test).startsWith('..')).toBe(true)
    expect(relative(test, live).startsWith('..')).toBe(true)

    const livePort = bundleRows().find((r) => r.id === 'webserver')!.config!.port
    const port = testPatch().find((r) => r.id === 'webserver')!.config!.port
    expect(port).toBe(TEST_PORT)
    expect(port).not.toBe(livePort)

    // Every file the test profile keeps (store, vault and its key, tokens, discovery) is under its own directory.
    const rows = Object.fromEntries(testPatch().map((r) => [r.id, r.config ?? {}]))
    const paths = [rows.store!.path, rows.credentials!.path, rows.credentials!.keyFile, rows['web-ui']!.tokenDir, rows['mcp-server']!.tokenDir, rows['mcp-server']!.discoveryFile] as string[]
    for (const path of paths) expect(path.startsWith(`${test}/`) || path === test, path).toBe(true)
    expect(paths.some((p) => p.startsWith(`${live}/`) || p === live)).toBe(false)
  })

  it('configures no website or agent account of the live profile', () => {
    const rows = testPatch()
    // Every row that signs in to an account is off, so its Workers, sessions and browser contexts are never opened.
    for (const id of TEST_OFF_ROWS) expect(rows.find((r) => r.id === id)?.disabled, id).toBe(true)
    for (const id of ['accounts', 'login', 'turns', 'browser', 'provider-chatgpt-web', 'provider-gemini-web', 'agent-workers', 'agent-runtimes']) expect(TEST_OFF_ROWS).toContain(id)
    // The live patch's account catalog, agent Workers and login profiles are not carried over; its other rows are.
    expect(rows.some((r) => r.config && JSON.stringify(r.config).includes('claude-1'))).toBe(false)
    expect(rows.some((r) => r.config && JSON.stringify(r.config).includes('chatgpt-web'))).toBe(false)
    expect(rows.some((r) => JSON.stringify(r).includes('codex-2') || JSON.stringify(r).includes('codex-3'))).toBe(false)
    // The rest of the live patch is kept whole, an operator's inserted row included: what live switches on, the stage runs.
    expect(stagePatch(LIVE_PATCH, offPackages())).toEqual([LIVE_PATCH[3], LIVE_PATCH[4], { insert: [{ id: 'operator-row', name: 'operator-plugin' }] }])
    expect(rows.some((r) => r.insert?.some((i) => i.id === 'operator-row'))).toBe(true)
    expect(rows.some((r) => r.id === 'models' && !r.disabled)).toBe(true)
    // The Workers are the fakes: the bundle ships that row off, and the test profile turns it on, last (so it wins).
    expect(bundleRows().find((r) => r.id === 'workers-fake')?.disabled).toBe(true)
    expect(rows.filter((r) => r.id === 'workers-fake').at(-1)?.disabled).toBe(false)
    // The rows that sign in are optional ones of the bundle (so turning them off breaks nothing required).
    const bundle = bundleRows().map((r) => r.id)
    for (const id of TEST_OFF_ROWS) expect(bundle, id).toContain(id)
  })

  it('composes the live profile\'s bundles: its preset layer and every bundle the operator added', () => {
    const live = {
      name: 'dsh-profile-system', private: true,
      dependencies: { '@tsuuanmi/system-bundle': 'link:/live/packages/system-bundle', '@tsuuanmi/system-preset-api-first': 'link:/live/packages/system-bundle/presets/api-first', 'operator-bundle': '^1.0.0' },
      dsh: { profile: { bundles: ['@tsuuanmi/system-bundle', '@tsuuanmi/system-preset-api-first', 'operator-bundle'] } },
    }
    const manifest = testProfileManifest(live, '/stage/packages/system-bundle')
    expect(manifest.name).toBe('dsh-profile-system-test')
    expect(manifest.dsh.profile.bundles).toEqual(live.dsh.profile.bundles)
    // Linked from the installation being staged, as init links any profile; the operator's own bundle as live has it.
    expect(manifest.dependencies).toEqual({
      '@tsuuanmi/system-bundle': 'link:/stage/packages/system-bundle', '@tsuuanmi/system-preset-api-first': 'link:/stage/packages/system-bundle/presets/api-first', 'operator-bundle': '^1.0.0',
    })
    // Without a preset in the live profile, none here either.
    expect(testProfileManifest({ dsh: { profile: { bundles: ['@tsuuanmi/system-bundle'] } } }, '/b').dsh.profile.bundles).toEqual(['@tsuuanmi/system-bundle'])
  })

  it('refuses a live patch entry it cannot reproduce, rather than stage another composition', () => {
    expect(() => stagePatch([{ remove: 'workflow' }])).toThrow('cannot reproduce')
    expect(() => stagePatch(['workflow'])).toThrow('cannot reproduce')
  })

  it('refuses a profile that is neither of the two', () => {
    expect(() => useProfile('other')).toThrow('no such profile')
  })
})
