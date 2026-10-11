import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const AAD = Buffer.from('system-vault:v1')

/** The decrypted vault contents. */
export interface VaultDocument {
  refs: Record<string, string>
  records: Record<string, unknown>
}

interface VaultFile {
  format: 'system-vault'
  version: 1
  cipher: 'aes-256-gcm'
  nonce: string
  tag: string
  data: string
}

export const emptyDocument = (): VaultDocument => ({ refs: {}, records: {} })

/** Encrypt a document with AES-256-GCM under a fresh 96-bit nonce. */
export function seal(document: VaultDocument, key: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(AAD)
  const data = Buffer.concat([cipher.update(JSON.stringify(document), 'utf8'), cipher.final()])
  const file: VaultFile = {
    format: 'system-vault', version: 1, cipher: 'aes-256-gcm',
    nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  }
  return `${JSON.stringify(file)}\n`
}

/** Decrypt and authenticate a vault file; a wrong key or any tampering throws. */
export function open(text: string, key: Buffer): VaultDocument {
  const file = JSON.parse(text) as Partial<VaultFile>
  if (file.format !== 'system-vault' || file.version !== 1 || file.cipher !== 'aes-256-gcm') {
    throw new Error('vault: unsupported file format')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.nonce ?? '', 'base64'))
  decipher.setAAD(AAD)
  decipher.setAuthTag(Buffer.from(file.tag ?? '', 'base64'))
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(file.data ?? '', 'base64')), decipher.final()])
  } catch {
    throw new Error('vault: authentication failed (wrong key or modified file)')
  }
  const document = JSON.parse(plain.toString('utf8')) as Partial<VaultDocument>
  return { refs: document.refs ?? {}, records: document.records ?? {} }
}

/** Read the vault, or an empty document when the file does not exist yet. */
export function readVault(path: string, key: Buffer): VaultDocument {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument()
    throw error
  }
  return open(text, key)
}

/** Atomically replace the vault: write a 0600 temp file, fsync, rename. */
export function writeVault(path: string, document: VaultDocument, key: Buffer): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeSync(fd, seal(document, key))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
}

/**
 * Cross-process exclusion through an O_EXCL lock file. A lock older than `staleMs`
 * (a crashed holder) is broken; waiting longer than `timeoutMs` throws.
 */
export async function withFileLock<T>(lockPath: string, fn: () => T, timeoutMs = 5000, staleMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      closeSync(openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) unlinkSync(lockPath)
      } catch {
        // the holder released it between our attempts
      }
      if (Date.now() > deadline) throw new Error(`vault: timed out waiting for ${lockPath}`)
      await sleep(10 + Math.random() * 20)
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lockPath)
    } catch {
      // already removed as stale by another process
    }
  }
}
