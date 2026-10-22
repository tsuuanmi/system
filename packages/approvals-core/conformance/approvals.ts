/**
 * Conformance suite for `ctx.approvals` (ADR-0037; docs/design/approvals.md), and a fake provider
 * that passes it. `boot` returns a context that provides `ctx.approvals` and `ctx.artifacts`,
 * with the policies in {@link POLICIES} configured and an empty queue.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { contentId, SchemaRegistry } from '@tsuuanmi/system-libs'
import { expect } from 'vitest'
import { defineSuite, type Scenario } from '../../libs/conformance/runner.ts'
import {
  type Action, type ActionClass, ALWAYS_ASK, type ApprovalRequest, Approvals, ApprovalsError, type ArtifactRef, type AutonomyPolicy, type AutonomyVerdict,
  type Check, type Mode, MODES, type NewRequest, type RequestState, SHELL_METACHARACTER, type Subject, type Verdict, type VerdictResult,
} from '../src/index.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

const STUDIO: AutonomyPolicy = {
  schema: 'autonomy-policy@1.1', id: 'studio', version: 3, scope: 'studio',
  rules: [
    { actionClass: 'read', mode: 'auto' },
    { actionClass: 'workspace-write', mode: 'auto', requires: ['tests', 'lint'] },
    { actionClass: 'merge', mode: 'ask' },
    { actionClass: 'command', mode: 'ask', expiresSeconds: 600 },
    { actionClass: 'deploy', mode: 'ask' },
  ],
  default: 'ask', commands: ['pnpm test'],
  expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
  batch: { maxSize: 2, maxWaitSeconds: 300 },
}
const PROJECT: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'p1.policy', version: 1, scope: 'project', projectId: 'p1', narrows: 'studio',
  rules: [{ actionClass: 'merge', mode: 'forbid' }, { actionClass: 'read', mode: 'notify' }, { actionClass: 'command', mode: 'ask', expiresSeconds: 400 }],
  default: 'ask', expiry: { defaultSeconds: 1800, maxSeconds: 3600 },
}
const NO_COMMANDS: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'p3.policy', version: 1, scope: 'project', projectId: 'p3', narrows: 'studio',
  rules: [{ actionClass: 'command', mode: 'forbid' }], default: 'ask', expiry: { defaultSeconds: 1800, maxSeconds: 3600 },
}
/** The policies every provider under test is configured with: a studio policy, project p1's, and project p3's (no commands). */
export const POLICIES: readonly AutonomyPolicy[] = [STUDIO, PROJECT, NO_COMMANDS]

const T0 = new Date('2026-10-22T09:00:00Z')
const after = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000)
const schemas = new SchemaRegistry()
const subject = (ref: string, version = 'v1'): Subject => ({ type: 'content', ref, version })

type Decision = {
  schema: string; decisionType: string; outcome: { option: string; detail?: Record<string, unknown> }; candidates: Array<{ option: string; selected: boolean; reasons: string[] }>
  decider: { type: string; id: string; version: string; hash?: string }
}
const decisionOf = (ctx: Context, ref: ArtifactRef): Decision => {
  const envelope = ctx.artifacts.get(ref)
  expect(envelope?.kind, `${ref} is a decision`).toBe('decision')
  const body = envelope!.body as Decision
  schemas.assertRecord(body as unknown as { schema: string })
  return body
}
const valid = (request: ApprovalRequest): ApprovalRequest => {
  schemas.assertRecord(request)
  return request
}

async function asked(ctx: Context, action: Action, ref: string, extra: Partial<NewRequest> = {}): Promise<ApprovalRequest> {
  const verdict = await ctx.approvals.check(action)
  expect(verdict.mode).toBe('ask')
  return valid(await ctx.approvals.request({
    subject: subject(ref), action: { class: action.class, summary: `do ${ref}` }, requester: { component: 'board', runId: `run-${ref}`, ...(action.projectId ? { projectId: action.projectId } : {}) },
    verdict, classification: 'operator-shared', ...extra,
  }, T0))
}

const failureOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call
    return 'resolved'
  } catch (error) {
    return error instanceof ApprovalsError ? error.failure : `not an ApprovalsError: ${String(error)}`
  }
}

