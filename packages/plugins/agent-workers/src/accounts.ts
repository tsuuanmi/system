/**
 * Agent accounts (PROP-0012 phase E, ADR-0051): each runtime's enrollment slots, the account signed
 * in to each slot's home, and its status. A slot is a home and nothing more; the account id comes
 * from the verified login, as a keyed hash (`<provider>:<h>`), never from a name, and the key is kept
 * in the credential vault. A principal that is missing, changed, ambiguous, shared with another slot,
 * or unread for want of a verified reader takes no work, and every change of what a slot holds is an
 * `enrollment` decision recorded before the record changes (INV-13). The principal itself never
 * reaches this module: only the runtime's keyed hash and a masked hint do (INV-8).
 *
 * Workers derived as account × role (phase F) take work only while their account is `ready`
 * ({@link AgentAccounts.accountGate}). Hand-named Workers, until the operator moves them, run in their
 * runtime's own home, which slot 1 adopts without moving it: the account enrolled there is the one
 * they run on, so they take work only while it is `ready`, or while it is `unverified` because the
 * runtime has no verified reader (as before enrollment, and never beyond slot 1); a home no slot
 * holds keeps the behaviour before enrollment.
 * @module
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { type CredentialProvider, type CredentialRecord, credentialKey } from '@deepseek-ai/dsh-credentials'
import { type AgentRuntimeProvider, type IdentityReading, type LoginCommand, accountIdOf, titleOf } from '@tsuuanmi/system-agent-runtime-core'
import { type ContentId, ensurePrivateDir, SchemaRegistry } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'

export type AccountStatus = 'enrolled' | 'ready' | 'signed-out' | 'quarantined'
export type QuarantineReason = 'changed' | 'ambiguous' | 'duplicate' | 'unverified'

/** One slot and the account signed in to its home (`agent-account@1.0`; `@1.1` with a quarantine's `detail`). */
export interface AgentAccount {
  schema: 'agent-account@1.0' | 'agent-account@1.1'
  accountId?: string
  provider: string
  slot: number
  home: string
  status: AccountStatus
  /** Why it takes no work: the reason, since when, its decision, and what the reading found (`detail`, `@1.1`). */
  quarantine?: { reason: QuarantineReason; since: string; decision: ContentId; detail?: string }
  identity?: { hmac: string; reader: string; runtimeVersion: string; verifiedAt: string }
  hint?: string
  revision: number
  updatedAt: string
}

/** Which slot a call is about: a provider's slot, or an account by its id. */
export type SlotRef = { provider: string; slot?: number | undefined } | { accountId: string }

/** What `begin` gives the operator: the slot, the runtime's own sign-in command for its home, and whether slot 1 adopted the runtime's existing home. */
export interface Begun {
  account: AgentAccount
  login: LoginCommand
  /** Slot 1 was just taken, and its home is the runtime's own, which already existed (the account the configured Workers run on now). */
  adopted: boolean
}

/** Whether the Workers that run in a home take work, as its enrolled account says. */
export type HomeGate = { state: 'ready' } | { state: 'unavailable'; why: string }
/** Whether an account's Workers take work: ready, with its record, or not, with why. */
export type AccountGate = { state: 'ready'; account: AgentAccount } | { state: 'unavailable'; why: string }

/** The store table of the slots (agent-workers migration 10). */
export const ACCOUNTS_MIGRATION = {
  version: 10,
  sql: `CREATE TABLE agent_accounts (
    provider TEXT NOT NULL, slot INTEGER NOT NULL, home TEXT NOT NULL UNIQUE, record TEXT NOT NULL, decision TEXT,
    PRIMARY KEY (provider, slot)
  );`,
}

