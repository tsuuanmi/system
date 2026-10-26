import Artifacts from '@tsuuanmi/system-artifacts'
import { issueLeadToken, leadTokens, revokeLeadToken } from '@tsuuanmi/system-libs'
import { describe, expect, it, vi } from 'vitest'
import { activeProject } from '../../workflow/conformance/workflow.ts'
import { decidedBy, runAcceptanceOf } from '../src/index.ts'
import { boot, reviewed } from './store-backed.ts'

// The lead principal at the operator's web UI (ADR-0076): a project's lead token reaches the approval
// queue and the reviews of its project, held to the closed list of its rights, and nothing else; what it
// decides is recorded as lead:<project>. Over the store-backed board, queue, and engine.
vi.setConfig({ testTimeout: 120_000 })

const leadOf = (dir: string, project: string): string => {
  issueLeadToken(dir, project)
  return leadTokens(dir).get(project)!
}

describe('web UI: a project lead\'s token', () => {
  it('reaches the approval queue and the reviews, and no other route: the operator\'s policy, projects, and roster stay refused with a reason', async () => {
    const { dir, call } = await boot({ approvals: { devBranches: { p1: ['dev'] } } })
    const lead = leadOf(dir, 'p1')
    expect((await call('approvals', undefined, lead)).status).toBe(200)
    expect((await call('reviews', undefined, lead)).status).toBe(200)
    for (const [path, body] of [['roster'], ['policy'], ['policy/propose', { policy: {} }], ['projects'], ['projects/p1/pause', { revision: 0 }], ['dispatch'], ['activity'], ['runs']] as Array<[string, unknown?]>) {
      const refused = await call(path, body, lead)
      expect(refused.status, path).toBe(403)
      expect(refused.value.error, path).toMatch(/the lead token of project p1 \(decider lead:p1\) reaches the approval queue and the reviews of its project only/)
    }
  })

  it('is refused once revoked, at once, and a token of another project is not this one\'s', async () => {
    const { dir, call } = await boot()
    const lead = leadOf(dir, 'p1')
    expect((await call('approvals', undefined, lead)).status).toBe(200)
    revokeLeadToken(dir, 'p1')
    expect((await call('approvals', undefined, lead)).status).toBe(401)
    // A rotated token replaces the old one.
    const first = leadOf(dir, 'p1')
    const second = leadOf(dir, 'p1')
    expect((await call('approvals', undefined, first)).status).toBe(401)
    expect((await call('approvals', undefined, second)).status).toBe(200)
  })

  it('gives a verdict on a command of its project as lead:p1, a client decider, and is refused a policy change and another project\'s request', async () => {
    const { ctx, dir, call } = await boot({ approvals: { devBranches: { p1: ['dev'] } } })
    await activeProject(ctx)
    const lead = leadOf(dir, 'p1')
    const argv = ['git', 'log', '--oneline']
    const ask = async (projectId: string) => {
      const verdict = await ctx.approvals.check({ class: 'command', command: argv, projectId })
      expect(verdict.mode).toBe('ask')
      return ctx.approvals.request({
        subject: { type: 'content', ref: `command:${projectId}`, version: 'v1' }, action: { class: 'command', summary: 'git log' }, requester: { component: 'worker', projectId },
        verdict, command: argv, classification: 'operator-shared',
      })
    }
    const own = await ask('p1')
    const other = await ask('p2')
    const listed = await call('approvals', undefined, lead)
    // The lead lists its own project's requests only.
    expect(JSON.stringify(listed.value)).toContain(own.requestId)
    expect(JSON.stringify(listed.value)).not.toContain(other.requestId)
    // Another project's request is refused, and nothing is decided.
    const refused = await call('approvals/decide', { verdicts: [{ requestId: other.requestId, subject: other.subject, verdict: 'approved' }] }, lead)
    expect(refused.status).toBe(403)
    expect(refused.value.error).toMatch(/lead:p1 decides only for project p1; this belongs to project p2/)
    expect((await ctx.approvals.get(other.requestId))!.state).not.toBe('approved')
    const done = await call('approvals/decide', { verdicts: [{ requestId: own.requestId, subject: own.subject, verdict: 'approved' }] }, lead)
    expect(done.status).toBe(200)
    const resolved = (await ctx.approvals.get(own.requestId))!
    expect(resolved).toMatchObject({ state: 'approved', resolution: { cause: 'verdict' } })
    expect(ctx.artifacts.get(resolved.resolution!.decision)!.body).toMatchObject({ decider: { type: 'client', id: 'lead:p1' } })
    expect(decidedBy(ctx.artifacts.get(resolved.resolution!.decision)!.body)).toMatchObject({ kind: 'lead', id: 'lead:p1', label: 'lead:p1' })
  })

  it('accepts a result on a listed dev branch the run\'s own acceptance recorded, as lead:p1, on the checks that run recorded: done once they passed, never past them', async () => {
    const { ctx, dir, call } = await boot({ approvals: { devBranches: { p1: ['dev'] } } })
    await activeProject(ctx)
    const lead = leadOf(dir, 'p1')
    expect(ctx.approvals.devBranches?.('p1')).toEqual(['dev'])
    const { task } = await reviewed(ctx, 'lead-accepts')
    const subject = task.result!.subject
    // The run's acceptance records no branch the result lands on (no git tree): the branch cannot be read, so the lead decides nothing.
    const unread = await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject }, lead)
    expect(unread.status).toBe(403)
    expect(unread.value.error).toMatch(/lead:p1 decides a result only on a listed dev branch, and the branch it lands on could not be read.*nothing was decided/)
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'review' })

    // With the branch recorded (the engine writes it in the acceptance when the result is on a git tree): main is not a dev branch, dev is.
    const real = Artifacts.prototype.get
    let branch = 'main'
    // What the run's own acceptance recorded of its checks: none passed at first, as the fixture's run reports.
    let checks: Record<string, boolean> | undefined
    const runAcceptance = runAcceptanceOf(task, (ref) => ctx.artifacts.get(ref)?.body)?.ref
    expect(runAcceptance).toMatch(/^sha256:/)
    const spy = vi.spyOn(Artifacts.prototype, 'get').mockImplementation(function (this: Artifacts, id: string) {
      const envelope = real.call(this, id)
      const body = envelope?.body as { decisionType?: string; decider?: { type?: string }; outcome?: { detail?: object } } | undefined
      // Only the run owner's acceptance (a rule's): the lead's own carries over what it read here.
      return body?.decisionType === 'acceptance' && body.decider?.type === 'rule'
        ? { ...envelope!, body: { ...body, outcome: { ...body.outcome, detail: { ...body.outcome?.detail, landing: { repository: '/repo', branch }, ...(checks ? { checks } : {}) } } } } as typeof envelope
        : envelope
    })
    try {
      const main = await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject }, lead)
      expect(main.status, JSON.stringify(main.value)).toBe(403)
      expect(main.value.error, JSON.stringify(main.value)).toMatch(/only on a listed dev branch \(dev\); main is not one/)
      branch = 'dev'
      const other = await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject }, leadOf(dir, 'p2'))
      // Another project's lead sees no review of p1, and its decision is refused.
      expect(other.status, JSON.stringify(other.value)).toBe(403)
      expect(other.value.error, JSON.stringify(other.value)).toMatch(/lead:p2 decides only for project p2; this belongs to project p1/)
      // On dev, but the run recorded no passed check of the policy's required tests and lint: the lead's acceptance is not the operator's,
      // so the review stays the operator's and nothing moves.
      const unchecked = await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject }, lead)
      expect(unchecked.status, JSON.stringify(unchecked.value)).toBe(409)
      expect(unchecked.value.error).toMatch(/required checks have not passed/)
      expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' } })

      // The run recorded both required checks passed: the lead's acceptance carries those facts over, and the result is accepted on the lead's token.
      checks = { tests: true, lint: true }
      const decided = await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject }, lead)
      expect(decided.status, JSON.stringify(decided.value)).toBe(200)
      const decision = ctx.artifacts.get(decided.value.decision as never)!
      expect(decision.body).toMatchObject({
        schema: 'decision@1.10', decisionType: 'acceptance', decider: { type: 'client', id: 'lead:p1', version: '1' },
        outcome: { option: 'accept', detail: { taskId: task.taskId, subject, checks: { tests: true, lint: true }, landing: { branch: 'dev' }, acceptance: runAcceptance } },
      })
      expect((decision.body as { inputs: string[] }).inputs).toContain(runAcceptance)
      expect(decision.producer).toEqual({ type: 'system', ref: 'lead:p1' })
      expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', result: { acceptance: decided.value.decision } })
    } finally {
      spy.mockRestore()
    }
  })

  it('says who decided: the operator (at version 2), a lead, System, and a record from before the lead principal', () => {
    const body = (decider: object) => ({ decider })
    expect(decidedBy(body({ type: 'operator', id: 'operator.review', version: '2' }))).toEqual({ kind: 'operator', id: 'operator.review', label: 'the operator' })
    expect(decidedBy(body({ type: 'client', id: 'lead:system', version: '1' }))).toEqual({ kind: 'lead', id: 'lead:system', label: 'lead:system' })
    expect(decidedBy(body({ type: 'rule', id: 'workflow.task-acceptance', version: '4' }))).toEqual({ kind: 'system', id: 'workflow.task-acceptance', label: 'System' })
    expect(decidedBy(body({ type: 'policy', id: 'studio', version: '3' }))).toMatchObject({ kind: 'system' })
    // Old records are not migrated: they say so.
    expect(decidedBy(body({ type: 'operator', id: 'operator', version: '1' }))).toEqual({ kind: 'operator', id: 'operator', label: 'the operator (before the lead principal)', beforeLeadPrincipal: true })
    expect(decidedBy(body({ type: 'client', id: 'workflow.vote', version: '1' }))).toMatchObject({ kind: 'lead', beforeLeadPrincipal: true })
    expect(decidedBy(undefined)).toBeUndefined()
    expect(decidedBy({})).toBeUndefined()
  })
})
