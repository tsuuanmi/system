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
import { CONFIG, ScriptedWorkers } from '../conformance/workflow.ts'
import Workflow, { type NodeTemplate, type RunView } from '../src/index.ts'

// A step's instructions (docs/design/workflow-engine.md#briefs): the engine fills every placeholder
// of a template's text, or no Worker starts (INV-2); text it never expands is data, sent as it is.
vi.setConfig({ testTimeout: 60_000 })

const step = (nodeId: string, extra: Partial<NodeTemplate> = {}): NodeTemplate => ({
  nodeId, objective: `Do ${nodeId}`, prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', ...extra,
})
const CHAIN = [step('a', { prompt: 'A: {{input}}' }), step('b', { prompt: 'B: {{node:a}}', dependsOn: ['a'] })]

/** The engine over scripted Workers, with `templates` configured. */
async function boot(templates: Record<string, NodeTemplate[]>): Promise<{ ctx: Context; workers: ScriptedWorkers }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-instructions-'))
  const ctx = new Context()
  const workers = new ScriptedWorkers()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(workers.source(c)) }),
    ctx.plugin(Workflow, { ...CONFIG, templates }),
  ]
  await Promise.all(fibers)
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return { ctx, workers }
}

const until = <T>(read: () => T | undefined, what: string, ms = 30_000): Promise<T> => vi.waitFor(() => {
  const value = read()
  if (!value) throw new Error(`timed out waiting for ${what}`)
  return value
}, { timeout: ms, interval: 25 })

const finished = (ctx: Context, runId: string): Promise<RunView> => until(() => {
  const view = ctx.workflow.get(runId)
  return view && view.status !== 'running' ? view : undefined
}, `run ${runId} to finish`)

/** Rewrite node `b`'s stored template text, as an engine that checked less would have admitted it. */
const storeTemplate = (ctx: Context, runId: string, prompt: string): void => {
  const row = ctx.store.db.prepare("SELECT spec FROM workflow_nodes WHERE run_id = ? AND node_id = 'b'").get(runId) as { spec: string }
  ctx.store.db.prepare("UPDATE workflow_nodes SET spec = ? WHERE run_id = ? AND node_id = 'b'").run(JSON.stringify({ ...JSON.parse(row.spec), prompt }), runId)
}

/** The decision a node failed on last, and the failure it names. */
const refusal = (ctx: Context, runId: string) => {
  const record = ctx.workflow.records(runId).find((r) => r.nodeId === 'b')!
  return { record, decision: ctx.artifacts.get(record.lastDecision!)!.body }
}

