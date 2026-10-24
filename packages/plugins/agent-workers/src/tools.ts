/**
 * The operator's agent account tools (PROP-0012 phases E and F, ADR-0051), operator scope:
 * `account_enroll` (take a slot and get its sign-in command, then verify who signed in),
 * `account_remove` (free a slot), `account_agents` (every slot and what it holds), and
 * `account_migrate` (plan, apply, or undo the move from hand-named Workers to account × role). Input
 * and output are checked against `mcp-agent-accounts@1.1` (ADR-0037); nothing in them holds a
 * principal or a token (INV-8). Beside them, `agent_run_free` (`mcp-agent-runs@1.0`): the operator
 * frees what a run that ended with its liveness unknown holds (PROP-0013).
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { outline } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import zod from 'zod'
import type { AgentAccounts, SlotRef } from './accounts.ts'

const TAG = 'mcp-agent-accounts@1.1'
const RUNS_TAG = 'mcp-agent-runs@1.0'
const schemas = new SchemaRegistry()

const refused = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

/** One call of a tool of schema `tag`: its input checked, the work done, its output checked; a refusal does nothing more. */
async function checked(tag: string, tool: string, args: Record<string, unknown>, work: () => Promise<Record<string, unknown>>, text: (out: Record<string, unknown>) => string) {
  const def = tool.replaceAll('_', '-')
  try {
    schemas.assertDef(tag, `${def}-input`, args)
  } catch (error) {
    return refused(`invalid input, nothing done: ${(error as Error).message}`)
  }
  let out: Record<string, unknown>
  try {
    out = await work()
  } catch (error) {
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

const call = (tool: string, args: Record<string, unknown>, work: () => Promise<Record<string, unknown>>, text: (out: Record<string, unknown>) => string) => checked(TAG, tool, args, work, text)

const refOf = (args: Record<string, unknown>): SlotRef => (typeof args.accountId === 'string'
  ? { accountId: args.accountId }
  : { provider: String(args.provider), ...(typeof args.slot === 'number' ? { slot: args.slot } : {}) })

/** What frees a run's holds, as the `agents` source does it. */
export interface Freer {
  free(input: { agentRun: string; agentGone: boolean; commitWorktree?: boolean; note?: string }): Promise<object>
}

/**
 * The operator's tool that frees what an agent run that ended without being known to be gone holds
 * (PROP-0013, ADR-0056): `agent_run_free`, operator scope, its input and output checked against
 * `mcp-agent-runs@1.0`.
 */
export function registerRunTools(ctx: Context, freer: Freer): void {
  ctx.mcp.tool('agent_run_free', {
    scope: 'operator',
    description: 'Operator tool: free the session and worktree an agent run holds because it ended with its liveness unknown, on your word that its agent is gone (agentGone). Recorded as your decision. Refused while its liveness is still looked at, a process holds it, or its holder or agent process is present. A worktree is removed only when clean, or with commitWorktree after its changes are committed on its branch; the branch stays.',
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
}

/** The move from hand-named rows to derived Workers, as the `agents` source runs it. */
export interface Migrator {
  migrate(options: { apply?: boolean; rollback?: boolean; stop?: readonly string[] }): Promise<Record<string, unknown>>
}

export function registerAccountTools(ctx: Context, accounts: AgentAccounts, migrator: Migrator): void {
  const slotShape = {
    provider: zod.string().max(64).optional().describe('An agent runtime kind, as its provider registers it'),
    slot: zod.number().int().min(1).max(64).optional().describe('One slot of the provider'),
    accountId: zod.string().max(81).optional().describe('An agent account id, <provider>:<16 hex>'),
  }
  ctx.mcp.tool('account_enroll', {
    scope: 'operator',
    description: 'Operator tool: enroll an agent account (ADR-0051). step begin takes the lowest free slot of a provider (or the slot named; a taken slot or an accountId is signed in again in its own home) and returns the runtime\'s own sign-in command for the slot\'s home, which you run in your own terminal without D-Bus; step verify then reads who signed in and records the account: ready, signed-out, or quarantined (changed, ambiguous, duplicate, unverified) with why. accept takes a changed slot\'s new principal as a new account.',
    inputSchema: { step: zod.enum(['begin', 'verify']).describe('begin, then verify after the sign-in'), ...slotShape, accept: zod.boolean().optional().describe('verify only: accept a changed slot\'s new principal as a new account') },
  }, async (args) => call('account_enroll', args, async () => {
    const ref = refOf(args)
    if (args.step === 'begin') {
      const begun = await accounts.begin(ref)
      return { account: begun.account, workers: accounts.workersIn(begun.account), login: begun.login, adopted: begun.adopted }
    }
    const account = await accounts.verify(ref, { accept: args.accept === true })
    return { account, workers: accounts.workersIn(account) }
  }, (out) => {
    const account = out.account as { provider: string; slot: number; status: string; accountId?: string; quarantine?: { reason: string } }
    const login = out.login as { command: string; args: string[]; env: Record<string, string> } | undefined
    const head = `slot ${account.slot} of ${account.provider}: ${account.status}${account.quarantine ? ` (${account.quarantine.reason})` : ''}${account.accountId ? `, ${account.accountId}` : ''}`
    return login ? `${head}\nsign in with: ${Object.entries(login.env).map(([k, v]) => `${k}=${v}`).join(' ')} ${[login.command, ...login.args].join(' ')}` : head
  }))
  ctx.mcp.tool('account_remove', {
    scope: 'operator',
    description: 'Operator tool: free an agent account\'s slot (ADR-0051), by its account id or by provider and slot. Recorded as an enrollment decision; its home and the sign-in in it are kept as they are, and a later sign-in in that slot replaces it.',
    inputSchema: slotShape,
  }, async (args) => call('account_remove', args, async () => ({ removed: await accounts.remove(refOf(args)) }), (out) => {
    const removed = out.removed as { provider: string; slot: number; accountId?: string }
    return `freed slot ${removed.slot} of ${removed.provider}${removed.accountId ? ` (was ${removed.accountId})` : ''}`
  }))
  ctx.mcp.tool('account_agents', {
    scope: 'operator',
    description: 'Operator tool: list agent accounts (ADR-0051): each enrollment slot with its account id, masked hint, status and why, home, and the Workers that run there; and each runtime with its slots, how many are taken, and whether it can read identity.',
    inputSchema: {},
  }, async (args) => call('account_agents', args, async () => ({
    accounts: accounts.list().map((account) => ({ account, workers: accounts.workersIn(account) })),
    providers: accounts.providers(),
  }), outline))
  ctx.mcp.tool('account_migrate', {
    scope: 'operator',
    description: 'Operator tool: the move from hand-named agent Workers to Workers derived as account × role (PROP-0012 phase F). By default it only plans: the roles, assignments, and provider settings of the new agent-workers row, the pool templates for the resources row, each old Worker\'s new id, and what stops the move. apply records each move and the cutover as enrollment decisions and moves the old Workers\' agent sessions and runs to their new ids; from then on the hand-named rows are refused at load (drain first: refused while one of their runs is queued or running). rollback undoes it. stop: runtimes whose Workers stop at the cutover because their account is not ready.',
    inputSchema: {
      apply: zod.boolean().optional().describe('Apply the move (recorded; the hand-named rows are refused from then on)'),
      rollback: zod.boolean().optional().describe('Undo an applied move: sessions and runs moved back, the hand-named rows load again'),
      stop: zod.array(zod.string().max(64)).max(64).optional().describe('Runtimes whose Workers stop at the cutover, their account not ready'),
    },
  }, async (args) => call('account_migrate', args, async () => migrator.migrate({
    apply: args.apply === true, rollback: args.rollback === true, stop: Array.isArray(args.stop) ? args.stop.map(String) : [],
  }), (out) => {
    const plan = out.plan as { workers: Array<{ from: string; to?: string; why: string }>; blockers: string[] }
    return [
      `${out.outcome}:`,
      ...plan.workers.map((w) => `  ${w.from} -> ${w.to ?? 'stops'} (${w.why})`),
      ...plan.blockers.map((b) => `  refused: ${b}`),
    ].join('\n')
  }))
}
