/**
 * The protocol gateways' request guard: the one every client endpoint shares
 * (`@tsuuanmi/system-gateway-core`), with the model scope's token only (ADR-0023), also
 * accepted from `x-api-key` as Anthropic clients send it.
 */
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { guardRequest, LOOPBACK_HOSTS, scopeToken, tokenFile } from '@tsuuanmi/system-gateway-core'
import { dshHome } from '@tsuuanmi/system-libs'

/** Largest request body a gateway reads (a long conversation with tool results). */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024

export interface GuardOptions {
  /** Directory of the scope token files (default `<DSH_HOME>/system`); the gateways read `model.token`. */
  tokenDir?: string
  allowedHosts?: string[]
}

/** The model token's file the gateways read, which they register as secret (ADR-0024). */
export function modelTokenPath(options: GuardOptions = {}): string {
  return tokenFile(options.tokenDir ?? join(dshHome(), 'system'), 'model')
}

/** A function that returns why a request is refused (`[status, reason]`), or undefined. */
export function guard(options: GuardOptions = {}): (req: IncomingMessage) => [number, string] | undefined {
  const model = scopeToken(options.tokenDir ?? join(dshHome(), 'system'), 'model')
  const allowedHosts = options.allowedHosts ?? LOOPBACK_HOSTS
  return (req) => {
    const verdict = guardRequest(req, { tokens: { model }, allowedHosts, apiKeyHeader: true })
    return verdict.ok ? undefined : [verdict.status, verdict.reason]
  }
}
