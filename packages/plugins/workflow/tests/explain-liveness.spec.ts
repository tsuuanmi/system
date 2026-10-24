/**
 * `explain` and the liveness of a run's executions (PROP-0013, ADR-0056): what the Worker sources tell
 * of an execution that is stalled, being looked at, or ended without being known to be gone, beside
 * the run's decision chain, through the tool's own handler.
 */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { Workflow } from '../src/index.ts'
import { registerTools } from '../src/tools.ts'
import type { Explanation } from '../src/types.ts'

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>

const RUN: Explanation = { runId: 'run_1', template: 'develop', status: 'running', specHash: `sha256:${'a'.repeat(64)}`, nodes: [{ nodeId: 'develop:1', state: 'RUNNING', executionId: 'arun_00000000000000aa', worker: 'agent:dev', decisions: [] }] }
const HELD = {
  source: 'agents', execution: 'arun_00000000000000aa', worker: 'agent:dev', state: 'unknown' as const, since: '2026-10-24T01:00:00.000Z', verdict: 'unknown (liveness@1)', looks: { taken: 3, max: 3 },
  reasons: ['the agent process: unknown (never reported)'], decision: `sha256:${'b'.repeat(64)}` as const, holds: ['session ses_1'], action: 'confirm that no process of its agent runs, then free it: system free arun_00000000000000aa --agent-gone', runId: 'run_1', sessionId: 'ses_1',
}

/** The `explain` handler over one run, with a `ctx.workers` that tells `told` (or throws it), or none. */
function explain(told?: { runs: Array<typeof HELD>; unread: Array<{ source: string; detail: string }> } | Error): { handler: Handler; asked: unknown[] } {
  const registered = new Map<string, Handler>()
  const asked: unknown[] = []
  const c = { mcp: { tool: (name: string, _spec: unknown, handler: Handler) => registered.set(name, handler) } } as unknown as Context
  const w = { explain: (id: string) => (id === RUN.runId ? RUN : undefined) } as unknown as Workflow
  const workers = told === undefined ? undefined : {
    liveness: async (query: { runId?: string; execution?: string }) => {
      asked.push(query)
      if (told instanceof Error) throw told
      const runs = told.runs.filter((r) => (!query.runId || r.runId === query.runId) && (!query.execution || r.execution === query.execution))
      return { runs, counts: { unknown: runs.length, looking: 0, stalled: 0 }, unread: told.unread }
    },
  }
  const ctx = { get: (key: string) => (key === 'workers' ? workers : undefined), artifacts: { explain: () => undefined } } as unknown as Context
  registerTools(c, w, ctx)
  return { handler: registered.get('explain')!, asked }
}

describe('explain: the liveness of a run\'s executions (PROP-0013)', () => {
  it('gives a run\'s executions whose liveness needs a look beside its decision chain: the verdict, its looks, why, what it holds, and what to do', async () => {
    const { handler, asked } = explain({ runs: [HELD], unread: [] })
    const explained = await handler({ id: 'run_1' })
    expect(explained.structuredContent).toEqual({ ...RUN, liveness: [HELD] })
    expect(asked).toEqual([{ runId: 'run_1' }])
    // An execution told of by its own id; anything else is unknown.
    expect((await handler({ id: HELD.execution })).structuredContent).toEqual({ execution: HELD.execution, liveness: [HELD] })
    expect(await handler({ id: 'arun_00000000000000cc' })).toMatchObject({ isError: true, content: [{ text: 'nothing is known about arun_00000000000000cc' }] })
  })

  it('leaves a run with nothing to tell as it was, and names a source that could not tell, never reading it as having none (INV-2)', async () => {
    expect((await explain({ runs: [], unread: [] }).handler({ id: 'run_1' })).structuredContent).toEqual(RUN)
    expect((await explain().handler({ id: 'run_1' })).structuredContent).toEqual(RUN)
    expect((await explain({ runs: [], unread: [{ source: 'agents', detail: 'the store failed' }] }).handler({ id: 'run_1' })).structuredContent).toEqual({ ...RUN, liveness: [], livenessUnread: [{ source: 'agents', detail: 'the store failed' }] })
    expect((await explain(new Error('no router')).handler({ id: 'run_1' })).structuredContent).toEqual({ ...RUN, liveness: [], livenessUnread: [{ source: 'workers', detail: 'no router' }] })
  })
})