const scenario = (id: string, title: string, run: (ctx: Context) => Promise<void>): Scenario<Boot> => ({
  id: `approvals.${id}`, since: '1.0', title,
  run: async (boot) => {
    const { ctx, dispose } = await boot()
    try {
      await run(ctx)
    } finally {
      await dispose()
    }
  },
})

export const approvalsSuite = defineSuite<Boot>({
  seam: 'approvals',
  contract: '1.0',
  scenarios: [
    scenario('policy-strictest', 'gives each action class the strictest mode of the studio and project policies, and fails closed for a class no rule names (INV-2)', async (ctx) => {
      const studio = await ctx.approvals.policy()
      expect(studio.policies.map((p) => p.id)).toEqual(['studio'])
      const mode = (effective: typeof studio.effective, actionClass: ActionClass): Mode | undefined => effective.find((e) => e.actionClass === actionClass)?.mode
      expect(mode(studio.effective, 'read')).toBe('auto')
      expect(mode(studio.effective, 'spend')).toBe('ask')
      const project = await ctx.approvals.policy('p1')
      expect(project.policies.map((p) => p.id)).toEqual(['studio', 'p1.policy'])
      expect(mode(project.effective, 'read')).toBe('notify')
      expect(mode(project.effective, 'merge')).toBe('forbid')
      expect(mode(project.effective, 'workspace-write')).toBe('auto')
      for (const actionClass of ALWAYS_ASK) expect(['ask', 'forbid'], actionClass).toContain(mode(project.effective, actionClass))
    }),
    scenario('check-records-decision', 'records every classification as an autonomy decision naming the policy and the hash of the policy set it was judged under (INV-13)', async (ctx) => {
      const verdict = await ctx.approvals.check({ class: 'merge', projectId: 'p1' })
      expect(verdict).toMatchObject({ mode: 'forbid', policy: { id: 'p1.policy', version: 1 } })
      const decision = decisionOf(ctx, verdict.decision)
      expect(decision).toMatchObject({ schema: 'decision@1.4', decisionType: 'autonomy', outcome: { option: 'forbid' }, decider: { type: 'policy', id: 'p1.policy', version: '1' } })
      expect(decision.candidates.map((c) => c.option).sort()).toEqual([...MODES].sort())
      // decider.hash names the effective policy set (the studio's and the project's), so an edit that keeps a version still shows.
      expect(decision.decider.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
      const studio = decisionOf(ctx, (await ctx.approvals.check({ class: 'merge' })).decision)
      expect(studio.decider.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(studio.decider.hash).not.toBe(decision.decider.hash)
      expect(decisionOf(ctx, (await ctx.approvals.check({ class: 'read' })).decision).decider.hash).toBe(studio.decider.hash)
    }),
    scenario('checks-gate-auto', 'lets an auto action run only while its required checks pass, and sends a failed check back, never to the operator', async (ctx) => {
      const passed = await ctx.approvals.check({ class: 'workspace-write', checks: { tests: true, lint: true } })
      expect(passed.mode).toBe('auto')
      expect(passed.failedChecks ?? []).toEqual([])
      const failed = await ctx.approvals.check({ class: 'workspace-write', checks: { tests: true } })
      expect(failed.mode).toBe('auto')
      expect(failed.failedChecks).toEqual(['lint'] satisfies Check[])
      expect(await failureOf(ctx.approvals.request({ subject: subject('w'), action: { class: 'workspace-write', summary: 'w' }, requester: { component: 'board', runId: 'run-1' }, verdict: failed, classification: 'public' }, T0))).toBe('not-asked')
    }),
    scenario('commands-allow-list', 'classes a listed command, its exact argv, by what it does, any other command as command, and forbids listed ones too where commands are forbidden (INV-2)', async (ctx) => {
      const checks = { tests: true, lint: true }
      expect((await ctx.approvals.check({ class: 'command', command: ['pnpm', 'test'], checks })).mode).toBe('auto')
      // Exact, never a prefix: more arguments, or words that only join to the listed line, are the command class.
      expect((await ctx.approvals.check({ class: 'command', command: ['pnpm', 'test', '--watch'], checks })).mode).toBe('ask')
      expect((await ctx.approvals.check({ class: 'command', command: ['pnpm test'], checks })).mode).toBe('ask')
      expect((await ctx.approvals.check({ class: 'command', command: ['pnpm', 'testx'] })).mode).toBe('ask')
      expect((await ctx.approvals.check({ class: 'command', command: ['rm', '-rf', '/'] })).mode).toBe('ask')
      expect((await ctx.approvals.check({ class: 'command', projectId: 'p3', command: ['pnpm', 'test'], checks })).mode).toBe('forbid')
    }),
    scenario('commands-metacharacters', 'forbids an argv with a word holding a shell metacharacter, listed or not, and records why (INV-2)', async (ctx) => {
      const checks = { tests: true, lint: true }
      for (const command of [['pnpm', 'test', '&&', 'curl', 'x'], ['git', '-c', 'core.sshCommand=sh -c "curl x|sh"', 'fetch'], ['pnpm', 'test;'], ['echo', '$HOME'], ['ls', '*'], ['cat', 'a\nb']]) {
        const verdict = await ctx.approvals.check({ class: 'command', command, checks })
        expect(verdict.mode, command.join(' ')).toBe('forbid')
        const forbid = decisionOf(ctx, verdict.decision).candidates.find((c) => c.selected)!
        expect(forbid.reasons.join(' ')).toMatch(/shell metacharacter/)
      }
      expect(SHELL_METACHARACTER.test('--watch')).toBe(false)
    }),
    scenario('request-needs-ask', 'queues a request only for an action whose recorded verdict is ask (INV-2)', async (ctx) => {
      const auto = await ctx.approvals.check({ class: 'read' })
      expect(await failureOf(ctx.approvals.request({ subject: subject('r'), action: { class: 'read', summary: 'r' }, requester: { component: 'board', runId: 'run-1' }, verdict: auto, classification: 'public' }, T0))).toBe('not-asked')
      const forged: AutonomyVerdict = { ...auto, mode: 'ask' }
      expect(await failureOf(ctx.approvals.request({ subject: subject('r'), action: { class: 'read', summary: 'r' }, requester: { component: 'board', runId: 'run-1' }, verdict: forged, classification: 'public' }, T0))).toBe('not-asked')
      const request = await asked(ctx, { class: 'merge' }, 'm')
      expect(request).toMatchObject({ state: 'open', subject: subject('m'), action: { class: 'merge' }, revision: 0 })
      expect(await ctx.approvals.get(request.requestId)).toEqual(request)
    }),
    scenario('request-rejudged', 'judges the action again when it is queued: an ask for another class, another project\'s policies, or a class the project forbids is refused (INV-2)', async (ctx) => {
      const merge = await ctx.approvals.check({ class: 'merge' })
      expect(merge.mode).toBe('ask')
      const ask = (action: ApprovalRequest['action'], requester: ApprovalRequest['requester'], verdict: AutonomyVerdict) =>
        ctx.approvals.request({ subject: subject('x'), action, requester, verdict, classification: 'public' }, T0)
      // p1 forbids merge: the studio's ask for merge does not reach the operator for p1.
      expect(await failureOf(ask({ class: 'merge', summary: 'm' }, { component: 'board', projectId: 'p1' }, merge))).toBe('not-asked')
      // An ask for merge is not an ask for deploy, though the policy asks for both.
      expect(await failureOf(ask({ class: 'deploy', summary: 'd' }, { component: 'board', runId: 'run-1' }, merge))).toBe('not-asked')
      // p1's ask for deploy (the studio's rule) was judged under p1's policies, not the studio's alone.
      const deploy = await ctx.approvals.check({ class: 'deploy', projectId: 'p1' })
      expect(deploy.mode).toBe('ask')
      expect(await failureOf(ask({ class: 'deploy', summary: 'd' }, { component: 'board', runId: 'run-1' }, deploy))).toBe('not-asked')
      expect(await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).toEqual([])
      expect(valid(await ask({ class: 'deploy', summary: 'd' }, { component: 'board', projectId: 'p1' }, deploy))).toMatchObject({ state: 'open', policy: { id: 'studio', version: 3, decision: deploy.decision } })
    }),
    scenario('request-exact-subject', 'refuses a request whose subject names no version, unless it is an artifact by its content id (INV-5)', async (ctx) => {
      const verdict = await ctx.approvals.check({ class: 'merge' })
      const ask = (s: Subject) => ctx.approvals.request({ subject: s, action: { class: 'merge', summary: 'm' }, requester: { component: 'board', runId: 'run-1' }, verdict, classification: 'public' }, T0)
      expect(await failureOf(ask({ type: 'git-head', ref: 'main' }))).toBe('invalid')
      expect(await failureOf(ask({ type: 'content', ref: 'plan', version: '' }))).toBe('invalid')
      expect(await failureOf(ask({ type: 'artifact', ref: 'plan-1' }))).toBe('invalid')
      const artifact: Subject = { type: 'artifact', ref: `sha256:${'a'.repeat(64)}` }
      expect(valid(await ask(artifact)).subject).toEqual(artifact)
    }),
    scenario('expiry-bounded', 'gives every request an expiry from its rule, else the policy default, within the strictest maximum (INV-9)', async (ctx) => {
      const command = await asked(ctx, { class: 'command', command: ['git', 'push'] }, 'c')
      expect(command.expiresAt).toBe(after(600).toISOString())
      const merge = await asked(ctx, { class: 'merge' }, 'm')
      expect(merge.expiresAt).toBe(after(3600).toISOString())
      const project = await asked(ctx, { class: 'deploy', projectId: 'p1' }, 'd')
      expect(project.expiresAt).toBe(after(1800).toISOString())
      // Both p1's rule and the studio's name command's expiry: the shorter applies, though the studio's rule wins the tie in mode.
      const shorter = await asked(ctx, { class: 'command', projectId: 'p1' }, 'p1-command')
      expect(shorter.expiresAt).toBe(after(400).toISOString())
    }),
    scenario('batches', 'groups open requests into batches by the policy\'s batch rule, and keeps them in the queue', async (ctx) => {
      const first = await asked(ctx, { class: 'merge' }, 'b1')
      expect(await ctx.approvals.batch(after(10))).toEqual([])
      const second = await asked(ctx, { class: 'deploy' }, 'b2')
      const [batchId, ...more] = await ctx.approvals.batch(after(20))
      expect(more).toEqual([])
      for (const id of [first.requestId, second.requestId]) expect(valid((await ctx.approvals.get(id))!)).toMatchObject({ state: 'batched', batchId })
      const third = await asked(ctx, { class: 'spend' }, 'b3')
      expect(await ctx.approvals.batch(after(100))).toEqual([])
      const [late] = await ctx.approvals.batch(after(301))
      expect(late).toBeDefined()
      expect(late).not.toBe(batchId)
      expect((await ctx.approvals.get(third.requestId))?.batchId).toBe(late)
      expect((await ctx.approvals.list()).map((r) => r.requestId).sort()).toEqual([first.requestId, second.requestId, third.requestId].sort())
    }),
    scenario('verdict-binds-subject', 'records an operator verdict as an approval artifact on the exact subject, and refuses one for a changed subject (INV-5, INV-6)', async (ctx) => {
      const request = await asked(ctx, { class: 'merge' }, 'head')
      const [changed] = await ctx.approvals.decide([{ requestId: request.requestId, subject: subject('head', 'v2'), verdict: 'approved' }], after(5))
      expect(changed).toEqual({ requestId: request.requestId, state: 'open', refused: 'subject-changed' } satisfies VerdictResult)
      const [approved] = await ctx.approvals.decide([{ requestId: request.requestId, subject: subject('head'), verdict: 'approved', note: 'ok' }], after(6))
      expect(approved).toMatchObject({ requestId: request.requestId, state: 'approved' })
      const approval = ctx.artifacts.get(approved!.approval!)
      expect(approval).toMatchObject({ kind: 'approval', bodySchema: 'approval@1.0', body: { schema: 'approval@1.0', subject: subject('head'), verdict: 'approved', by: 'operator' } })
      const resolved = valid((await ctx.approvals.get(request.requestId))!)
      expect(resolved).toMatchObject({ state: 'approved', resolution: { cause: 'verdict', approval: approved!.approval }, revision: 1 })
      expect(decisionOf(ctx, resolved.resolution!.decision)).toMatchObject({ decisionType: 'approval', outcome: { option: 'approved' } })
    }),
    scenario('verdict-refusals', 'refuses a verdict for an unknown, resolved, or expired request and leaves it unchanged, while the other verdicts of the call apply', async (ctx) => {
      const done = await asked(ctx, { class: 'merge' }, 'done')
      const late = await asked(ctx, { class: 'command' }, 'late')
      const fresh = await asked(ctx, { class: 'deploy' }, 'fresh')
      await ctx.approvals.decide([{ requestId: done.requestId, subject: done.subject, verdict: 'rejected' }], after(1))
      const verdicts: Verdict[] = [
        { requestId: 'apr-unknown', subject: subject('x'), verdict: 'approved' },
        { requestId: done.requestId, subject: done.subject, verdict: 'approved' },
        { requestId: late.requestId, subject: late.subject, verdict: 'approved' },
        { requestId: fresh.requestId, subject: fresh.subject, verdict: 'approved' },
      ]
      const results = await ctx.approvals.decide(verdicts, after(700))
      expect(results.map((r) => [r.requestId, r.state, r.refused])).toEqual([
        ['apr-unknown', 'rejected', 'unknown-request'],
        [done.requestId, 'rejected', 'already-resolved'],
        [late.requestId, 'open', 'expired'],
        [fresh.requestId, 'approved', undefined],
      ])
      expect((await ctx.approvals.get(late.requestId))?.state).toBe('open')
    }),
    scenario('expiry-rejects', 'rejects an unanswered request at its expiry with the decision denied:expired, and never approves one by default (INV-2)', async (ctx) => {
      const request = await asked(ctx, { class: 'command' }, 'cmd')
      expect(await ctx.approvals.sweep(after(599))).toEqual([])
      const [expired, ...rest] = await ctx.approvals.sweep(after(600))
      expect(rest).toEqual([])
      expect(valid(expired!)).toMatchObject({ requestId: request.requestId, state: 'rejected', resolution: { cause: 'expired' } })
      expect(expired!.resolution!.approval).toBeUndefined()
      expect(decisionOf(ctx, expired!.resolution!.decision)).toMatchObject({ schema: 'decision@1.4', decisionType: 'approval', outcome: { option: 'denied:expired' } })
      expect(await ctx.approvals.sweep(after(10_000))).toEqual([])
    }),
    scenario('withdraw', 'rejects a request whose waiting work ended, with cause withdrawn, and keeps a resolved one as it is', async (ctx) => {
      const request = await asked(ctx, { class: 'merge' }, 'w')
      const withdrawn = valid(await ctx.approvals.withdraw(request.requestId, after(1)))
      expect(withdrawn).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
      expect(decisionOf(ctx, withdrawn.resolution!.decision).outcome.option).toBe('withdrawn')
      expect(await ctx.approvals.withdraw(request.requestId, after(2))).toEqual(withdrawn)
      expect(await failureOf(ctx.approvals.withdraw('apr-unknown'))).toBe('unknown-request')
    }),
    scenario('list-filters', 'lists open and batched requests by default, and filters by state and project', async (ctx) => {
      const mine = await asked(ctx, { class: 'deploy', projectId: 'p1' }, 'mine')
      const other = await asked(ctx, { class: 'deploy' }, 'other')
      await ctx.approvals.decide([{ requestId: other.requestId, subject: other.subject, verdict: 'rejected' }], after(1))
      expect((await ctx.approvals.list()).map((r) => r.requestId)).toEqual([mine.requestId])
      expect((await ctx.approvals.list({ states: ['rejected'] })).map((r) => r.requestId)).toEqual([other.requestId])
      expect((await ctx.approvals.list({ states: ['open', 'rejected'], projectId: 'p1' })).map((r) => r.requestId)).toEqual([mine.requestId])
    }),
  ],
})

const rank = (mode: Mode): number => MODES.indexOf(mode)
const sameSubject = (a: Subject, b: Subject) => a.type === b.type && a.ref === b.ref && a.version === b.version

/**
 * A fake provider of `ctx.approvals`: the protocol in memory, over the configured policies, with
 * decisions and approvals recorded through `ctx.artifacts`. Its policies never change, so no open
 * request ever outlives its policy.
 */
export class FakeApprovals extends Approvals {
  static inject = ['artifacts']
  private readonly requests = new Map<string, ApprovalRequest>()
  private batches = 0

  constructor(ctx: Context, private readonly config: { policies?: readonly AutonomyPolicy[] } = {}) {
    super(ctx)
  }

  private policies(projectId?: string): AutonomyPolicy[] {
    const all = this.config.policies ?? POLICIES
    const studio = all.find((p) => p.scope === 'studio')
    if (!studio) throw new ApprovalsError('invalid', 'no studio policy is configured')
    const project = projectId === undefined ? undefined : all.find((p) => p.scope === 'project' && p.projectId === projectId)
    return project ? [studio, project] : [studio]
  }

  /** The policies that apply to a class: a project policy constrains only the classes it names; its default applies only where neither policy names the class. */
  private applying(actionClass: ActionClass, projectId?: string): AutonomyPolicy[] {
    const [studio, ...narrowing] = this.policies(projectId)
    const named = studio!.rules.some((r) => r.actionClass === actionClass)
    return [studio!, ...narrowing.filter((p) => !named || p.rules.some((r) => r.actionClass === actionClass))]
  }

  /** The strictest rule over the policies, and the policy it comes from (the studio's on a tie); a class in ALWAYS_ASK at least asks. */
  private effective(actionClass: ActionClass, projectId?: string): { policy: AutonomyPolicy; mode: Mode; requires: Check[] } {
    let best: { policy: AutonomyPolicy; mode: Mode } | undefined
    const requires = new Set<Check>()
    for (const policy of this.applying(actionClass, projectId)) {
      const rule = policy.rules.find((r) => r.actionClass === actionClass)
      rule?.requires?.forEach((c) => requires.add(c))
      const mode = rule?.mode ?? policy.default
      if (!best || rank(mode) > rank(best.mode)) best = { policy, mode }
    }
    const mode = ALWAYS_ASK.includes(actionClass) && rank(best!.mode) < rank('ask') ? 'ask' : best!.mode
    return { policy: best!.policy, mode, requires: [...requires] }
  }

  /** How one action is judged: its class (workspace-write for a listed command), the rule, and why it is forbidden whatever a rule says. */
  private judge(action: Action) {
    const policies = this.policies(action.projectId)
    const argv = action.command
    const unsafe = argv?.findIndex((w) => SHELL_METACHARACTER.test(w)) ?? -1
    if (unsafe >= 0) return { actionClass: action.class, ...this.effective(action.class, action.projectId), mode: 'forbid' as Mode, policies, forbidden: `argv word ${unsafe + 1} holds a shell metacharacter` }
    // A project's list may only narrow the studio's: a command is listed when every policy that has a list has its exact argv.
    const allows = (p: AutonomyPolicy) => (p.commands ?? []).some((c) => c.split(' ').length === argv!.length && c.split(' ').every((w, i) => argv![i] === w))
    const listed = action.class === 'command' && argv !== undefined && allows(policies[0]!) && policies.slice(1).every((p) => p.commands === undefined || allows(p))
      && this.effective('command', action.projectId).mode !== 'forbid'
    const actionClass: ActionClass = listed ? 'workspace-write' : action.class
    return { actionClass, ...this.effective(actionClass, action.projectId), policies, forbidden: undefined }
  }

  async policy(projectId?: string) {
    const classes: ActionClass[] = ['read', 'workspace-write', 'merge', 'command', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change']
    return { policies: this.policies(projectId), effective: classes.map((actionClass) => ({ actionClass, mode: this.effective(actionClass, projectId).mode })) }
  }

  async check(action: Action): Promise<AutonomyVerdict> {
    const { actionClass, policy, mode, requires, policies, forbidden } = this.judge(action)
    const failedChecks = mode === 'auto' || mode === 'notify' ? requires.filter((c) => action.checks?.[c] !== true) : []
    const decision = this.ctx.artifacts.recordDecision({
      schema: 'decision@1.4', decisionType: 'autonomy', question: `Which mode does the policy give a ${action.class} action?`, inputs: [],
      candidates: MODES.map((m) => ({
        option: m, selected: m === mode,
        reasons: [forbidden ? (m === mode ? `${forbidden}: forbidden whatever a rule says` : `not ${m}: ${forbidden}`)
          : m === mode ? `the strictest rule for ${actionClass} is ${policy.id}'s`
          : rank(m) < rank(mode) ? `not ${m}: laxer than ${policy.id}'s rule for ${actionClass} (${mode}), the strictest that applies`
          : `not ${m}: no applying policy's rule for ${actionClass} is that strict`],
      })),
      decider: { type: 'policy', id: policy.id, version: String(policy.version), hash: contentId(policies) },
      outcome: { option: mode, detail: { actionClass, policies: policies.map((p) => p.id), ...(failedChecks.length ? { failedChecks } : {}) } }, deterministic: true,
    }, { producer: { type: 'policy', ref: policy.id } })
    return { mode, ...(failedChecks.length ? { failedChecks } : {}), policy: { id: policy.id, version: policy.version }, decision: decision.id as ArtifactRef }
  }

  async request(request: NewRequest, at: Date = new Date()): Promise<ApprovalRequest> {
    const { subject: s, requester: { projectId } } = request
    if (!(s?.version || (s?.type === 'artifact' && /^sha256:[0-9a-f]{64}$/.test(s.ref)))) throw new ApprovalsError('invalid', 'the subject names no version (INV-5)')
    const notAsked = (why: string) => new ApprovalsError('not-asked', `${request.action.class}: ${why}`)
    const envelope = this.ctx.artifacts.get(request.verdict.decision)
    const recorded = envelope?.body as { decisionType?: string; outcome?: { option?: string; detail?: { actionClass?: string; policies?: string[] } }; decider?: { type?: string; id?: string; version?: string; hash?: string } } | undefined
    if (request.verdict.mode !== 'ask' || recorded?.decisionType !== 'autonomy' || recorded.outcome?.option !== 'ask') throw notAsked('the recorded policy verdict is not ask')
    // The decision is a policy's own, of the verdict's policy, made under the project's policies now.
    const policies = this.policies(projectId)
    if (envelope!.producer.type !== 'policy' || recorded.decider?.type !== 'policy' || recorded.decider.id !== request.verdict.policy.id || recorded.decider.version !== String(request.verdict.policy.version)) throw notAsked('not this policy\'s decision')
    if (!policies.some((p) => p.id === recorded.decider!.id && String(p.version) === recorded.decider!.version) || recorded.decider.hash !== contentId(policies)
      || JSON.stringify(recorded.outcome.detail?.policies) !== JSON.stringify(policies.map((p) => p.id))) throw notAsked('decided under other policies')
    // Judged again: the policy still asks, for the class the decision names.
    const judged = this.judge({ class: request.action.class, ...(projectId !== undefined ? { projectId } : {}), ...(request.command ? { command: request.command } : {}) })
    if (judged.mode !== 'ask' || judged.actionClass !== recorded.outcome.detail?.actionClass || judged.policy.id !== recorded.decider.id) throw notAsked('the policy does not ask for this action')
    // The shortest expiry of the rules that apply, else the stricter default, within the stricter maximum.
    const named = this.applying(request.action.class, projectId).flatMap((p) => p.rules.filter((r) => r.actionClass === request.action.class && r.expiresSeconds !== undefined).map((r) => r.expiresSeconds!))
    const seconds = Math.min(named.length ? Math.min(...named) : Math.min(...policies.map((p) => p.expiry.defaultSeconds)), ...policies.map((p) => p.expiry.maxSeconds))
    const created: ApprovalRequest = {
      schema: 'approval-request@1.0', requestId: `apr-${randomUUID().slice(0, 8)}`, state: 'open',
      subject: request.subject, action: request.action, requester: request.requester,
      policy: { ...request.verdict.policy, decision: request.verdict.decision }, classification: request.classification,
      createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + seconds * 1000).toISOString(), revision: 0,
    }
    try {
      schemas.assertRecord(created)
    } catch (error) {
      throw new ApprovalsError('invalid', (error as Error).message)
    }
    this.requests.set(created.requestId, created)
    return structuredClone(created)
  }

  async get(requestId: string) {
    const request = this.requests.get(requestId)
    return request && structuredClone(request)
  }

  async list(filter: { states?: RequestState[]; batchId?: string; projectId?: string } = {}) {
    const states = filter.states ?? ['open', 'batched']
    return [...this.requests.values()]
      .filter((r) => states.includes(r.state) && (filter.batchId === undefined || r.batchId === filter.batchId) && (filter.projectId === undefined || r.requester.projectId === filter.projectId))
      .sort((a, b) => (a.batchId ?? '￿').localeCompare(b.batchId ?? '￿') || a.expiresAt.localeCompare(b.expiresAt))
      .map((r) => structuredClone(r))
  }

  async batch(at: Date = new Date()): Promise<string[]> {
    const groups = new Map<string, ApprovalRequest[]>()
    for (const r of this.requests.values()) if (r.state === 'open') groups.set(r.requester.projectId ?? '', [...(groups.get(r.requester.projectId ?? '') ?? []), r])
    const made: string[] = []
    for (const [projectId, open] of groups) {
      const rule = this.policies(projectId || undefined).map((p) => p.batch).find((b) => b !== undefined) ?? { maxSize: 1, maxWaitSeconds: 0 }
      const oldest = Math.min(...open.map((r) => Date.parse(r.createdAt)))
      if (open.length < rule.maxSize && at.getTime() - oldest < rule.maxWaitSeconds * 1000) continue
      const batchId = `batch-${++this.batches}`
      for (const r of open) Object.assign(r, { state: 'batched', batchId, revision: r.revision + 1 })
      made.push(batchId)
    }
    return made
  }

  private resolve(request: ApprovalRequest, cause: 'verdict' | 'expired' | 'withdrawn', option: string, at: Date, approval?: ArtifactRef): void {
    // Why each other resolution lost: what happened first.
    const verdicts = ['approved', 'rejected']
    const lost = (o: string): string => cause === 'verdict' ? (verdicts.includes(o) ? `the operator's verdict is ${option}` : 'a verdict came first')
      : cause === 'expired' ? (o === 'withdrawn' ? 'it was not withdrawn before it expired' : 'no verdict came before it expired')
      : o === 'denied:expired' ? 'it was withdrawn before it expired' : 'it was withdrawn before a verdict'
    const decision = this.ctx.artifacts.recordDecision({
      schema: 'decision@1.4', decisionType: 'approval', question: `Is approval request ${request.requestId} approved?`, inputs: [request.policy.decision, ...(approval ? [approval] : [])],
      candidates: ['approved', 'rejected', 'denied:expired', 'withdrawn'].map((o) => ({ option: o, selected: o === option, reasons: [o === option ? cause : `not ${o}: ${lost(o)}`] })),
      decider: cause === 'verdict' ? { type: 'operator', id: 'operator', version: '1' } : { type: 'rule', id: cause === 'expired' ? 'approvals.expiry' : 'approvals.withdraw', version: '1' },
      outcome: { option, detail: { requestId: request.requestId } }, deterministic: cause !== 'verdict',
    }, { producer: { type: cause === 'verdict' ? 'operator' : 'system', ref: 'approvals' }, classification: request.classification === 'local-private' ? 'local-private' : 'operator-shared' })
    Object.assign(request, {
      state: option === 'approved' ? 'approved' : 'rejected', revision: request.revision + 1,
      resolution: { cause, ...(approval ? { approval } : {}), decision: decision.id as ArtifactRef, at: at.toISOString() },
    })
  }

  async decide(verdicts: Verdict[], at: Date = new Date()): Promise<VerdictResult[]> {
    return verdicts.map((v) => {
      const request = this.requests.get(v.requestId)
      if (!request) return { requestId: v.requestId, state: 'rejected', refused: 'unknown-request' }
      if (request.resolution) return { requestId: v.requestId, state: request.state, refused: 'already-resolved' }
      if (Date.parse(request.expiresAt) <= at.getTime()) return { requestId: v.requestId, state: request.state, refused: 'expired' }
      if (!sameSubject(request.subject, v.subject)) return { requestId: v.requestId, state: request.state, refused: 'subject-changed' }
      const approval = this.ctx.artifacts.put({
        kind: 'approval', bodySchema: 'approval@1.0', body: { schema: 'approval@1.0', subject: request.subject, verdict: v.verdict, by: 'operator', ...(v.note ? { note: v.note } : {}) },
        classification: request.classification === 'local-private' ? 'local-private' : 'operator-shared', producer: { type: 'operator', ref: 'operator' }, subject: request.subject,
      }).id as ArtifactRef
      this.resolve(request, 'verdict', v.verdict, at, approval)
      return { requestId: v.requestId, state: request.state, approval }
    })
  }

  async withdraw(requestId: string, at: Date = new Date()): Promise<ApprovalRequest> {
    const request = this.requests.get(requestId)
    if (!request) throw new ApprovalsError('unknown-request', `no approval request ${requestId}`)
    if (!request.resolution) this.resolve(request, 'withdrawn', 'withdrawn', at)
    return structuredClone(request)
  }

  async sweep(at: Date): Promise<ApprovalRequest[]> {
    const expired: ApprovalRequest[] = []
    for (const request of this.requests.values()) {
      if (request.resolution || Date.parse(request.expiresAt) > at.getTime()) continue
      this.resolve(request, 'expired', 'denied:expired', at)
      expired.push(structuredClone(request))
    }
    return expired
  }
}
