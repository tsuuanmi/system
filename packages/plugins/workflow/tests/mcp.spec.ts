import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: explain, and MCP', () => {
  it('explains a run: egress, tier, route, and acceptance for every node (REQ-ART-3)', async () => {
    const { ctx } = await boot()
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'deep-research', input: 'why' }).runId, 60_000)
    const explained = ctx.workflow.explain(done.runId)!
    expect(explained.nodes.map((n) => [n.nodeId, n.decisions.map((d) => [d.type, d.outcome])])).toEqual([
      ['research:1', [['egress', 'allow'], ['tier', 'frontier'], ['route', 'worker:chatgpt-main/frontier'], ['acceptance', 'accept']]],
      ['compact:1', [['egress', 'allow'], ['tier', 'economy'], ['route', 'worker:chatgpt-main/economy'], ['acceptance', 'accept']]],
    ])
    expect(explained.nodes[1]!.decisions[3]!.reasons).toEqual(['the answer has text'])
    // Runs outlive their turns: the chain survives the turn runtime's retention.
    ctx.store.db.prepare('DELETE FROM turns').run()
    expect(ctx.workflow.explain(done.runId)!.nodes.map((n) => n.decisions.length)).toEqual([4, 4])
  }, 90_000)

  it('serves ask, research, run, result, usage, and explain over MCP in place of the placeholders (REQ-GW-3, REQ-SES-8)', async () => {
    const { ctx, dir } = await boot()
    const { url, tokenFiles } = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { url: string; tokenFiles: { operator: string } }
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${readFileSync(tokenFiles.operator).toString('base64url')}` } } }) as unknown as Transport)
    try {
      const asked = await client.callTool({ name: 'ask', arguments: { prompt: 'hi', waitSeconds: 25 } })
      expect(asked.content).toEqual([{ type: 'text', text: 'Plain answer.' }])
      const runId = (asked.structuredContent as { runId: string }).runId
      expect(asked.structuredContent).toMatchObject({ runId, status: 'completed', answer: 'Plain answer.' })
      // `research` runs the research profile's procedure: without that profile it fails closed, naming the template.
      const noProfile = await client.callTool({ name: 'research', arguments: { question: 'q' } })
      expect(noProfile).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/unknown workflow template research/) }] })
      ctx.workflow.template('research', [{ nodeId: 'study:1', objective: 'answer', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer' }])
      expect((await client.callTool({ name: 'research', arguments: { question: 'q' } })).structuredContent).toMatchObject({ template: 'research', nodes: [{ nodeId: 'study:1' }] })
      const research = await client.callTool({ name: 'run', arguments: { template: 'deep-research', input: 'q', waitSeconds: 0 } })
      const researchRun = research.structuredContent as { runId: string; status: string; sessionId: string }
      expect(researchRun).toMatchObject({ status: 'running', sessionId: expect.stringMatching(/^ses_/) })
      const fetched = await client.callTool({ name: 'result', arguments: { runId: researchRun.runId, waitSeconds: 40 } })
      expect(fetched.structuredContent).toMatchObject({ status: 'completed' })
      const usage = await client.callTool({ name: 'usage', arguments: {} })
      expect((usage.structuredContent as { runs: Array<{ runId: string; nodes: Array<{ tier: string; quotaClass: string }> }> }).runs.find((r) => r.runId === researchRun.runId)?.nodes)
        .toEqual([expect.objectContaining({ tier: 'frontier', quotaClass: 'subscription-chat' }), expect.objectContaining({ tier: 'economy', quotaClass: 'subscription-chat' })])
      const explained = await client.callTool({ name: 'explain', arguments: { id: runId } })
      expect(explained.structuredContent).toMatchObject({ runId, nodes: [{ nodeId: 'ask:1' }] })
      const ran = await client.callTool({ name: 'run', arguments: { template: 'ask', input: 'via run', waitSeconds: 25 } })
      expect(ran.structuredContent).toMatchObject({ template: 'ask', status: 'completed', answer: 'Plain answer.' })
      expect((await client.callTool({ name: 'run', arguments: { template: 'nope', input: 'x' } })).isError).toBe(true)
      const missing = await client.callTool({ name: 'result', arguments: { runId: 'run_nope' } })
      expect(missing.isError).toBe(true)
    } finally {
      await client.close()
    }
  }, 120_000)
})