/** The most slots one provider may have (`agent-account@1.0` slot bound; INV-9). */
export const MAX_SLOTS = 64
/** A provider's kind, as an account id's namespace (`agent-account@1.0` provider). */
const PROVIDER = /^[a-z][a-z0-9-]{0,63}$/
const ACCOUNT_ID = /^[a-z][a-z0-9-]{0,63}:[0-9a-f]{16}$/
const DECIDER = { type: 'rule' as const, id: 'agent-accounts.enrollment', version: '1' }
/** Where the per-install key of the account ids is kept in the vault. */
const KEY_RECORD = credentialKey('system-agent-workers', 'identity-key')
const KEY_BYTES = 32
const schemas = new SchemaRegistry()
const now = (): string => new Date().toISOString()
/** The most characters of a quarantine's `detail` (`agent-account@1.1`). */
const MAX_DETAIL = 300
/** One line of at most `max` characters (code points), cut with an ellipsis. */
const clip = (text: string, max: number): string => {
  const line = text.replace(/\p{Cc}+/gu, ' ').trim() || 'no reason was given'
  return [...line].length > max ? `${[...line].slice(0, max - 1).join('')}…` : line
}
/** A quarantine's reason, with what its reading found when the record says it (1.1). */
const quarantineText = (q: NonNullable<AgentAccount['quarantine']> | undefined): string => (q ? `${q.reason}${q.detail ? `: ${q.detail}` : ''}` : 'duplicate')

interface Row {
  provider: string
  slot: number
  home: string
  record: string
  decision: string | null
}

export interface AccountsOptions {
  /** How many slots a provider has: its configured `slots`, else 1 (its own home, adopted). */
  slots: (provider: string) => number
  /** Where homes of slot 2 and later go: `<root>/<provider>/<n>`. */
  root: string
  /** The configured Workers that run on a slot's account, for the listing. */
  workersIn: (account: AgentAccount) => string[]
  /** The operator's display label of an account, by its id (agent-workers `assignments[].label`); for people only. */
  labelOf?: (accountId: string) => string | undefined
  /** Why the last usage report of an account, by its id, could not be read, and when; none once one is read (ADR-0059). */
  unreadReport?: (accountId: string) => { why: string; at: string } | undefined
}

/** What one reading makes of a slot: its next status and why, and what it makes of the slots it collides with. */
interface Assessment {
  next: AgentAccount
  reason?: QuarantineReason
  why: string
  peers: Array<{ account: AgentAccount; reason: QuarantineReason; why: string }>
}

export class AgentAccounts {
  /** One enrollment change at a time per provider: a slot is never taken twice, and a pair of duplicates is judged together. */
  private readonly chains = new Map<string, Promise<unknown>>()
  private key: Uint8Array | undefined

  constructor(private readonly ctx: Context, private readonly options: AccountsOptions) {}

  /** Every slot taken, by provider and slot. */
  list(): AgentAccount[] {
    return (this.ctx.store.db.prepare('SELECT * FROM agent_accounts ORDER BY provider, slot').all() as unknown as Row[]).map((row) => JSON.parse(row.record) as AgentAccount)
  }

  /**
   * The providers that can be enrolled into: each registered runtime with its slots, how many are
   * taken, whether it reads identity and gives a sign-in command, and its title for people, when it
   * gives one.
   */
  providers(): Array<{ provider: string; slots: number; taken: number; identity: boolean; login: boolean; title?: string }> {
    const taken = this.list()
    return this.ctx.agentRuntimes.list().filter((kind) => PROVIDER.test(kind)).map((provider) => {
      const runtime = this.ctx.agentRuntimes.get(provider)
      const title = titleOf(runtime)
      return {
        provider, slots: this.options.slots(provider), taken: taken.filter((a) => a.provider === provider).length, identity: typeof runtime?.identity === 'function', login: typeof runtime?.loginCommand === 'function',
        ...(title !== undefined ? { title } : {}),
      }
    })
  }

  /** The configured Workers that run on this slot's account: those assigned to it, or, with hand-named rows, its runtime's when it is the runtime's own home. */
  workersIn(account: AgentAccount): string[] {
    return this.options.workersIn(account)
  }

  /** The operator's display label of this slot's account, when its assignment gives one; never a routing input. */
  labelOf(account: AgentAccount): string | undefined {
    return account.accountId ? this.options.labelOf?.(account.accountId) : undefined
  }

