/**
 * `ctx.accounts`: the provider-agnostic, multi-account vault (docs/design/browser-runtime.md
 * #accounts-ctxaccounts-provider-agnostic-multi-account). The catalog is configuration;
 * each account's record (`account@1.0`, including portable browser state) and its login
 * credentials are separate **encrypted** grant records in `ctx.credentials`. Upper layers
 * receive secret-free views only (INV-8); `portableState` and `credentials` exist for the
 * provider runtime alone.
 * @module @tsuuanmi/system-accounts
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import { type CredentialKey, type CredentialRecord, credentialKey } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { type AccountSetting, accountSettings, ASSIGNED, type ContentId, DESCRIPTION, MAX_DESCRIPTION, type PooledTerms, type ProviderAccounts, SchemaRegistry } from '@tsuuanmi/system-libs'
import { type PortableState, ProviderError, type Tier } from '@tsuuanmi/system-provider-core'

export type { PortableState }

declare module '@deepseek-ai/cordis' {
  interface Context {
    accounts: Accounts
  }
}

export type QuotaClass = 'subscription-chat' | 'agent-plan' | 'metered' | 'local'
export type AccountStatus = 'new' | 'ready' | 'reauth-required' | 'challenge' | 'disabled'
export type SignOutEvidence = 'login-url' | 'login-surface'

export interface CatalogEntry {
  id: string
  provider: string
  label?: string
  /** What its Workers are for, in the operator's words (`capability-descriptor@1.6`); each tier's Worker carries it with its tier. */
  description?: string
  quotaClass: QuotaClass
  /** Tier → provider mode, e.g. `{ economy: 'instant', frontier: 'pro' }` (purpose P4). */
  tiers: Partial<Record<Tier, string>>
}

export interface LoginCredentials {
  email: string
  password: string
  totpSecret?: string
}

/** What routing, gateways, and operators may see: no state, no credentials. */
export interface AccountView extends Omit<CatalogEntry, 'label'> {
  label?: string
  status: AccountStatus
  loginMode: 'manual' | 'credentials'
  revision: number
  verifiedAt?: string
  statusEvidence?: string
  /** Website features a probe proved on this account (REQ-PRV-7), and when. */
  features?: { names: string[]; provedAt: string }
}

interface AccountRecord {
  schema: 'account@1.0' | 'account@1.1'
  accountId: string
  provider: string
  status: AccountStatus
  login?: { mode: 'manual' | 'credentials'; credentialRef?: string; codeProviders?: ('totp-local' | 'manual' | 'imap')[] }
  identityHash?: ContentId
  verifiedAt?: string
  statusEvidence?: string
  state?: PortableState
  features?: { names: string[]; provedAt: string }
  revision: number
  updatedAt: string
}

const ID = /^[a-z][a-z0-9-]*$/

export interface Config {
  accounts: CatalogEntry[]
  /**
   * How each website provider's accounts are used (ADR-0052, ADR-0055): `assigned` (the default) or
   * `pooled`, which needs `pooledTerms`, the operator's recorded decision. A provider no entry names
   * is assigned.
   */
  providers?: ProviderAccounts[]
}

export class Accounts extends Service {
  static inject = ['credentials']
  static Config: z<Config> = z.object({
    accounts: z.array(z.object({
      id: z.string().pattern(ID).required(),
      provider: z.string().pattern(ID).required(),
      label: z.string(),
      description: z.string().max(MAX_DESCRIPTION).pattern(DESCRIPTION).description('What its Workers are for, in your words: plain text on one line, at most 200 characters; each tier\'s Worker shows it with its tier on the roster (never a routing input)'),
      quotaClass: z.union(['subscription-chat', 'agent-plan', 'metered', 'local']).required(),
      tiers: z.dict(z.string()).default({}).description('Tier → provider mode preset; each mapped tier is one Worker, an unmapped tier is never served'),
    })).default([]).description('Account catalog: any number of accounts per provider'),
    providers: z.array(z.object({
      provider: z.string().pattern(ID).required().description('The website provider: the provider of its catalog accounts (its driver kind)'),
      accounts: z.union(['assigned', 'pooled']).default('assigned').description('assigned (the default): a limit on one account never moves its work to another account of this provider, the work waits; pooled: only with pooledTerms'),
      // Not z.object: an omitted object would come back as {}; checked when loaded.
      pooledTerms: z.any().description('{confirmedBy, confirmedAt, terms}: the operator\'s decision to pool this provider\'s accounts: who decided, when (ISO time), and which terms on what basis (that they allow it, or, for a personal subscription, that the operator accepts the risk); required for pooled (ADR-0055)'),
    })).default([]).description('How each website provider\'s accounts are used; a provider not listed is assigned (ADR-0052)'),
  }) as unknown as z<Config>

