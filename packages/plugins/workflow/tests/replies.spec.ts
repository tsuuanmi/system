/**
 * The engine's most read replies, `result` and `usage`, measured on fixture runs through the tools'
 * own handlers, as the MCP response a client reads (QA-12, INV-9). The shipped profile's replies
 * and `tools/list` are measured in packages/cli/tests/surface.e2e.ts; the ceilings and the token
 * estimator are in packages/plugins/mcp-server/tests/budget.ts.
 */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { BUDGET, bytesOf, tokens } from '../../mcp-server/tests/budget.ts'
import type { Workflow } from '../src/index.ts'
import { registerTools } from '../src/tools.ts'
import type { NodeView, RunView } from '../src/types.ts'

const hex = (seed: string, length: number): string => seed.repeat(length).slice(0, length)
const ref = (seed: string) => `sha256:${hex(seed, 64)}` as NonNullable<RunView['result']>
/** An answer of exactly `bytes` ASCII bytes. */
const answerOf = (bytes: number): string => 'The evidence supports the first hypothesis. '.repeat(Math.ceil(bytes / 44)).slice(0, bytes)
const at = (second: number): string => new Date(Date.UTC(2026, 9, 24, 8, 0, second)).toISOString()

/** A completed node on a website Worker, as the engine views it. */
const node = (nodeId: string, seed: string, minTier: NodeView['minTier'] = 'standard'): NodeView => ({
  nodeId, state: 'COMPLETED', minTier, attempt: 1, executionId: `turn_${hex(seed, 16)}`, source: 'website',
  worker: `worker:main-account/${minTier}`, tier: minTier, quotaClass: 'subscription-chat', result: ref(seed), brief: ref(`${seed}b`),
})
const run = (runId: string, template: string, nodes: NodeView[], answer: string): RunView => ({
  runId: `run_${hex(runId, 16)}`, template, status: 'completed', specHash: ref(runId), result: nodes.at(-1)!.result!, answer, nodes, createdAt: at(0), updatedAt: at(30),
})

/** An ask answered in 1,000 bytes; a research run's six steps and a 4,000-byte conclusion; an ask that failed closed. */
const ASK = run('a1', 'ask', [node('ask:1', 'c1')], answerOf(1000))
const RESEARCH = run('b2', 'research', ['frame:1', 'literature:1', 'literature:2', 'evidence:1', 'critique:1', 'conclusion:1'].map((id, i) => node(id, `d${i}`, i ? 'frontier' : 'standard')), answerOf(4000))
const FAILED: RunView = {
  runId: `run_${hex('e3', 16)}`, template: 'ask', status: 'failed', specHash: ref('e3'), createdAt: at(0), updatedAt: at(1),
  nodes: [{ nodeId: 'ask:1', state: 'FAILED', minTier: 'standard', attempt: 1, error: { kind: 'reauth_required', disposition: 'USER_ACTION', message: 'no Worker can take this work: no Worker is configured' } }],
  error: { kind: 'reauth_required', disposition: 'USER_ACTION', message: 'no Worker can take this work: no Worker is configured' },
}

type Handler = (args: Record<string, unknown>) => Promise<unknown>

/** The engine's tool handlers over a workflow that holds the fixture runs. */
function tools(runs: RunView[]): Map<string, Handler> {
  const registered = new Map<string, Handler>()
  const c = { mcp: { tool: (name: string, _spec: unknown, handler: Handler) => registered.set(name, handler) } } as unknown as Context
  const w = {
    wait: async (runId: string) => runs.find((r) => r.runId === runId)!,
    usage: (limit: number) => runs.slice(0, limit),
  } as unknown as Workflow
  registerTools(c, w, {} as Context)
  return registered
}

/** The JSON-RPC response of a `tools/call`, as the server sends it. */
const reply = async (handler: Handler, args: Record<string, unknown>) => bytesOf({ result: await handler(args), jsonrpc: '2.0', id: 1 })

describe('replies say it once (QA-12)', () => {
  it('gives a completed run its answer as text, any other run a line on where it stands, and the run once, as structured content', async () => {
    const result = tools([RESEARCH, ASK, FAILED]).get('result')!
    expect(await result({ runId: ASK.runId })).toEqual({ content: [{ type: 'text', text: ASK.answer }], structuredContent: ASK })
    expect(await result({ runId: FAILED.runId })).toEqual({ content: [{ type: 'text', text: `${FAILED.runId} (ask) failed: reauth_required: ${FAILED.error!.message}` }], structuredContent: FAILED })
    const running: RunView = { ...RESEARCH, status: 'running', nodes: RESEARCH.nodes.map((n, i) => (i < 2 ? n : { ...n, state: 'RUNNING' })) }
    expect((await tools([running]).get('result')!({ runId: running.runId }) as { content: unknown }).content).toEqual([{ type: 'text', text: `${running.runId} (research) running: 2 of 6 steps completed; poll result with its runId` }])
  })

  it('reports usage without answers, ids, or errors: per step its Worker, tier, quota class, and tokens; ten runs unless asked for more (QA-12, INV-9)', async () => {
    const counted = { ...ASK, runId: `run_${hex('f4', 16)}`, nodes: [{ ...ASK.nodes[0]!, usage: { inputTokens: 7, outputTokens: 3 } }] }
    const many = Array.from({ length: 12 }, (_, i) => ({ ...counted, runId: `run_${String(i).padStart(16, '0')}` }))
    const usage = tools(many).get('usage')!
    const page = await usage({}) as { content: Array<{ text: string }>; structuredContent: { runs: Array<Record<string, unknown>> } }
    expect(page.structuredContent.runs).toHaveLength(10)
    expect(page.content).toEqual([{ type: 'text', text: '10 recent runs, 10 steps' }])
    expect(page.structuredContent.runs[0]).toEqual({
      runId: many[0]!.runId, template: 'ask', status: 'completed', createdAt: ASK.createdAt, updatedAt: ASK.updatedAt,
      nodes: [{ nodeId: 'ask:1', state: 'COMPLETED', minTier: 'standard', attempt: 1, executionId: ASK.nodes[0]!.executionId, source: 'website', worker: 'worker:main-account/standard', tier: 'standard', quotaClass: 'subscription-chat', usage: { inputTokens: 7, outputTokens: 3 } }],
    })
    expect((await usage({ limit: 12 }) as typeof page).structuredContent.runs).toHaveLength(12)
    const failed = (await tools([FAILED]).get('usage')!({}) as typeof page).structuredContent.runs[0]!
    expect(failed).not.toHaveProperty('error')
    expect(failed.nodes).toEqual([{ nodeId: 'ask:1', state: 'FAILED', minTier: 'standard', attempt: 1 }])
  })
})

describe('reply budget (fixtures)', () => {
  it('keeps result of a completed ask and of a research run, and usage of three runs, under their ceilings (QA-12, INV-9)', async () => {
    const handlers = tools([RESEARCH, ASK, FAILED])
    const measured = {
      resultAsk: await reply(handlers.get('result')!, { runId: ASK.runId }),
      resultResearch: await reply(handlers.get('result')!, { runId: RESEARCH.runId }),
      usageThreeRuns: await reply(handlers.get('usage')!, {}),
    }
    for (const [name, bytes] of Object.entries(measured) as Array<[keyof typeof measured, number]>) {
      expect.soft(bytes, `reply ${name}: ${bytes} B (~${tokens(bytes)} tokens) over its ceiling`).toBeLessThanOrEqual(BUDGET.replies[name].ceiling)
    }
  })
})
