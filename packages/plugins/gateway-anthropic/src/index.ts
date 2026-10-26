/**
 * The Anthropic Messages gateway (docs/design/gateways.md, ADR-0022): Claude Code points its
 * base URL here and uses a website model as its model. Each request is an exchange on a thread
 * bound to one persistent provider conversation (`@tsuuanmi/system-gateway-turns`); the
 * client's tools reach the model through the text protocol, and the client runs every call under
 * its own sandbox and approvals (INV-6). This plugin owns only the Messages wire format.
 * @module @tsuuanmi/system-gateway-anthropic
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { assertSafeBind, LOOPBACK_HOSTS, readJsonBody } from '@tsuuanmi/system-gateway-core'
import { estimateTokens, guard, MAX_REQUEST_BYTES, modelTokenPath, renderOpening, type Tier, Threads, tierOf } from '@tsuuanmi/system-gateway-turns'
import { registerSecretPath } from '@tsuuanmi/system-libs'
import { conversationKey, type MessagesRequest, messageOf, streamEvents, systemText, toolsOf, turnsOf } from './protocol.ts'

export * from './protocol.ts'

export interface Config {
  path?: string
  /** Directory of the scope token files (default `<DSH_HOME>/system`); this gateway takes `model.token` (ADR-0023). */
  tokenDir?: string
  allowedHosts?: string[]
  /** Model-name patterns → tier; `system-<tier>` always names a tier; anything else is standard. */
  models?: Record<string, Tier>
  /** Classification of what Claude Code sends (its context, files, results); egress applies (INV-12). */
  classification?: 'public' | 'operator-shared' | 'local-private'
  /** Longest a request may wait for its turn (default 15 min). */
  timeoutMs?: number
  /** SSE ping interval while the turn runs (default 10 s). */
  pingMs?: number
}

export const name = 'gateway-anthropic'
export const inject = ['webServer', 'workflow', 'store']
export const Config: z<Config> = z.object({
  path: z.string().default('/anthropic').description('Route prefix; Claude Code sets ANTHROPIC_BASE_URL to it'),
  tokenDir: z.string().description('Directory of the scope token files (default <DSH_HOME>/system); the gateway takes model.token'),
  allowedHosts: z.array(z.string()).default([...LOOPBACK_HOSTS]),
  models: z.dict(z.union(['economy', 'standard', 'frontier'])).default({}).description('Model-name patterns → tier, as the operator configures them (model names are configuration only, ADR-0073); none by default'),
  classification: z.union(['public', 'operator-shared', 'local-private']).default('operator-shared').description('Classification of what the client sends'),
  timeoutMs: z.natural().min(1000).default(15 * 60_000),
  pingMs: z.natural().min(100).default(10_000),
}) as unknown as z<Config>

export function apply(ctx: Context, config: Config = {}): void {
  const prefix = config.path ?? '/anthropic'
  const refuse = guard(config)
  // Agent Workers never read the model token, wherever tokenDir puts it (ADR-0024).
  ctx.effect(() => registerSecretPath(modelTokenPath(config)))
  const models = config.models ?? {}
  const threads = new Threads(ctx, { scope: 'anthropic', ...(config.classification ? { classification: config.classification } : {}), ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}) })

  const error = (res: ServerResponse, status: number, type: string, message: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type, message } }))
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice(prefix.length) || '/'
    if (req.method === 'HEAD' || (req.method === 'GET' && path === '/')) return void res.writeHead(200).end()
    const refused = refuse(req)
    if (refused) return error(res, refused[0], refused[0] === 401 ? 'authentication_error' : 'permission_error', refused[1])
    if (req.method === 'GET' && path === '/v1/models') {
      const data = (['economy', 'standard', 'frontier'] as const).map((tier) => ({ type: 'model', id: `system-${tier}`, display_name: `system ${tier} (website Workers)`, created_at: '2026-10-12T00:00:00Z' }))
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data, has_more: false, first_id: data[0]!.id, last_id: data[2]!.id }))
    }
    if (req.method !== 'POST') return error(res, 405, 'invalid_request_error', 'method not allowed')
    let request: MessagesRequest
    try {
      request = await readJsonBody(req, MAX_REQUEST_BYTES) as MessagesRequest
      if (!request || typeof request.model !== 'string' || !Array.isArray(request.messages) || !request.messages.length) {
        throw Object.assign(new Error('model and messages are required'), { status: 400 })
      }
    } catch (e) {
      return error(res, (e as { status?: number }).status ?? 400, 'invalid_request_error', (e as Error).message)
    }
    if (path === '/v1/messages/count_tokens') {
      const tokens = estimateTokens(renderOpening(systemText(request.system), toolsOf(request), turnsOf(request), new Map()))
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: tokens }))
    }
    if (path !== '/v1/messages') return error(res, 404, 'not_found_error', `unknown route ${path}`)
    await messages(request, res)
  }

  const messages = async (request: MessagesRequest, res: ServerResponse): Promise<void> => {
    let ping: NodeJS.Timeout | undefined
    let closed = false
    res.on('close', () => { closed = true })
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      ping = setInterval(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), config.pingMs ?? 10_000)
    }
    try {
      const tier = tierOf(request.model, models)
      const outcome = await threads.exchange({
        key: conversationKey(tier, request), tier, system: systemText(request.system), tools: toolsOf(request), turns: turnsOf(request),
        closed: () => closed, newId: () => `toolu_${randomBytes(12).toString('hex')}`,
      })
      if (outcome.kind === 'closed') return
      if (outcome.kind === 'failed') {
        const type = { overloaded: 'overloaded_error', invalid: 'invalid_request_error', api: 'api_error' }[outcome.error]
        if (request.stream) return void res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message: outcome.message } })}\n\n`)
        return error(res, outcome.status, type, outcome.message)
      }
      const message = messageOf(`msg_${outcome.runId}`, request.model, outcome.text, outcome.calls, outcome.promptTokens)
      if (!request.stream) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message))
      for (const [event, data] of streamEvents(message)) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      res.end()
    } finally {
      clearInterval(ping)
    }
  }

  ctx.effect(() => {
    // The token must not travel in clear text over a network (QA-5): no route on such a bind.
    assertSafeBind({ protocol: ctx.webServer.protocol, host: ctx.webServer.host })
    return ctx.webServer.register({ kind: 'prefix', path: prefix, handler: (req, res) => void handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) error(res, 500, 'api_error', (e as Error).message)
      else res.end()
    }) })
  })
}
