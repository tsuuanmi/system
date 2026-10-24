import { randomBytes } from 'node:crypto'
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

// A realistic key id, made at test time (scanners ignore documented example keys).
const AWS_KEY = `AKIA${Array.from(randomBytes(16), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b % 32]).join('')}`

// The seam's contract is held by its conformance suite (conformance.spec.ts); these tests pin what
// only this provider does.
describe('ctx.egress (INV-12)', () => {
  it('denies an AWS key pair whose secret ends in + or /, which the recommended rules miss', async () => {
    const ctx = await boot()
    // A shape secretlint's AWS rule skips (its pattern needs a word boundary after the secret).
    const pair = `aws_access_key_id = ${AWS_KEY}\naws_secret_access_key = ${randomBytes(30).toString('base64').slice(0, 39)}+`
    const verdict = await ctx.egress.check({ payload: pair, classification: 'operator-shared', workerClass: 'website' })
    expect(verdict).toMatchObject({ allowed: false, findings: [expect.objectContaining({ rule: 'aws-access-key-id' })] })
  })

})
