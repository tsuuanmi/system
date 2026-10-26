/**
 * A run the host's own stop cut runs again by itself after the restart (T283; seen live 2026-10-26 at
 * the update to b594eaa9, where the cut develop:1 of T270 was failed `reconciliation_failed`,
 * USER_ACTION, and waited for the operator). Only the host's stop marks a run as cut: a crash, or an
 * agent that is still present, is reconciled as before (INV-4).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { RunObserver } from '@tsuuanmi/system-agent-runtime-core'
import type { RunSpec } from '@tsuuanmi/system-agent-runtimes'
import { processIdentity } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/index.ts'
import { ScriptedAgent, boot, requirement, worker } from './stack.ts'

const DEVELOP = (): Config['workers'][number] => worker({ id: 'dev', sandbox: 'workspace-write', tools: [] })
const develop = () => requirement({ capabilities: ['develop', 'local-data'] })
const CAPABLE = { sandboxes: ['read-only', 'workspace-write'] as Array<'read-only' | 'workspace-write'> }

/** Start a develop run in a session, and stop its host while its agent works: the host's own stop cuts it. */
async function cut(options: { resume?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-agents-'))
  const first = await boot(new ScriptedAgent({ ...CAPABLE, ...options, holdMs: 30_000, process: true }), { workers: [DEVELOP()] }, dir)
  const admitted = await first.ctx.workers.route(develop())
  const started = first.ctx.workers.source('agents')!.start({ key: 'k', worker: 'agent:dev', prompt: 'add the flag', sessionId: 'ses_dev', requirement: develop(), decisions: admitted.decisions })
  await vi.waitFor(() => expect(first.ctx.store.db.prepare('SELECT agent_process FROM agent_runs WHERE run_id = ?').get(started.id)).toMatchObject({ agent_process: expect.any(String) }))
  await first.stop()
  return { dir, id: started.id }
}

/** A scripted agent whose first run completes as ScriptedAgent's do, and whose later runs hold until stopped without reporting a handle. */
class BeforeHandle extends ScriptedAgent {
  private started = 0
  override async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void, observer?: RunObserver) {
    if (++this.started === 1) return super.run(spec, signal, onHandle, observer)
    this.runs.push(spec)
    return await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new ProviderError('aborted', 'stopped')), { once: true }))
  }
}

const rowOf = (dir: string, id: string) => {
  const db = new DatabaseSync(join(dir, 'system.db'))
  try {
    return db.prepare('SELECT status, error, host_stopped_at, resumes, native_handle, liveness_looks, liveness_decision FROM agent_runs WHERE run_id = ?').get(id) as Record<string, unknown>
  } finally {
    db.close()
  }
}

