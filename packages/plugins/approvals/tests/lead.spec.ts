// The lead principal in the approval queue (ADR-0076): a project's lead gives verdicts on its own
// token, held to a closed list of rights the queue enforces, and what it decides is recorded as
// `lead:<project>`, never as the operator's.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { type Action, type ApprovalRequest, ApprovalsError, type AutonomyPolicy, type NewRequest, type Subject } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { POLICIES } from '../../../approvals-core/conformance/approvals.ts'
import { checkConfig, type Config } from '../src/index.ts'
import { APPROVAL_TOOLS, SCOPES } from '../src/tools.ts'
import { ManualApprovals } from './manual.ts'

class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

const T0 = new Date('2026-10-22T09:00:00Z')
const after = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000)
const subject = (ref: string, version = 'v1'): Subject => ({ type: 'content', ref, version })
const [STUDIO] = POLICIES as [AutonomyPolicy]

/** The landings the engine would hold, by run: the lead's rights read a merge's base branch from the landing of its request. */
type Landings = Map<string, { requestId: string; base: { branch: string } }>

async function boot(config: Partial<Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-approvals-lead-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const landings: Landings = new Map()
  const tasks = new Map<string, { taskId: string; projectId: string }>([['t-system', { taskId: 't-system', projectId: 'system' }], ['t-other', { taskId: 't-other', projectId: 'other' }]])
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(RecordingMcp),
    ctx.plugin({ name: 'workflow', apply: (c: Context) => void (c as unknown as { provide(name: string, value: unknown): void }).provide('workflow', { landing: (runId: string) => landings.get(runId) }) }),
    // The board's tasks by id: a Worker's command names its task, whose project is the board's.
    ctx.plugin({ name: 'board', apply: (c: Context) => void (c as unknown as { provide(name: string, value: unknown): void }).provide('board', { task: async (taskId: string) => tasks.get(taskId) }) }),
    ctx.plugin(ManualApprovals, { policies: POLICIES, devBranches: { system: ['dev'] }, ...config }),
  ]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 0))
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return { ctx, approvals: ctx.approvals as ManualApprovals, landings, mcp: (ctx as unknown as { mcp: RecordingMcp }).mcp }
}

type Booted = Awaited<ReturnType<typeof boot>>

/** One request of a project, asked as the engine would: the class, its run, and its project. */
async function ask(booted: Booted, action: Action, ref: string, projectId: string | undefined, extra: Partial<NewRequest> = {}): Promise<ApprovalRequest> {
  const verdict = await booted.ctx.approvals.check(action)
  expect(verdict.mode).toBe('ask')
  return booted.ctx.approvals.request({
    subject: subject(ref), action: { class: action.class, summary: `do ${ref}` }, requester: { component: 'workflow', runId: `run-${ref}`, ...(projectId ? { projectId } : {}) },
    verdict, classification: 'operator-shared', ...(action.class === 'command' && action.command ? { command: action.command } : {}), ...extra,
  }, T0)
}

const decisionOf = (booted: Booted, ref: string) => booted.ctx.artifacts.get(ref as never)!.body as { decider: { type: string; id: string; version: string }; outcome: { option: string } }
const verdictOn = (request: ApprovalRequest, verdict: 'approved' | 'rejected' = 'approved') => ({ requestId: request.requestId, subject: request.subject, verdict })

