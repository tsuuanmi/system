import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack, until } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: restarts', () => {
  it('supersedes a run left with a running node after a restart: a turn that answered meanwhile stays history, never taken or resent, and the node runs again once (INV-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-workflow-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const step = (nodeId: string, prompt: string, extra: Record<string, unknown> = {}) => ({ nodeId, objective: nodeId, prompt, capabilities: ['reason'], tier: 'standard' as const, conversation: 'temporary' as const, acceptance: 'acceptance.answer', ...extra })
    // The slow step answers in its own conversation; its sibling needs a capability no Worker has, so the run fails beside it.
    const templates = { 'fan-out': [
      step('context:1', 'Context for: {{input}}'),
      step('slow:1', 'Slow step on: {{node:context:1}}', { dependsOn: ['context:1'], conversation: 'persistent' }),
      step('blocked:1', 'Blocked on: {{node:context:1}}', { dependsOn: ['context:1'], capabilities: ['reason', 'connector:nowhere'] }),
      step('final:1', 'Both: {{node:slow:1}} {{node:blocked:1}}', { dependsOn: ['slow:1', 'blocked:1'] }),
    ] }
    const first = await boot({ dir, fake: { thinkMs: 3000, answer: (prompt) => (prompt.startsWith('Context for') ? 'the old context' : `answered: ${prompt}`) }, workflow: { templates } })
    const run = first.ctx.workflow.start({ template: 'fan-out', input: 'a question' })
    const slowTurn = (): string | undefined => first.ctx.workflow.get(run.runId)!.nodes.find((n) => n.nodeId === 'slow:1')?.executionId
    // Every wait is on state, with budgets above the turn clocks: a loaded host is slow, never wrong.
    await until(() => slowTurn() !== undefined && first.ctx.turns.get(slowTurn()!)?.binding !== undefined, 150_000, 'the slow step bound')
    const orphan = slowTurn()!
    await first.stop()
    const slow = (context: string) => first.fake.sent.filter((s) => s.prompt.startsWith(`Slow step on: ${context}`))
    // The site answers while no host runs; the restarted turn runtime recovers that answer.
    const second = await boot({ dir, shared: first.fake, workflow: { templates } })
    await until(() => second.ctx.workflow.get(run.runId)?.status === 'failed', 150_000, 'the restarted run failed')
    await until(() => second.ctx.turns.get(orphan)?.status !== 'running' && second.ctx.turns.get(orphan)?.status !== 'queued', 150_000, 'the orphan settled')
    // Recovered when the restarted runtime observes the answer in time; on a loaded host it may not,
    // and then it fails closed (reconciliation_failed). Either way it is settled before the supersede.
    const answered = second.ctx.turns.get(orphan)!.status === 'completed'
    expect(second.ctx.workflow.get(run.runId)!.nodes.find((n) => n.nodeId === 'slow:1')).toMatchObject({ state: 'RUNNING', executionId: orphan })
    const website = second.ctx.workers.source('website')!
    const cancel = website.cancel!.bind(website)
    const cancels: Array<[string, boolean]> = []
    website.cancel = (id) => {
      const done = cancel(id)
      cancels.push([id, done])
      return done
    }
    // Refused before anything is cancelled: the slow step has no result to replace.
    await expect(second.ctx.workflow.supersede(run.runId, 'slow:1', { text: 'x' })).rejects.toThrow('has no completed result')
    expect(cancels).toEqual([])
    await second.ctx.workflow.supersede(run.runId, 'context:1', { text: 'the new context' })
    // Settled already: it is not cancelled.
    expect(cancels).toEqual([])
    await until(() => second.ctx.workflow.get(run.runId)?.status === 'failed' && second.ctx.workflow.get(run.runId)!.nodes.find((n) => n.nodeId === 'slow:1')?.state === 'COMPLETED', 180_000, 'the slow step ran again')
    expect(slow('the old context')).toHaveLength(1)
    expect(slow('the new context')).toHaveLength(1)
    const node = second.ctx.workflow.explain(run.runId)!.nodes.find((n) => n.nodeId === 'slow:1')!
    expect(node.state).toBe('COMPLETED')
    const rerun = node.decisions.find((d) => d.type === 'recovery' && d.outcome === 'rerun')!
    expect(rerun.reasons).toEqual([expect.stringMatching(/^context:1's result .* was superseded by/), answered
      ? expect.stringMatching(new RegExp(`^its execution ${orphan} had already finished; its result sha256:[0-9a-f]{64} is history, never taken or resent$`))
      : `its execution ${orphan} had already ended (reconciliation_failed); nothing of it is taken or resent`])
    // The orphan's answer is not the node's result.
    expect(second.ctx.artifacts.read(node.decisions.filter((d) => d.type === 'acceptance').at(-1)!.result!)).toMatchObject({ text: expect.stringMatching(/^answered: Slow step on: the new context/) })
  }, 720_000)

  it('recovers a run after a restart without sending the research prompt again (REQ-WF-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-workflow-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { researchMs: 6000 } })
    const run = first.ctx.workflow.start({ template: 'deep-research', input: 'survive a crash' })
    await until(() => {
      const id = first.ctx.workflow.get(run.runId)!.nodes[0]!.executionId
      return id !== undefined && first.ctx.turns.get(id)?.binding !== undefined
    })
    await first.stop()
    const second = await boot({ dir, shared: first.fake })
    const done = await second.ctx.workflow.wait(run.runId, 90_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'Synthesis: plugins matter (https://src.example/catalog).' })
    expect(first.fake.sent.map((s) => s.deepResearch)).toEqual([true, false])
  }, 150_000)
})
