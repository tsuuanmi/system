/**
 * Encrypted `ctx.credentials` provider (ADR-0017, docs/research/dsh-community-plugins-review.md).
 * DSH's `dsh-credentials-local` keeps secrets as plain YAML; this provider keeps the same
 * seam but seals the whole document with AES-256-GCM. The key is a 32-byte owner-only file —
 * point `keyFile` at a systemd credential (`$CREDENTIALS_DIRECTORY/<name>`) or another
 * disk to separate key and ciphertext.
 * @module @tsuuanmi/system-credentials-vault
 */
import { dirname, join } from 'node:path'
import { type Context } from '@deepseek-ai/cordis'
import {
  CredentialProvider, parseCredentialKey,
  type CredentialInfo, type CredentialKey, type CredentialRecord, type CredentialRecordEntry,
  type CredentialRecordInfo, type CredentialRef, type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { dshHome, ensurePrivateDir, readOrCreateSecretFile } from '@tsuuanmi/system-libs'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { type VaultDocument, own, readVault, writeVault } from './vault-file.ts'

export { open, seal } from './vault-file.ts'

/** Own-property environment lookup: names like `constructor` are never inherited values. */
function envValue(ref: string): string | undefined {
  const value = Object.hasOwn(process.env, ref) ? process.env[ref] : undefined
  return typeof value === 'string' && value !== '' ? value : undefined
}

export interface Config {
  /** Encrypted vault file; defaults to `<DSH_HOME>/system/vault.enc`. */
  path?: string
  /** How long a writer waits for the cross-process lock, in milliseconds (default 30 s; mutations may do network refreshes). */
  lockWaitMs?: number
  /** 32-byte key file (created 0600 when absent); defaults to `<DSH_HOME>/system/vault.key`. */
  keyFile?: string
}

export class VaultCredentialProvider extends CredentialProvider {
  static Config: z<Config> = z.object({
    path: z.string().description('Encrypted vault file; defaults to <DSH_HOME>/system/vault.enc'),
    keyFile: z.string().description('32-byte owner-only key file; defaults to <DSH_HOME>/system/vault.key'),
    lockWaitMs: z.natural().default(30_000).description('Cross-process lock wait in milliseconds'),
  })

  readonly path: string
  private readonly key: Buffer
  private readonly lockWaitMs: number
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.path = config.path ?? join(dshHome(), 'system', 'vault.enc')
    this.lockWaitMs = config.lockWaitMs ?? 30_000
    ensurePrivateDir(dirname(this.path))
    this.key = readOrCreateSecretFile(config.keyFile ?? join(dshHome(), 'system', 'vault.key'), 32)
    ctx.effect(() => () => {
      this.closed = true
      this.key.fill(0)
    })
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const env = envValue(ref)
    if (env) return { value: env, source: 'env' }
    const stored = own(this.read().refs, ref)
    return stored ? { value: stored, source: 'vault' } : undefined
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (envValue(ref)) return { configured: true, source: 'env', writable: false }
    const configured = Boolean(own(this.read().refs, ref))
    return configured ? { configured, source: 'vault', writable: true } : { configured, writable: true }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    if (!value) throw new Error('vault: refusing an empty value; use unset')
    this.assertNotShadowed(ref)
    await this.mutate((document) => {
      document.refs[ref] = value
    })
    this.notifyUpdated(ref)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.assertNotShadowed(ref)
    await this.mutate((document) => {
      delete document.refs[ref]
    })
    this.notifyUpdated(ref)
  }

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return own(this.read().records, key) as CredentialRecord | undefined
  }

  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = own(this.read().records, key) as CredentialRecord | undefined
    return record ? { configured: true, kind: record.kind, writable: true } : { configured: false, writable: true }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Object.entries(this.read().records).map(([key, record]) => ({ key: parseCredentialKey(key), kind: (record as CredentialRecord).kind }))
  }

  /**
   * Serialized read-modify-write holding the cross-process lock across the async
   * `mutate` (seam contract): `mutate` runs once per call and always sees the committed
   * state, so a rotating refresh token is never spent twice.
   */
  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    let changed = false
    const result = await this.serialized(() =>
      withFileLock(this.path, async () => {
        const document = this.read()
        const current = own(document.records, key) as CredentialRecord | undefined
        const next = await mutate(current)
        if (next === undefined) return current
        document.records[key] = JSON.parse(JSON.stringify(next)) as unknown
        writeVault(this.path, document, this.key)
        changed = true
        return next
      }, { waitMs: this.lockWaitMs }),
    )
    if (changed) this.notifyRecordUpdated(key)
    return result
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    let existed = false
    await this.mutate((document) => {
      existed = key in document.records
      delete document.records[key]
    })
    if (existed) this.notifyRecordUpdated(key)
  }

  private read(): VaultDocument {
    if (this.closed) throw new Error('vault: provider is disposed')
    return readVault(this.path, this.key)
  }

  private assertNotShadowed(ref: CredentialRef): void {
    if (envValue(ref)) throw new Error(`vault: ${ref} is set in the launch environment, which shadows the vault`)
  }

  private mutate(apply: (document: VaultDocument) => void): Promise<void> {
    return this.serialized(() =>
      withFileLock(this.path, async () => {
        const document = this.read()
        apply(document)
        writeVault(this.path, document, this.key)
      }, { waitMs: this.lockWaitMs }),
    )
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }
}

export default VaultCredentialProvider