  /**
   * Why this slot's account's last usage report could not be read, and when, while no later one was
   * read (ADR-0059): the roster says it on a window with no reading yet, so the operator sees it.
   */
  unreadReport(account: AgentAccount): { why: string; at: string } | undefined {
    return account.accountId ? this.options.unreadReport?.(account.accountId) : undefined
  }

  /**
   * Whether the Workers derived for an account take work (PROP-0012 phase F, REQ-ACC-11): only while
   * one slot holds it and it is `ready`; otherwise not, with why, as health and `status` show it.
   */
  accountGate(accountId: string): AccountGate {
    const held = this.list().filter((a) => a.accountId === accountId)
    if (!held.length) return { state: 'unavailable', why: `the account ${accountId} is assigned, and no slot holds it: enroll it (system account login ${accountId.split(':')[0]}), or change its assignment` }
    const account = held[0]!
    if (held.length === 1 && account.status === 'ready') return { state: 'ready', account }
    const named = `${accountId} (slot ${held.map((a) => a.slot).join(' and ')} of ${account.provider})`
    const why = held.length > 1 || account.status === 'quarantined'
      ? `the account ${named} is quarantined (${quarantineText(account.quarantine)}): its Workers take no work until the operator resolves it (docs/operations/runbooks.md#resolve-a-quarantined-agent-account)`
      : account.status === 'signed-out'
        ? `the account ${named} is signed out: sign it in again (system account login ${accountId})`
        : `the account ${named} is ${account.status} and not verified: finish its sign-in (system account verify ${accountId})`
    return { state: 'unavailable', why }
  }

  /** The latest `enrollment` decision of the slot that holds an account, when one does. */
  decisionOf(accountId: string): ContentId | undefined {
    const row = this.list().find((a) => a.accountId === accountId)
    if (!row) return undefined
    const decision = this.ctx.store.db.prepare('SELECT decision FROM agent_accounts WHERE provider = ? AND slot = ?').get(row.provider, row.slot) as { decision: string | null } | undefined
    return (decision?.decision ?? undefined) as ContentId | undefined
  }

  /**
   * Take a slot for a sign-in, or name one taken for a sign-in again (ADR-0051). A provider alone takes
   * its lowest free slot; with a slot, that one, free or taken. A free slot's home is made owner-only
   * (slot 1's is the runtime's own home, adopted where it is), and an `enrollment` decision records it
   * `enrolled` before the slot is taken. A taken slot, or an account by its id, changes nothing: its
   * account is signed in again in its own home, and `verify` then requires the pinned principal.
   * Returns the runtime's own sign-in command for the home, which the operator runs in their terminal.
   * A runtime with no identity reader takes no free slot: its account could only ever be quarantined
   * `unverified`, and taking its own home would hold the Workers running there now (INV-2); nothing
   * is enrolled. `check` sees what a free slot's taking would return, before anything is made or
   * recorded: one that throws leaves the slot free.
   */
  begin(ref: SlotRef, check?: (begun: Begun) => void): Promise<Begun> {
    return this.serial(this.providerOf(ref), async () => {
      const taken = 'accountId' in ref || ref.slot !== undefined ? this.find(ref) : undefined
      const provider = taken?.provider ?? (ref as { provider: string }).provider
      const runtime = this.runtime(provider)
      if (typeof runtime.loginCommand !== 'function') throw new ProviderError('config_error', `${provider} gives no sign-in command for a home, so it cannot be enrolled`)
      if (taken) return { account: taken, login: runtime.loginCommand(taken.home), adopted: false }
      if ('accountId' in ref) throw new ProviderError('invalid_input', `no slot holds the account ${ref.accountId}`)
      if (typeof runtime.identity !== 'function') {
        throw new ProviderError('config_error', `${provider} has no verified way to read who is signed in (no identity reader), so an account of it could only be quarantined (unverified) and take no work; `
          + `taking a slot would also hold the Workers that run in ${provider}'s own home now. Nothing was enrolled: its Workers run as before until a reader is verified (PROP-0012 open question 1)`)
      }
      const slots = this.options.slots(provider)
      const used = new Set(this.list().filter((a) => a.provider === provider).map((a) => a.slot))
      const slot = ref.slot ?? Array.from({ length: slots }, (_, i) => i + 1).find((n) => !used.has(n))
      if (slot === undefined) {
        throw new ProviderError('invalid_input', `every slot of ${provider} is taken (${slots}): raise slots on its agent-workers providers entry, or free one (system account remove <accountId>)`)
      }
      if (slot < 1 || slot > slots) throw new ProviderError('invalid_input', `${provider} has slots 1 to ${slots}, not ${slot}`)
      const home = this.homeOf(runtime, slot)
      const clash = this.list().find((a) => a.home === home)
      if (clash) throw new ProviderError('config_error', `the home ${home} is already slot ${clash.slot} of ${clash.provider}; one home holds one account`)
      const adopted = slot === 1 && runtime.home === home && existsSync(home)
      const at = now()
      const account: AgentAccount = { schema: 'agent-account@1.0', provider, slot, home, status: 'enrolled', revision: 0, updatedAt: at }
      const begun: Begun = { account, login: runtime.loginCommand(home), adopted }
      check?.(begun)
      try {
        if (slot > 1) {
          ensurePrivateDir(this.options.root)
          ensurePrivateDir(join(this.options.root, provider))
        }
        ensurePrivateDir(home)
      } catch (error) {
        throw new ProviderError('config_error', `slot ${slot} of ${provider} cannot have its home ${home}: ${(error as Error).message}; nothing was enrolled`, { cause: error })
      }
      this.ctx.store.transaction(() => {
        const decision = this.decide(undefined, account, {
          option: 'enrolled', why: adopted ? `slot 1 of ${provider} adopts its runtime's own home ${home}, where it stays` : `slot ${slot} of ${provider} was free; its home is ${home}`,
        })
        this.write(account, decision, 'insert')
      })
      return begun
    })
  }

