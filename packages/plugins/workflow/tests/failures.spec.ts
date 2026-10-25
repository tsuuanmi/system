import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { source } from '../../../workers-core/conformance/workers.ts'
import { browserStack, until } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: failures', () => {
  it('never resends a submitted prompt: a timeout after sending fails the node, without a retry (INV-4)', async () => {
    const { ctx, fake } = await boot({ fake: { thinkMs: 20_000 }, turns: { turnTimeoutMs: 4000, stallTimeoutMs: 3500 }, workflow: { retryDelayMs: 100 } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'slow' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { disposition: 'USER_ACTION' } })
    expect(fake.sent).toHaveLength(1)
    const record = ctx.workflow.records(done.runId)[0]!
    expect(ctx.artifacts.get(record.lastDecision!)?.body).toMatchObject({ decisionType: 'recovery', outcome: { option: 'fail' } })
  }, 90_000)

  it('takes a run back after its lease was lost, instead of stranding it', async () => {
    const { ctx } = await boot({ fake: { thinkMs: 3000 } })
    const run = ctx.workflow.start({ template: 'ask', input: 'keep going' })
    await until(() => ctx.workflow.get(run.runId)?.nodes[0]?.state === 'RUNNING')
    ctx.leases.invalidate(`run:${run.runId}`)
    expect((await ctx.workflow.wait(run.runId, 60_000)).status).toBe('completed')
  }, 90_000)

  it('refuses a template whose acceptance contract is unknown before anything is sent', async () => {
    const typo = [{ nodeId: 'ask:1', objective: 'x', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.anwser' }]
    const { ctx, fake } = await boot({ workflow: { templates: { typo } } })
    expect(() => ctx.workflow.start({ template: 'typo', input: 'x' })).toThrow(/unknown acceptance contract acceptance.anwser/)
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('fails closed with USER_ACTION when no account is ready, and sends nothing', async () => {
    const { ctx, fake } = await boot({ ready: false })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'nobody' }).runId, 30_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'reauth_required', disposition: 'USER_ACTION' } })
    expect(ctx.artifacts.get(ctx.workflow.records(done.runId)[0]!.lastDecision!)?.body).toMatchObject({ decisionType: 'recovery', inputs: [expect.any(String)] })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('keeps local-private work off website Workers (REQ-WRK-7, MVP exit criterion 3)', async () => {
    const { ctx, fake } = await boot()
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'my notes', classification: 'local-private' }).runId, 30_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'egress_denied' } })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('starts nothing for a node that is still routing when the engine stops', async () => {
    const { ctx, fake, stop } = await boot()
    let routing!: () => void
    const entered = new Promise<void>((resolve) => (routing = resolve))
    ctx.workers.register(source('slow', async () => (routing(), await new Promise((resolve) => setTimeout(resolve, 2000)), [])))
    ctx.workflow.start({ template: 'ask', input: 'caught mid-route' })
    await entered
    await stop()
    expect(fake.sent).toEqual([])
  }, 60_000)
})
