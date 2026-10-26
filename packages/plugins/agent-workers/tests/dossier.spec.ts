// A board task's dossier as an agent Worker writes it (ADR-0070): its run holds `dossier_read` and
// `dossier_append` as host tools, bound by this source to the step it serves, so the agent's own
// calls (through its gate) append the plan and progress as that step's Worker, and it can name no
// other step. Over the store-backed board, queue, and engine; only the agent runtime is scripted.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry, { type AgentRuntimeProvider, type RunSpec, type ToolCall, type ToolVerdict } from '@tsuuanmi/system-agent-runtimes'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerRouter from '@tsuuanmi/system-workers'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import Workflow from '@tsuuanmi/system-workflow'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { CHARTER } from '../../../board-core/conformance/board.ts'
import AgentWorkers from '../src/index.ts'

const WORKSPACE = mkdtempSync(join(tmpdir(), 'system-dossier-ws-'))
afterAll(() => rmSync(WORKSPACE, { recursive: true, force: true }))

/**
 * A scripted agent whose runtime offers host tools (or not, `hostTools: false`): each run makes its
 * scripted calls, asking the run's gate before each one as a gating runtime does; an allowed call of a
 * host tool is answered by the tool the run was given, as the runtime's server would.
 */
class HostedAgent implements AgentRuntimeProvider {
  readonly kind = 'hosted'
  readonly runs: RunSpec[] = []
  readonly verdicts: ToolVerdict[] = []
  readonly answers: Array<{ text: string; isError: boolean }> = []
  constructor(private readonly calls: Array<Omit<ToolCall, 'callId'>>, private readonly offers = true) {}
  async probe() {
    return { available: true, detail: 'hosted 1.0', sandboxes: ['read-only', 'workspace-write'] as Array<'read-only' | 'workspace-write'>, resume: true, executes: true, readsConfined: true, gatesToolCalls: true, ...(this.offers ? { hostTools: true } : {}) }
  }
  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void) {
    this.runs.push(spec)
    onHandle?.(`h-${this.runs.length}`)
    for (const [i, call] of this.calls.entries()) {
      const verdict = await spec.toolGate!({ ...call, callId: `call-${i + 1}` }, signal)
      this.verdicts.push(verdict)
      if (verdict.decision !== 'allow') continue
      const tool = spec.hostTools?.find((t) => `mcp__system__${t.name}` === call.tool)
      if (tool) this.answers.push(await tool.call(call.input as Record<string, unknown>))
    }
    return { text: 'Transcript: I read calc.py, edited it, and ran the tests.', nativeHandle: `h-${this.runs.length}`, turns: 1 }
  }
}

const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio-test', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto' }, { actionClass: 'command', mode: 'ask' }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86_400 },
}
const CHANGE = [{ nodeId: 'change', objective: 'Change the code', prompt: '{{input}}', capabilities: ['develop', 'local-data'], tier: 'standard' as const, conversation: 'persistent' as const, acceptance: 'acceptance.answer' }]

