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
import { type ContentId, SchemaRegistry } from '@tsuuanmi/system-libs'
import { ProviderError, type Tier } from '@tsuuanmi/system-provider-core'

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
  quotaClass: QuotaClass
  /** Tier → provider mode, e.g. `{ economy: 'instant', frontier: 'pro' }` (purpose P4). */
  tiers: Partial<Record<Tier, string>>
}

export interface PortableState {
  origins: string[]
  cookies: Record<string, unknown>[]
  localStorage?: Record<string, unknown>[]
  indexedDB?: { status: 'captured' | 'kept-previous' | 'absent'; data?: Record<string, unknown>[] }
  capturedAt: string
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
}

interface AccountRecord {
  schema: 'account@1.0'
  accountId: string
  provider: string
  status: AccountStatus
  login?: { mode: 'manual' | 'credentials'; credentialRef?: string; codeProviders?: ('totp-local' | 'manual' | 'imap')[] }
  identityHash?: ContentId
  verifiedAt?: string
  statusEvidence?: string
  state?: PortableState
  revision: number
  updatedAt: string
}

const ID = /^[a-z][a-z0-9-]*$/

export interface Config {
  accounts: CatalogEntry[]
}

export class Accounts extends Service {
  static inject = ['credentials']
  static Config: z<Config> = z.object({
    accounts: z.array(z.object({
      id: z.string().pattern(ID).required(),
      provider: z.string().pattern(ID).required(),
      label: z.string(),
      quotaClass: z.union(['subscription-chat', 'agent-plan', 'metered', 'local']).required(),
      tiers: z.dict(z.string()).default({}),
    })).default([]).description('Account catalog: any number of accounts per provider'),
  }) as unknown as z<Config>

  private readonly catalog = new Map<string, CatalogEntry>()
  private readonly schemas = new SchemaRegistry()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'accounts')
    for (const entry of config.accounts ?? []) {
      if (!ID.test(entry.id)) throw new ProviderError('config_error', `account id ${entry.id} must match ${ID}`)
      if (this.catalog.has(entry.id)) throw new ProviderError('config_error', `duplicate account id ${entry.id}`)
      this.catalog.set(entry.id, entry)
    }
  }

  async list(): Promise<AccountView[]> {
    return Promise.all([...this.catalog.keys()].map((id) => this.get(id)))
  }

  async get(id: string): Promise<AccountView> {
    return this.view(this.entry(id), await this.record(id))
  }

  /** Save verified portable state after a login (provider runtime only); the account becomes ready. */
  async saveState(id: string, input: { state: PortableState; identityHash: ContentId; verifiedAt: string }, expectedRevision?: number): Promise<AccountView> {
    return this.mutate(id, expectedRevision, (current) => ({
      ...current, status: 'ready', state: input.state, identityHash: input.identityHash, verifiedAt: input.verifiedAt, statusEvidence: undefined,
    }))
  }

  /** Only positive sign-out evidence may mark an account reauth-required (REQ-ACC-5). */
  async markSignedOut(id: string, evidence: SignOutEvidence, expectedRevision: number): Promise<AccountView> {
    if (evidence !== 'login-url' && evidence !== 'login-surface') throw new ProviderError('invalid_input', 'sign-out requires positive evidence (login-url or login-surface)')
    return this.mutate(id, expectedRevision, (current) => ({ ...current, status: 'reauth-required', statusEvidence: evidence }))
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
      const next = JSON.parse(JSON.stringify({ ...change(current), revision: current.revision + 1, updatedAt: new Date().toISOString() })) as AccountRecord
      this.schemas.assertRecord(next)
      return { kind: 'grant', payload: next }
    })
    return this.view(entry, (written as { payload: AccountRecord }).payload)
  }

  private view(entry: CatalogEntry, record: AccountRecord | undefined): AccountView {
    return {
      id: entry.id, provider: entry.provider, quotaClass: entry.quotaClass, tiers: entry.tiers,
      ...(entry.label !== undefined && { label: entry.label }),
      status: record?.status ?? 'new',
      loginMode: record?.login?.mode ?? 'manual',
      revision: record?.revision ?? 0,
      ...(record?.verifiedAt !== undefined && { verifiedAt: record.verifiedAt }),
      ...(record?.statusEvidence !== undefined && { statusEvidence: record.statusEvidence }),
    }
  }
}

export default Accounts