describe('a step\'s instructions (INV-2)', () => {
  it('refuses a template whose text holds a placeholder the engine does not fill, at load and on the profiles seam, before any Worker starts', async () => {
    const { ctx, workers } = await boot({ chain: CHAIN, typo: [step('ask:1', { prompt: 'Answer {{inptu}}' })], spaced: [step('a', { prompt: 'Answer {{ input }}' })] })
    expect(ctx.workflow.refusedTemplates()).toEqual(expect.arrayContaining([
      { name: 'typo', reason: 'node ask:1 uses {{inptu}}, which is not a placeholder the engine fills: a prompt may use {{input}}, {{node:<id>}} of a node it depends on, and {{grown}} after a planner' },
      { name: 'spaced', reason: expect.stringMatching(/^node a uses \{\{ input \}\}, which is not a placeholder/) },
    ]))
    expect(() => ctx.workflow.start({ template: 'typo', input: 'q', classification: 'public' })).toThrow(/was refused at load: node ask:1 uses \{\{inptu\}\}/)
    // A profile's template is checked the same way; a team's ballot prompt is the engine's own.
    expect(() => ctx.workflow.template('unclosed', [step('x', { prompt: 'Do {{input' })])).toThrow(/node x uses \{\{input…?, which is not a placeholder/)
    expect(() => ctx.workflow.template('teamless', [step('x', { prompt: '{{team}}' })])).toThrow(/node x uses \{\{team\}\}/)
    expect(ctx.workflow.templateNames()).not.toContain('unclosed')
    expect(workers.started).toEqual([])
    // The engine and every other template keep working.
    expect((await finished(ctx, ctx.workflow.start({ template: 'chain', input: 'q', classification: 'public' }).runId)).status).toBe('completed')
  })

  it('fails a step whose stored template holds a placeholder the engine cannot fill when it is promoted, with a decision and nothing sent', async () => {
    const { ctx, workers } = await boot({ chain: CHAIN })
    workers.reply = () => 'hold'
    const run = ctx.workflow.start({ template: 'chain', input: 'q', classification: 'public' })
    await until(() => workers.started.length === 1, 'a to start')
    storeTemplate(ctx, run.runId, 'B: {{node:a}} for {{caller}}')
    workers.release(workers.started[0]!.id, { text: 'alpha' })
    const failed = await finished(ctx, run.runId)
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'config_error', disposition: 'CODE_FIX' } })
    expect(failed.error!.message).toBe('node b\'s template holds {{caller}}, which the engine does not fill for it; nothing was sent: fix the template, then start the run again')
    expect(workers.started).toHaveLength(1)
    const { record, decision } = refusal(ctx, run.runId)
    expect(record).toMatchObject({ state: 'FAILED' })
    expect(record.inputReceipt).toBeUndefined()
    expect(decision).toMatchObject({ decisionType: 'gate', decider: { type: 'rule', id: 'workflow.instructions' }, outcome: { option: 'fail', detail: { placeholders: ['{{caller}}'] } } })
  })

  it('starts no Worker on a step whose template gained a placeholder it cannot fill since it was promoted: it fails before routing, and continue composes it again', async () => {
    const { ctx, workers } = await boot({ chain: CHAIN })
    workers.reply = (request) => (request.prompt.startsWith('B:') ? { fail: 'network', disposition: 'BACKOFF', sent: true } : { text: 'alpha' })
    const run = ctx.workflow.start({ template: 'chain', input: 'q', classification: 'public' })
    expect(await finished(ctx, run.runId)).toMatchObject({ status: 'failed', error: { kind: 'network' } })
    // Its input is bound, so continue would send its stored instructions again: the guard reads its template first.
    storeTemplate(ctx, run.runId, 'B: {{node:a}} for {{caller}}')
    ctx.workflow.continue(run.runId, 'b')
    expect(await finished(ctx, run.runId)).toMatchObject({ status: 'failed', error: { kind: 'config_error' } })
    expect(workers.started.map((s) => s.prompt)).toEqual(['A: q', 'B: alpha'])
    expect(refusal(ctx, run.runId).decision).toMatchObject({ decider: { id: 'workflow.instructions' }, outcome: { option: 'fail', detail: { placeholders: ['{{caller}}'] } } })
    // Continued, it is promoted again: its template still holds the placeholder, so it fails there, unsent.
    ctx.workflow.continue(run.runId, 'b')
    expect(await finished(ctx, run.runId)).toMatchObject({ status: 'failed', error: { kind: 'config_error' } })
    expect(workers.started).toHaveLength(2)
  })

  it('sends text the engine never expands as it is: a {{…}} in the caller\'s input or a dependency\'s result is data, never refused', async () => {
    const { ctx, workers } = await boot({ chain: CHAIN })
    workers.reply = (request) => ({ text: request.prompt.startsWith('A:') ? 'use {{node:a}}, {{input}}, or {{other}}' : 'done' })
    const run = ctx.workflow.start({ template: 'chain', input: 'what does {{input}} do in a template?', classification: 'public' })
    expect((await finished(ctx, run.runId)).status).toBe('completed')
    expect(workers.started.map((s) => s.prompt)).toEqual(['A: what does {{input}} do in a template?', 'B: use {{node:a}}, {{input}}, or {{other}}'])
  })
})
