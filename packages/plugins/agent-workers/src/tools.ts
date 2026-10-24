/**
 * The operator's agent account tools (PROP-0012 phases E and F, ADR-0051), operator scope:
 * `account_enroll` (take a slot and get its sign-in command, then verify who signed in),
 * `account_remove` (free a slot), `account_agents` (every slot and what it holds), and
 * `account_migrate` (plan, apply, or undo the move from hand-named Workers to account × role). Input
 * and output are checked against `mcp-agent-accounts@1.2` (ADR-0037), the output of a call that
 * changes anything before its change commits; nothing in them holds a principal or a token (INV-8).
 * Beside them, the run tools (`mcp-agent-runs@1.1`): `agent_run_free`, the operator frees what a
 * run that ended with its liveness unknown holds (PROP-0013); and `agent_worktrees` and
 * `agent_worktrees_remove`, the operator lists the run worktrees and removes the finished ones (D12).
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { outline } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import zod from 'zod'
import type { AgentAccount, AgentAccounts, Begun, SlotRef } from './accounts.ts'
import type { WorktreeRemoval } from './index.ts'

const TAG = 'mcp-agent-accounts@1.2'
const RUNS_TAG = 'mcp-agent-runs@1.1'
const schemas = new SchemaRegistry()

const refused = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

/**
 * Checks the output a call would give: a call that changes anything runs it on that output before
 * its change commits, so an output its schema refuses (a defect) leaves everything as it was.
 */
export type OutputCheck = (out: Record<string, unknown>) => void

/** The output a call would give, refused by its schema before its change committed. */
class RefusedOutput extends Error {}

/**
 * One call of a tool of schema `tag`: its input checked, the work done, its output checked; a
 * refusal does nothing more. Work that changes anything is given `check` and runs it on the output
 * it would give before it commits (fail closed, INV-2): a defect then refuses the call with nothing
 * changed. The output is checked once more at the end, which is all a read-only call needs.
 */
async function checked(tag: string, tool: string, args: Record<string, unknown>, work: (check: OutputCheck) => Promise<Record<string, unknown>>, text: (out: Record<string, unknown>) => string) {
  const def = tool.replaceAll('_', '-')
  try {
    schemas.assertDef(tag, `${def}-input`, args)
  } catch (error) {
    return refused(`invalid input, nothing done: ${(error as Error).message}`)
  }
  const check: OutputCheck = (out) => {
    try {
      schemas.assertDef(tag, `${def}-output`, out)
    } catch (error) {
      throw new RefusedOutput((error as Error).message)
    }
  }
  let out: Record<string, unknown>
  try {
    out = await work(check)
  } catch (error) {
    if (error instanceof RefusedOutput) return refused(`${tool} would make an output its schema refuses (a defect), so nothing changed: ${error.message}`)
    const kind = (error as { kind?: unknown }).kind
    return refused(`${typeof kind === 'string' ? `${kind}: ` : ''}${(error as Error).message}`)
  }
  try {
    schemas.assertDef(tag, `${def}-output`, out)
  } catch (error) {
    return refused(`${tool} made an output its schema refuses (a defect): ${(error as Error).message}`)
  }
  return { content: [{ type: 'text' as const, text: text(out) }], structuredContent: out }
}

const call = (tool: string, args: Record<string, unknown>, work: (check: OutputCheck) => Promise<Record<string, unknown>>, text: (out: Record<string, unknown>) => string) => checked(TAG, tool, args, work, text)

const refOf = (args: Record<string, unknown>): SlotRef => (typeof args.accountId === 'string'
  ? { accountId: args.accountId }
  : { provider: String(args.provider), ...(typeof args.slot === 'number' ? { slot: args.slot } : {}) })

/** What frees a run's holds, and lists and removes the run worktrees, as the `agents` source does it. */
export interface Freer {
  free(input: { agentRun: string; agentGone: boolean; commitWorktree?: boolean; note?: string }): Promise<object>
  runWorktrees(input: { limit?: number }): Promise<object>
  removeWorktrees(input: { runId?: string; commitChanges?: boolean; note?: string }, check?: (planned: WorktreeRemoval) => void): Promise<object>
}

/**
 * The operator's run tools, operator scope, their input and output checked against
 * `mcp-agent-runs@1.1`: `agent_run_free` frees what an agent run that ended without being known to
 * be gone holds (PROP-0013, ADR-0056); `agent_worktrees` lists the workflow runs' worktrees, and
 * `agent_worktrees_remove` removes the finished ones now, never discarding a change (D12), its
 * output checked on its plan before anything is decided.
 */