  /**
   * Read who is signed in to a slot's home and record what it is (ADR-0051): `ready` when the runtime
   * verifies a principal whole that no other slot of the provider holds and, if the slot had one
   * pinned, equal to it; `signed-out` when no one is; else quarantined `changed`, `ambiguous`,
   * `duplicate` (both slots), or `unverified`. `accept` takes a `changed` slot's new principal as a new
   * account (the old id keeps its history in the decisions). The operator's call: the only way a
   * quarantine or a sign-out is lifted. Each change is an `enrollment` decision first. `check` sees
   * the slot's record as it would be once the reading is recorded, before anything commits: one that
   * throws leaves every slot as it was.
   */
  verify(ref: SlotRef, options: { accept?: boolean; check?: (account: AgentAccount) => void } = {}): Promise<AgentAccount> {
    return this.serial(this.providerOf(ref), async () => {
      const current = this.find(ref)
      if (!current) throw new ProviderError('invalid_input', `${describeRef(ref)} holds no account: take a slot first (system account login <provider>)`)
      const runtime = this.runtime(current.provider)
      if (options.accept && !(current.status === 'quarantined' && current.quarantine?.reason === 'changed')) {
        throw new ProviderError('invalid_input', `slot ${current.slot} of ${current.provider} is ${current.status}${current.quarantine ? ` (${current.quarantine.reason})` : ''}, not quarantined as changed: there is no new principal to accept`)
      }
      const reading = await this.read(runtime, current.home)
      return this.apply(current, reading, { accept: options.accept === true, operator: true, ...(options.check ? { check: options.check } : {}) })
    })
  }

  /**
   * Free a slot (ADR-0051): its account is no longer enrolled, recorded first as an `enrollment`
   * decision. Its home and the sign-in in it stay where they are (nothing is deleted); a later sign-in
   * in that slot replaces it. A slot that held a duplicate's other half keeps its quarantine until the
   * operator verifies it again. `check` sees the record removed before anything commits: one that
   * throws leaves the slot taken.
   */
  remove(ref: SlotRef, check?: (removed: AgentAccount) => void): Promise<AgentAccount> {
    return this.serial(this.providerOf(ref), async () => {
      const current = this.find(ref)
      if (!current) throw new ProviderError('invalid_input', `${describeRef(ref)} holds no account`)
      return this.ctx.store.transaction(() => {
        this.decide(current, { ...current, revision: current.revision + 1 }, { option: 'removed', why: `the operator freed slot ${current.slot} of ${current.provider}; its home ${current.home} is kept as it is` })
        this.ctx.store.db.prepare('DELETE FROM agent_accounts WHERE provider = ? AND slot = ?').run(current.provider, current.slot)
        check?.(current)
        return current
      })
    })
  }