describe('a run the host cut runs again by itself (T283)', () => {
  it('marks a run in flight when the host stops, and resumes it on restart in its native session: not failed, not asked about, not an attempt', async () => {
    const { dir, id } = await cut()
    expect(rowOf(dir, id)).toMatchObject({ status: 'running', host_stopped_at: expect.any(String), resumes: 0, native_handle: 'h-1' })
    const again = new ScriptedAgent({ ...CAPABLE })
    const second = await boot(again, { workers: [DEVELOP()], deadAfterSeconds: 1 }, dir)
    const done = await second.ctx.workers.source('agents')!.wait(id, 10_000)
    // The same run completed: it never failed, so no failed step reached the workflow (no attempt spent) and no one was asked.
    expect(done).toMatchObject({ status: 'completed', submitted: true })
    expect(done.error).toBeUndefined()
    expect(again.runs).toHaveLength(1)
    expect(again.runs[0]).toMatchObject({ resume: 'h-1', prompt: expect.stringContaining('restarted while you worked') })
    expect(again.runs[0]!.prompt).not.toContain('add the flag')
    expect(rowOf(dir, id)).toMatchObject({ status: 'completed', error: null, host_stopped_at: null, resumes: 1, liveness_looks: 0, liveness_decision: null })
    const decision = done.decisions.map((d) => second.ctx.artifacts.get(d)!.body as { decisionType: string; decider: { id: string }; outcome: { option: string; detail: Record<string, unknown> } }).find((d) => d.decider.id === 'agent-workers.resume-cut')!
    expect(decision).toMatchObject({ decisionType: 'reconciliation', outcome: { option: 'resume', detail: { agentRun: id, resumes: 1, nativeHandle: 'h-1' } } })
    expect(second.ctx.eventLog.query({ type: 'agent-workers.run.resumed' })).toEqual([expect.objectContaining({ sessionId: 'ses_dev', data: expect.objectContaining({ agentRun: id, how: 'resumed', resumes: 1, nativeHandle: 'h-1' }) })])
    expect(second.ctx.eventLog.query({ type: 'agent-workers.run.unknown' })).toEqual([])
    // Its session is free for the next run: it ended known.
    expect(await second.ctx.workers.held!('ses_dev')).toBeUndefined()
  }, 30_000)

  it('sends a run cut before its own conversation was recorded its own prompt again, on its session\'s conversation, never only "go on" (T283)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agents-'))
    // The session's first run completes (its conversation h-1); its second is cut before its runtime reports a handle.
    const first = await boot(new BeforeHandle({ ...CAPABLE }), { workers: [DEVELOP()] }, dir)
    const admitted = await first.ctx.workers.route(develop())
    const source = first.ctx.workers.source('agents')!
    const earlier = source.start({ key: 'k-1', worker: 'agent:dev', prompt: 'write the plan', sessionId: 'ses_dev', requirement: develop(), decisions: admitted.decisions })
    expect(await source.wait(earlier.id, 10_000)).toMatchObject({ status: 'completed' })
    const later = source.start({ key: 'k-2', worker: 'agent:dev', prompt: 'add the flag', sessionId: 'ses_dev', requirement: develop(), decisions: admitted.decisions })
    await vi.waitFor(() => expect(first.ctx.store.db.prepare('SELECT submitted_at FROM agent_runs WHERE run_id = ?').get(later.id)).toMatchObject({ submitted_at: expect.any(String) }))
    await first.stop()
    expect(rowOf(dir, later.id)).toMatchObject({ status: 'running', host_stopped_at: expect.any(String), native_handle: null })
    const again = new ScriptedAgent({ ...CAPABLE })
    const second = await boot(again, { workers: [DEVELOP()], deadAfterSeconds: 1 }, dir)
    expect(await second.ctx.workers.source('agents')!.wait(later.id, 10_000)).toMatchObject({ status: 'completed' })
    // Its own task, on the session's conversation as any later turn of it: the earlier run's task is not what it goes on with.
    expect(again.runs).toHaveLength(1)
    expect(again.runs[0]).toMatchObject({ resume: 'h-1', prompt: expect.stringMatching(/^add the flag\n\n\(The host you ran on was restarted/) })
    expect(again.runs[0]!.prompt).not.toContain('restarted while you worked')
    expect(second.ctx.eventLog.query({ type: 'agent-workers.run.resumed' })).toEqual([expect.objectContaining({ data: expect.objectContaining({ agentRun: later.id, how: 'restarted', sessionHandle: 'h-1' }) })])
  }, 30_000)

  it('starts a run again from the same worktree with its prompt when its runtime cannot resume', async () => {
    const { dir, id } = await cut({ resume: false })
    const again = new ScriptedAgent({ ...CAPABLE, resume: false })
    const second = await boot(again, { workers: [DEVELOP()], deadAfterSeconds: 1 }, dir)
    const done = await second.ctx.workers.source('agents')!.wait(id, 10_000)
    expect(done).toMatchObject({ status: 'completed', submitted: true })
    expect(again.runs).toHaveLength(1)
    expect(again.runs[0]!.resume).toBeUndefined()
    expect(again.runs[0]!.prompt).toMatch(/^add the flag\n\n\(The host you ran on was restarted/)
    expect(again.runs[0]!.workspace).toBeTruthy()
    expect(second.ctx.eventLog.query({ type: 'agent-workers.run.resumed' })).toEqual([expect.objectContaining({ data: expect.objectContaining({ agentRun: id, how: 'restarted' }) })])
  }, 30_000)

  it('resumes a run again when the host cuts it a second time: each cut is counted, and the mark is cleared as it runs', async () => {
    const { dir, id } = await cut()
    // Cut a second time, while it runs again.
    const holding = new ScriptedAgent({ ...CAPABLE, holdMs: 30_000, process: true })
    const second = await boot(holding, { workers: [DEVELOP()], deadAfterSeconds: 1 }, dir)
    // It waits for its runtime to register (a second, at the start) before it is sent again.
    await vi.waitFor(() => expect(holding.runs).toHaveLength(1), { timeout: 10_000 })
    await vi.waitFor(() => expect(second.ctx.store.db.prepare('SELECT host_stopped_at, agent_process FROM agent_runs WHERE run_id = ?').get(id)).toMatchObject({ host_stopped_at: null, agent_process: expect.any(String) }), { timeout: 10_000 })
    await second.stop()
    expect(rowOf(dir, id)).toMatchObject({ status: 'running', host_stopped_at: expect.any(String), resumes: 1 })
    const again = new ScriptedAgent({ ...CAPABLE })
    const third = await boot(again, { workers: [DEVELOP()], deadAfterSeconds: 1 }, dir)
    expect(await third.ctx.workers.source('agents')!.wait(id, 10_000)).toMatchObject({ status: 'completed' })
    expect(rowOf(dir, id)).toMatchObject({ resumes: 2 })
    expect(again.runs[0]).toMatchObject({ resume: 'h-1' })
  }, 60_000)

  it('fails a crashed run for the operator as before: no stop marked it, so its holder is lost, not stopped (INV-4)', async () => {
    const { dir, id } = await cut()
    const db = new DatabaseSync(join(dir, 'system.db'))
    db.prepare('UPDATE agent_runs SET host_stopped_at = NULL WHERE run_id = ?').run(id)
    db.close()
    const again = new ScriptedAgent({ ...CAPABLE })
    const second = await boot(again, { workers: [DEVELOP()], deadAfterSeconds: 1 }, dir)
    const done = await second.ctx.workers.source('agents')!.wait(id, 10_000)
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'reconciliation_failed', disposition: 'USER_ACTION' } })
    expect(again.runs).toEqual([])
  }, 30_000)

  it('never runs a cut run again while an agent process of it is present: its verdict is taken, and it is never driven twice (INV-4, INV-15)', async () => {
    const { dir, id } = await cut()
    const db = new DatabaseSync(join(dir, 'system.db'))
    db.prepare('UPDATE agent_runs SET agent_process = ? WHERE run_id = ?').run(JSON.stringify(processIdentity(process.pid)), id)
    db.close()
    const again = new ScriptedAgent({ ...CAPABLE })
    const second = await boot(again, { workers: [DEVELOP()], deadAfterSeconds: 1 }, dir)
    await vi.waitFor(() => expect(rowOf(dir, id)).toMatchObject({ status: 'running', liveness_looks: 1 }), { timeout: 10_000 })
    expect(again.runs).toEqual([])
    await second.stop()
  }, 30_000)
})