export function registerRunTools(ctx: Context, freer: Freer): void {
  ctx.mcp.tool('agent_run_free', {
    scope: 'operator',
    description: 'Free the session and worktree an agent run holds because it ended with its liveness unknown, on your word that its agent is gone (agentGone). Recorded as your decision. Refused while its liveness is still looked at, a process holds it, or its holder or agent process is present. A worktree is removed only when clean, or with commitWorktree after its changes are committed on its branch; the branch stays.',
    inputSchema: {
      agentRun: zod.string().max(64).describe('The agent run (arun_…) status or explain lists as unknown'),
      agentGone: zod.boolean().describe('Your word that no process of its agent runs; required true'),
      commitWorktree: zod.boolean().optional().describe('Commit a dirty worktree\'s changes on its branch, then remove it'),
      note: zod.string().max(1000).optional().describe('Why, kept on the decision'),
    },
  }, async (args) => checked(RUNS_TAG, 'agent_run_free', args, async () => ({ ...await freer.free({
    agentRun: String(args.agentRun), agentGone: args.agentGone === true, commitWorktree: args.commitWorktree === true, ...(typeof args.note === 'string' ? { note: args.note } : {}),
  }) }), (out) => {
    const freed = out as { agentRun: string; decision: string; again: boolean; freed: string[]; worktrees: Array<{ path: string; outcome: string; why: string; commit?: string }> }
    return [
      `${freed.again ? 'freed again' : 'freed'} ${freed.agentRun} (decision ${freed.decision})${freed.freed.length ? `: ${freed.freed.join(', ')}` : ''}`,
      ...freed.worktrees.map((w) => `  worktree ${w.path}: ${w.outcome}${w.commit ? ` (committed ${w.commit})` : ''}: ${w.why}`),
    ].join('\n')
  }))
  ctx.mcp.tool('agent_worktrees', {
    scope: 'operator',
    description: 'List the workflow runs\' worktrees not removed yet, oldest first: each with its run, branch, state (in-use while an agent run of its workflow run runs; held while one ended with its liveness unknown; else finished), what it holds (clean, uncommitted, gone, not-intact), and when the retention removes it.',
    inputSchema: { limit: zod.number().int().min(1).max(100).optional().describe('At most this many (default and most 100)') },
  }, async (args) => checked(RUNS_TAG, 'agent_worktrees', args, async () => ({ ...await freer.runWorktrees(typeof args.limit === 'number' ? { limit: args.limit } : {}) }), (out) => {
    const listing = out as { retentionHours: number; total: number; worktrees: Array<{ runId: string; path: string; branch: string; state: string; changes: string; retiresAt?: string }> }
    return [
      `${listing.total} run worktree(s); the retention removes a finished one ${listing.retentionHours ? `${listing.retentionHours} h after its last agent run` : 'never (worktreeRetentionHours 0)'}`,
      ...listing.worktrees.map((w) => `  ${w.runId}  ${w.state}, ${w.changes}${w.retiresAt ? `, retires ${w.retiresAt}` : ''}  ${w.path} (${w.branch})`),
    ].join('\n')
  }))
  ctx.mcp.tool('agent_worktrees_remove', {
    scope: 'operator',
    description: 'Remove finished run worktrees now, before the retention does: every one, or one workflow run\'s (runId). One is removed only while no agent run of its workflow run is unfinished or held, and only when clean, or with commitChanges after its changes are committed on its branch: nothing is discarded, and the branch stays. Recorded as your retention decision; one it cannot remove stays, with why.',
    inputSchema: {
      runId: zod.string().max(128).optional().describe('Only this workflow run\'s worktrees'),
      commitChanges: zod.boolean().optional().describe('Commit a finished worktree\'s uncommitted changes on its branch, then remove it'),
      note: zod.string().max(1000).optional().describe('Why, kept on the decision'),
    },
  }, async (args) => checked(RUNS_TAG, 'agent_worktrees_remove', args, async (check) => ({ ...await freer.removeWorktrees({
    ...(typeof args.runId === 'string' ? { runId: args.runId } : {}), commitChanges: args.commitChanges === true, ...(typeof args.note === 'string' ? { note: args.note } : {}),
  }, (planned) => check({ ...planned })) }), (out) => {
    const removal = out as { decision?: string; more: number; worktrees: Array<{ runId: string; path: string; outcome: string; why: string; commit?: string }> }
    return [
      removal.decision ? `removed finished run worktrees (decision ${removal.decision})` : 'no finished run worktree to remove; nothing was decided',
      ...removal.worktrees.map((w) => `  ${w.runId} ${w.path}: ${w.outcome}${w.commit ? ` (committed ${w.commit})` : ''}: ${w.why}`),
      ...(removal.more ? [`  ${removal.more} more not looked at: run it again`] : []),
    ].join('\n')
  }))
}

/** The move from hand-named rows to derived Workers, as the `agents` source runs it; an apply or a rollback runs `check` on its output before it commits. */
export interface Migrator {
  migrate(options: { apply?: boolean; rollback?: boolean; stop?: readonly string[] }, check: OutputCheck): Promise<Record<string, unknown>>
}

