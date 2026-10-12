/**
 * The request guard of every client endpoint (MCP, the protocol gateways, the web UI; docs/security/
 * threat-model.md): a loopback `Host` (against DNS rebinding), no browser `Origin` (no CORS),
 * then the bearer token compared in constant time; plus the bind check and bounded JSON bodies.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

export interface GuardOptions {
  token: string
  allowedHosts: readonly string[]
  /** Also accept the token from `x-api-key` (Anthropic clients send it there). */
  apiKeyHeader?: boolean
  /** Accept the endpoint's own origin (an endpoint that serves a page, the web UI); any other is refused. */
  sameOrigin?: boolean
}

export type GuardResult = { ok: true } | { ok: false; status: 401 | 403 | 421; reason: string }

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

/** Constant-time comparison over SHA-256 digests (equal length by construction); never an empty token. */
export function tokenMatches(presented: string, token: string): boolean {
  return timingSafeEqual(digest(presented), digest(token)) && presented.length > 0
}

/** Hostname of a Host header, without port; IPv6 literals keep their brackets. */
export function hostName(host: string | undefined): string {
  if (!host) return ''
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1)
  return host.split(':')[0] ?? ''
}

/** Host, then origin, then token. */
export function guardRequest(req: IncomingMessage, options: GuardOptions): GuardResult {
  if (!options.allowedHosts.includes(hostName(req.headers.host))) return { ok: false, status: 421, reason: 'host not allowed' }
  const origin = req.headers.origin
  const own = options.sameOrigin && (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`)
  if (origin !== undefined && !own) return { ok: false, status: 403, reason: 'browser origins are not accepted' }
  // The auth scheme is case-insensitive (RFC 7235); the credential itself is exact.
  const header = req.headers.authorization ?? ''
  const presented = /^bearer /i.test(header) ? header.slice(7) : options.apiKeyHeader ? String(req.headers['x-api-key'] ?? '') : ''
  if (!tokenMatches(presented, options.token)) return { ok: false, status: 401, reason: 'missing or invalid token' }
  return { ok: true }
}

const LOOPBACK = /^(127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3}|localhost)$/i

/** Endpoint URL from the webserver's bound protocol, host (IPv6 bracketed), and port. */
export function endpointUrl(bound: { protocol: string; host: string; port: number }, path: string): string {
  const host = bound.host.includes(':') ? `[${bound.host}]` : bound.host
  return `${bound.protocol}//${host}:${bound.port}${path}`
}

/**
 * The bearer token must not travel in clear text over a network: refuse a non-loopback
 * bind unless the webserver serves TLS.
 */
export function assertSafeBind(bound: { protocol: string; host: string }): void {
  if (bound.protocol !== 'https:' && !LOOPBACK.test(bound.host)) {
    throw new Error(`system endpoints refuse plain HTTP on non-loopback host ${bound.host}; bind loopback or enable TLS`)
  }
}

/** A JSON request body, bounded in size; an empty body is `undefined`. Errors carry an HTTP status. */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error('request body too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (!size) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw Object.assign(new Error('the body is not JSON'), { status: 400 })
  }
}
