/**
 * The client-protocol gateways' request guard, the same rules as the MCP endpoint: a loopback
 * `Host` (against DNS rebinding), no browser `Origin`, and the bearer token (or `x-api-key`)
 * compared in constant time.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { dshHome, readOrCreateSecretFile } from '@tsuuanmi/system-libs'

export interface GuardOptions {
  /** Bearer token file (default: the MCP token). */
  tokenFile?: string
  allowedHosts?: string[]
}

export const DEFAULT_HOSTS = ['127.0.0.1', 'localhost', '[::1]']

/** A function that returns why a request is refused (`[status, reason]`), or undefined. */
export function guard(options: GuardOptions = {}): (req: IncomingMessage) => [number, string] | undefined {
  const token = readOrCreateSecretFile(options.tokenFile ?? join(dshHome(), 'system', 'mcp.token'), 32).toString('base64url')
  const hosts = options.allowedHosts ?? DEFAULT_HOSTS
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  return (req) => {
    if (!hosts.includes((req.headers.host ?? '').replace(/:\d+$/, ''))) return [421, 'host not allowed']
    if (req.headers.origin !== undefined) return [403, 'browser origins are not accepted']
    const header = req.headers.authorization ?? ''
    const presented = /^bearer /i.test(header) ? header.slice(7) : String(req.headers['x-api-key'] ?? '')
    if (!timingSafeEqual(digest(presented), digest(token))) return [401, 'missing or invalid token']
    return undefined
  }
}

/** A JSON request body, bounded in size. */
export async function readJson(req: IncomingMessage, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw Object.assign(new Error('request too large'), { status: 413 })
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw Object.assign(new Error('the body is not JSON'), { status: 400 })
  }
}
