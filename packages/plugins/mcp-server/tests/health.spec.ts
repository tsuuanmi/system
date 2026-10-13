import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type HealthSources, healthReport } from '../src/health.ts'

const home = mkdtempSync(join(tmpdir(), 'system-health-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const base = (extra: Partial<HealthSources> = {}): HealthSources => ({
  dshHome: home, storeCheck: () => 'ok', accounts: async () => [{ id: 'main', status: 'ready' }], workers: async () => [{ worker: 'w1', state: 'ready' }],
  events: () => [], nodeVersion: '24.21.0', minFreeBytes: 1, driftWindowMs: 86_400_000, ...extra,
})
const check = async (extra: Partial<HealthSources>, name: string) => (await healthReport(base(extra))).checks.find((c) => c.name === name)

describe('host health (REQ-HOST-6)', () => {
  it('is ok when every check is, and names each check', async () => {
    const report = await healthReport(base())
    expect(report.state).toBe('ok')
    expect(report.checks.map((c) => c.name)).toEqual(['runtime', 'store', 'disk', 'vault-key', 'accounts', 'workers', 'ui-drift'])
  })

  it('is degraded by an account to sign in again, an unavailable Worker, low disk, or a vault key beside the vault, saying what to do', async () => {
    expect(await check({ accounts: async () => [{ id: 'main', status: 'reauth-required' }] }, 'accounts')).toMatchObject({ state: 'degraded', detail: expect.stringContaining('main (reauth-required)') })
    expect(await check({ workers: async () => [{ worker: 'w1', state: 'ready' }, { worker: 'w2', state: 'unavailable' }] }, 'workers')).toMatchObject({ state: 'degraded', detail: expect.stringContaining('w2') })
    expect(await check({ minFreeBytes: Number.MAX_SAFE_INTEGER }, 'disk')).toMatchObject({ state: 'degraded' })
    mkdirSync(join(home, 'system'), { recursive: true })
    writeFileSync(join(home, 'system', 'vault.key'), 'k')
    expect(await check({}, 'vault-key')).toMatchObject({ state: 'degraded', detail: expect.stringContaining('key-custody') })
    rmSync(join(home, 'system', 'vault.key'))
  })

  it('is degraded by a provider UI change in the window: a drift event, or a step that failed as ui_drift', async () => {
    const events = (type: string) => (type === 'workflow.node.failed' ? [{ data: { kind: 'ui_drift' } }, { data: { kind: 'quota_exhausted' } }] : [])
    expect(await check({ events }, 'ui-drift')).toMatchObject({ state: 'degraded', detail: expect.stringMatching(/^1 provider UI change/) })
  })

  it('is down when the store fails its integrity check, no Worker is available, or the runtime is outside the supported range', async () => {
    expect((await healthReport(base({ storeCheck: () => 'row 7 missing from index' }))).state).toBe('down')
    expect((await healthReport(base({ workers: async () => [{ worker: 'w1', state: 'unavailable' }] }))).state).toBe('down')
    expect((await healthReport(base({ nodeVersion: '22.23.3' }))).state).toBe('down')
  })
})
