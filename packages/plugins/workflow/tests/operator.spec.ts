import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack, until } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: the operator stops a run or supersedes a result', () => {
  it('lets the operator stop a run: running work is cancelled, nothing else starts, nothing is resent (REQ-WF-7)', async () => {
    const { ctx, fake } = await boot({ fake: { thinkMs: 20_000 } })
    const run = ctx.workflow.start({ template: 'deep-research', input: 'long one' })
    await until(() => ctx.workflow.get(run.runId)?.nodes[0]?.state === 'RUNNING' && fake.sent.length === 1)
    const stopped = await ctx.workflow.stop(run.runId, 'not needed any more')
    expect(stopped).toMatchObject({ status: 'failed', error: { kind: 'stopped', disposition: 'NONE' } })
    expect(stopped.nodes.map((n) => n.state)).toEqual(['FAILED', 'FAILED'])
    const turn = await ctx.turns.wait(stopped.nodes[0]!.executionId!, 10_000)
    expect(turn).toMatchObject({ status: 'failed', error: { kind: 'aborted' } })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(fake.sent).toHaveLength(1)
    await expect(ctx.workflow.stop(run.runId)).rejects.toThrow(/not running/)
  }, 90_000)

  it('re-runs everything downstream of a superseded result, and records why (lineage invalidation, REQ-ART-2)', async () => {
    const { ctx, fake } = await boot()
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'deep-research', input: 'q' }).runId, 60_000)
    expect(done.status).toBe('completed')
    const old = ctx.workflow.records(done.runId)[0]!.outputReceipt!.result
    const reopened = await ctx.workflow.supersede(done.runId, 'research:1', { text: 'Corrected report https://src.example/fixed', note: 'the first report misread the catalog' })
    expect(reopened).toMatchObject({ status: 'running' })
    const again = await ctx.workflow.wait(done.runId, 60_000)
    expect(again.status).toBe('completed')
    expect(fake.sent).toHaveLength(3)
    expect(fake.sent[2]!.prompt).toContain('Corrected report https://src.example/fixed')
    const records = ctx.workflow.records(done.runId)
    const replacement = ctx.artifacts.get(records[0]!.outputReceipt!.result)!
    expect(replacement).toMatchObject({ lineage: { supersedes: [old] }, producer: { type: 'operator' } })
    const recovery = ctx.artifacts.get(records[1]!.inputReceipt!.bundle[0]!)
    expect(recovery?.id).toBe(replacement.id)
    const invalidation = ctx.artifacts.list({ kind: 'decision', decisionType: 'recovery', runId: done.runId })
      .map((a) => a.body as { outcome: { option: string }; inputs: string[] })
      .find((b) => b.outcome.option === 'rerun')!
    expect(invalidation.inputs).toEqual([old, replacement.id].sort())
    await expect(ctx.workflow.supersede(done.runId, 'compact:1', { text: 'x' })).resolves.toBeDefined()
    await ctx.workflow.wait(done.runId, 60_000)
  }, 150_000)
})
