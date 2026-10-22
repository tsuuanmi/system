// What the conformance suite does not cover: the policy set checked at load (each load-time rule),
// restart persistence, a verdict race on one store and across processes, the queue's own clock,
// the batch bound, paging bounds, records that fail their schema, and the MCP tools' outputs.
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { type Action, type ApprovalRequest, ApprovalsError, type AutonomyPolicy, type NewRequest, type Subject, type VerdictResult } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z as zod } from 'zod'
import { POLICIES } from '../../../approvals-core/conformance/approvals.ts'
import StoreApprovals, { checkConfig, type Config, policyProblems } from '../src/index.ts'
import { APPROVAL_TOOLS, type ApprovalTool, INPUTS } from '../src/tools.ts'

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
const [STUDIO, PROJECT] = POLICIES as [AutonomyPolicy, AutonomyPolicy, AutonomyPolicy]

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'system-approvals-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface Booted { ctx: Context; dir: string; approvals: StoreApprovals; mcp: () => RecordingMcp; stop: () => Promise<void> }

async function boot(options: { dir?: string; config?: Partial<Config>; eventLog?: boolean; mcp?: boolean } = {}): Promise<Booted> {
  const dir = options.dir ?? tempDir()
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ...(options.eventLog ? [ctx.plugin(EventLog, {})] : []),
    ...(options.mcp ? [ctx.plugin(RecordingMcp)] : []), ctx.plugin(StoreApprovals, { policies: POLICIES, sweepSeconds: 0, ...options.config }),
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
  cleanups.push(stop)
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
      [[{ ...STUDIO, default: 'auto' }], /^policy studio: autonomy-policy@1\.0: /],
      [[{ ...PROJECT, scope: 'studio' }], /^policy p1\.policy: autonomy-policy@1\.0: /],
      ['studio', /^policies must be a list of autonomy-policy@1\.0 records$/],
    ]
    for (const [policies, problem] of cases) expect(policyProblems(policies), JSON.stringify(policies).slice(0, 120)).toContainEqual(expect.stringMatching(problem))
    expect(policyProblems(POLICIES)).toEqual([])
    // The `system check` preflight names every problem, as the plugin would refuse it.
    expect(checkConfig({ policies: POLICIES })).toEqual([])
    expect(checkConfig({ policies: [PROJECT] })).toEqual(['exactly one studio policy is needed; 0 configured', 'policy p1.policy: narrows studio, which is not a configured studio policy'])
    expect(checkConfig({})).toEqual(['policies must be a list of autonomy-policy@1.0 records'])
    // The Config schema itself refuses a row with no policies at all.
    expect(() => StoreApprovals.Config({ sweepSeconds: 60 } as unknown as Config)).toThrow(/policies/)
  })

  it('provides no ctx.approvals when the policy set is refused, and logs why (fail-closed rule 5, INV-2)', async () => {
    const ctx = new Context()
    const errors = logged(ctx, 'error')
    const store = ctx.plugin(Store, { path: join(tempDir(), 'system.db') })
    await store
    cleanups.push(() => store.dispose())
    const artifacts = ctx.plugin(Artifacts, {})
    await artifacts
    cleanups.push(() => artifacts.dispose())
    for (const policies of [[PROJECT], [{ ...STUDIO, expiry: { defaultSeconds: 120, maxSeconds: 300 } }], []]) {
      const fiber = ctx.plugin(StoreApprovals, { policies, sweepSeconds: 0 })
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
    expect(effective.map((e) => e.actionClass)).toEqual(['read', 'workspace-write', 'merge', 'command', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change'])
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
    const second = await boot({ dir: first.dir, config: { sweepSeconds: 3600 } })
    await vi.waitFor(async () => expect((await second.ctx.approvals.get(stale.requestId))?.resolution?.cause).toBe('expired'), { timeout: 5000, interval: 50 })
  })
})

describe('the queue\'s own clock', () => {
  it('sweeps and batches every sweepSeconds with no caller: an expired request is denied, an open one that waited is batched (INV-2, INV-9)', async () => {
    const { ctx } = await boot({ config: { sweepSeconds: 1 } })
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

  it('classes a listed command word for word: an argv whose words only join to a listed line is a command (INV-2)', async () => {
    const { ctx } = await boot()
    const checks = { tests: true, lint: true }
    expect((await ctx.approvals.check({ class: 'command', command: ['pnpm', 'test', '--', 'a b'], checks })).mode).toBe('auto')
    expect((await ctx.approvals.check({ class: 'command', command: ['pnpm test'], checks })).mode).toBe('ask')
    expect((await ctx.approvals.check({ class: 'command', command: ['pnpm', 'test ; rm -rf /'], checks })).mode).toBe('ask')
    expect(await failureOf(ctx.approvals.check({ class: 'teleport' as Action['class'] }))).toBe('invalid')
    expect(await failureOf(ctx.approvals.check({ class: 'command', command: 'pnpm test' as unknown as string[] }))).toBe('invalid')
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

  it('contributes approvals_list, approvals_get, and approvals_policy to clients and approvals_decide to the operator only (INV-6)', async () => {
    const booted = await boot({ mcp: true })
    const tools = booted.mcp().tools
    expect([...tools.keys()].sort()).toEqual([...APPROVAL_TOOLS].sort())
    expect(Object.fromEntries([...tools].map(([name, t]) => [name, t.spec.scope]))).toEqual({ approvals_list: 'client', approvals_get: 'client', approvals_decide: 'operator', approvals_policy: 'client' })
    // Each input shape takes what its schema definition takes.
    const samples: Record<ApprovalTool, Record<string, unknown>> = {
      approvals_list: { states: ['open', 'rejected'], projectId: 'p1', batchId: 'batch-1', limit: 100, after: 'x' },
      approvals_get: { requestId: 'apr-1' },
      approvals_decide: { verdicts: [{ requestId: 'apr-1', subject: subject('x'), verdict: 'rejected', note: 'no' }] },
      approvals_policy: { projectId: 'p1' },
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
      expect(text(refused)).toMatch(/^invalid input, nothing done: mcp-approvals@1\.0#\/\$defs\/approvals-decide-input/)
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