  /**
   * Read the `ready` accounts of a runtime again (at each probe, and before each run of a Worker in the
   * home): one that no longer reads as its pinned principal is quarantined or signed out, recorded
   * first. Never lifts anything: only the operator's `verify` does. `home` limits it to that home's.
   */
  recheck(provider: string, home?: string): Promise<void> {
    return this.serial(provider, async () => {
      const runtime = this.ctx.agentRuntimes.get(provider)
      if (!runtime) return
      for (const account of this.list().filter((a) => a.provider === provider && a.status === 'ready' && (home === undefined || a.home === home))) {
        let reading: IdentityReading
        try {
          reading = await this.read(runtime, account.home)
        } catch (error) {
          // No key to hash with (the vault is gone): its principal cannot be confirmed, so it is not ready (INV-2).
          reading = { status: 'unverified', reason: (error as Error).message.slice(0, 300) }
        }
        if (reading.status === 'verified' && reading.hmac === account.identity?.hmac) continue
        await this.apply(account, reading, { accept: false, operator: false })
      }
    })
  }

  /**
   * Whether the hand-named Workers of a runtime, which run in its own home, take work as the account
   * enrolled there says: yes when no slot holds that home (as before enrollment), when it is `ready`,
   * or when it is `unverified` (the runtime has no verified reader, so nothing better was known before
   * enrollment either); otherwise not, with why.
   */
  homeGate(provider: string): HomeGate {
    const home = this.ctx.agentRuntimes.get(provider)?.home
    if (home === undefined) return { state: 'ready' }
    const row = this.ctx.store.db.prepare('SELECT record FROM agent_accounts WHERE home = ?').get(home) as { record: string } | undefined
    if (!row) return { state: 'ready' }
    const account = JSON.parse(row.record) as AgentAccount
    if (account.status === 'ready' || (account.status === 'quarantined' && account.quarantine?.reason === 'unverified')) return { state: 'ready' }
    const named = account.accountId ? `${account.accountId} (slot ${account.slot} of ${account.provider})` : `slot ${account.slot} of ${account.provider}`
    const why = account.status === 'enrolled'
      ? `the account in ${provider}'s home, ${named}, is enrolled and not verified yet: finish its sign-in (system account login ${account.provider} --slot ${account.slot})`
      : account.status === 'signed-out'
        ? `the account in ${provider}'s home, ${named}, is signed out: sign it in again (system account login ${account.accountId ?? `${account.provider} --slot ${account.slot}`})`
        : `the account in ${provider}'s home, ${named}, is quarantined (${quarantineText(account.quarantine)}): it takes no work until the operator resolves it (docs/operations/runbooks.md#resolve-a-quarantined-agent-account)`
    return { state: 'unavailable', why }
  }

  /**
   * What one reading makes of a slot, recorded in one transaction: its own decision first, then each
   * peer's; `check` sees the slot's record before it commits, and one that throws rolls all of it back.
   */
  private async apply(current: AgentAccount, reading: IdentityReading, options: { accept: boolean; operator: boolean; check?: (account: AgentAccount) => void }): Promise<AgentAccount> {
    const others = this.list().filter((a) => a.provider === current.provider && a.slot !== current.slot)
    const assessed = assess(current, reading, others, now(), options.accept)
    // The periodic re-read only takes away: it never lifts a quarantine or a sign-out, nor makes a peer one.
    if (!options.operator && assessed.next.status === 'ready') return current
    return this.ctx.store.transaction(() => {
      const next = this.recorded(current, assessed.next, assessed.reason, assessed.why, reading)
      for (const peer of options.operator ? assessed.peers : []) {
        if (peer.account.status === 'quarantined' && peer.account.quarantine?.reason === peer.reason) continue
        this.recorded(peer.account, { ...peer.account, status: 'quarantined' }, peer.reason, peer.why)
      }
      options.check?.(next)
      return next
    })
  }

