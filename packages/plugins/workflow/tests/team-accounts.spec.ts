/**
 * A team's distinct accounts counted by account, not by Worker (REQ-TEAM-4; PROP-0012 phase C,
 * docs/design/teams.md#distinct-accounts): a member avoids every sibling of a Worker another member
 * holds, and every Worker whose descriptor names the same account. When the held Worker's account
 * cannot be told apart, the member is refused with the cause. The Workers are scripted as the
 * `agents` source describes the roles of one runtime home: siblings of one another.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { sha256, startPrompt } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { ArtifactRef, CapabilityDescriptor, WorkerExecution, WorkerStart } from '@tsuuanmi/system-workers-core'
import { afterEach, describe, expect, it } from 'vitest'
import { worker } from '../../../workers-core/conformance/workers.ts'
import Workflow, { type Config } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** A Worker a team member may take: it reasons and keeps its conversation. */
const role = (id: string, family: string, account?: string): CapabilityDescriptor => worker(id, {
  schema: 'capability-descriptor@1.5', provider: family, family, proves: ['reason', 'persistent-conversation'],
  ...(account ? { account: { id: account, group: 'runtime', mode: 'assigned' as const } } : {}),
})

const isProposal = (prompt: string): boolean => prompt.includes('Answer on your own')
/** A member that proposes its own option and votes O1, with no objection. */
const member = (prompt: string): string => (isProposal(prompt)
  ? `My proposal.\n${JSON.stringify({ recommendation: `option of ${/member (\d)/.exec(prompt)?.[1]}`, rationale: 'it fits', risks: [] })}`
  : JSON.stringify({ choice: 'O1', ranking: ['O1', 'O2'], rationale: 'I prefer O1', evidence: [], strongest: { O2: 'it is simpler' }, objections: [], confidence: 'high' }))

/**
 * A scripted source over `workers`: sessions stay on their Worker; `accounts` lists the sets of
 * Workers it names as siblings of one another; `onStart` sees each start before it answers.
 */
function scripted(ctx: Context, state: { workers: CapabilityDescriptor[]; accounts?: string[][]; onStart?: ((start: WorkerStart) => void) | undefined }) {
  const started: Array<WorkerStart & { prompt: string }> = []
  const sessions = new Map<string, string>()
  const executions = new Map<string, WorkerExecution>()
  ctx.workers.register({
    name: 'scripted', describe: async () => state.workers,
    start: (request) => {
      state.onStart?.(request)
      const prompt = startPrompt(request, (ref) => ctx.artifacts.get(ref)).prompt
      if (request.sessionId) sessions.set(request.sessionId, sessions.get(request.sessionId) ?? request.worker)
      started.push({ ...request, prompt })
      const id = `x-${started.length}`
      const result = ctx.artifacts.put({
        kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'public', producer: { type: 'worker', ref: request.worker },
        body: { schema: 'provider-answer@1.0', provider: 'scripted', account: 'scripted', turnId: id, conversation: { mode: 'temporary' }, promptHash: sha256(prompt), text: member(prompt) },
      }).id as ArtifactRef
      const execution: WorkerExecution = { id, status: 'completed', submitted: true, result, decisions: [] }
      executions.set(id, execution)
      return execution
    },
    get: (id) => executions.get(id),
    wait: async (id) => executions.get(id)!,
    affinity: (sessionId) => (sessions.has(sessionId) ? [sessions.get(sessionId)!] : undefined),
    siblings: (id) => state.accounts?.find((set) => set.includes(id)),
  })
  return started
}

async function boot(config: Config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-team-accounts-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100, ...config }),
  ]
  await Promise.all(fibers)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return ctx
}

const brainstorm = (ctx: Context) => ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'Which store?', classification: 'public' }).runId, 60_000)
const workerOf = (run: { nodes: Array<{ nodeId: string; worker?: string }> }, nodeId: string): string | undefined => run.nodes.find((n) => n.nodeId === nodeId)?.worker

