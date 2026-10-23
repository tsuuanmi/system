import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type HealthSources, healthReport, MAX_UNKNOWN_ENTRIES } from '../src/health.ts'

const home = mkdtempSync(join(tmpdir(), 'system-health-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const base = (extra: Partial<HealthSources> = {}): HealthSources => ({
  dshHome: home, storeCheck: () => 'ok', keyCustody: () => ({ keyApart: true }), accounts: async () => [{ id: 'main', status: 'ready' }], workers: async () => [{ worker: 'w1', state: 'ready' }],
  events: () => [], nodeVersion: '24.21.0', minFreeBytes: 1, driftWindowMs: 86_400_000, ...extra,
})
const check = async (extra: Partial<HealthSources>, name: string) => (await healthReport(base(extra))).checks.find((c) => c.name === name)

describe('host health (REQ-HOST-6)', () => {
  it('is ok when every check is, and names each check', async () => {
    const report = await healthReport(base())
    expect(report.state).toBe('ok')
    expect(report.checks.map((c) => c.name)).toEqual(['runtime', 'store', 'disk', 'vault-key', 'accounts', 'workers', 'ui-drift', 'retention'])
  })

  it('is degraded by an account to sign in again, a Worker that cannot take work, or low disk, saying what to do', async () => {
    expect(await check({ accounts: async () => [{ id: 'main', status: 'reauth-required' }] }, 'accounts')).toMatchObject({ state: 'degraded', detail: expect.stringContaining('main (reauth-required)') })
    expect(await check({ workers: async () => [{ worker: 'w1', state: 'ready' }, { worker: 'w2', state: 'reauth-required' }] }, 'workers')).toMatchObject({ state: 'degraded', detail: expect.stringContaining('w2 (reauth-required)') })
    expect(await check({ minFreeBytes: Number.MAX_SAFE_INTEGER }, 'disk')).toMatchObject({ state: 'degraded' })
  })

  it('is degraded by accounts signed in as one person, naming them and the runbook (REQ-ACC-7)', async () => {
    const duplicates = await check({ duplicateAccounts: async () => [['chatgpt-main', 'chatgpt-2']] }, 'accounts')
    expect(duplicates).toMatchObject({ state: 'degraded', detail: expect.stringMatching(/^chatgpt-main and chatgpt-2 are signed in as the same person, so none of them takes work: .*runbooks\.md#two-accounts-sign-in-as-one-person/) })
    // With an account to sign in again too, both are named.
    const both = await check({ accounts: async () => [{ id: 'main', status: 'reauth-required' }], duplicateAccounts: async () => [['a', 'b']] }, 'accounts')
    expect(both?.detail).toMatch(/main \(reauth-required\).*; a and b are signed in as the same person/)
    expect(await check({ duplicateAccounts: async () => [] }, 'accounts')).toMatchObject({ state: 'ok' })
    // A source that cannot say fails the check closed, as any other.
    expect(await check({ duplicateAccounts: async () => { throw new Error('vault locked') } }, 'accounts')).toMatchObject({ state: 'down', detail: expect.stringContaining('vault locked') })
  })

  it('advises on a vault key beside the vault without alarming: the default must not page every install', async () => {
    expect(await check({ keyCustody: () => ({ keyApart: false }) }, 'vault-key')).toMatchObject({ state: 'ok', detail: expect.stringContaining('key-custody') })
  })

  it('reports a check whose source throws as down, and still reports every other check', async () => {
    const report = await healthReport(base({ accounts: async () => { throw new Error('duplicate account id') } }))
    expect(report.checks.find((c) => c.name === 'accounts')).toMatchObject({ state: 'down', detail: expect.stringContaining('duplicate account id') })
    expect(report.checks.map((c) => c.name)).toContain('ui-drift')
  })

  it('is degraded while a pool has a run whose usage the ledger could not count in its current window, naming the pool and the count (D25)', async () => {
    const now = Date.parse('2026-10-23T12:00:00Z')
    const fact = (runId: string, pool: string, kind: string, at: string) => ({
      at, data: { schema: 'usage-unknown@1.0', runId, kind, account: 'max', pool, observedAt: at, reason: 'why', ...(kind === 'refused' ? { failure: 'invalid' } : {}) },
    })
    const entries = [
      fact('arun_1', 'max.agents', 'not-reported', '2026-10-23T10:00:00.000Z'),
      fact('arun_2', 'max.agents', 'refused', '2026-10-23T11:00:00.000Z'),
      // The same run again (a restart found it interrupted): it counts once, by its first fact.
      fact('arun_2', 'max.agents', 'interrupted', '2026-10-23T11:30:00.000Z'),
      // Before the pool's longest window: it no longer bears on what the pool admits.
      fact('arun_3', 'max.agents', 'not-reported', '2026-10-23T06:59:59.000Z'),
      // Reconciled: the ledger counts a record of it now.
      fact('arun_4', 'max.agents', 'failed', '2026-10-23T11:00:00.000Z'),
      // A credit balance never resets: every unreconciled run counts.
      fact('arun_5', 'api.key', 'not-reported', '2026-09-01T00:00:00.000Z'),
      // A pool no longer configured is skipped; an entry that is no record is said, never skipped silently.
      fact('arun_6', 'gone.pool', 'not-reported', '2026-10-23T11:00:00.000Z'),
      { at: '2026-10-23T11:00:00.000Z', data: { kind: 'not-reported', pool: 'max.agents' } },
    ]
    const asked: string[] = []
    const unknownUsage = {
      pools: async () => [{ pool: 'max.agents', windows: [{ seconds: 3600 }, { seconds: 18_000 }] }, { pool: 'api.key', windows: [{}] }],
      entries: (since: string) => (asked.push(since), entries),
      counted: async (runId: string) => runId === 'arun_4',
    }
    const report = await healthReport(base({ unknownUsage, now: () => now }))
    expect(report.state).toBe('degraded')
    expect(report.checks.find((c) => c.name === 'usage')).toEqual({
      name: 'usage', state: 'degraded',
      detail: 'api.key: 1 run(s) in its current window (it has a window that never resets) whose usage the ledger could not count (1 not-reported); '
        + 'max.agents: 2 run(s) in its current window (the last 5h) whose usage the ledger could not count (1 not-reported, 1 refused); '
        + '1 usage.unknown entry is not a valid usage-unknown@1.0 record, so no pool counts it. '
        + 'A cap counts each as 0 until the ledger counts a record of it: see system events --type usage.unknown (docs/operations/runbooks.md#usage-the-ledger-could-not-count)',
    })
    // Read once, back to the earliest window's start: the start of time for a window that never resets.
    expect(asked).toEqual([new Date(0).toISOString()])
  })

  it('is ok once every such run is reconciled or out of its window, says when it read only part, and with no pool configured', async () => {
    const at = '2026-10-23T11:00:00.000Z'
    const one = { at, data: { schema: 'usage-unknown@1.0', runId: 'arun_1', kind: 'not-reported', account: 'max', pool: 'max.agents', observedAt: at, reason: 'why' } }
    const pools = async () => [{ pool: 'max.agents', windows: [{ seconds: 18_000 }] }]
    const now = () => Date.parse('2026-10-23T12:00:00Z')
    expect(await check({ unknownUsage: { pools, entries: () => [one], counted: async () => true }, now }, 'usage')).toMatchObject({ state: 'ok', detail: 'the ledger counted the usage of every run in each pool\'s current window' })
    expect(await check({ unknownUsage: { pools, entries: () => [one], counted: async () => false }, now: () => Date.parse('2026-10-24T12:00:00Z') }, 'usage')).toMatchObject({ state: 'ok' })
    expect(await check({ unknownUsage: { pools: async () => [], entries: () => [one], counted: async () => false } }, 'usage')).toMatchObject({ state: 'ok', detail: 'no resource pool is configured' })
    const full = Array.from({ length: MAX_UNKNOWN_ENTRIES }, (_, i) => ({ ...one, data: { ...one.data, runId: `arun_${i}` } }))
    expect(await check({ unknownUsage: { pools, entries: () => full, counted: async () => false }, now }, 'usage')).toMatchObject({ state: 'degraded', detail: expect.stringMatching(/^max\.agents: 1000 run\(s\) .* \(counted from the first 1000 entries only\)\. /) })
    // A ledger that cannot be read leaves the check down, saying why, never ok.
    expect(await check({ unknownUsage: { pools: async () => { throw new Error('the store is closed') }, entries: () => [], counted: async () => false } }, 'usage')).toMatchObject({ state: 'down', detail: expect.stringContaining('the store is closed') })
  })

  it('is degraded by a provider UI change in the window: a drift event, or a step that failed as ui_drift', async () => {
    const events = (type: string) => (type === 'workflow.node.failed' ? [{ data: { kind: 'ui_drift' } }, { data: { kind: 'quota_exhausted' } }] : [])
    expect(await check({ events }, 'ui-drift')).toMatchObject({ state: 'degraded', detail: expect.stringMatching(/^1 provider UI change/) })
  })

  it('counts each stale element of a map once, however often it recurs, and names it', async () => {
    const drift = (element: string, mapHash = 'sha256:aa') => ({ data: { provider: 'chatgpt-web', element, candidate: 1, source: 'shipped', mapHash } })
    const events = (type: string) => (type === 'ui.drift'
      ? [drift('composer.form'), drift('composer.form'), drift('answer.code'), drift('composer.form'), drift('composer.form', 'sha256:bb')]
      : [])
    expect(await check({ events }, 'ui-drift')).toMatchObject({
      state: 'degraded',
      detail: '3 provider UI change(s) seen recently (chatgpt-web answer.code, chatgpt-web composer.form): update the UI map (docs/operations/playbooks.md)',
    })
  })

  it('is down when a plugin is not running, and degraded by a refused template, naming each', async () => {
    expect(await check({ plugins: () => [{ name: 'workflow', state: 'failed', detail: 'node panel: team must be …' }] }, 'plugins'))
      .toMatchObject({ state: 'down', detail: expect.stringMatching(/^workflow failed: node panel: team must be …/) })
    expect((await healthReport(base({ plugins: () => [] }))).checks.find((c) => c.name === 'plugins')).toMatchObject({ state: 'ok' })
    expect(await check({ templates: () => [{ name: 'panel-led', reason: 'node panel: team must be {kind: …}' }] }, 'templates'))
      .toMatchObject({ state: 'degraded', detail: '1 configured template(s) refused, every other one works: panel-led (node panel: team must be {kind: …})' })
  })

  it('is down while the manifest check found something in a plugin a row mounts, naming each finding and what to do (REQ-HOST-7, INV-2, ADR-0048)', async () => {
    const valid = { name: '@x/b', mounted: true, state: 'valid' as const, findings: [] }
    expect(await check({ manifests: () => [{ name: '@x/a', mounted: true, state: 'absent', reason: '@x/a ships no plugin-manifest.json', findings: ['it runs with no manifest: @x/a ships no plugin-manifest.json'] }, valid, { name: '@x/c', mounted: true, state: 'valid', findings: ['it consumes ctx.thing in the range ^2.0.0, which @x/p does not satisfy: it provides 1.0.0', 'another'] }] }, 'manifests'))
      .toMatchObject({ state: 'down', detail: expect.stringMatching(/^@x\/a: it runs with no manifest: @x\/a ships no plugin-manifest\.json; @x\/c: it consumes ctx\.thing .*; another\. The plugin host cannot keep a row from running: turn the row off, or fix or allow its package, and restart \(docs\/operations\/runbooks\.md#the-manifest-check-found-a-plugin\)$/) })
  })

  it('is degraded by a manifest the plugin host refused in a row that is off, and notes the packages that run with none as its configuration allows (REQ-HOST-7)', async () => {
    const allowed = { name: '@deepseek-ai/dsh-llm', mounted: true, state: 'absent' as const, reason: 'ships none', findings: [] }
    expect(await check({ manifests: () => [{ name: '@x/a', mounted: false, state: 'refused', reason: 'it declares _meta, which belongs to the host', findings: [] }, allowed] }, 'manifests'))
      .toMatchObject({ state: 'degraded', detail: expect.stringMatching(/^@x\/a: it declares _meta, which belongs to the host: its row is off, and its lifecycle is not recorded/) })
    expect(await check({ manifests: () => [allowed, { name: '@x/off', mounted: false, state: 'absent', reason: 'ships none', findings: [] }] }, 'manifests'))
      .toMatchObject({ state: 'ok', detail: 'every plugin a row mounts passes the manifest check; 1 of them run with no manifest, as the plugin host\'s configuration allows: @deepseek-ai/dsh-llm; 1 row(s) that are off have none: @x/off' })
    expect(await check({ manifests: () => [] }, 'manifests')).toMatchObject({ state: 'ok', detail: 'every plugin a row mounts passes the manifest check' })
    expect(await check({}, 'manifests')).toBeUndefined()
  })

  it('notes what retention removed recently, without degrading health', async () => {
    const events = (type: string) => (type === 'workflow.retention.swept' ? [{ data: { runs: 40, conversations: 12, retainRunsDays: 30 } }, { data: { runs: 2, conversations: 0, retainRunsDays: 30 } }] : [])
    expect(await check({ events }, 'retention')).toMatchObject({ state: 'ok', detail: expect.stringMatching(/^retention expired 42 run\(s\) and released 12 website conversation\(s\)/) })
  })

  it('is degraded by website conversations whose deletion failed every attempt (PROP-0004 Phase 5)', async () => {
    expect(await check({ undeleted: () => [{ account: 'gemini-main', binding: 'b1', reason: 'ui_drift: …' }, { account: 'chatgpt-main', binding: 'b2' }] }, 'conversations'))
      .toMatchObject({ state: 'degraded', detail: expect.stringMatching(/^2 website conversation\(s\) of chatgpt-main, gemini-main could not be deleted/) })
    expect(await check({ undeleted: () => [] }, 'conversations')).toMatchObject({ state: 'ok' })
  })

  it('shows a login profile a process holds that could not be stopped, and the profiles held for a login or for work (ADR-0030)', async () => {
    expect(await check({ profiles: () => [{ account: 'gemini-main', open: false, pages: 0, reserved: false, blocked: 'process 42 still runs Chrome on gemini-main\'s login profile and could not be stopped: stop it, then retry' }] }, 'login-profiles'))
      .toMatchObject({ state: 'degraded', detail: expect.stringMatching(/^gemini-main: process 42 .*stop it, then retry$/) })
    expect(await check({ profiles: () => [{ account: 'gemini-main', open: false, pages: 0, kept: 0, reserved: true }, { account: 'gemini-2', open: true, pages: 1, kept: 2, reserved: false }] }, 'login-profiles'))
      .toMatchObject({ state: 'ok', detail: expect.stringMatching(/remote login: gemini-main .*open for work: gemini-2 \(2 kept tab\(s\)\)/) })
    // Against the cap, when one is set (PROP-0007).
    expect(await check({ profiles: () => [{ account: 'gemini-2', open: true, pages: 1, reserved: false }], browserCap: 2 }, 'login-profiles'))
      .toMatchObject({ state: 'ok', detail: 'open for work (1 of at most 2): gemini-2' })
  })

  it('counts a reported drift and the turn it failed as one change', async () => {
    const events = (type: string) => (type === 'ui.drift'
      ? [{ data: { provider: 'gemini-web', element: 'temporary.enable', kind: 'postcondition', candidate: -1, mapHash: 'sha256:aa' } }]
      : [{ data: { kind: 'ui_drift', message: 'gemini-web: temporary.enable did not reach its postcondition' } }, { data: { kind: 'ui_drift', message: 'gemini-web: the report cannot be read' } }])
    expect(await check({ events }, 'ui-drift')).toMatchObject({ detail: expect.stringMatching(/^2 provider UI change\(s\) seen recently \(gemini-web temporary\.enable\)/) })
  })

  it('is down when the store fails its integrity check, no Worker is available, or the runtime is outside the supported range', async () => {
    expect((await healthReport(base({ storeCheck: () => 'row 7 missing from index' }))).state).toBe('down')
    expect((await healthReport(base({ workers: async () => [{ worker: 'w1', state: 'reauth-required' }, { worker: 'w2', state: 'quota-exhausted' }] }))).state).toBe('down')
    expect((await healthReport(base({ nodeVersion: '22.23.3' }))).state).toBe('down')
  })
})