export function registerAccountTools(ctx: Context, accounts: AgentAccounts, migrator: Migrator): void {
  const slotShape = {
    provider: zod.string().max(64).optional().describe('An agent runtime kind, as its provider registers it'),
    slot: zod.number().int().min(1).max(64).optional().describe('One slot of the provider'),
    accountId: zod.string().max(81).optional().describe('An agent account id, <provider>:<16 hex>'),
  }
  ctx.mcp.tool('account_enroll', {
    scope: 'operator',
    description: 'Enroll an agent account. step begin takes a provider\'s lowest free slot (or the slot named; a taken slot or an accountId signs in again in its own home) and returns the runtime\'s sign-in command for the slot\'s home, to run in your own terminal without D-Bus; step verify then reads who signed in and records the account: ready, signed-out, or quarantined (changed, ambiguous, duplicate, unverified) with why.',
    inputSchema: { step: zod.enum(['begin', 'verify']).describe('begin, then verify after the sign-in'), ...slotShape, accept: zod.boolean().optional().describe('verify only: accept a changed slot\'s new principal as a new account') },
  }, async (args) => call('account_enroll', args, async (check) => {
    const ref = refOf(args)
    const begunOutput = (begun: Begun) => ({ account: begun.account, workers: accounts.workersIn(begun.account), login: begun.login, adopted: begun.adopted })
    if (args.step === 'begin') return begunOutput(await accounts.begin(ref, (begun) => check(begunOutput(begun))))
    const verifiedOutput = (account: AgentAccount) => ({ account, workers: accounts.workersIn(account) })
    return verifiedOutput(await accounts.verify(ref, { accept: args.accept === true, check: (account) => check(verifiedOutput(account)) }))
  }, (out) => {
    const account = out.account as { provider: string; slot: number; status: string; accountId?: string; quarantine?: { reason: string } }
    const login = out.login as { command: string; args: string[]; env: Record<string, string> } | undefined
    const head = `slot ${account.slot} of ${account.provider}: ${account.status}${account.quarantine ? ` (${account.quarantine.reason})` : ''}${account.accountId ? `, ${account.accountId}` : ''}`
    return login ? `${head}\nsign in with: ${Object.entries(login.env).map(([k, v]) => `${k}=${v}`).join(' ')} ${[login.command, ...login.args].join(' ')}` : head
  }))
  ctx.mcp.tool('account_remove', {
    scope: 'operator',
    description: 'Free an agent account\'s slot, by its account id or by provider and slot. Recorded as an enrollment decision; its home and the sign-in in it are kept as they are, and a later sign-in in that slot replaces it.',
    inputSchema: slotShape,
  }, async (args) => call('account_remove', args, async (check) => ({ removed: await accounts.remove(refOf(args), (removed) => check({ removed })) }), (out) => {
    const removed = out.removed as { provider: string; slot: number; accountId?: string }
    return `freed slot ${removed.slot} of ${removed.provider}${removed.accountId ? ` (was ${removed.accountId})` : ''}`
  }))
  ctx.mcp.tool('account_agents', {
    scope: 'operator',
    description: 'List agent accounts: each enrollment slot with its account id, masked hint, status and why, home, and the Workers that run there; and each runtime with its slots, how many are taken, and whether it can read identity.',
    inputSchema: {},
  }, async (args) => call('account_agents', args, async () => ({
    accounts: accounts.list().map((account) => {
      const label = accounts.labelOf(account)
      return { account, workers: accounts.workersIn(account), ...(label !== undefined ? { label } : {}) }
    }),
    providers: accounts.providers(),
  }), outline))
  ctx.mcp.tool('account_migrate', {
    scope: 'operator',
    description: 'The move from hand-named agent Workers to Workers derived as account × role. By default it only plans: the roles, assignments, and provider settings of the new agent-workers row, the pool templates for the resources row, each old Worker\'s new id, and what stops the move. apply records each move and the cutover as enrollment decisions and moves the old Workers\' agent sessions and runs to their new ids; from then on the hand-named rows are refused at load (drain first: refused while one of their runs is queued or running). rollback undoes it.',
    inputSchema: {
      apply: zod.boolean().optional().describe('Apply the move (recorded; the hand-named rows are refused from then on)'),
      rollback: zod.boolean().optional().describe('Undo an applied move: sessions and runs moved back, the hand-named rows load again'),
      stop: zod.array(zod.string().max(64)).max(64).optional().describe('Runtimes whose Workers stop at the cutover, their account not ready'),
    },
  }, async (args) => call('account_migrate', args, async (check) => migrator.migrate({
    apply: args.apply === true, rollback: args.rollback === true, stop: Array.isArray(args.stop) ? args.stop.map(String) : [],
  }, check), (out) => {
    const plan = out.plan as { workers: Array<{ from: string; to?: string; why: string }>; blockers: string[] }
    return [
      `${out.outcome}:`,
      ...plan.workers.map((w) => `  ${w.from} -> ${w.to ?? 'stops'} (${w.why})`),
      ...plan.blockers.map((b) => `  refused: ${b}`),
    ].join('\n')
  }))
}
