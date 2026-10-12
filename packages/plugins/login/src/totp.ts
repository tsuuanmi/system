/**
 * The `totp-local` code provider (ADR-0017): RFC 6238 codes computed on this machine with
 * `otpauth`. A secret is never sent anywhere. A code is not handed out with fewer than 5
 * seconds left in its window, and never twice for the same account.
 */
import { Secret, TOTP } from 'otpauth'

export interface TotpClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const PERIOD_S = 30
const MIN_REMAINING_MS = 5000

export class TotpCodes {
  /** Last time step used per account. */
  private readonly used = new Map<string, number>()

  constructor(private readonly clock: TotpClock = { now: () => Date.now(), sleep: (ms) => new Promise((done) => setTimeout(done, ms)) }) {}

  async next(account: string, secret: string, options: { digits?: number } = {}): Promise<string> {
    let key: Secret
    try {
      key = Secret.fromBase32(secret.replace(/\s+/g, '').toUpperCase())
    } catch {
      throw new Error(`TOTP secret for ${account} is not valid Base32`)
    }
    if (key.bytes.length === 0) throw new Error(`TOTP secret for ${account} is not valid Base32`)
    const totp = new TOTP({ secret: key, digits: options.digits ?? 6, period: PERIOD_S, algorithm: 'SHA1' })
    for (;;) {
      const now = this.clock.now()
      const step = Math.floor(now / 1000 / PERIOD_S)
      const remaining = (step + 1) * PERIOD_S * 1000 - now
      if (remaining < MIN_REMAINING_MS || step <= (this.used.get(account) ?? -1)) {
        await this.clock.sleep(remaining)
        continue
      }
      this.used.set(account, step)
      return totp.generate({ timestamp: now })
    }
  }
}
