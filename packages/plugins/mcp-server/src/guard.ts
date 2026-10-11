import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export interface GuardOptions {
  token: string
  allowedHosts: readonly string[]
}

export type GuardResult = { ok: true } | { ok: false; status: 401 | 403 | 421; reason: string }

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

/** Constant-time bearer comparison over SHA-256 digests (equal length by construction). */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice(7) : ''
  return timingSafeEqual(digest(presented), digest(token)) && presented.length > 0
}

/** Hostname of a Host header, without port; IPv6 literals keep their brackets. */
export function hostName(host: string | undefined): string {
  if (!host) return ''
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1)
  return host.split(':')[0] ?? ''
}

/**
 * Transport-level checks for every request (docs/security/threat-model.md):
 * Host allow-list against DNS rebinding, no browser origins (no CORS), then the bearer token.
 */
export function guardRequest(req: IncomingMessage, options: GuardOptions): GuardResult {
  if (!options.allowedHosts.includes(hostName(req.headers.host))) return { ok: false, status: 421, reason: 'host not allowed' }
  if (req.headers.origin !== undefined) return { ok: false, status: 403, reason: 'browser origins are not accepted' }
  if (!tokenMatches(req.headers.authorization, options.token)) return { ok: false, status: 401, reason: 'missing or invalid bearer token' }
  return { ok: true }
}
