import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished } from 'vitest'
import { POLICIES } from '../../../approvals-core/conformance/approvals.ts'
import { boardSuite, CHARTER } from '../../../board-core/conformance/board.ts'
import { BOARD_CONTRACT, type TaskInput } from '../../../board-core/src/index.ts'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { ManualApprovals } from './manual.ts'

// The bundle's composition: the store-backed board passes its seam's suite over this queue, as it
// does over the approvals fake, with no expected failures. Both own clocks are off: the suite
// sweeps at the times it names. A policy change restarts the queue with the new configuration
// over the same store, as the operator's change does.
runSuite(boardSuite, {
  name: '@tsuuanmi/system-board over @tsuuanmi/system-approvals',
  contract: BOARD_CONTRACT,
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-approvals-board-'))
    const ctx = new Context()
    const base = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(Leases, {})]
    let approvals = ctx.plugin(ManualApprovals, { policies: POLICIES })
    const board = ctx.plugin(StoreBoard, { sweepSeconds: 0 })
    await Promise.all([...base, approvals, board])
    return {
      ctx,
      changePolicies: async (policies) => {
        await approvals.dispose()
        approvals = ctx.plugin(ManualApprovals, { policies })
        await approvals
      },
      dispose: async () => {
        for (const fiber of [board, approvals, ...base.reverse()]) await fiber.dispose()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})

describe('the store-backed board over this queue: a policy change', () => {
  /** The bundle's pair over the store in `dir`, as one process of the daemon starts it with `policies`. */
  const start = async (dir: string, policies: readonly AutonomyPolicy[]): Promise<{ ctx: Context; stop: () => Promise<void> }> => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(Leases, {}),
      ctx.plugin(ManualApprovals, { policies }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
    ]
    await Promise.all(fibers)
    let stopped = false
    const stop = async () => {
      if (stopped) return
      stopped = true
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    }
    onTestFinished(stop)
    return { ctx, stop }
  }
  const task = (title: string, actionClass: TaskInput['actionClass']): TaskInput => ({
    projectId: 'p2', title, goal: `do ${title}`, acceptance: [{ id: 'a1', statement: 'tests pass', check: 'tests' }], actionClass,
  })
  const decide = async (ctx: Context, requestId: string, when: Date): Promise<void> => {
    const request = await ctx.approvals.get(requestId)
    const [result] = await ctx.approvals.decide([{ requestId, subject: request!.subject, verdict: 'approved' }], when)
    expect(result?.refused).toBeUndefined()
  }

  it('puts every wait whose request the restarted queue withdrew to the new policy: a loosened class runs, a forbidden one is cancelled, one that still asks gets one new request on the same subject (INV-2, INV-13)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-approvals-board-policy-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    // Wall-clock times: the restarted queue withdraws at load, by the wall clock, what it no longer asks for.
    const base = new Date()
    const at = (minutes: number): Date => new Date(base.getTime() + minutes * 60_000)
    const first = await start(dir, POLICIES)
    let { ctx } = first
    const { approvalRequest } = await ctx.board.charter({ projectId: 'p2', title: 'project p2', charter: CHARTER }, base)
    await decide(ctx, approvalRequest, at(0.1))
    await ctx.board.sweep(at(0.1))
    const loose = await ctx.board.propose(task('loose', 'command'), at(0.2))
    const tight = await ctx.board.propose(task('tight', 'deploy'), at(0.2))
    const spent = await ctx.board.propose(task('spent', 'read'), at(0.2))
    await ctx.board.sweep(at(0.2))
    const { generation } = await ctx.board.claim(spent.taskId, 'lead', 600_000, at(0.3))
    await ctx.board.start(spent.taskId, generation, { runId: 'run-1' }, at(0.3))
    await ctx.board.block(spent.taskId, generation, { reason: 'budget-spent' }, at(0.4))
    const waits = new Map<string, string>()
    for (const t of [loose, tight, spent]) {
      const waiting = (await ctx.board.task(t.taskId))!
      expect(waiting.state).toBe('waiting-for-approval')
      waits.set(t.taskId, waiting.waiting!.approvalRequest!)
    }
    await first.stop()

    // The operator's change, then a restart: the studio's next version lets a command run and forbids deploy (a merge always asks, D56).
    const [studio, ...rest] = POLICIES
    const changed: AutonomyPolicy = {
      ...studio!, version: studio!.version + 1,
      rules: [...studio!.rules.filter((r) => r.actionClass !== 'command' && r.actionClass !== 'deploy'), { actionClass: 'command', mode: 'auto' }, { actionClass: 'deploy', mode: 'forbid' }],
    }
    ;({ ctx } = await start(dir, [changed, ...rest]))
    // At load, before any sweep, the queue withdrew every one of them, naming the policy change.
    for (const requestId of waits.values()) {
      const resolution = (await ctx.approvals.get(requestId))!.resolution!
      expect(resolution.cause).toBe('withdrawn')
      expect(ctx.artifacts.get(resolution.decision)?.body).toMatchObject({ decider: { type: 'rule', id: 'approvals.policy' } })
    }
    await ctx.board.sweep(at(1))
    const boardDecision = (ref: string | undefined) => ctx.artifacts.get(ref!)!.body as { decisionType: string; inputs: string[]; candidates: Array<{ option: string; selected: boolean; reasons: string[] }>; outcome: { option: string; detail: Record<string, unknown> } }

    const ready = (await ctx.board.task(loose.taskId))!
    expect(ready).toMatchObject({ state: 'ready' })
    const readied = boardDecision(ready.lastDecision)
    expect(readied).toMatchObject({ decisionType: 'board', outcome: { option: 'ready', detail: { reason: 'approval-needed', actionClass: 'command', mode: 'auto', withdrawn: waits.get(loose.taskId) } } })
    expect(readied.inputs).toContain((await ctx.approvals.get(waits.get(loose.taskId)!))!.resolution!.decision)
    expect(readied.candidates.map((c) => [c.option, c.selected])).toEqual([['ready', true], ['waiting-for-approval', false], ['cancelled', false]])
    for (const candidate of readied.candidates) expect(candidate.reasons.join('').trim()).not.toBe('')

    const cancelled = (await ctx.board.task(tight.taskId))!
    expect(cancelled).toMatchObject({ state: 'cancelled', cancellation: { reason: 'forbidden' } })
    expect(boardDecision(cancelled.lastDecision)).toMatchObject({ decisionType: 'board', outcome: { option: 'cancelled', detail: { mode: 'forbid' } } })

    // A spent budget still asks (funding always asks): one new request on the same exact subject, and the run kept.
    const asked = (await ctx.board.task(spent.taskId))!
    expect(asked).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'budget-spent' }, run: { runId: 'run-1' }, attempts: { count: 1 } })
    const old = (await ctx.approvals.get(waits.get(spent.taskId)!))!
    const fresh = (await ctx.approvals.get(asked.waiting!.approvalRequest!))!
    expect(fresh.requestId).not.toBe(old.requestId)
    expect(fresh).toMatchObject({ state: 'open', subject: old.subject, action: { class: 'funding' }, requester: { component: 'board', taskId: spent.taskId, runId: 'run-1' }, policy: { id: 'studio', version: changed.version } })
    expect(boardDecision(asked.lastDecision)).toMatchObject({ outcome: { option: 'waiting-for-approval', detail: { approvalRequest: fresh.requestId, withdrawn: old.requestId } } })
    expect(await ctx.board.sweep(at(2))).toEqual({ tasks: [], projects: [] })
    expect((await ctx.approvals.list({ projectId: 'p2' })).filter((r) => r.requester.taskId === spent.taskId).map((r) => r.requestId)).toEqual([fresh.requestId])
    // Approved, going on is the next attempt, through the gate (read: auto).
    await decide(ctx, fresh.requestId, at(3))
    await ctx.board.sweep(at(3))
    expect(await ctx.board.task(spent.taskId)).toMatchObject({ state: 'ready', attempts: { count: 1 } })
  })
})