  /** Write `next` when it differs from `current` in what it holds, its decision recorded first; else keep `current`. */
  private recorded(current: AgentAccount, proposed: AgentAccount, reason: QuarantineReason | undefined, why: string, reading?: IdentityReading): AgentAccount {
    const same = proposed.status === current.status && proposed.accountId === current.accountId && proposed.identity?.hmac === current.identity?.hmac
      && reason === current.quarantine?.reason
    // Nothing it holds changed (a new masked hint alone is no decision): the record stays as it is.
    if (same) return current
    const at = now()
    const { quarantine: _, ...rest } = proposed
    const draft: AgentAccount = { ...rest, schema: 'agent-account@1.0', revision: current.revision + 1, updatedAt: at }
    const decision = this.decide(current, draft, { option: draft.status, why, ...(reason ? { reason } : {}), ...(reading ? { reading } : {}) })
    // A quarantine says what its reading found (1.1), so the operator reads the version found, not only `unverified`.
    const next: AgentAccount = reason
      ? { ...draft, schema: 'agent-account@1.1', quarantine: { reason, since: current.quarantine?.reason === reason ? current.quarantine.since : at, decision, detail: clip(why, MAX_DETAIL) } }
      : draft
    this.write(next, decision, 'update')
    if (next.status === 'quarantined' && (current.status !== 'quarantined' || current.quarantine?.reason !== reason)) this.quarantined(next, decision)
    return next
  }