describe('a project lead in the approval queue', () => {
  it('records a merge approval into a dev branch as decider lead:system, a client decider, never the operator', async () => {
    const booted = await boot()
    const merge = await ask(booted, { class: 'merge', projectId: 'system' }, 'merge-1', 'system')
    booted.landings.set('run-merge-1', { requestId: merge.requestId, base: { branch: 'dev' } })
    const [result] = await booted.approvals.decideAsLead('system', [verdictOn(merge)], after(5))
    expect(result).toMatchObject({ requestId: merge.requestId, state: 'approved' })
    const resolved = (await booted.ctx.approvals.get(merge.requestId))!
    expect(resolved.state).toBe('approved')
    const decision = decisionOf(booted, resolved.resolution!.decision)
    expect(decision.decider).toEqual({ type: 'client', id: 'lead:system', version: '1' })
    // The approval artifact names who gave it, in its producer and its note (its `by` is closed to operator and policy).
    const approval = booted.ctx.artifacts.get(resolved.resolution!.approval!)!
    expect(approval.producer).toEqual({ type: 'system', ref: 'lead:system' })
    expect((approval.body as { note?: string }).note).toBe('[lead:system]')
  })

  it('records the operator\'s verdict as the operator, at the version after the lead principal', async () => {
    const booted = await boot()
    const command = await ask(booted, { class: 'command', command: ['ls'] }, 'cmd-op', 'system')
    await booted.ctx.approvals.decide([verdictOn(command)], after(5))
    const decision = decisionOf(booted, (await booted.ctx.approvals.get(command.requestId))!.resolution!.decision)
    expect(decision.decider).toEqual({ type: 'operator', id: 'operator', version: '2' })
  })

  it('refuses a lead\'s approval of a policy change, and decides nothing', async () => {
    const booted = await boot()
    const { request } = await booted.approvals.proposePolicy({ policy: { ...STUDIO, version: STUDIO.version + 1, commands: [...(STUDIO.commands ?? []), 'git status'] } }, T0)
    const failure = await booted.approvals.decideAsLead('system', [verdictOn(request)], after(5)).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ApprovalsError)
    expect((failure as ApprovalsError).failure).toBe('forbidden')
    expect((failure as ApprovalsError).message).toMatch(/lead:system may not decide policy-change: only the operator decides it/)
    expect((await booted.ctx.approvals.get(request.requestId))!.state).not.toBe('approved')
    // The operator still can.
    const [done] = await booted.ctx.approvals.decide([verdictOn(request)], after(6))
    expect(done!.state).toBe('approved')
  })

  it('leaves the other classes to the operator: deploy, external-send, charter', async () => {
    const booted = await boot()
    for (const actionClass of ['deploy', 'external-send', 'charter', 'spend'] as const) {
      const request = await ask(booted, { class: actionClass, projectId: 'system' }, `x-${actionClass}`, 'system')
      await expect(booted.approvals.decideAsLead('system', [verdictOn(request)], after(5))).rejects.toThrow(new RegExp(`lead:system may not decide ${actionClass}`))
      expect((await booted.ctx.approvals.get(request.requestId))!.state).not.toBe('approved')
    }
  })

  it('refuses a merge into a branch that is not a listed dev branch, or whose branch cannot be read', async () => {
    const booted = await boot()
    const main = await ask(booted, { class: 'merge', projectId: 'system' }, 'merge-main', 'system')
    booted.landings.set('run-merge-main', { requestId: main.requestId, base: { branch: 'main' } })
    await expect(booted.approvals.decideAsLead('system', [verdictOn(main)], after(5))).rejects.toThrow(/only on a listed dev branch \(dev\); main is not one/)
    const unknown = await ask(booted, { class: 'merge', projectId: 'system' }, 'merge-unknown', 'system')
    await expect(booted.approvals.decideAsLead('system', [verdictOn(unknown)], after(5))).rejects.toThrow(/the branch it lands on could not be read/)
    expect((await booted.ctx.approvals.get(main.requestId))!.state).not.toBe('approved')
  })

  it('refuses another project\'s merge, even into a branch its own project lists, and approves its own (T285)', async () => {
    const booted = await boot({ devBranches: { system: ['dev'], other: ['dev'] } })
    const theirs = await ask(booted, { class: 'merge', projectId: 'other' }, 'merge-other', 'other')
    booted.landings.set('run-merge-other', { requestId: theirs.requestId, base: { branch: 'dev' } })
    await expect(booted.approvals.decideAsLead('system', [verdictOn(theirs)], after(5))).rejects.toThrow(/lead:system decides only for project system; this belongs to project other/)
    expect((await booted.ctx.approvals.get(theirs.requestId))!.state).not.toBe('approved')
    const own = await ask(booted, { class: 'merge', projectId: 'system' }, 'merge-own', 'system')
    booted.landings.set('run-merge-own', { requestId: own.requestId, base: { branch: 'dev' } })
    expect((await booted.approvals.decideAsLead('system', [verdictOn(own)], after(6)))[0]).toMatchObject({ state: 'approved' })
  })

  it('lists, reads, and shows the policy of its own project\'s requests only, and refuses another project\'s with the reason (T285)', async () => {
    const booted = await boot()
    const tool = (name: string, args: Record<string, unknown>, context: { scope: 'client' | 'operator'; lead?: string } = { scope: 'client', lead: 'system' }) =>
      booted.mcp.tools.get(name)!.handler(args, context) as unknown as Promise<{ isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>
    const mine = await ask(booted, { class: 'command', command: ['ls'], projectId: 'system' }, 'mine', 'system')
    const theirs = await ask(booted, { class: 'command', command: ['ls'], projectId: 'p1' }, 'theirs', 'p1')
    const worker = (ref: string, taskId: string) => ask(booted, { class: 'command', command: ['ls'] }, ref, undefined, { requester: { component: 'worker', runId: `agent-${ref}`, sessionId: `s-${ref}`, taskId } })
    const workerMine = await worker('w-mine', 't-system')
    const workerTheirs = await worker('w-theirs', 't-other')
    const ids = (reply: { structuredContent?: Record<string, unknown> }) => (reply.structuredContent!.requests as Array<{ requestId: string }>).map((r) => r.requestId).sort()
    // Its list is its own project's, a Worker's command of its project's task included, by default and when it names its project.
    expect(ids(await tool('approvals_list', {}))).toEqual([mine.requestId, workerMine.requestId].sort())
    expect(ids(await tool('approvals_list', { projectId: 'system' }))).toEqual([mine.requestId, workerMine.requestId].sort())
    // A page at a time: the next page goes on from where the last one stopped.
    const first = await tool('approvals_list', { limit: 1 })
    const second = await tool('approvals_list', { limit: 1, after: first.structuredContent!.next })
    expect([...ids(first), ...ids(second)].sort()).toEqual([mine.requestId, workerMine.requestId].sort())
    // Another project's list, request, or policy is refused with the reason.
    expect((await tool('approvals_list', { projectId: 'p1' })).content[0]!.text).toMatch(/^forbidden: the lead token of project system reaches only project system; project p1 belongs to project p1/)
    expect((await tool('approvals_get', { requestId: theirs.requestId })).content[0]!.text).toMatch(new RegExp(`^forbidden: .*approval request ${theirs.requestId} belongs to project p1`))
    expect((await tool('approvals_get', { requestId: workerTheirs.requestId })).content[0]!.text).toMatch(/belongs to project other/)
    expect((await tool('approvals_policy', { projectId: 'p1' })).content[0]!.text).toMatch(/^forbidden: .*project p1 belongs to project p1/)
    // Its own pass.
    expect((await tool('approvals_get', { requestId: mine.requestId })).structuredContent).toMatchObject({ request: { requestId: mine.requestId } })
    expect((await tool('approvals_get', { requestId: workerMine.requestId })).isError).toBeFalsy()
    expect((await tool('approvals_policy', {})).isError).toBeFalsy()
    // The operator, and a client token with no project, read every project's.
    expect(ids(await tool('approvals_list', {}, { scope: 'operator' }))).toHaveLength(4)
    expect(ids(await tool('approvals_list', {}, { scope: 'client' }))).toHaveLength(4)
    expect((await tool('approvals_get', { requestId: theirs.requestId }, { scope: 'client' })).isError).toBeFalsy()
  })

  it('decides the commands and dispatch starts of its own project, and no other project\'s', async () => {
    const booted = await boot()
    const own = await ask(booted, { class: 'command', command: ['ls'], projectId: 'system' }, 'own', 'system')
    const [done] = await booted.approvals.decideAsLead('system', [verdictOn(own, 'rejected')], after(5))
    expect(done).toMatchObject({ state: 'rejected' })
    expect(decisionOf(booted, (await booted.ctx.approvals.get(own.requestId))!.resolution!.decision).decider.id).toBe('lead:system')
    const other = await ask(booted, { class: 'command', command: ['ls'], projectId: 'p1' }, 'other', 'p1')
    await expect(booted.approvals.decideAsLead('system', [verdictOn(other)], after(5))).rejects.toThrow(/decides only for project system; this belongs to project p1/)
    const none = await ask(booted, { class: 'command', command: ['ls'] }, 'none', undefined)
    await expect(booted.approvals.decideAsLead('system', [verdictOn(none)], after(5))).rejects.toThrow(/belongs to no project/)
  })

  it('decides a Worker\'s deferred command of its project\'s board task: judged under the studio policy, the request names the task, whose project is the board\'s', async () => {
    const booted = await boot()
    const worker = (ref: string, taskId: string) => ask(booted, { class: 'command', command: ['ls'] }, ref, undefined, { requester: { component: 'worker', runId: `agent-${ref}`, sessionId: `s-${ref}`, taskId } })
    const own = await worker('w-own', 't-system')
    expect(own.requester.projectId).toBeUndefined()
    expect(await booted.approvals.projectOfRequest(own)).toBe('system')
    const [done] = await booted.approvals.decideAsLead('system', [verdictOn(own)], after(5))
    expect(done).toMatchObject({ state: 'approved' })
    expect(decisionOf(booted, (await booted.ctx.approvals.get(own.requestId))!.resolution!.decision).decider.id).toBe('lead:system')
    const other = await worker('w-other', 't-other')
    await expect(booted.approvals.decideAsLead('system', [verdictOn(other)], after(5))).rejects.toThrow(/belongs to project other/)
    const unknown = await worker('w-unknown', 't-gone')
    await expect(booted.approvals.decideAsLead('system', [verdictOn(unknown)], after(5))).rejects.toThrow(/belongs to no project/)
  })

  it('refuses the whole call when one verdict is off the list: the others are not decided either', async () => {
    const booted = await boot()
    const fine = await ask(booted, { class: 'command', command: ['ls'], projectId: 'system' }, 'fine', 'system')
    const deploy = await ask(booted, { class: 'deploy', projectId: 'system' }, 'deploy', 'system')
    await expect(booted.approvals.decideAsLead('system', [verdictOn(fine), verdictOn(deploy)], after(5))).rejects.toThrow(/nothing was decided/)
    expect((await booted.ctx.approvals.get(fine.requestId))!.state).not.toBe('approved')
  })

  it('lists approvals_decide as the one operator tool a lead may call, and refuses the others', async () => {
    const booted = await boot()
    const specs = [...booted.mcp.tools.entries()].map(([name, { spec }]) => [name, spec.scope, spec.lead] as const)
    expect(specs.filter(([, , lead]) => lead).map(([name]) => name)).toEqual(['approvals_decide'])
    expect(SCOPES.approvals_policy_propose).toBe('operator')
    expect(APPROVAL_TOOLS).toContain('approvals_policy_propose')
    // The tool itself: a lead caller reaches the lead's path; a caller with no scope and no lead takes no verdict.
    const decide = booted.mcp.tools.get('approvals_decide')!.handler
    // The tools decide at the clock's now: only Date is faked, to a fixed instant after the request was made.
    vi.useFakeTimers({ toFake: ['Date'], now: after(5) })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const command = await ask(booted, { class: 'command', command: ['ls'], projectId: 'system' }, 'via-tool', 'system')
    const refused = await decide({ verdicts: [verdictOn(command)] }, { scope: 'client' })
    expect(refused.isError).toBe(true)
    const ok = await decide({ verdicts: [verdictOn(command)] }, { scope: 'client', lead: 'system' })
    expect(ok.isError).not.toBe(true)
    expect(decisionOf(booted, (await booted.ctx.approvals.get(command.requestId))!.resolution!.decision).decider.id).toBe('lead:system')
  })
})

