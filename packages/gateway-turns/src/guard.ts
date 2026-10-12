/**
 * The protocol gateways' request guard: the one every client endpoint shares
 * (`@tsuuanmi/system-gateway-core`), with the MCP token, and the token also accepted from
 * `x-api-key` as Anthropic clients send it.
 */
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { guardRequest, LOOPBACK_HOSTS } from '@tsuuanmi/system-gateway-core'
import { dshHome, readOrCreateSecretFile } from '@tsuuanmi/system-libs'

/** Largest request body a gateway reads (a long conversation with tool results). */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024

export interface GuardOptions {
  /** Bearer token file (default: the MCP token). */
  tokenFile?: string
  allowedHosts?: string[]
}

/** A function that returns why a request is refused (`[status, reason]`), or undefined. */
export function guard(options: GuardOptions = {}): (req: IncomingMessage) => [number, string] | undefined {
  const token = readOrCreateSecretFile(options.tokenFile ?? join(dshHome(), 'system', 'mcp.token'), 32).toString('base64url')
  const allowedHosts = options.allowedHosts ?? LOOPBACK_HOSTS
  return (req) => {
    const verdict = guardRequest(req, { token, allowedHosts, apiKeyHeader: true })
    return verdict.ok ? undefined : [verdict.status, verdict.reason]
  }
}
