import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { processIdentity, SchemaRegistry } from '@tsuuanmi/system-libs'
import type { WorkerExecution } from '@tsuuanmi/system-workers'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/index.ts'
import { ScriptedAgent, worker, boot, requirement } from './stack.ts'

describe('agents source: a run is gone only on a liveness verdict (PROP-0013, ADR-0056)', () => {
  /** Start a run in `session` on a first boot, stop that boot while the agent runs, and return what a restart needs. */
  const started = async (agent: ScriptedAgent, session = 'ses_live') => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agents-'))
    const first = await boot(agent, undefined, dir)
    const admitted = await first.ctx.workers.route(requirement())
    const execution = first.ctx.workers.source('agents')!.start({ key: 'k', worker: 'agent:reviewer', prompt: 'long', sessionId: session, requirement: requirement(), decisions: admitted.decisions })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await first.stop()
    return { dir, id: execution.id, session }
  }
  const restart = async (dir: string, config: Partial<Config> = {}) => {
    const again = new ScriptedAgent()
    const booted = await boot(again, { workers: [worker()], deadAfterSeconds: 1, ...config }, dir)
    return { ...booted, again }
  }
  const decisionOf = (ctx: Context, done: WorkerExecution) => done.decisions.map((d) => ctx.artifacts.get(d)!.body as { decisionType: string; decider: { id: string; version: string }; outcome: { option: string; detail: Record<string, unknown> }; candidates: Array<{ option: string; reasons: string[] }> })
    .find((d) => d.decisionType === 'reconciliation')

  it('records the holder and the agent process of a run, and reconciles it as dead only when both are gone and it has been quiet long enough (REQ-WRK-16, INV-4)', async () => {
    const agent = new ScriptedAgent({ holdMs: 30_000, process: true })
    const { dir, id, session } = await started(agent)
    const db = new DatabaseSync(join(dir, 'system.db'))
    const row = db.prepare('SELECT holder, agent_process, activity_at, submitted_at FROM agent_runs WHERE run_id = ?').get(id) as Record<string, string>
    db.close()
    expect(JSON.parse(row.holder!)).toMatchObject({ pid: process.pid })
    expect(JSON.parse(row.agent_process!)).toMatchObject({ pid: agent.processes[0] })
    expect(row.activity_at).toBe(row.submitted_at)
    const { ctx, again, stop } = await restart(dir)
    const done = await ctx.workers.source('agents')!.wait(id, 10_000)
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'reconciliation_failed', disposition: 'USER_ACTION', message: expect.stringContaining('it is gone (liveness dead') } })
    expect(again.runs).toEqual([])
    const decision = decisionOf(ctx, done)!
    expect(decision).toMatchObject({ decider: { id: 'agent-workers.reconcile', version: '2' }, outcome: { option: 'dead', detail: { verdict: 'dead', rule: 'liveness@1', looks: 1, deadAfterSeconds: 1 } } })
    expect(decision.candidates[0]!.reasons).toEqual([
      expect.stringContaining('the holder\'s lease: lapsed'), 'the holder\'s process: gone (it is this process, which runs no agent of this run now)',
      `the agent process: gone (no process ${agent.processes[0]} exists)`, expect.stringMatching(/^activity: the latest \d+ s ago$/),
    ])
    // Dead, so its session is free for the next run.
    expect(await ctx.workers.held!(session)).toBeUndefined()
    await stop()
  }, 30_000)

  // The failure mode PROP-0013 found: a run whose liveness could not be shown was failed at restart as if it were gone.
  it('never takes a failed probe for death: a run whose agent process was never reported is looked at again, not failed, then goes to the operator with its session held (REQ-WRK-16, INV-15)', async () => {
    const { dir, id, session } = await started(new ScriptedAgent({ holdMs: 30_000 }))
    const second = await restart(dir)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const look = second.ctx.store.db.prepare('SELECT status, liveness_looks, liveness_verdict, liveness_decision FROM agent_runs WHERE run_id = ?').get(id)
    expect(look).toEqual({ status: 'running', liveness_looks: 1, liveness_verdict: 'unknown', liveness_decision: null })
    expect(await second.ctx.workers.held!(session)).toContain('has not finished (running)')
    await second.stop()
    // The bound reached: to the operator, never declared dead.
    const third = await restart(dir, { maxUnknownVerdicts: 2 })
    const done = await third.ctx.workers.source('agents')!.wait(id, 10_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed', disposition: 'USER_ACTION', message: expect.stringContaining('it is not declared dead, so its session stays held') } })
    const decision = decisionOf(third.ctx, done)!
    expect(decision).toMatchObject({ outcome: { option: 'operator', detail: { verdict: 'unknown', looks: 2 } } })
    expect(decision.candidates[0]!.reasons).toContain('the agent process: unknown (never reported)')
    const heldWhy = new RegExp(`^its run ${id} ended without being known to be gone \\(liveness unknown, decision sha256:`)
    expect(await third.ctx.workers.held!(session)).toMatch(heldWhy)
    // The source itself never drives that session again, whoever asks (INV-15), and a refused later run frees nothing.
    const admitted = await third.ctx.workers.route(requirement())
    const later = third.ctx.workers.source('agents')!.start({ key: 'k-later', worker: 'agent:reviewer', prompt: 'next', sessionId: session, requirement: requirement(), decisions: admitted.decisions })
    expect(await third.ctx.workers.source('agents')!.wait(later.id, 10_000)).toMatchObject({
      status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringContaining(`run ${id} of session ${session} ended without being known to be gone`) },
    })
    expect(await third.ctx.workers.held!(session)).toMatch(heldWhy)
    expect([second.again.runs, third.again.runs]).toEqual([[], []])
    await third.stop()
  }, 30_000)

  it('takes a holder recorded on another host as unknown, never gone, though its agent process is gone (REQ-WRK-16)', async () => {
    const { dir, id } = await started(new ScriptedAgent({ holdMs: 30_000, process: true }))
    const db = new DatabaseSync(join(dir, 'system.db'))
    const holder = JSON.parse((db.prepare('SELECT holder FROM agent_runs WHERE run_id = ?').get(id) as { holder: string }).holder) as Record<string, unknown>
    db.prepare('UPDATE agent_runs SET holder = ? WHERE run_id = ?').run(JSON.stringify({ ...holder, host: 'another-host' }), id)
    db.close()
    const { ctx, stop } = await restart(dir, { maxUnknownVerdicts: 1 })
    const done = await ctx.workers.source('agents')!.wait(id, 10_000)
    expect(decisionOf(ctx, done)).toMatchObject({ outcome: { option: 'operator', detail: { verdict: 'unknown' } } })
    expect(decisionOf(ctx, done)!.candidates[0]!.reasons).toContain('the holder\'s process: unknown (it ran on another host (another-host))')
    await stop()
  }, 30_000)

  it('reports a running agent stalled once per stall, while its process is present and it is quiet, and never stops it', async () => {
    const quiet = new ScriptedAgent({ holdMs: 3500, process: true })
    const { ctx } = await boot(quiet, { workers: [worker()], stallSeconds: 1 })
    const admitted = await ctx.workers.route(requirement())
    const source = ctx.workers.source('agents')!
    const run = source.start({ key: 'quiet', worker: 'agent:reviewer', prompt: 'quiet', sessionId: 'ses_q', requirement: requirement(), decisions: admitted.decisions })
    expect(await source.wait(run.id, 10_000)).toMatchObject({ status: 'completed' })
    const stalls = ctx.eventLog.query({ type: 'agent-workers.run.stalled' })
    expect(stalls).toHaveLength(1)
    expect(stalls[0]).toMatchObject({ sessionId: 'ses_q', data: { agentRun: run.id, worker: 'agent:reviewer', stallSeconds: 1, rule: 'liveness@1' } })
    // An agent that keeps showing activity, or one whose process is not known, is never reported stalled.
    for (const agent of [new ScriptedAgent({ holdMs: 2500, process: true, activityEveryMs: 200 }), new ScriptedAgent({ holdMs: 2500 })]) {
      const other = await boot(agent, { workers: [worker()], stallSeconds: 1 })
      const id = other.ctx.workers.source('agents')!.start({ key: 'busy', worker: 'agent:reviewer', prompt: 'busy', requirement: requirement(), decisions: admitted.decisions }).id
      expect(await other.ctx.workers.source('agents')!.wait(id, 10_000)).toMatchObject({ status: 'completed' })
      expect(other.ctx.eventLog.query({ type: 'agent-workers.run.stalled' })).toEqual([])
    }
  }, 30_000)

  /** Wait until a restarted source has taken `looks` verdicts on a run. */
  const looked = async (ctx: Context, id: string, looks: number): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if ((ctx.store.db.prepare('SELECT liveness_looks FROM agent_runs WHERE run_id = ?').get(id) as { liveness_looks: number }).liveness_looks >= looks) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`run ${id} got fewer than ${looks} verdicts`)
  }

  it('tells the runs whose liveness needs a look: being looked at, then unknown with its verdict, reasons, what it holds, and what to do (PROP-0013, REQ-WRK-16)', async () => {
    const { dir, id, session } = await started(new ScriptedAgent({ holdMs: 30_000 }))
    const second = await restart(dir)
    await looked(second.ctx, id, 1)
    const looking = await second.ctx.workers.liveness!()
    expect(looking).toMatchObject({ counts: { unknown: 0, looking: 1, stalled: 0 }, unread: [] })
    expect(looking.runs).toEqual([expect.objectContaining({
      source: 'agents', execution: id, worker: 'agent:reviewer', state: 'looking', verdict: 'unknown (liveness@1)', looks: { taken: 1, max: 3 }, holds: [`session ${session}`],
      reasons: expect.arrayContaining(['the agent process: unknown (never reported)']), action: expect.stringContaining('looked at again (1 of 3 verdicts)'),
    })])
    await second.stop()
    const third = await restart(dir, { maxUnknownVerdicts: 2 })
    const done = await third.ctx.workers.source('agents')!.wait(id, 10_000)
    const told = await third.ctx.workers.liveness!()
    expect(told.counts).toEqual({ unknown: 1, looking: 0, stalled: 0 })
    expect(told.runs).toEqual([expect.objectContaining({
      execution: id, state: 'unknown', verdict: 'unknown (liveness@1)', looks: { taken: 2, max: 2 }, decision: done.decisions.find((d) => (third.ctx.artifacts.get(d)!.body as { decisionType: string }).decisionType === 'reconciliation'),
      holds: [`session ${session}`], action: expect.stringContaining(`system free ${id} --agent-gone`),
    })])
    // The reasons are the decision's signals, never its "not dead" preamble.
    expect(told.runs[0]!.reasons).toContain('the agent process: unknown (never reported)')
    expect(told.runs[0]!.reasons.some((r) => r.startsWith('not dead'))).toBe(false)
    expect(third.ctx.eventLog.query({ type: 'agent-workers.run.unknown' })).toEqual([expect.objectContaining({
      sessionId: session, decision: told.runs[0]!.decision, data: { agentRun: id, worker: 'agent:reviewer', verdict: 'unknown', looks: 2, cause: 'holder', rule: 'liveness@1' },
    })])
    // Asked for one execution, or a workflow run it does not serve.
    expect((await third.ctx.workers.liveness!({ execution: id })).runs).toHaveLength(1)
    expect(await third.ctx.workers.liveness!({ runId: 'run_other' })).toMatchObject({ runs: [], counts: { unknown: 0, looking: 0, stalled: 0 } })
    await third.stop()
  }, 30_000)

  it('tells a running agent that is stalled, with what stops it', async () => {
    const quiet = new ScriptedAgent({ holdMs: 4000, process: true })
    const { ctx } = await boot(quiet, { workers: [worker()], stallSeconds: 1 })
    const admitted = await ctx.workers.route(requirement())
    const run = ctx.workers.source('agents')!.start({ key: 'quiet', worker: 'agent:reviewer', prompt: 'quiet', sessionId: 'ses_q', requirement: requirement(), decisions: admitted.decisions })
    for (let i = 0; i < 100 && !ctx.eventLog.query({ type: 'agent-workers.run.stalled' }).length; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    const told = await ctx.workers.liveness!()
    expect(told.counts).toEqual({ unknown: 0, looking: 0, stalled: 1 })
    expect(told.runs[0]).toMatchObject({ execution: run.id, state: 'stalled', holds: ['session ses_q'], action: expect.stringContaining('its own deadline'), reasons: expect.arrayContaining(['the agent process: present']) })
    expect(await ctx.workers.source('agents')!.wait(run.id, 10_000)).toMatchObject({ status: 'completed' })
    expect((await ctx.workers.liveness!()).runs).toEqual([])
  }, 30_000)

  it('frees a session held by a run that ended unknown only on the operator\'s word that its agent is gone, recorded first as their decision, and refuses while its agent process is present (INV-13, INV-15, INV-2)', async () => {
    const { dir, id, session } = await started(new ScriptedAgent({ holdMs: 30_000 }))
    const { ctx, again } = await restart(dir, { maxUnknownVerdicts: 1 })
    const done = await ctx.workers.source('agents')!.wait(id, 10_000)
    expect(done.status).toBe('failed')
    expect(await ctx.workers.held!(session)).toContain(`system free ${id} --agent-gone`)
    // Never without the operator's word.
    await expect(ctx.agentWorkers.free({ agentRun: id, agentGone: false })).rejects.toThrow(/your word that its agent is gone/)
    // An agent process present on this host is not gone, whatever the operator saw.
    ctx.store.db.prepare('UPDATE agent_runs SET agent_process = ? WHERE run_id = ?').run(JSON.stringify(processIdentity(process.pid)), id)
    await expect(ctx.agentWorkers.free({ agentRun: id, agentGone: true })).rejects.toThrow(/agent process is present on this host/)
    ctx.store.db.prepare('UPDATE agent_runs SET agent_process = NULL WHERE run_id = ?').run(id)
    const reconciliations = () => ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' }).length
    expect(reconciliations()).toBe(1)
    const freed = await ctx.agentWorkers.free({ agentRun: id, agentGone: true, note: 'the host restarted; no agent of it runs' })
    expect(freed).toMatchObject({ agentRun: id, worker: 'agent:reviewer', again: false, freed: [`session ${session}`], worktrees: [] })
    const decision = ctx.artifacts.get(freed.decision)!.body as Record<string, unknown>
    new SchemaRegistry().assertRecord(decision as { schema: string })
    expect(decision).toMatchObject({
      decisionType: 'reconciliation', decider: { type: 'operator', id: 'operator.free', version: '1' }, deterministic: false, rationale: 'the host restarted; no agent of it runs',
      outcome: { option: 'free', detail: { agentRun: id, sessionId: session, verdict: 'unknown', again: false, worktrees: [] } },
    })
    expect((decision.candidates as Array<{ reasons: string[] }>)[0]!.reasons).toEqual([
      'the operator confirms its agent is gone: the host restarted; no agent of it runs', expect.stringMatching(/^it ended without being known to be gone \(liveness unknown, decision sha256:/),
      'as this host shows them now: the holder\'s process gone (it is this process, which runs no agent of this run now); the agent process unknown (never reported)',
    ])
    expect(ctx.eventLog.query({ type: 'agent-workers.run.freed' })).toEqual([expect.objectContaining({ sessionId: session, decision: freed.decision, data: { agentRun: id, worker: 'agent:reviewer', again: false, worktrees: 0 } })])
    expect(ctx.workers.source('agents')!.get(id)!.decisions).toContain(freed.decision)
    // Free: nothing holds the session, nothing is listed, and its next run runs.
    expect(await ctx.workers.held!(session)).toBeUndefined()
    expect((await ctx.workers.liveness!()).counts.unknown).toBe(0)
    const admitted = await ctx.workers.route(requirement())
    const later = ctx.workers.source('agents')!.start({ key: 'k-later', worker: 'agent:reviewer', prompt: 'next', sessionId: session, requirement: requirement(), decisions: admitted.decisions })
    expect(await ctx.workers.source('agents')!.wait(later.id, 10_000)).toMatchObject({ status: 'completed' })
    expect(again.runs).toHaveLength(1)
    // Freed again: only for a worktree, and it has none, so nothing is decided; a run that holds nothing is refused.
    const decided = ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' }).length
    await expect(ctx.agentWorkers.free({ agentRun: id, agentGone: true })).rejects.toThrow(new RegExp(`was freed already \\(decision ${freed.decision}\\), and no worktree of it is left`))
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' })).toHaveLength(decided)
    await expect(ctx.agentWorkers.free({ agentRun: later.id, agentGone: true })).rejects.toThrow(/completed, so it holds nothing to free/)
    await expect(ctx.agentWorkers.free({ agentRun: 'arun_0000000000000000', agentGone: true })).rejects.toThrow(/no agent run/)
  }, 30_000)

  it('refuses to free a run whose liveness is still being looked at', async () => {
    const { dir, id } = await started(new ScriptedAgent({ holdMs: 30_000 }))
    const { ctx } = await restart(dir)
    await looked(ctx, id, 1)
    await expect(ctx.agentWorkers.free({ agentRun: id, agentGone: true })).rejects.toThrow(/still being looked at \(1 of 3 verdicts\)/)
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' })).toEqual([])
  }, 30_000)

  // T74's gap: an operator cancel of a started run whose lease was free failed it `aborted` with no verdict, freeing its session.
  it('gives an operator cancel of a started run that no process holds a verdict: not known to be gone, it ends aborted with its session held; dead, it ends aborted and frees it (REQ-WRK-4, INV-15)', async () => {
    const cancelled = async (gone: boolean) => {
      const { dir, id, session } = await started(new ScriptedAgent({ holdMs: 30_000 }))
      const booted = await restart(dir)
      // Between two looks no process holds it: the next one is a minute away.
      await looked(booted.ctx, id, 1)
      if (gone) {
        // Its agent process positively gone (its pid now another process's), and quiet past deadAfterSeconds.
        booted.ctx.store.db.prepare('UPDATE agent_runs SET agent_process = ?, submitted_at = ?, activity_at = ? WHERE run_id = ?')
          .run(JSON.stringify({ ...processIdentity(process.pid)!, startTicks: 1 }), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', id)
      }
      const source = booted.ctx.workers.source('agents')!
      expect(source.cancel!(id)).toBe(true)
      const done = await source.wait(id, 10_000)
      return { ...booted, id, session, done, decision: decisionOf(booted.ctx, done)! }
    }
    const unknown = await cancelled(false)
    expect(unknown.done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'aborted', message: expect.stringContaining(`it is not known to be gone (liveness unknown`) } })
    expect(unknown.decision).toMatchObject({ outcome: { option: 'operator', detail: { verdict: 'unknown', cause: 'cancel', looks: 1 } } })
    expect(await unknown.ctx.workers.held!(unknown.session)).toMatch(new RegExp(`^its run ${unknown.id} ended without being known to be gone`))
    expect(unknown.ctx.eventLog.query({ type: 'agent-workers.run.unknown' })).toEqual([expect.objectContaining({ data: expect.objectContaining({ agentRun: unknown.id, cause: 'cancel' }) })])
    expect((await unknown.ctx.workers.liveness!()).runs).toEqual([expect.objectContaining({ execution: unknown.id, state: 'unknown' })])
    expect(unknown.again.runs).toEqual([])
    await unknown.stop()
    const dead = await cancelled(true)
    expect(dead.done).toMatchObject({ status: 'failed', error: { kind: 'aborted', message: expect.stringContaining('it is gone (liveness dead') } })
    expect(dead.decision).toMatchObject({ outcome: { option: 'dead', detail: { verdict: 'dead', cause: 'cancel' } } })
    expect(await dead.ctx.workers.held!(dead.session)).toBeUndefined()
    expect(dead.ctx.eventLog.query({ type: 'agent-workers.run.unknown' })).toEqual([])
    expect(dead.again.runs).toEqual([])
  }, 60_000)
})