describe('the dev branches', () => {
  it('lists each project\'s dev branches, none for a project not listed', async () => {
    const booted = await boot({ devBranches: { system: ['dev', 'next'], p1: [] } })
    expect(booted.approvals.devBranches('system')).toEqual(['dev', 'next'])
    expect(booted.approvals.devBranches('elsewhere')).toEqual([])
  })

  it('refuses a configuration that lists a protected branch or a name that is no branch', () => {
    expect(checkConfig({ policies: POLICIES, devBranches: { system: ['dev'] } })).toEqual([])
    expect(checkConfig({ policies: POLICIES, devBranches: { system: ['main'] } })).toContainEqual(expect.stringMatching(/main is a protected branch/))
    expect(checkConfig({ policies: POLICIES, devBranches: { system: ['master'] } })).toContainEqual(expect.stringMatching(/master is a protected branch/))
    expect(checkConfig({ policies: POLICIES, devBranches: { system: ['a..b'] } })).toContainEqual(expect.stringMatching(/is not a branch name/))
    expect(checkConfig({ policies: POLICIES, devBranches: { 'a/b': ['dev'] } })).toContainEqual(expect.stringMatching(/not a project id a lead token can be issued for/))
    expect(checkConfig({ policies: POLICIES, devBranches: ['dev'] as never })).toContainEqual(expect.stringMatching(/devBranches must be an object/))
  })
})
