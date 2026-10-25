import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { worker } from '../../../workers-core/conformance/workers.ts'
import { CONFIG, ScriptedWorkers, TEMPLATES } from '../conformance/workflow.ts'
import Workflow from '../src/index.ts'

// D60, ADR-0062 (T144 should-fix 1): a resend is fenced by the run's lease before the session's reset.
vi.setConfig({ testTimeout: 60_000 })

/** The site answered the sent input with its own error in place of an answer. */
const SITE_ERROR = { fail: 'overloaded', disposition: 'BACKOFF', sent: true, siteError: true } as const
const MEMBER = (id: string, family: string) => worker(id, { schema: 'capability-descriptor@1.1', family, proves: ['reason', 'persistent-conversation'] })
const PROPOSAL = `My proposal.\n${JSON.stringify({ recommendation: 'option of m2', rationale: 'it fits', risks: [] })}`

/**
 * The engine over scripted Workers, whose `reset` notes the run lease's holder at the moment of
 * each reset (its generation, or `none` while no engine holds the run).
 */
async function boot(): Promise<{ ctx: Context; workers: ScriptedWorkers; resets: Array<number | 'none'>; watch: (runId: string) => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-site-error-'))
  const ctx = new Context()
  const workers = new ScriptedWorkers()
  workers.extra = [MEMBER('w:a', 'family-a'), MEMBER('w:b', 'family-b')]
  const resets: Array<number | 'none'> = []
  let watched = ''
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({
      name: 'scripted-workers', inject: ['workers', 'artifacts', 'leases'], apply: (c: Context) => {
        const source = workers.source(c)
        const reset = source.reset!
        source.reset = (sessionId) => {
          resets.push(c.leases.current(`run:${watched}`)?.generation ?? 'none')
          return reset(sessionId)
        }
        c.workers.register(source)
      },
    }),
    ctx.plugin(Workflow, { ...CONFIG, templates: TEMPLATES }),
  ]
  await Promise.all(fibers)
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return { ctx, workers, resets, watch: (runId) => void (watched = runId) }
}

const until = (check: () => boolean, what: string, ms = 30_000): Promise<void> => vi.waitFor(() => {
  if (!check()) throw new Error(`timed out waiting for ${what}`)
}, { timeout: ms, interval: 25 })

const proposals = (workers: ScriptedWorkers, member: string) => workers.started.filter((s) => s.key.includes(`:team:${member}:propose:`))
const recoveries = (ctx: Context, runId: string) => ctx.artifacts.list({ kind: 'decision', decisionType: 'recovery', runId, nodeId: 'team:m1:propose', limit: 100 })
  .map((a) => a.body as { outcome: { option: string } })

describe('a resend after a site\'s own error, under the run\'s lease (ADR-0062)', () => {
  it('changes nothing from an engine that lost the run\'s lease: no reset, no decision, no event; the engine that takes the run back resends once (INV-4)', async () => {
    const { ctx, workers, resets, watch } = await boot()
    workers.reply = () => 'hold'
    const run = ctx.workflow.start({ template: 'team', input: 'q', classification: 'public' })
    watch(run.runId)
    await until(() => proposals(workers, 'm1').length === 1 && proposals(workers, 'm2').length === 1, 'both members running')
    const failed = proposals(workers, 'm1')[0]!
    // The engine loses the run's lease (a host suspend, a takeover) just as m1's site error arrives:
    // it reads the failure under the lease it no longer holds, and its fenced resend throws.
    const lost = ctx.leases.invalidate(`run:${run.runId}`)
    workers.release(failed.id, SITE_ERROR)
    // The engine takes the run back under a new lease, and that holder decides the resend.
    await until(() => recoveries(ctx, run.runId).length > 0, 'the new holder\'s recovery decision')
    await new Promise((resolve) => setTimeout(resolve, 200))
    // One reset only, made under the lease of the engine that took the run back, never while none held it.
    expect(resets).toHaveLength(1)
    expect(resets[0]).not.toBe('none')
    expect(resets[0] as number).toBeGreaterThan(lost)
    expect(workers.resets).toEqual([failed.sessionId])
    expect(recoveries(ctx, run.runId).map((d) => d.outcome.option)).toEqual(['resend'])
    expect(ctx.eventLog.query({ type: 'workflow.node.resent', runId: run.runId })).toHaveLength(1)
    // Like any retry, the new attempt starts on the run's next pass, once m2's running step settles.
    workers.release(proposals(workers, 'm2')[0]!.id, { text: PROPOSAL })
    await until(() => proposals(workers, 'm1').length === 2, 'm1 resent')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const resent = proposals(workers, 'm1')[1]!
    expect(resent.sessionId).toBe(failed.sessionId)
    expect(resent.conversation).not.toBe(failed.conversation)
    expect(proposals(workers, 'm1')).toHaveLength(2)
    expect(resets).toHaveLength(1)
    expect(recoveries(ctx, run.runId).map((d) => d.outcome.option)).toEqual(['resend'])
    expect(ctx.eventLog.query({ type: 'workflow.node.resent', runId: run.runId })).toHaveLength(1)
  })
})
