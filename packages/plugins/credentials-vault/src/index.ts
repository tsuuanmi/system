/**
 * Encrypted `ctx.credentials` provider (ADR-0017, docs/research/dsh-community-plugins-review.md).
 * DSH's `dsh-credentials-local` keeps secrets as plain YAML; this provider keeps the same
 * seam but seals the whole document with AES-256-GCM. The key is a 32-byte 0600 file —
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
import { type VaultDocument, readVault, withFileLock, writeVault } from './vault-file.ts'

export { open, seal } from './vault-file.ts'

export interface Config {
  /** Encrypted vault file; defaults to `<DSH_HOME>/system/vault.enc`. */
  path?: string
  /** 32-byte key file (created 0600 when absent); defaults to `<DSH_HOME>/system/vault.key`. */
  keyFile?: string
}

export class VaultCredentialProvider extends CredentialProvider {
  static Config: z<Config> = z.object({
    path: z.string().description('Encrypted vault file; defaults to <DSH_HOME>/system/vault.enc'),
    keyFile: z.string().description('32-byte 0600 key file; defaults to <DSH_HOME>/system/vault.key'),
  })

  readonly path: string
  private readonly lockPath: string
  private readonly key: Buffer
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.path = config.path ?? join(dshHome(), 'system', 'vault.enc')
    this.lockPath = `${this.path}.lock`
    ensurePrivateDir(dirname(this.path))
    this.key = readOrCreateSecretFile(config.keyFile ?? join(dshHome(), 'system', 'vault.key'), 32)
    ctx.effect(() => () => {
      this.closed = true
      this.key.fill(0)
    })
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const env = process.env[ref]
    if (env) return { value: env, source: 'env' }
    const stored = this.read().refs[ref]
    return stored ? { value: stored, source: 'vault' } : undefined
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (process.env[ref]) return { configured: true, source: 'env', writable: false }
    const configured = Boolean(this.read().refs[ref])
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
    return this.read().records[key] as CredentialRecord | undefined
  }

  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.read().records[key] as CredentialRecord | undefined
    return record ? { configured: true, kind: record.kind, writable: true } : { configured: false, writable: true }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Object.entries(this.read().records).map(([key, record]) => ({ key: parseCredentialKey(key), kind: (record as CredentialRecord).kind }))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    let changed = false
    const result = await this.serialized(async () => {
      // The mutation is async, so it runs before taking the file lock; the lock then
      // re-reads and refuses to commit over a concurrent write to the same record.
      for (let attempt = 0; attempt < 16; attempt++) {
        const before = this.read().records[key] as CredentialRecord | undefined
        const next = await mutate(before)
        if (next === undefined) return before
        const committed = await withFileLock(this.lockPath, () => {
          const document = this.read()
          if (JSON.stringify(document.records[key]) !== JSON.stringify(before)) return false
          document.records[key] = JSON.parse(JSON.stringify(next)) as unknown
          writeVault(this.path, document, this.key)
          return true
        })
        if (committed) {
          changed = true
          return next
        }
      }
      throw new Error(`vault: ${key} kept changing concurrently; giving up`)
    })
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
    if (process.env[ref]) throw new Error(`vault: ${ref} is set in the launch environment, which shadows the vault`)
  }

  private mutate(apply: (document: VaultDocument) => void): Promise<void> {
    return this.serialized(() =>
      withFileLock(this.lockPath, () => {
        const document = this.read()
        apply(document)
        writeVault(this.path, document, this.key)
      }),
    )
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }
}

export default VaultCredentialProvider
