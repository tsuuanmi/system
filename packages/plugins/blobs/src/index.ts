/**
 * `ctx.blobs`: content-addressed files (docs/design/artifacts.md#storage). DSH's
 * `ctx.attachments` is prompt-attachment oriented (image normalization, session paths),
 * so system keeps its own store: `<dir>/sha256/<aa>/<hex>`, atomic 0600 writes,
 * deduplicated, and verified against its address on every read.
 * @module @tsuuanmi/system-blobs
 */
import { randomBytes } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type ContentId, dshHome, ensurePrivateDir, sha256 } from '@tsuuanmi/system-libs'

declare module '@deepseek-ai/cordis' {
  interface Context {
    blobs: Blobs
  }
}

/** The blob reference carried by an artifact envelope. */
export interface BlobRef {
  ref: ContentId
  bytes: number
  mediaType: string
}

/** Stored bytes no longer match their address. */
export class BlobCorrupted extends Error {
  constructor(readonly ref: string) {
    super(`blob ${ref} does not match its content address`)
    this.name = 'BlobCorrupted'
  }
}

export interface Config {
  /** Blob directory; defaults to `<DSH_HOME>/system/blobs`. */
  dir?: string
  /** Largest accepted blob, in bytes (default 64 MiB). */
  maxBytes?: number
}

const REF = /^sha256:([0-9a-f]{64})$/

export class Blobs extends Service {
  static Config: z<Config> = z.object({
    dir: z.string().description('Blob directory; defaults to <DSH_HOME>/system/blobs'),
    maxBytes: z.natural().min(1).default(64 * 1024 * 1024).description('Largest accepted blob'),
  })

  readonly dir: string
  private readonly maxBytes: number

  constructor(ctx: Context, config: Config) {
    super(ctx, 'blobs')
    this.dir = config.dir ?? join(dshHome(), 'system', 'blobs')
    this.maxBytes = config.maxBytes ?? 64 * 1024 * 1024
    ensurePrivateDir(this.dir)
  }

  /** Store bytes and return their reference; storing the same bytes twice is a no-op. */
  put(data: Uint8Array | string, mediaType: string): BlobRef {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    if (bytes.length > this.maxBytes) throw new RangeError(`blob exceeds ${this.maxBytes} bytes`)
    const ref = sha256(bytes)
    const path = this.pathOf(ref)
    if (!existsSync(path)) {
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
      const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeSync(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, path)
    }
    return { ref, bytes: bytes.length, mediaType }
  }

  /** Read and verify a blob; throws {@link BlobCorrupted} when the bytes do not match. */
  get(ref: string): Buffer {
    const bytes = readFileSync(this.pathOf(ref))
    if (sha256(bytes) !== ref) throw new BlobCorrupted(ref)
    return bytes
  }

  has(ref: string): boolean {
    return existsSync(this.pathOf(ref))
  }

  size(ref: string): number {
    return statSync(this.pathOf(ref)).size
  }

  private pathOf(ref: string): string {
    const match = REF.exec(ref)
    if (!match?.[1]) throw new TypeError(`not a content address: ${ref}`)
    return join(this.dir, 'sha256', match[1].slice(0, 2), match[1])
  }
}

export default Blobs