describe('a team\'s distinct accounts are counted by account, across every Worker on it (REQ-TEAM-4, PROP-0012 phase C)', () => {
  it('never takes another role of the account a member holds as an independent member; a Worker of another account takes it', async () => {
    const ctx = await boot()
    // Two roles of one home, each with a family of its own: before, the second member took the other role.
    const state = { workers: [role('agent:review', 'family-a'), role('agent:develop', 'family-b')], accounts: [['agent:develop', 'agent:review']] }
    const started = scripted(ctx, state)
    const refused = await brainstorm(ctx)
    expect(refused).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringContaining('members use distinct accounts (REQ-TEAM-4); another member holds this account') } })
    expect(started).toHaveLength(1)
    // A Worker on another account is admitted for the second member.
    state.workers.push(role('agent:other', 'family-c'))
    const done = await brainstorm(ctx)
    expect(done).toMatchObject({ status: 'completed' })
    const held = [workerOf(done, 'brainstorm:m1:propose'), workerOf(done, 'brainstorm:m2:propose')]
    expect(held).toContain('agent:other')
    expect(held.filter((w) => w !== 'agent:other')).toHaveLength(1)
  }, 60_000)

  it('says the members share an account when the only other Worker of the family is a role of the same account, with the same family allowed (ADR-0029, ADR-0035)', async () => {
    const ctx = await boot({ allowSameFamily: true })
    scripted(ctx, { workers: [role('agent:review', 'family-a'), role('agent:develop', 'family-a')], accounts: [['agent:develop', 'agent:review']] })
    const done = await brainstorm(ctx)
    expect(done.status).toBe('completed')
    // Before, the two roles counted as two accounts: `same-family`, "each on an account of its own".
    expect(done.answer).toContain('Members: same provider family (allowSameFamily), some sharing one account: no other provider judged this.')
    const m2 = ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === 'brainstorm:m2:propose')!
    expect(m2.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'admission', outcome: 'same-family-shared-account' })]))
    expect(m2.decisions.some((d) => d.outcome === 'same-family')).toBe(false)
  }, 60_000)

  it('counts Workers whose descriptors name one account as one, whether or not a source names them siblings', async () => {
    const ctx = await boot()
    const started = scripted(ctx, { workers: [role('w:a', 'family-a', 'acct-1'), role('w:b', 'family-b', 'acct-1')] })
    const refused = await brainstorm(ctx)
    expect(refused).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('another member holds this account') } })
    expect(started).toHaveLength(1)
  }, 60_000)

  it('refuses a member, with the cause, when no source describes the Worker another member holds, though the same family is allowed (INV-2)', async () => {
    const ctx = await boot({ allowSameFamily: true })
    const state: Parameters<typeof scripted>[1] = { workers: [role('agent:review', 'family-a'), role('agent:develop', 'family-b')] }
    // Once the first member started, its Worker is no longer described, and no source names its siblings.
    state.onStart = (start) => {
      state.workers = state.workers.filter((w) => w.worker !== start.worker)
      state.onStart = undefined
    }
    const started = scripted(ctx, state)
    const refused = await brainstorm(ctx)
    // The family rule reads the held Worker first and says so; the distinct-account rule would refuse
    // it for the same cause: neither can tell which account it is on.
    expect(refused).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringMatching(/Worker agent:\w+ is no longer listed, so no Worker can be shown to differ from it/) } })
    // Nothing was sent for the refused member.
    expect(started).toHaveLength(1)
  }, 60_000)

  it('refuses a member, with the cause, when a held Worker\'s siblings name different accounts (INV-2)', async () => {
    const ctx = await boot({ allowSameFamily: true })
    const started = scripted(ctx, {
      workers: [role('w:a', 'family-a', 'acct-1'), role('w:b', 'family-b', 'acct-2'), role('w:c', 'family-c')],
      accounts: [['w:a', 'w:b']],
    })
    const refused = await brainstorm(ctx)
    expect(refused).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringMatching(/^team brainstorm: member m\d holds w:[ab], whose source names w:a, w:b as the Workers of its account, and their descriptors name different accounts, so its account cannot be told apart from the others' \(REQ-TEAM-4\)/) } })
    expect(started).toHaveLength(1)
  }, 60_000)
})