  private readonly catalog = new Map<string, CatalogEntry>()
  private readonly settings: Map<string, AccountSetting>
  private readonly schemas = new SchemaRegistry()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'accounts')
    for (const entry of config.accounts ?? []) {
      if (!ID.test(entry.id)) throw new ProviderError('config_error', `account id ${entry.id} must match ${ID}`)
      if (this.catalog.has(entry.id)) throw new ProviderError('config_error', `duplicate account id ${entry.id}`)
      if (entry.description !== undefined && (typeof entry.description !== 'string' || !DESCRIPTION.test(entry.description))) {
        throw new ProviderError('config_error', `account ${entry.id}: description must be plain text on one line, 1 to ${MAX_DESCRIPTION} characters`)
      }
      this.catalog.set(entry.id, entry)
    }
    try {
      this.settings = accountSettings(config.providers, 'accounts.providers')
    } catch (error) {
      throw new ProviderError('config_error', (error as Error).message)
    }
  }

  /** How a provider's accounts are used (ADR-0052): its configured setting, else assigned. */
  setting(provider: string): AccountSetting {
    return this.settings.get(provider) ?? ASSIGNED
  }

  /** Every provider configured `pooled`, with the terms its operator recorded. */
  pooled(): Array<{ provider: string; pooledTerms: PooledTerms }> {
    return [...this.settings].flatMap(([provider, s]) => (s.mode === 'pooled' && s.pooledTerms ? [{ provider, pooledTerms: s.pooledTerms }] : []))
  }

  async list(): Promise<AccountView[]> {
    return Promise.all([...this.catalog.keys()].map((id) => this.get(id)))
  }

  async get(id: string): Promise<AccountView> {
    return this.view(this.entry(id), await this.record(id))
  }

  /** Save verified portable state after a login (provider runtime only); the account becomes ready. */
  /**
   * Store a verified sign-in. With `sameIdentity` (an unattended credential relogin), a sign-in as
   * a different account than the one saved is refused and nothing is stored: stored credentials
   * may have been changed by a client, and only the operator, at the remote login, may switch.
   */
  async saveState(id: string, input: { state: PortableState; identityHash: ContentId; verifiedAt: string }, expectedRevision?: number, options: { sameIdentity?: boolean } = {}): Promise<AccountView> {
    return this.mutate(id, expectedRevision, ({ statusEvidence: _cleared, ...current }) => {
      if (options.sameIdentity && current.identityHash && current.identityHash !== input.identityHash) {
        throw new ProviderError('reauth_required', `account ${id}: the sign-in is a different account than the one saved; nothing was saved (sign in at the remote login to switch)`)
      }
      return { ...current, status: 'ready', state: input.state, identityHash: input.identityHash, verifiedAt: input.verifiedAt }
    })
  }

  /**
   * Write back the browser state refreshed during a turn (rotated cookies). Only a ready
   * account, only at the revision the turn started from; identity and verification stay.
   */
  async refreshState(id: string, state: PortableState, expectedRevision: number): Promise<AccountView> {
    return this.mutate(id, expectedRevision, (current) => {
      if (current.status !== 'ready') throw new ProviderError('reauth_required', `account ${id} is ${current.status}; its state is not refreshed`)
      return { ...current, state }
    })
  }

  /** Only positive sign-out evidence may mark an account reauth-required (REQ-ACC-5). */
  async markSignedOut(id: string, evidence: SignOutEvidence, expectedRevision: number): Promise<AccountView> {
    if (evidence !== 'login-url' && evidence !== 'login-surface') throw new ProviderError('invalid_input', 'sign-out requires positive evidence (login-url or login-surface)')
    return this.mutate(id, expectedRevision, (current) => ({ ...current, status: 'reauth-required', statusEvidence: evidence }))
  }

  /**
   * A signed-out mark the stored state disproves (a false positive): the account is ready again,
   * verified now, with its state and identity unchanged. The caller has just signed in with the
   * stored state as the same identity; nothing is saved or written back here.
   */
  async reverify(id: string, identityHash: ContentId, expectedRevision: number): Promise<AccountView> {
    return this.mutate(id, expectedRevision, ({ statusEvidence: _cleared, ...current }) => {
      if (current.status !== 'reauth-required') throw new ProviderError('invalid_input', `account ${id} is ${current.status}, not reauth-required`)
      if (current.identityHash !== identityHash) throw new ProviderError('reauth_required', `account ${id}: the stored state signs in as a different account than the one saved`)
      return { ...current, status: 'ready', verifiedAt: new Date().toISOString() }
    })
  }

  /** A challenge needs the operator but is not a sign-out: the state is kept. */
  async markChallenge(id: string, evidence: string, expectedRevision?: number): Promise<AccountView> {
    return this.mutate(id, expectedRevision, (current) => ({ ...current, status: 'challenge', statusEvidence: evidence.slice(0, 200) }))
  }

  /** Store login credentials (encrypted, separate record) and switch the account to credential login. */
  async setCredentials(id: string, credentials: LoginCredentials): Promise<AccountView> {
    this.entry(id)
    if (!credentials.email || !credentials.password) throw new ProviderError('invalid_input', 'email and password are required')
    await this.ctx.credentials.modifyRecord(this.credentialsKey(id), async () => ({ kind: 'grant', payload: { ...credentials } }))
    return this.mutate(id, undefined, (current) => ({
      ...current, login: { mode: 'credentials', credentialRef: this.credentialsKey(id), codeProviders: credentials.totpSecret ? ['totp-local', 'manual'] : ['manual'] },
    }))
  }

  /** Provider runtime only: the portable browser state of a ready account. */
  /** Record which website features a probe proved on the account (REQ-PRV-7). */
  async setFeatures(id: string, names: readonly string[], provedAt: string = new Date().toISOString()): Promise<AccountView> {
    return this.mutate(id, undefined, (current) => ({ ...current, features: { names: [...new Set(names)].sort(), provedAt } }))
  }

  async portableState(id: string): Promise<PortableState | undefined> {
    this.entry(id)
    return (await this.record(id))?.state
  }

  /** Provider runtime only: login credentials, decrypted in memory. */
  async credentials(id: string): Promise<LoginCredentials | undefined> {
    this.entry(id)
    const record = await this.ctx.credentials.readRecord(this.credentialsKey(id))
    return record?.kind === 'grant' ? (record.payload as LoginCredentials) : undefined
  }

  /** Groups of account ids whose identity hashes collide (REQ-ACC-7, REQ-TEAM-4). */
  async duplicateIdentities(): Promise<string[][]> {
    const byIdentity = new Map<string, string[]>()
    for (const id of this.catalog.keys()) {
      const identity = (await this.record(id))?.identityHash
      if (identity) byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), id])
    }
    return [...byIdentity.values()].filter((ids) => ids.length > 1)
  }

  private entry(id: string): CatalogEntry {
    const entry = this.catalog.get(id)
    if (!entry) throw new ProviderError('invalid_input', `unknown account ${id}`)
    return entry
  }

  private recordKey(id: string): CredentialKey {
    return credentialKey('system-accounts', id)
  }

  private credentialsKey(id: string): CredentialKey {
    return credentialKey('system-credentials', id)
  }

  private async record(id: string): Promise<AccountRecord | undefined> {
    const stored = await this.ctx.credentials.readRecord(this.recordKey(id))
    return stored?.kind === 'grant' ? (stored.payload as AccountRecord) : undefined
  }

  private async mutate(id: string, expectedRevision: number | undefined, change: (current: AccountRecord) => AccountRecord): Promise<AccountView> {
    const entry = this.entry(id)
    const written = await this.ctx.credentials.modifyRecord(this.recordKey(id), async (stored: CredentialRecord | undefined) => {
      const current: AccountRecord = stored?.kind === 'grant'
        ? (stored.payload as AccountRecord)
        : { schema: 'account@1.0', accountId: id, provider: entry.provider, status: 'new', revision: 0, updatedAt: new Date().toISOString() }
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new ProviderError('reconciliation_failed', `account ${id}: expected revision ${expectedRevision}, found ${current.revision}`)
      }
      const next = JSON.parse(JSON.stringify({ ...change(current), schema: 'account@1.1', revision: current.revision + 1, updatedAt: new Date().toISOString() })) as AccountRecord
      this.schemas.assertRecord(next)
      return { kind: 'grant', payload: next }
    })
    return this.view(entry, (written as { payload: AccountRecord }).payload)
  }

  private view(entry: CatalogEntry, record: AccountRecord | undefined): AccountView {
    return {
      id: entry.id, provider: entry.provider, quotaClass: entry.quotaClass, tiers: entry.tiers,
      ...(entry.label !== undefined && { label: entry.label }),
      ...(entry.description !== undefined && { description: entry.description }),
      status: record?.status ?? 'new',
      loginMode: record?.login?.mode ?? 'manual',
      revision: record?.revision ?? 0,
      ...(record?.verifiedAt !== undefined && { verifiedAt: record.verifiedAt }),
      ...(record?.statusEvidence !== undefined && { statusEvidence: record.statusEvidence }),
      ...(record?.features !== undefined && { features: record.features }),
    }
  }
}

export default Accounts