  /**
   * One `agent-workers.account.quarantined` event for a slot newly quarantined, or quarantined for
   * another reason: the slot, its account id, the reason, and the Workers that now take no work,
   * never the principal or its hint. The event log is optional; a failed append is logged only.
   */
  private quarantined(account: AgentAccount, decision: ContentId): void {
    try {
      this.ctx.get('eventLog')?.append({
        type: 'agent-workers.account.quarantined', decision,
        data: { provider: account.provider, slot: account.slot, ...(account.accountId ? { accountId: account.accountId } : {}), reason: account.quarantine!.reason, workers: this.workersIn(account).slice(0, 32) },
      })
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: the quarantine event of slot ${account.slot} of ${account.provider} was not appended: ${(error as Error).message}`)
    }
  }

  /** The `enrollment` decision of one change to a slot (decision@1.8): the slot's earlier decision its input, never the principal. */
  private decide(before: AgentAccount | undefined, after: AgentAccount, change: { option: string; why: string; reason?: QuarantineReason; reading?: IdentityReading }): ContentId {
    const row = this.ctx.store.db.prepare('SELECT decision FROM agent_accounts WHERE provider = ? AND slot = ?').get(after.provider, after.slot) as { decision: string | null } | undefined
    const options = ['enrolled', 'ready', 'signed-out', 'quarantined', 'removed']
    const reader = change.reading?.reader ?? after.identity?.reader
    const version = change.reading?.runtimeVersion ?? after.identity?.runtimeVersion
    const decision = this.ctx.artifacts.recordDecision({
      schema: 'decision@1.8',
      decisionType: 'enrollment',
      question: `What is the account signed in to slot ${after.slot} of ${after.provider}?`,
      inputs: row?.decision ? [row.decision as ContentId] : [],
      candidates: options.filter((o) => o === change.option || (before ? o !== 'enrolled' : o === 'enrolled')).map((option) => ({
        option, selected: option === change.option, reasons: [option === change.option ? change.why : `not ${option}`],
      })),
      decider: DECIDER,
      outcome: {
        option: change.option,
        detail: {
          provider: after.provider, slot: after.slot, home: after.home, revision: after.revision, ...(after.accountId ? { accountId: after.accountId } : {}),
          ...(before?.accountId && before.accountId !== after.accountId ? { previousAccountId: before.accountId } : {}),
          ...(change.reason ? { reason: change.reason } : {}), ...(reader ? { reader } : {}), ...(version ? { runtimeVersion: version } : {}),
        },
      },
      deterministic: true,
      rationale: change.why,
    }, { producer: { type: 'system', ref: 'agent-workers' } })
    return decision.id as ContentId
  }

  private write(account: AgentAccount, decision: ContentId, how: 'insert' | 'update'): void {
    // A record its schema refuses is a defect: nothing is written (INV-14).
    schemas.assertRecord(account)
    if (how === 'insert') {
      this.ctx.store.db.prepare('INSERT INTO agent_accounts (provider, slot, home, record, decision) VALUES (?, ?, ?, ?, ?)').run(account.provider, account.slot, account.home, JSON.stringify(account), decision)
    } else {
      this.ctx.store.db.prepare('UPDATE agent_accounts SET record = ?, decision = ? WHERE provider = ? AND slot = ?').run(JSON.stringify(account), decision, account.provider, account.slot)
    }
  }

  /** Who is signed in to a home, as its runtime reads it with the install's key; a runtime with no reader reads `unverified`. */
  private async read(runtime: AgentRuntimeProvider, home: string): Promise<IdentityReading> {
    if (typeof runtime.identity !== 'function') return { status: 'unverified', reason: `${runtime.kind} has no verified way to read who is signed in (no identity reader)` }
    const key = await this.identityKey()
    try {
      return await runtime.identity(home, key)
    } catch (error) {
      // The seam says a reader never throws for a home it cannot read; one that does is not trusted.
      return { status: 'ambiguous', reason: `its identity reader failed: ${(error as Error).message.split('\n')[0]!.slice(0, 200)}` }
    }
  }

  /**
   * The per-install key of the account ids, kept in the credential vault and backed up with it: made
   * once, under the vault's lock, and never made again. No vault, or a key that is not 32 bytes, and
   * nothing is read (losing the key changes every id: ADR-0051).
   */
  private async identityKey(): Promise<Uint8Array> {
    if (this.key) return this.key
    const credentials = this.ctx.get('credentials') as CredentialProvider | undefined
    if (!credentials) throw new ProviderError('config_error', 'no credential vault (ctx.credentials) is loaded, so the key of the account ids cannot be kept; nothing was read')
    const record = await credentials.modifyRecord(KEY_RECORD, async (current: CredentialRecord | undefined) => (current
      ? undefined
      : { kind: 'grant', payload: { schema: 'agent-account-key@1', key: randomBytes(KEY_BYTES).toString('base64') } }))
    const encoded = record?.kind === 'grant' ? (record.payload as { key?: unknown } | null)?.key : undefined
    const key = typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : undefined
    if (!key || key.length !== KEY_BYTES) throw new ProviderError('config_error', `the key of the account ids in the vault (${KEY_RECORD}) is not ${KEY_BYTES} bytes; it is never replaced by itself, since every account id would change`)
    this.key = new Uint8Array(key)
    return this.key
  }

  private runtime(provider: string): AgentRuntimeProvider {
    if (!PROVIDER.test(provider)) throw new ProviderError('invalid_input', `${provider} cannot name an account namespace (a runtime kind of lowercase letters, digits, and hyphens)`)
    const runtime = this.ctx.agentRuntimes.get(provider)
    if (!runtime) throw new ProviderError('config_error', `no ${provider} runtime is registered (its row is off)`)
    return runtime
  }

  /** Slot 1 adopts the runtime's own home; any other slot, and slot 1 of a runtime that names none, is `<root>/<provider>/<n>`. */
  private homeOf(runtime: AgentRuntimeProvider, slot: number): string {
    return slot === 1 && runtime.home ? runtime.home : join(this.options.root, runtime.kind, String(slot))
  }

  private find(ref: SlotRef): AgentAccount | undefined {
    if ('accountId' in ref) {
      if (!ACCOUNT_ID.test(ref.accountId)) throw new ProviderError('invalid_input', `${ref.accountId} is not an agent account id (<provider>:<16 hex>)`)
      const held = this.list().filter((a) => a.accountId === ref.accountId)
      if (held.length > 1) throw new ProviderError('invalid_input', `${ref.accountId} is held by slots ${held.map((a) => a.slot).join(' and ')} of ${held[0]!.provider} (a duplicate): name the provider and the slot`)
      return held[0]
    }
    if (ref.slot === undefined) throw new ProviderError('invalid_input', `name a slot of ${ref.provider}`)
    const row = this.ctx.store.db.prepare('SELECT record FROM agent_accounts WHERE provider = ? AND slot = ?').get(ref.provider, ref.slot) as { record: string } | undefined
    return row ? JSON.parse(row.record) as AgentAccount : undefined
  }

  private providerOf(ref: SlotRef): string {
    return 'accountId' in ref ? ref.accountId.split(':')[0]! : ref.provider
  }

  private serial<T>(provider: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(provider) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.then(() => undefined, () => undefined)
    this.chains.set(provider, settled)
    void settled.then(() => {
      if (this.chains.get(provider) === settled) this.chains.delete(provider)
    })
    return next
  }
}

const describeRef = (ref: SlotRef): string => ('accountId' in ref ? `the account ${ref.accountId}` : `slot ${ref.slot ?? '?'} of ${ref.provider}`)

/**
 * What a reading makes of a slot (a pure rule, `agent-accounts.enrollment` version 1). A pinned
 * principal stays on the record when it is no longer read, so the operator sees which account the
 * slot should hold. Peers: the other slots of the provider that hold the same principal (`duplicate`)
 * or another principal under the same short id (`ambiguous`), each quarantined with it.
 */
export function assess(current: AgentAccount, reading: IdentityReading, others: readonly AgentAccount[], at: string, accept: boolean): Assessment {
  const base: AgentAccount = { ...current }
  delete base.quarantine
  const slot = `slot ${current.slot} of ${current.provider}`
  if (reading.status !== 'verified') {
    if (reading.status === 'missing') return { next: { ...base, status: 'signed-out' }, why: `${slot} is not signed in: ${reading.reason}`, peers: [] }
    if (reading.status === 'unverified') return { next: { ...base, status: 'quarantined' }, reason: 'unverified', why: `${slot} cannot be verified: ${reading.reason}`, peers: [] }
    return { next: { ...base, status: 'quarantined' }, reason: 'ambiguous', why: `${slot}'s principal cannot be read whole: ${reading.reason}`, peers: [] }
  }
  const accountId = accountIdOf(current.provider, reading.hmac)
  const pinned = current.identity?.hmac
  if (pinned && pinned !== reading.hmac && !accept) {
    return { next: { ...base, status: 'quarantined' }, reason: 'changed', why: `${slot} now signs in as another principal than its account ${current.accountId ?? '(unnamed)'}`, peers: [] }
  }
  const verified: AgentAccount = { ...base, accountId, identity: { hmac: reading.hmac, reader: reading.reader, runtimeVersion: reading.runtimeVersion, verifiedAt: at } }
  if (reading.hint !== undefined) verified.hint = reading.hint
  else delete verified.hint
  const same = others.filter((o) => o.identity?.hmac === reading.hmac)
  if (same.length) {
    const why = `${same.map((o) => `slot ${o.slot}`).join(' and ')} and slot ${current.slot} of ${current.provider} resolve to one principal, so none of them takes work until the operator resolves it`
    return { next: { ...verified, status: 'quarantined' }, reason: 'duplicate', why, peers: same.map((account) => ({ account, reason: 'duplicate', why })) }
  }
  const collide = others.filter((o) => o.accountId === accountId)
  if (collide.length) {
    const why = `slot ${current.slot} and ${collide.map((o) => `slot ${o.slot}`).join(' and ')} of ${current.provider} hold different principals under one account id ${accountId}`
    return { next: { ...verified, status: 'quarantined' }, reason: 'ambiguous', why, peers: collide.map((account) => ({ account, reason: 'ambiguous', why })) }
  }
  return { next: { ...verified, status: 'ready' }, why: `${slot} signs in as ${accountId}${pinned && pinned !== reading.hmac ? ', accepted by the operator as a new account' : ''}, verified by ${reading.reader} on ${reading.runtimeVersion}`, peers: [] }
}