async function bootTask(agent: AgentRuntimeProvider) {
  const dir = mkdtempSync(join(tmpdir(), 'system-dossier-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(WorkerSessions, {}),
    ctx.plugin(AgentWorkers, { workers: [{ id: 'dev', runtime: agent.kind, workspace: WORKSPACE, sandbox: 'workspace-write', tier: 'standard' }] }),
    ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
  ]
  await Promise.all(fibers)
  const engine = ctx.plugin(Workflow, { retryDelayMs: 50, approvalPollSeconds: 1, templates: { change: CHANGE } })
  await engine
  ctx.agentRuntimes.register(agent)
  onTestFinished(async () => {
    await engine.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  // The board's own steps to a ready task (kept here so these tests compose the engine's code, never its tests).
  const { approvalRequest } = await ctx.board.charter({ projectId: 'p1', title: 'project p1', charter: CHARTER })
  const request = await ctx.approvals.get(approvalRequest)
  await ctx.approvals.decide([{ requestId: approvalRequest, subject: request!.subject, verdict: 'approved' }])
  await ctx.board.sweep(new Date())
  const proposed = await ctx.board.propose({ projectId: 'p1', title: 'change', goal: 'make add() add', acceptance: [{ id: 'a1', statement: 'it answers' }], actionClass: 'read' })
  await ctx.board.sweep(new Date())
  const task = (await ctx.board.task(proposed.taskId))!
  expect(task.state).toBe('ready')
  const run = await ctx.workflow.start({ template: 'change', input: 'Make add() add', classification: 'operator-shared', task: { taskId: task.taskId } })
  const done = await vi.waitFor(() => {
    const view = ctx.workflow.get(run.runId)!
    if (view.task?.phase !== 'reported') throw new Error(`run ${run.runId} is not reported yet (${view.status})`)
    return view
  }, { timeout: 30_000, interval: 50 })
  return { ctx, task, run, done }
}

const PLAN = 'Plan: make add() return a + b in calc.py; risk: a caller relying on the difference.'
const PROGRESS = 'Changed calc.py: add() adds. Remains: a test, which I did not write.'
const EVIDENCE = '$ npm test\nexit 0\nTests: 3 passed, 0 failed'
const append = (input: Record<string, unknown>) => ({ tool: 'mcp__system__dossier_append', input })

describe('an agent Worker\'s own dossier tools (ADR-0070)', { timeout: 60_000 }, () => {
  it('appends the plan and progress as the Worker of the step it runs, through its gate; the agent names no step, and one that tries is denied', async () => {
    const agent = new HostedAgent([
      append({ kind: 'plan', text: PLAN }),
      // The agent cannot choose the step or the run it writes for: no such argument exists, and the gate refuses it.
      append({ kind: 'progress', text: 'forged', runId: 'run_other', nodeId: 'review' }),
      // Nor write a reviewer's kind.
      append({ kind: 'review', text: 'approve' }),
      // An author shows the output of the checks it ran as evidence (T267): its own report, by its own name.
      append({ kind: 'evidence', text: EVIDENCE }),
      append({ kind: 'progress', text: PROGRESS, commits: ['0123abc'] }),
      { tool: 'mcp__system__dossier_read', input: { limit: 10 } },
    ])
    const { ctx, task, run, done } = await bootTask(agent)
    expect(done).toMatchObject({ status: 'completed', task: { outcome: { status: 'accepted' } } })
    // The run was given the two tools, and told what to write with them; its Worker offers `dossier`, which a step that must show its checks' output needs (T267).
    expect(agent.runs[0]!.hostTools?.map((t) => t.name)).toEqual(['dossier_read', 'dossier_append'])
    expect((await ctx.workers.list()).find((w) => w.worker === 'agent:dev')!.capabilities.map((c) => c.capability)).toContain('dossier')
    expect(agent.runs[0]!.prompt).toContain('dossier_append adds your entry as this step\'s Worker')
    const [plan, forged, review, evidence, progress, read] = agent.verdicts
    expect(plan).toEqual({ decision: 'allow' })
    expect(forged).toMatchObject({ decision: 'deny', reason: expect.stringContaining('carries "runId", a field the gate does not classify') })
    // The gate lets the call through to the tool, which refuses a kind the step's role does not write: nothing is appended.
    expect(review).toEqual({ decision: 'allow' })
    expect([evidence, progress, read]).toEqual([{ decision: 'allow' }, { decision: 'allow' }, { decision: 'allow' }])
    expect(agent.answers.map((a) => a.isError)).toEqual([false, true, false, false, false])
    expect(agent.answers[1]!.text).toMatch(/^refused: .*a writing step appends plan, progress, response, evidence, not review/)
    expect(JSON.parse(agent.answers[4]!.text)).toMatchObject({ taskId: task.taskId, total: 3, entries: [{ seq: 1, kind: 'plan' }, { seq: 2, kind: 'evidence' }, { seq: 3, kind: 'progress' }] })

    // The entries are the step's Worker's, bound to the step and the execution this source ran it as.
    const execution = done.nodes.find((n) => n.nodeId === 'change')!.executionId!
    const page = ctx.workflow.dossier({ taskId: task.taskId })
    expect(page.entries.map((e) => [e.kind, e.author])).toEqual([
      ['plan', { type: 'worker', ref: 'agent:dev', runId: run.runId, nodeId: 'change', execution }],
      // The author's own evidence is the Worker's, never the System's: a reader tells them apart by author.
      ['evidence', { type: 'worker', ref: 'agent:dev', runId: run.runId, nodeId: 'change', execution }],
      ['progress', { type: 'worker', ref: 'agent:dev', runId: run.runId, nodeId: 'change', execution }],
      // The System's evidence: acceptance, then the report to the board (the landing's outcome may follow).
      ['evidence', { type: 'system', ref: 'workflow', runId: run.runId }],
      ['evidence', { type: 'system', ref: 'workflow', runId: run.runId }],
      ...page.entries.slice(5).map(() => ['evidence', { type: 'system', ref: 'workflow', runId: run.runId }]),
    ])
    expect(page.entries.map((e) => e.text).slice(0, 3)).toEqual([PLAN, EVIDENCE, PROGRESS])
    expect(page.entries[2]!.commits).toEqual(['0123abc'])
    // It wrote its own, so the engine added no entry for the step; its transcript is nowhere in the dossier.
    expect(page.entries.some((e) => e.text.includes('Transcript'))).toBe(false)
    // Once the step settled, the tools it held write nothing more.
    expect(await agent.runs[0]!.hostTools!.find((t) => t.name === 'dossier_append')!.call({ kind: 'progress', text: 'late' }))
      .toMatchObject({ isError: true, text: expect.stringMatching(/is not running.*; nothing was appended/) })
  })

  it('gives no dossier tool on a runtime that offers no host tools: the engine records the step, its answer linked, never copied', async () => {
    const agent = new HostedAgent([append({ kind: 'plan', text: PLAN })], false)
    const { ctx, task, done } = await bootTask(agent)
    expect(done).toMatchObject({ status: 'completed' })
    expect(agent.runs[0]!.hostTools).toBeUndefined()
    expect(agent.runs[0]!.prompt).not.toContain('dossier_append')
    expect((await ctx.workers.list()).find((w) => w.worker === 'agent:dev')!.capabilities.map((c) => c.capability)).not.toContain('dossier')
    // A host tool the run was not given is no tool of System's: denied.
    expect(agent.verdicts).toEqual([expect.objectContaining({ decision: 'deny', reason: expect.stringContaining('this run was given no such host tool') })])
    const [entry] = ctx.workflow.dossier({ taskId: task.taskId }).entries
    expect(entry).toMatchObject({ kind: 'progress', author: { type: 'worker', ref: 'agent:dev' }, text: expect.stringMatching(/Its answer is linked, not copied/) })
    expect(entry!.text).not.toContain('Transcript')
  })
})
