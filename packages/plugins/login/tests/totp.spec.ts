import { describe, expect, it } from 'vitest'
import { TotpCodes } from '../src/totp.ts'

// RFC 6238 test secret ("12345678901234567890" in Base32).
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('local TOTP codes (never computed by any website)', () => {
  it('matches the RFC 6238 SHA-1 test vector', async () => {
    // T = 1111111111 s: 29 s left in its window, so no wait.
    const codes = new TotpCodes({ now: () => 1_111_111_111_000, sleep: async () => { throw new Error('should not wait') } })
    expect(await codes.next('acct', SECRET, { digits: 8 })).toBe('14050471')
  })

  it('waits for the next window when fewer than 5 seconds remain', async () => {
    let clock = 28_000
    const slept: number[] = []
    const codes = new TotpCodes({ now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms } })
    await codes.next('acct', SECRET)
    expect(slept).toEqual([2000])
  })

  it('never hands out the same code twice for one account', async () => {
    let clock = 10_000
    const codes = new TotpCodes({ now: () => clock, sleep: async (ms) => { clock += ms } })
    const first = await codes.next('acct', SECRET)
    const second = await codes.next('acct', SECRET)
    expect(second).not.toBe(first)
    expect(clock).toBeGreaterThanOrEqual(30_000)
  })

  it('rejects a malformed secret without echoing it', async () => {
    const codes = new TotpCodes({ now: () => 0, sleep: async () => {} })
    await expect(codes.next('acct', 'not base32 !!')).rejects.toThrow(/TOTP secret for acct is not valid Base32/)
    await expect(codes.next('acct', 'not base32 !!')).rejects.not.toThrow(/not base32 !!/)
  })
})
