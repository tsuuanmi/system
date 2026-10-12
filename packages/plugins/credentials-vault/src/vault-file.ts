import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFileDurable } from '@tsuuanmi/system-libs'

const AAD = Buffer.from('system-vault:v1')
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** The decrypted vault contents. Null-prototype maps: names like `__proto__` are plain keys. */
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

const dictionary = <T>(entries: Record<string, T> = {}): Record<string, T> =>
  Object.assign(Object.create(null) as Record<string, T>, entries)

export const emptyDocument = (): VaultDocument => ({ refs: dictionary(), records: dictionary() })

/** Own-property lookup that ignores the prototype chain. */
export function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined
}

/** Encrypt a document with AES-256-GCM under a fresh 96-bit nonce and a full 128-bit tag. */
export function seal(document: VaultDocument, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(AAD)
  const plain = JSON.stringify({ refs: { ...document.refs }, records: { ...document.records } })
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const file: VaultFile = {
    format: 'system-vault', version: 1, cipher: 'aes-256-gcm',
    nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  }
  return `${JSON.stringify(file)}\n`
}

/** Decrypt and authenticate a vault file; a wrong key, a short tag, or any tampering throws. */
export function open(text: string, key: Buffer): VaultDocument {
  const file = JSON.parse(text) as Partial<VaultFile>
  if (file.format !== 'system-vault' || file.version !== 1 || file.cipher !== 'aes-256-gcm') {
    throw new Error('vault: unsupported file format')
  }
  const nonce = Buffer.from(file.nonce ?? '', 'base64')
  const tag = Buffer.from(file.tag ?? '', 'base64')
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error('vault: malformed nonce or authentication tag')
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  decipher.setAAD(AAD)
  decipher.setAuthTag(tag)
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(file.data ?? '', 'base64')), decipher.final()])
  } catch {
    throw new Error('vault: authentication failed (wrong key or modified file)')
  }
  // JSON.parse defines "__proto__" as an own property, so no prototype is touched.
  const parsed = JSON.parse(plain.toString('utf8')) as Partial<VaultDocument>
  return { refs: dictionary(parsed.refs), records: dictionary(parsed.records) }
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

/** Durably replace the vault (0600 temp, fsync, rename, fsync directory). */
export function writeVault(path: string, document: VaultDocument, key: Buffer): void {
  writeFileDurable(path, seal(document, key), 0o600)
}
