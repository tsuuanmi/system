import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import StoreResources from '@tsuuanmi/system-resources'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { charter, POLICY, until } from '../../profile-software-development/tests/pilot.ts'
import { type HealthSources } from '../src/health.ts'
import { leadHealth, type PolicyFiles } from '../src/lead.ts'
import { policyDrift } from '../src/policy-drift.ts'
import * as Report from '../src/index.ts'

// Policy drift (T352): the policy row of the health table, from the live set and the repository's
// policy files at the live install's commit.
vi.setConfig({ testTimeout: 120_000 })

const RULE = { id: 'read-cat', program: 'cat', positionals: [{ kind: 'path', scope: 'repository-read', min: 1, max: 20 }], note: 'reads files' }
/** The project policy the live set holds for p1 (what the repository's file says at its commit). */
const LIVE: AutonomyPolicy = {
  schema: 'autonomy-policy@1.4', id: 'p1.policy', version: 4, scope: 'project', projectId: 'p1', narrows: 'studio-default',
  rules: [{ actionClass: 'merge', mode: 'ask' }], default: 'ask', expiry: { defaultSeconds: 86_400, maxSeconds: 1_209_600 },
}
const file = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...structuredClone(LIVE), ...over })

describe('what differs between a policy file and the live record', () => {
  const live = structuredClone(LIVE) as unknown as Record<string, unknown>
  const differing = (f: Record<string, unknown>, l: Record<string, unknown>): string[] => policyDrift('policies/x.json', f, l).differing

  it('names the keys whose content differs, and never the version or a key only the live record carries', () => {
    expect(differing(file({ version: 9 }), live)).toEqual([])
    expect(differing(file({ commandRules: [RULE], webAccess: { grants: [] } }), live)).toEqual(['commandRules', 'webAccess'])
    // Key order is not content; a live-only key is not the file's to speak for.
    expect(differing({ b: 1, a: { y: 1, x: 2 } }, { a: { x: 2, y: 1 }, b: 1, liveOnly: true })).toEqual([])
    expect(differing({ a: [1, 2] }, { a: [2, 1] })).toEqual(['a'])
  })

  it('proposes the file at a version past the live one, and keeps a higher version of its own', () => {
    const proposal = (f: Record<string, unknown>, l: Record<string, unknown> | undefined) => policyDrift('policies/p1.json', f, l).proposal
    expect(proposal(file({ commandRules: [RULE] }), live)).toMatchObject({ version: 5, commandRules: [RULE], id: 'p1.policy' })
    expect(proposal(file({ version: 7 }), live)['version']).toBe(7)
    expect(proposal(file(), undefined)['version']).toBe(4)
    expect(policyDrift('policies/p1.json', file(), undefined)).toMatchObject({ id: 'p1.policy', differing: [], fileVersion: 4 })
  })
})

