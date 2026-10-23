/**
 * The operator's agent account tools (PROP-0012 phase E, ADR-0051), operator scope: `account_enroll`
 * (take a slot and get its sign-in command, then verify who signed in), `account_remove` (free a
 * slot), and `account_agents` (every slot and what it holds). Input and output are checked against
 * `mcp-agent-accounts@1.0` (ADR-0037); nothing in them holds a principal or a token (INV-8).
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import zod from 'zod'
import type { AgentAccounts, SlotRef } from './accounts.ts'

const TAG = 'mcp-agent-accounts@1.0'
const schemas = new SchemaRegistry()

const refused = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

/** One call: its input checked, the work done, its output checked; a refusal does nothing more. */
async function call(tool: string, args: Record<string, unknown>, work: () => Promise<Record<string, unknown>>, text: (out: Record<string, unknown>) => string) {
  const def = tool.replaceAll('_', '-')
  try {
    schemas.assertDef(TAG, `${def}-input`, args)
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
    schemas.assertDef(TAG, `${def}-output`, out)
  } catch (error) {
    return refused(`${tool} made an output its schema refuses (a defect): ${(error as Error).message}`)
  }
  return { content: [{ type: 'text' as const, text: text(out) }], structuredContent: out }
}

const refOf = (args: Record<string, unknown>): SlotRef => (typeof args.accountId === 'string'
  ? { accountId: args.accountId }
  : { provider: String(args.provider), ...(typeof args.slot === 'number' ? { slot: args.slot } : {}) })

export function registerAccountTools(ctx: Context, accounts: AgentAccounts): void {
  const slotShape = {
    provider: zod.string().max(64).optional().describe('An agent runtime kind, for example codex-sdk'),
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
  }), (out) => JSON.stringify(out)))
}
