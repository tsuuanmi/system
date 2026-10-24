import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack, until, waitingPlan } from './stack.ts'
import { TEST_TEMPLATES } from './templates.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: static DAGs on the single engine', () => {
  it('runs research as two nodes: Deep research on frontier, then a cited compaction of the verbatim report on economy', async () => {
    const { ctx, fake } = await boot()
    const started = ctx.workflow.start({ template: 'deep-research', input: 'Survey the plugin catalog' })
    expect(started).toMatchObject({ template: 'deep-research', status: 'running' })
    expect(started.sessionId).toMatch(/^ses_/)
    // The file's first run also starts the browser: a loaded CI runner gets room for that.
    const done = await ctx.workflow.wait(started.runId, 120_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'Synthesis: plugins matter (https://src.example/catalog).' })
    expect(fake.sent).toHaveLength(2)
    expect(fake.sent[0]).toMatchObject({ prompt: 'Survey the plugin catalog', deepResearch: true, temporary: false, model: 'GPT-6', power: 'High' })
    expect(fake.sent[1]).toMatchObject({ deepResearch: false, temporary: true, model: 'Latest', power: 'Instant' })
    // Editors may change blank-line spacing; every line of the report arrives verbatim.
    expect(fake.sent[1]!.prompt.replace(/\n{2,}/g, '\n\n')).toContain('<report>\nResearch findings\nPlugins matter [1].\n\nSources:\n- [1] https://src.example/catalog\n</report>')
    expect(done.nodes.map((n) => [n.nodeId, n.state, n.worker, n.quotaClass])).toEqual([
      ['research:1', 'COMPLETED', 'worker:chatgpt-main/frontier', 'subscription-chat'],
      ['compact:1', 'COMPLETED', 'worker:chatgpt-main/economy', 'subscription-chat'],
    ])
    // Durable node records validate against workflow-node@1.0 and bind the result to its acceptance.
    const schemas = new SchemaRegistry()
    for (const record of ctx.workflow.records(started.runId)) {
      schemas.assertRecord(record)
      expect(record.outputReceipt).toBeDefined()
      expect(ctx.artifacts.get(record.outputReceipt!.acceptance)?.body).toMatchObject({ decisionType: 'acceptance', outcome: { option: 'accept' } })
    }
    // Template tiers are the profile's, and each requirement carries its node's objective.
    expect(ctx.workflow.records(started.runId).map((r) => [r.requirement.tier, r.requirement.objective])).toEqual([
      [{ min: 'frontier', source: 'profile' }, 'Write a cited Deep research report on the caller\'s question'],
      [{ min: 'economy', source: 'profile' }, 'Compact the report into a cited synthesis'],
    ])
    // Both tiers are visible in the event log (MVP exit criterion 4).
    const completed = ctx.eventLog.query({ type: 'workflow.node.completed', runId: started.runId })
    expect(completed.map((e) => [e.nodeId, e.data?.tier])).toEqual([['research:1', 'frontier'], ['compact:1', 'economy']])
  }, 180_000)

  it('answers ask as a one-node DAG with the caller\'s tier, and continues a session', async () => {
    const { ctx, fake } = await boot()
    const first = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'hello', tier: 'economy', persist: true }).runId, 30_000)
    expect(first).toMatchObject({ status: 'completed', answer: 'Plain answer.', nodes: [{ nodeId: 'ask:1', worker: 'worker:chatgpt-main/economy' }] })
    const second = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'again', sessionId: first.sessionId }).runId, 30_000)
    expect(second).toMatchObject({ status: 'completed', sessionId: first.sessionId, nodes: [{ worker: 'worker:chatgpt-main/standard' }] })
    expect(fake.sent[1]!.conversationId).toBe(fake.sent[0]!.conversationId ?? [...fake.conversations.keys()][0])
  }, 90_000)

  it('refuses a configured template that fails its check, alone: the engine and every other template keep working (INV-2)', async () => {
    const old = [{ nodeId: 'panel', objective: 'Answer as a panel', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary',
      acceptance: 'acceptance.team-synthesis', team: { members: 2, rounds: 2, distinctAccounts: true, lead: {} } }]
    const { ctx } = await boot({ workflow: { templates: { 'panel-led': old } } })
    expect(ctx.workflow.refusedTemplates()).toEqual([{ name: 'panel-led', reason: expect.stringMatching(/^node panel: team must be \{kind: brainstorm \| review/) }])
    expect(ctx.workflow.templateNames()).toEqual(expect.arrayContaining(['ask', 'brainstorm', 'review']))
    expect(ctx.workflow.templateNames()).not.toContain('panel-led')
    // What a served template runs, step by step, for a person to read before a start; none for a refused one (T116).
    expect(ctx.workflow.templateSteps('panel-led')).toBeUndefined()
    expect(ctx.workflow.templateSteps('toString')).toBeUndefined()
    expect(ctx.workflow.templateSteps('ask')).toEqual([expect.objectContaining({ capabilities: expect.arrayContaining(['reason']), tier: expect.any(String) })])
    expect(ctx.workflow.templateSteps('brainstorm')!.find((s) => s.team)).toMatchObject({ team: { kind: 'brainstorm', members: expect.any(Number) } })
    expect(() => ctx.workflow.start({ template: 'panel-led', input: 'q' })).toThrow(/workflow template panel-led was refused at load: node panel: team must be/)
    expect((await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'hi' }).runId, 60_000)).status).toBe('completed')
  }, 90_000)

  it('fails the run when a result is rejected by its acceptance contract, and never runs the next node (REQ-WRK-3, INV-3)', async () => {
    // A deployment that requires cited reports.
    const cited = TEST_TEMPLATES['deep-research']!.map((node) => ({ ...node, acceptance: 'acceptance.cited' }))
    const { ctx, fake } = await boot({ fake: { report: 'A report without any source.' }, workflow: { templates: { 'deep-research': cited } } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'deep-research', input: 'q' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'acceptance_rejected', disposition: 'NONE' } })
    expect(done.nodes.map((n) => n.state)).toEqual(['FAILED', 'WAITING'])
    expect(fake.sent).toHaveLength(1)
  }, 90_000)

  it('escalates a rejected result to the next tier once, keeping the rejected result as evidence (REQ-WRK-9)', async () => {
    const cited = [{ nodeId: 'ask:1', objective: 'x', prompt: '{{input}}', capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.cited' }]
    const { ctx, fake } = await boot({
      fake: { answer: (_prompt, sent) => (sent.power === 'Instant' ? 'No sources here.' : 'See https://src.example/a') },
      workflow: { templates: { cited } },
    })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'cited', input: 'q' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'See https://src.example/a', nodes: [{ tier: 'standard' }] })
    expect(fake.sent.map((s) => s.power)).toEqual(['Instant', 'Medium'])
    const record = ctx.workflow.records(done.runId)[0]!
    expect(record.requirement.tier).toMatchObject({ min: 'standard', source: 'decision' })
    const escalation = ctx.artifacts.get(record.requirement.tier.decision!)?.body as { decisionType: string; outcome: { option: string }; inputs: string[] }
    expect(escalation).toMatchObject({ decisionType: 'escalation', outcome: { option: 'escalate' } })
    expect(escalation.inputs).toHaveLength(2)
    expect(ctx.eventLog.query({ type: 'workflow.node.escalated', runId: done.runId })).toHaveLength(1)
  }, 90_000)

  it('grows the graph from a planner\'s validated plan, and feeds the steps\' findings to its dependent (REQ-WF-8, REQ-WF-10)', async () => {
    const answer = (prompt: string): string => {
      if (prompt.includes('Plan how to answer')) {
        return '```json\n' + JSON.stringify({ confidence: 'high', nodes: [
          { id: 'step-1', objective: 'Look up one', prompt: 'step one: look it up', capabilities: ['reason'], tier: 'economy' },
          { id: 'step-2', objective: 'Analyse two', prompt: 'step two: analyse {{input}}', capabilities: ['reason'], tier: 'standard', dependsOn: ['step-1'] },
        ] }) + '\n```'
      }
      if (prompt.includes('<findings>')) return `Synthesis of ${['finding A', 'finding B'].filter((f) => prompt.includes(f)).join(' and ')}`
      return prompt.includes('step one') ? 'finding A' : 'finding B'
    }
    const { ctx, fake } = await boot({ fake: { answer } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'investigate', input: 'why?' }).runId, 90_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'Synthesis of finding A and finding B' })
    expect(done.nodes.map((n) => [n.nodeId, n.state, n.tier])).toEqual([
      ['plan:1', 'COMPLETED', 'standard'], ['plan:1:step-1', 'COMPLETED', 'economy'], ['plan:1:step-2', 'COMPLETED', 'standard'], ['synthesis:1', 'COMPLETED', 'standard'],
    ])
    // A plan's text is used literally: its prompts are never expanded as templates.
    expect(fake.sent.map((s) => s.prompt)).toContain('step two: analyse {{input}}')
    const schemas = new SchemaRegistry()
    for (const record of ctx.workflow.records(done.runId)) schemas.assertRecord(record)
    const growth = ctx.artifacts.list({ kind: 'decision', decisionType: 'graph-growth', runId: done.runId })
    expect(growth.map((g) => (g.body as { outcome: { option: string } }).outcome.option)).toEqual(['append'])
    expect(ctx.artifacts.get(growth[0]!.inputs[0]!)).toMatchObject({ kind: 'plan', bodySchema: 'plan@1.0' })
  }, 120_000)

  it('refuses a plan whose step id is absurdly long as plan_rejected, never as an internal failure', async () => {
    const id = 'x'.repeat(400)
    const { ctx } = await boot({ fake: { answer: () => '```json\n' + JSON.stringify({ confidence: 'high', nodes: [{ id, objective: 'o', prompt: 'p', capabilities: ['reason'], tier: 'economy' }] }) + '\n```' } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'investigate', input: 'q' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'plan_rejected', disposition: 'NONE' } })
  }, 60_000)

  it('approves only the plan the operator names when two plans wait, never whichever came first (INV-5)', async () => {
    const [planner, synthesis] = TEST_TEMPLATES.investigate!
    const gated = { ...planner!, grows: { maxNodes: 2, approvalRequired: ['reason'] } }
    const twoPlans = [{ ...gated, nodeId: 'plan:a' }, { ...gated, nodeId: 'plan:b' }, { ...synthesis!, dependsOn: ['plan:a', 'plan:b'] }]
    const answer = (prompt: string): string => (prompt.includes('Plan how to answer')
      ? '```json\n{"confidence":"high","nodes":[{"id":"only","objective":"o","prompt":"the step","capabilities":["reason"],"tier":"economy"}]}\n```'
      : prompt.includes('<findings>') ? 'final' : 'step done')
    const { ctx } = await boot({ fake: { answer }, workflow: { templates: { twoPlans } } })
    const run = ctx.workflow.start({ template: 'twoPlans', input: 'q' })
    const plans = () => ctx.artifacts.list({ kind: 'plan', runId: run.runId })
    await until(() => plans().length === 2, 90_000)
    await until(() => ctx.workflow.records(run.runId).filter((r) => r.state === 'BLOCKED').length === 2, 30_000)
    expect(() => ctx.workflow.approve(run.runId, { verdict: 'approved' })).toThrow(/2 plans wait/)
    const [first, second] = plans()
    ctx.workflow.approve(run.runId, { verdict: 'approved', plan: first!.id })
    const approvals = () => ctx.artifacts.list({ kind: 'approval', runId: run.runId })
    expect(approvals().map((a) => (a.body as { subject: { ref: string } }).subject.ref)).toEqual([first!.id])
    // The run advances after a verdict (its lease is busy meanwhile); once it waits again, the
    // decided plan is no longer waiting and the other one is approved by its own id.
    const settled = async (fn: () => unknown): Promise<unknown> => {
      for (let i = 0; ; i++) {
        try {
          return fn()
        } catch (error) {
          if (!/busy/.test((error as Error).message) || i > 100) throw error
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
    }
    await expect(settled(() => ctx.workflow.approve(run.runId, { verdict: 'approved', plan: first!.id }))).rejects.toThrow(/not waiting/)
    await settled(() => ctx.workflow.approve(run.runId, { verdict: 'approved', plan: second!.id }))
    expect((await ctx.workflow.wait(run.runId, 90_000)).status).toBe('completed')
  }, 240_000)

  it('holds steps that need approval until the operator approves the exact plan (REQ-WF-11)', async () => {
    const gated = TEST_TEMPLATES.investigate!.map((n) => (n.grows ? { ...n, grows: { maxNodes: 2, approvalRequired: ['reason'] } } : n))
    const answer = (prompt: string): string => (prompt.includes('Plan how to answer')
      ? '```json\n{"confidence":"high","nodes":[{"id":"only","objective":"o","prompt":"the step","capabilities":["reason"],"tier":"economy"}]}\n```'
      : prompt.includes('<findings>') ? 'final' : 'step done')
    const { ctx, fake } = await boot({ fake: { answer }, workflow: { templates: { gated, rejectable: gated } } })
    const run = ctx.workflow.start({ template: 'gated', input: 'q' })
    await until(() => ctx.workflow.get(run.runId)?.blocked !== undefined, 60_000)
    const blocked = ctx.workflow.get(run.runId)!
    expect(blocked).toMatchObject({ status: 'running', blocked: { nodeId: 'plan:1:gate' } })
    expect(blocked.updatedAt > blocked.createdAt).toBe(true) // the plan's progress shows while the run is still running
    expect(fake.sent).toHaveLength(1)
    ctx.workflow.approve(run.runId, { verdict: 'approved', note: 'fine' })
    const done = await ctx.workflow.wait(run.runId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'final' })
    const approval = ctx.artifacts.list({ kind: 'approval', runId: run.runId })[0]!
    expect(approval.body).toMatchObject({ verdict: 'approved', by: 'operator', subject: { type: 'artifact', ref: waitingPlan(blocked) } })
    // A rejection fails the run, and the steps never run.
    const second = ctx.workflow.start({ template: 'rejectable', input: 'q2' })
    await until(() => ctx.workflow.get(second.runId)?.blocked !== undefined, 60_000)
    ctx.workflow.approve(second.runId, { verdict: 'rejected' })
    expect(await ctx.workflow.wait(second.runId, 30_000)).toMatchObject({ status: 'failed', error: { kind: 'plan_rejected' } })
    expect(() => ctx.workflow.approve(second.runId, { verdict: 'approved' })).toThrow(/waiting for approval/)
  }, 150_000)

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

  it('keeps a completed step when a later one fails: the operator\'s continue re-runs only the failed step, on the same input, as a new attempt recorded as their decision (QA-2, REQ-WF-3, REQ-WF-7)', async () => {
    const chain = [
      { nodeId: 'first:1', objective: 'x', prompt: 'first: {{input}}', capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.answer' },
      { nodeId: 'second:1', objective: 'y', dependsOn: ['first:1'], prompt: 'second: {{node:first:1}}', capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.cited', maxEscalations: 0 },
    ]
    let cite = false
    const { ctx, fake } = await boot({ fake: { answer: (p: string) => (p.startsWith('first') ? 'the first result' : cite ? 'See https://src.example/a' : 'no source') }, workflow: { templates: { chain } } })
    const failed = await ctx.workflow.wait(ctx.workflow.start({ template: 'chain', input: 'q' }).runId, 60_000)
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'acceptance_rejected' } })
    expect(failed.nodes.map((n) => n.state)).toEqual(['COMPLETED', 'FAILED'])
    const before = ctx.workflow.records(failed.runId)
    cite = true
    expect(ctx.workflow.continue(failed.runId)).toMatchObject({ status: 'running' })
    const done = await ctx.workflow.wait(failed.runId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'See https://src.example/a' })
    // The first step was sent once; the second twice, both times on the same input hash.
    expect(fake.sent.map((s) => s.prompt.split(':')[0])).toEqual(['first', 'second', 'second'])
    const after = ctx.workflow.records(done.runId)
    expect(after[0]!.outputReceipt).toEqual(before[0]!.outputReceipt)
    expect(after[1]!.inputReceipt!.inputHash).toBe(before[1]!.inputReceipt!.inputHash)
    const recovery = ctx.artifacts.list({ kind: 'decision', decisionType: 'recovery', runId: failed.runId }).map((a) => a.body as { decider: { type: string }; outcome: { option: string } })
    expect(recovery).toContainEqual(expect.objectContaining({ decider: expect.objectContaining({ type: 'operator' }), outcome: expect.objectContaining({ option: 'continue' }) }))
    expect(() => ctx.workflow.continue(failed.runId)).toThrow(/not failed/)
  }, 120_000)

  it('deletes a deleted run\'s website conversation on its site, but never one a later run of the session still uses (REQ-PRV-8)', async () => {
    const { ctx, fake } = await boot()
    // As the live check does for the real site: the fake's delete flow is the one its map describes.
    const map = (ctx.providers.get('chatgpt-web') as unknown as { map: { elements: Record<string, { unverified?: true }>; actions: Record<string, { unverified?: true }> } }).map
    for (const spec of [...Object.values(map.elements), ...Object.values(map.actions)]) delete spec.unverified
    const first = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'hello', persist: true }).runId, 30_000)
    const second = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'again', sessionId: first.sessionId }).runId, 30_000)
    const alone = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'alone', persist: true }).runId, 30_000)
    const [binding] = ctx.turns.conversations({ sessionId: first.sessionId! }).map((c) => c.binding)
    // The session continues in the second run: deleting the first releases nothing.
    ctx.workflow.delete(first.runId, ctx.workflow.delete(first.runId).updatedAt)
    expect(ctx.turns.conversations({ sessionId: first.sessionId! })).toEqual([expect.objectContaining({ binding, state: 'live' })])
    ctx.workflow.delete(alone.runId, ctx.workflow.delete(alone.runId).updatedAt)
    await expect.poll(() => ctx.turns.conversations({ sessionId: alone.sessionId! })[0]?.state, { timeout: 60_000 }).toBe('deleted')
    ctx.workflow.delete(second.runId, ctx.workflow.delete(second.runId).updatedAt)
    await expect.poll(() => ctx.turns.conversations({ sessionId: first.sessionId! })[0]?.state, { timeout: 60_000 }).toBe('deleted')
    expect(fake.deleted.has(binding!)).toBe(true)
    expect(ctx.eventLog.query({ type: 'conversation.released' })).toHaveLength(2)
  }, 180_000)

  it('deletes a finished run only on the exact version its preview showed (REQ-WF-7)', async () => {
    const { ctx } = await boot()
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'bye' }).runId, 30_000)
    const preview = ctx.workflow.delete(done.runId)
    expect(preview).toMatchObject({ deleted: false, runId: done.runId, status: 'completed', updatedAt: done.updatedAt, nodes: 1 })
    expect(() => ctx.workflow.delete(done.runId, '2000-01-01T00:00:00.000Z')).toThrow(/changed/)
    expect(ctx.workflow.delete(done.runId, preview.updatedAt)).toMatchObject({ deleted: true })
    expect(ctx.workflow.get(done.runId)).toBeUndefined()
    // Artifacts are append-only and stay.
    expect(ctx.artifacts.get(done.result!)).toBeDefined()
  }, 60_000)

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
