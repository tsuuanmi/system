import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { type CredentialRecord, credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it } from 'vitest'
import VaultCredentialProvider from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'system-vault-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function boot(dir: string): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(VaultCredentialProvider, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') })
  await fiber
  cleanups.push(() => fiber.dispose())
  return ctx
}

const REF = credentialRef('SYSTEM_TEST_SECRET')
const ACCOUNT = credentialKey('system-accounts', 'chatgpt-main')

describe('encrypted ctx.credentials provider', () => {
  it('round-trips a reference and never writes the value in plaintext', async () => {
    const dir = tempDir()
    const ctx = await boot(dir)
    await ctx.credentials.set(REF, 'hunter2-plaintext-marker')
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'hunter2-plaintext-marker', source: 'vault' })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: 'vault', writable: true })
    expect(readFileSync(join(dir, 'vault.enc'), 'utf8')).not.toContain('hunter2')
  })

  it('stores account credentials as an opaque grant record (REQ-ACC-9)', async () => {
    const dir = tempDir()
    const ctx = await boot(dir)
    const record: CredentialRecord = { kind: 'grant', payload: { email: 'me@example.com', password: 'pw-marker', totpSecret: 'JBSWY3DPEHPK3PXP' } }
    await ctx.credentials.modifyRecord(ACCOUNT, async () => record)
    expect(await ctx.credentials.readRecord(ACCOUNT)).toEqual(record)
    expect(await ctx.credentials.listRecords()).toEqual([{ key: ACCOUNT, kind: 'grant' }])
    expect(readFileSync(join(dir, 'vault.enc'), 'utf8')).not.toMatch(/pw-marker|JBSWY3DP/)
    await ctx.credentials.deleteRecord(ACCOUNT)
    expect(await ctx.credentials.describeRecord(ACCOUNT)).toEqual({ configured: false, writable: true })
  })

  it('lets the launch environment shadow the vault and refuses writes it would hide', async () => {
    const dir = tempDir()
    const ctx = await boot(dir)
    process.env[REF] = 'from-env'
    cleanups.push(() => delete process.env[REF])
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'from-env', source: 'env' })
    await expect(ctx.credentials.set(REF, 'x')).rejects.toThrow(/shadows/)
  })

  it('detects a wrong key and a modified file', async () => {
    const dir = tempDir()
    const ctx = await boot(dir)
    await ctx.credentials.set(REF, 'v')
    const sealed = JSON.parse(readFileSync(join(dir, 'vault.enc'), 'utf8')) as { data: string }
    sealed.data = Buffer.from('tampered').toString('base64')
    writeFileSync(join(dir, 'vault.enc'), JSON.stringify(sealed))
    await expect(ctx.credentials.resolve(REF)).rejects.toThrow(/authentication failed/)
  })

  it('loses no update when two providers race on one record', async () => {
    const dir = tempDir()
    const [a, b] = [await boot(dir), await boot(dir)]
    const bump = async (current: CredentialRecord | undefined): Promise<CredentialRecord> =>
      ({ kind: 'grant', payload: { n: ((current?.kind === 'grant' ? (current.payload as { n: number }).n : 0) + 1) } })
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).credentials.modifyRecord(ACCOUNT, bump)))
    expect(await a.credentials.readRecord(ACCOUNT)).toEqual({ kind: 'grant', payload: { n: 20 } })
  })
})

describe('review fixes (PR #3 security review)', () => {
  it('runs mutate exclusively across providers: one call per write, never overlapping, always on the latest value', async () => {
    const dir = tempDir()
    const [a, b] = [await boot(dir), await boot(dir)]
    let inFlight = 0
    let maxInFlight = 0
    let calls = 0
    const bump = async (current: CredentialRecord | undefined): Promise<CredentialRecord> => {
      calls++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 2))
      inFlight--
      return { kind: 'grant', payload: { n: (current?.kind === 'grant' ? (current.payload as { n: number }).n : 0) + 1 } }
    }
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).credentials.modifyRecord(ACCOUNT, bump)))
    expect(maxInFlight).toBe(1)
    expect(calls).toBe(10)
    expect(await a.credentials.readRecord(ACCOUNT)).toEqual({ kind: 'grant', payload: { n: 10 } })
  })

  it('rejects a truncated GCM tag', async () => {
    const dir = tempDir()
    const ctx = await boot(dir)
    await ctx.credentials.set(REF, 'v')
    const sealed = JSON.parse(readFileSync(join(dir, 'vault.enc'), 'utf8')) as { tag: string }
    sealed.tag = Buffer.from(sealed.tag, 'base64').subarray(0, 4).toString('base64')
    writeFileSync(join(dir, 'vault.enc'), JSON.stringify(sealed))
    await expect(ctx.credentials.resolve(REF)).rejects.toThrow(/vault/)
  })

  it('treats prototype-named references as ordinary keys', async () => {
    const dir = tempDir()
    const ctx = await boot(dir)
    for (const name of ['toString', 'constructor', '__proto__']) {
      const ref = credentialRef(name)
      expect(await ctx.credentials.resolve(ref)).toBeUndefined()
      await ctx.credentials.set(ref, `value-of-${name}`)
      expect(await ctx.credentials.resolve(ref)).toEqual({ value: `value-of-${name}`, source: 'vault' })
    }
  })

  it('accepts a read-only (0400) key file such as a systemd credential', async () => {
    const dir = tempDir()
    const keyFile = join(dir, 'key')
    writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o400 })
    const ctx = new Context()
    const fiber = ctx.plugin(VaultCredentialProvider, { path: join(dir, 'vault.enc'), keyFile })
    await fiber
    cleanups.push(() => fiber.dispose())
    await ctx.credentials.set(REF, 'v')
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'v', source: 'vault' })
  })

  it('leaves no temp files behind', async () => {
    const dir = tempDir()
    const ctx = await boot(dir)
    for (let i = 0; i < 5; i++) await ctx.credentials.set(REF, `v${i}`)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('disposal during an in-flight mutation (review)', () => {
  it('never seals the vault with a wiped key: dispose waits for the mutation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-vault-dispose-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const ctx = new Context()
    const fiber = ctx.plugin(VaultCredentialProvider, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') })
    await fiber
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pending = ctx.credentials.modifyRecord(ACCOUNT, async () => {
      await gate
      return { kind: 'grant', provider: 'test', grant: { token: 'kept' } } as never
    })
    const disposed = fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await Promise.allSettled([pending, disposed])
    const reopened = await boot(dir)
    expect(await reopened.credentials.readRecord(ACCOUNT)).toMatchObject({ grant: { token: 'kept' } })
  })

  it('reports where its key is kept: beside the vault by default, apart when keyFile points elsewhere (key custody)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-vault-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const beside = await boot(dir)
    expect((beside.credentials as unknown as VaultCredentialProvider).custody()).toEqual({ keyApart: false, keyFile: join(dir, 'vault.key'), vault: join(dir, 'vault.enc') })
    const apart = new Context()
    const fiber = apart.plugin(VaultCredentialProvider, { path: join(dir, 'other', 'vault.enc'), keyFile: join(dir, 'vault.key') })
    await fiber
    cleanups.push(() => fiber.dispose())
    expect((apart.credentials as unknown as VaultCredentialProvider).custody()).toMatchObject({ keyApart: true })
  })
})
