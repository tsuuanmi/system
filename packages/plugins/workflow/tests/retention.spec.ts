import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack, until } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: retention', () => {
  it('clears a finished run\'s private text after the retention period, but keeps the run while run retention is off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-workflow-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, workflow: { retainRunsDays: 0 } })
    const done = await first.ctx.workflow.wait(first.ctx.workflow.start({ template: 'ask', input: 'private words' }).runId, 30_000)
    first.ctx.store.db.prepare("UPDATE workflow_runs SET updated_at = '2000-01-01T00:00:00.000Z'").run()
    await first.stop()
    const second = await boot({ dir, shared: first.fake, workflow: { retainRunsDays: 0 } })
    await until(() => (second.ctx.store.db.prepare('SELECT input FROM workflow_runs').get() as { input: string }).input === '')
    expect(second.ctx.store.db.prepare('SELECT prompt FROM workflow_nodes').get()).toEqual({ prompt: null })
    expect(second.ctx.workflow.get(done.runId)).toMatchObject({ status: 'completed', answer: 'Plain answer.' })
  }, 90_000)

  it('expires finished runs past retainRunsDays, keeps a session\'s latest run, then collects what only they needed (INV-9)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-workflow-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir })
    const one = await first.ctx.workflow.wait(first.ctx.workflow.start({ template: 'ask', input: 'standalone' }).runId, 30_000)
    const s1 = await first.ctx.workflow.wait(first.ctx.workflow.start({ template: 'ask', input: 'session one', persist: true }).runId, 30_000)
    const s2 = await first.ctx.workflow.wait(first.ctx.workflow.start({ template: 'ask', input: 'session two', sessionId: s1.sessionId }).runId, 30_000)
    const onlyOf = (ctx: typeof first.ctx, runId: string) => (ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM artifact_runs r WHERE r.run_id = ?
      AND NOT EXISTS (SELECT 1 FROM artifact_runs o WHERE o.id = r.id AND o.run_id != r.run_id)`).get(runId) as { n: number }).n
    expect(onlyOf(first.ctx, one.runId)).toBeGreaterThan(0)
    // Everything is old: runs, turns, artifacts (past the grace period).
    const old = '2000-01-01T00:00:00.000Z'
    for (const sql of ['UPDATE workflow_runs SET updated_at = ?', 'UPDATE turns SET updated_at = ?', 'UPDATE artifacts SET created_at = ?']) first.ctx.store.db.prepare(sql).run(old)
    await first.stop()
    const second = await boot({ dir, shared: first.fake, workflow: { retainRunsDays: 1 }, turns: { retainDays: 1 } })
    await until(() => !second.ctx.workflow.get(one.runId) && !second.ctx.workflow.get(s1.runId))
    await until(() => (second.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }).n === 0)
    // The session's latest run stays, so the session can continue.
    expect(second.ctx.workflow.get(s2.runId)).toMatchObject({ status: 'completed', sessionId: s1.sessionId })
    await second.ctx.artifacts.collect()
    expect(onlyOf(second.ctx, one.runId)).toBe(0)
    expect(second.ctx.artifacts.get(s2.result!)).toBeDefined()
    const events = second.ctx.eventLog.query({ type: 'workflow.run.expired' }).map((e) => e.runId).sort()
    expect(events).toEqual([one.runId, s1.runId].sort())
    // One summary per sweep; the session continued by the retained run keeps its conversation.
    expect(second.ctx.eventLog.query({ type: 'workflow.retention.swept' })).toEqual([expect.objectContaining({ data: { runs: 2, conversations: 0, retainRunsDays: 1 } })])
    expect(second.ctx.turns.conversations({ sessionId: s1.sessionId! })).toEqual([expect.objectContaining({ state: 'live' })])
  }, 120_000)
})