describe('the policy row of the health table', () => {
  const ok: HealthSources = {
    projectId: 'p1', asOf: '2026-10-30T12:00:00.000Z',
    dispatch: { value: { enabled: true, pausedProjects: [], bounds: [] } }, workers: { value: [{ worker: 'w1', state: 'ready' }] }, pools: { value: [{ pool: 'plan', available: true }] },
    notifySinks: { value: [{ sink: 'f', at: '2026-10-30T11:00:00.000Z', outcome: 'sent' }] }, leadSinks: { value: [{ sink: 'w', at: '2026-10-30T11:00:00.000Z', outcome: 'sent' }] },
    liveUpdate: { value: undefined }, landingQueue: { value: { depth: 0 } }, worktrees: { value: { total: 0, inUse: 0, held: 0, uncommitted: 0 } }, enforcement: { value: [] },
    disk: { value: { mode: 'warn', floorBytes: 10 * 1024 ** 3, worktrees: { path: '/w', freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }, store: { path: '/s', freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 } } },
    policies: { value: [] },
  }
  const row = (h: Report.Health, id: string) => h.rows.find((r) => r.id === id)

  it('is ok when the live content equals the file, degraded naming the keys when it does not, unknown when not read', () => {
    const live = structuredClone(LIVE) as unknown as Record<string, unknown>
    const equal = Report.buildHealth({ ...ok, policies: { value: [policyDrift('policies/p1.json', file({ version: 5 }), live)] } })
    expect(row(equal, 'policy:p1.policy')).toMatchObject({ state: 'ok' })
    expect(equal.state).toBe('ok')
    const drift = Report.buildHealth({ ...ok, policies: { value: [policyDrift('policies/p1.json', file({ commandRules: [RULE] }), live)] } })
    expect(row(drift, 'policy:p1.policy')).toMatchObject({ state: 'degraded' })
    expect(row(drift, 'policy:p1.policy')!.reason).toContain('commandRules')
    expect(row(drift, 'policy:p1.policy')!.reason).toContain('v4')
    expect(drift.state).toBe('degraded')
    const absent = Report.buildHealth({ ...ok, policies: { value: [policyDrift('policies/p1.json', file(), undefined)] } })
    expect(row(absent, 'policy:p1.policy')).toMatchObject({ state: 'degraded', reason: expect.stringContaining('no policy p1.policy is in force') })
    expect(row(Report.buildHealth({ ...ok, policies: { unknown: 'no build stamp' } }), 'policy')).toMatchObject({ state: 'unknown', reason: 'not read: no build stamp' })
    expect(row(Report.buildHealth(ok), 'policy')).toMatchObject({ state: 'ok' })
  })
})

describe('leadHealth reads the live set and the files at the install\'s commit', () => {
  async function boot(): Promise<Context> {
    const dir = mkdtempSync(join(tmpdir(), 'system-policy-drift-'))
    const ctx = new Context()
    const fibers: Fiber[] = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, { retainDays: 0 }), ctx.plugin(Leases, {}),
      ctx.plugin(StoreApprovals, { policies: [POLICY, LIVE], sweepSeconds: 3600 }), ctx.plugin(StoreResources, { pools: [] }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
    ]
    await Promise.all(fibers)
    await until(() => ctx.get('board'), 'the board')
    onTestFinished(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    await charter(ctx, 'p1')
    return ctx
  }
  const health = async (ctx: Context, policyFiles: () => Promise<PolicyFiles>) => {
    const result = await leadHealth(ctx, { events: () => [], policyFiles }, { projectId: 'p1' })
    return result.rows.filter((r) => r.id.startsWith('policy'))
  }
  const files = (...records: Array<Record<string, unknown>>) => async (): Promise<PolicyFiles> => ({ commit: 'a'.repeat(40), files: records.map((record, i) => ({ path: `policies/f${i}.json`, record })) })

  it('shows a file that adds a command rule as degraded, naming commandRules', async () => {
    const ctx = await boot()
    const rows = await health(ctx, files(file({ commandRules: [RULE] })))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'policy:p1.policy', state: 'degraded' })
    expect(rows[0]!.reason).toContain('commandRules')
    expect(rows[0]!.reason).toContain('v4')
  })

  it('shows equal content as ok, though the file carries another version, and ignores another project\'s file', async () => {
    const ctx = await boot()
    const rows = await health(ctx, files(file({ version: 6 }), file({ id: 'other.policy', projectId: 'p2', commandRules: [RULE] })))
    expect(rows.map((r) => [r.id, r.state])).toEqual([['policy:p1.policy', 'ok']])
  })

  it('shows a project policy the live set lacks as degraded, and an unreadable repository as unknown', async () => {
    const ctx = await boot()
    expect((await health(ctx, files(file({ id: 'p1.new' }))))[0]).toMatchObject({ id: 'policy:p1.new', state: 'degraded' })
    const unread = await health(ctx, async () => { throw new Error('no build stamp at /x') })
    expect(unread).toEqual([{ id: 'policy', name: 'Policy files', state: 'unknown', reason: 'not read: no build stamp at /x' }])
  })
})
