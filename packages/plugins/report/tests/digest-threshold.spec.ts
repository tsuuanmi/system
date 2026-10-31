// lead_digest flags a hold under the N the lead inbox is configured with (its `expiringHours`, T357),
// through the public handler over the real core: a real board hold, held for the operator for the
// studio policy's day, is flagged with N = 30 and not with N = 12.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { ArtifactRef } from '@tsuuanmi/system-board-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import EventLog from '@tsuuanmi/system-event-log'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import LeadInbox from '@tsuuanmi/system-lead-inbox'
import Leases from '@tsuuanmi/system-leases'
import StoreResources from '@tsuuanmi/system-resources'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { charter, POLICY, until } from '../../profile-software-development/tests/pilot.ts'
import * as Report from '../src/index.ts'

vi.setConfig({ testTimeout: 120_000 })

class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

async function boot(expiringHours: number | undefined): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'system-digest-threshold-'))
  const ctx = new Context()
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, { retainDays: 0 }), ctx.plugin(Leases, {}),
    ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(StoreResources, { pools: [] }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }), ctx.plugin(RecordingMcp),
    ...(expiringHours === undefined ? [] : [ctx.plugin(LeadInbox, { expiringHours })]), ctx.plugin(Report),
  ]
  await Promise.all(fibers)
  await until(() => ctx.get('board'), 'the board')
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  await charter(ctx, 'p1')
  return ctx
}

/** A workspace-write result accepted by a rule with its required checks not reported: the board holds it for the operator. */
async function hold(ctx: Context): Promise<string> {
  const proposed = await ctx.board.propose({ projectId: 'p1', title: 'held result', goal: 'g', acceptance: [{ id: 'a1', statement: 'tests pass', check: 'tests' }], actionClass: 'workspace-write' })
  await ctx.board.sweep(new Date())
  const { generation } = await ctx.board.claim(proposed.taskId, 'lead', 60_000)
  await ctx.board.start(proposed.taskId, generation, { runId: 'run-held' })
  const r = ctx.artifacts.put({
    kind: 'report', bodySchema: 'agent-result@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: 'test' },
    body: { schema: 'agent-result@1.0', worker: 'w', runtime: 'fake', runId: 'r', promptHash: `sha256:${'0'.repeat(64)}`, sandbox: 'read-only', text: 'done' },
  }).id as ArtifactRef
  const subject = { type: 'git-head' as const, ref: 'HEAD', version: 'abc123' }
  await ctx.board.submit(proposed.taskId, generation, { artifacts: [r], subject })
  const decision = ctx.artifacts.recordDecision({
    decisionType: 'acceptance', question: `Does the result of ${proposed.taskId} satisfy the criteria?`, inputs: [r],
    candidates: [{ option: 'accept', selected: true, reasons: ['the criteria hold'] }, { option: 'reject', selected: false, reasons: ['not reject: the criteria hold'] }],
    decider: { type: 'rule', id: 'acceptance.test', version: '1' }, outcome: { option: 'accept', detail: { taskId: proposed.taskId, subject } }, deterministic: true,
  }, { producer: { type: 'policy', ref: 'test' } }).id as ArtifactRef
  const held = await ctx.board.accept(proposed.taskId, decision)
  expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' } })
  return proposed.taskId
}

const digestLine = async (ctx: Context, taskId: string): Promise<string> => {
  const tool = (ctx.get('mcp') as RecordingMcp).tools.get('lead_digest')!
  const result = await tool.handler({}, { scope: 'client', lead: 'p1' })
  expect(result.isError).toBeFalsy()
  const text = (result.content as Array<{ text: string }>)[0]!.text
  return text.split('\n').find((l) => l.includes(`review ${taskId}`))!
}

describe('lead_digest flags holds under the lead inbox\'s expiringHours', () => {
  it('flags the day-long hold with expiringHours 30, and not with 12', async () => {
    for (const [hours, flagged] of [[30, true], [12, false]] as const) {
      const ctx = await boot(hours)
      const taskId = await hold(ctx)
      const line = await digestLine(ctx, taskId)
      expect(line).toMatch(/h to expiry/)
      if (flagged) expect(line).toContain('EXPIRING SOON')
      else expect(line).not.toContain('EXPIRING SOON')
    }
  })
})
