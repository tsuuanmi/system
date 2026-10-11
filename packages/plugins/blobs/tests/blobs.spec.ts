import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import Blobs, { BlobCorrupted } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot(maxBytes?: number): Promise<{ ctx: Context; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-blobs-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fiber = ctx.plugin(Blobs, { dir: join(dir, 'blobs'), ...(maxBytes !== undefined && { maxBytes }) })
  await fiber
  cleanups.push(() => fiber.dispose())
  return { ctx, dir }
}

describe('ctx.blobs', () => {
  it('stores by content address, deduplicates, and reads back verified bytes', async () => {
    const { ctx } = await boot()
    const a = ctx.blobs.put('deep research report', 'text/markdown')
    expect(a).toMatchObject({ bytes: 20, mediaType: 'text/markdown' })
    expect(a.ref).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(ctx.blobs.put('deep research report', 'text/markdown').ref).toBe(a.ref)
    expect(ctx.blobs.get(a.ref).toString()).toBe('deep research report')
  })

  it('writes owner-only files and detects tampering', async () => {
    const { ctx, dir } = await boot()
    const { ref } = ctx.blobs.put('x', 'text/plain')
    const hex = ref.slice(7)
    const path = join(dir, 'blobs', 'sha256', hex.slice(0, 2), hex)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    writeFileSync(path, 'y')
    expect(() => ctx.blobs.get(ref)).toThrow(BlobCorrupted)
  })

  it('enforces the size limit and rejects malformed references', async () => {
    const { ctx } = await boot(4)
    expect(() => ctx.blobs.put('12345', 'text/plain')).toThrow(RangeError)
    expect(() => ctx.blobs.get('sha256:../../etc/passwd')).toThrow(TypeError)
  })
})

describe('review fixes (PR #3 security review)', () => {
  it('repairs a corrupted blob when the same bytes are put again', async () => {
    const { ctx, dir } = await boot()
    const { ref } = ctx.blobs.put('x', 'text/plain')
    const hex = ref.slice(7)
    writeFileSync(join(dir, 'blobs', 'sha256', hex.slice(0, 2), hex), 'y')
    ctx.blobs.put('x', 'text/plain')
    expect(ctx.blobs.get(ref).toString()).toBe('x')
  })
})
