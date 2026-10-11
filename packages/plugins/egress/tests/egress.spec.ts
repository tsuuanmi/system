import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import Egress from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot(config: Record<string, unknown> = {}): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'system-egress-'))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(Egress, config)]
  await Promise.all(fibers)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), async () => { for (const f of fibers.reverse()) await f.dispose() })
  return ctx
}

// Realistic secrets, made at test time (scanners ignore documented example keys).
const PRIVATE_KEY = String(generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' }))
const AWS_KEY = `AKIA${Array.from(randomBytes(16), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b % 32]).join('')}`
const AWS_PAIR = `aws_access_key_id = ${AWS_KEY}\naws_secret_access_key = ${randomBytes(30).toString('base64').slice(0, 40)}`

describe('ctx.egress (INV-12)', () => {
  it('allows operator-shared content to a website Worker and records the decision', async () => {
    const ctx = await boot()
    const verdict = await ctx.egress.check({ payload: 'Summarize the A2A protocol.', classification: 'operator-shared', workerClass: 'website' })
    expect(verdict).toMatchObject({ allowed: true, findings: [] })
    expect(ctx.artifacts.get(verdict.decision)?.body).toMatchObject({ decisionType: 'egress', outcome: { option: 'allow' } })
  })

  it('denies local-private content to a website Worker by default', async () => {
    const ctx = await boot()
    const verdict = await ctx.egress.check({ payload: 'harmless text', classification: 'local-private', workerClass: 'website' })
    expect(verdict).toMatchObject({ allowed: false })
    expect(ctx.artifacts.get(verdict.decision)?.body).toMatchObject({ outcome: { option: 'deny' } })
  })

  it('denies a payload that carries credentials, without recording the secret itself', async () => {
    const ctx = await boot()
    for (const secret of [AWS_PAIR, PRIVATE_KEY]) {
      const verdict = await ctx.egress.check({ payload: `please debug this: ${secret}`, classification: 'operator-shared', workerClass: 'website' })
      expect(verdict.allowed).toBe(false)
      expect(verdict.findings.length).toBeGreaterThan(0)
      const recorded = JSON.stringify(ctx.artifacts.get(verdict.decision))
      expect(recorded).not.toContain(AWS_KEY)
      expect(recorded).not.toContain(PRIVATE_KEY.split('\n')[1]!)
    }
  })

  it('applies operator deny patterns', async () => {
    const ctx = await boot({ denyPatterns: [{ name: 'internal-hostname', pattern: '\\b[a-z0-9-]+\\.corp\\.example\\b' }] })
    const verdict = await ctx.egress.check({ payload: 'ssh to db1.corp.example', classification: 'operator-shared', workerClass: 'website' })
    expect(verdict).toMatchObject({ allowed: false, findings: [expect.objectContaining({ rule: 'internal-hostname' })] })
  })

  it('denies an unknown Worker class (fail closed)', async () => {
    const ctx = await boot()
    const verdict = await ctx.egress.check({ payload: 'x', classification: 'public', workerClass: 'satellite' })
    expect(verdict.allowed).toBe(false)
  })
})
