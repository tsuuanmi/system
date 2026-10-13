/**
 * The OpenAI Responses gateway (docs/design/gateways.md, ADR-0022): Codex selects a custom model
 * provider whose base URL is here and uses a website model as its model. Each request is an
 * exchange on a thread bound to one persistent provider conversation
 * (`@tsuuanmi/system-gateway-turns`); the client's tools reach the model through the text
 * protocol, and the client runs every call under its own sandbox and approvals (INV-6). This
 * plugin owns only the Responses wire format.
 * @module @tsuuanmi/system-gateway-responses
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { assertSafeBind, LOOPBACK_HOSTS, readJsonBody } from '@tsuuanmi/system-gateway-core'
import { guard, MAX_REQUEST_BYTES, type Tier, Threads, tierOf } from '@tsuuanmi/system-gateway-turns'
import { conversationKey, type ResponseObject, type ResponsesRequest, responseOf, streamEvents, toolsOf, turnsOf } from './protocol.ts'

export * from './protocol.ts'

export interface Config {
  path?: string
  /** Directory of the scope token files (default `<DSH_HOME>/system`); this gateway takes `model.token` (ADR-0023). */
  tokenDir?: string
  allowedHosts?: string[]
  /** Model-name patterns → tier; `system-<tier>` always names a tier; anything else is standard. */
  models?: Record<string, Tier>
  /** Classification of what Codex sends (its context, files, results); egress applies (INV-12). */
  classification?: 'public' | 'operator-shared' | 'local-private'
  /** Longest a request may wait for its turn (default 15 min). */
  timeoutMs?: number
  /** Keepalive interval while the turn runs (default 10 s). */
  pingMs?: number
}

export const name = 'gateway-responses'
export const inject = ['webServer', 'workflow', 'store']
export const Config: z<Config> = z.object({
  path: z.string().default('/openai').description('Route prefix; Codex\'s model provider base_url is <origin><path>/v1'),
  tokenDir: z.string().description('Directory of the scope token files (default <DSH_HOME>/system); the gateway takes model.token'),
  allowedHosts: z.array(z.string()).default([...LOOPBACK_HOSTS]),
  models: z.dict(z.union(['economy', 'standard', 'frontier'])).default({}).description('Model-name patterns → tier'),
  classification: z.union(['public', 'operator-shared', 'local-private']).default('operator-shared').description('Classification of what the client sends'),
  timeoutMs: z.natural().min(1000).default(15 * 60_000),
  pingMs: z.natural().min(100).default(10_000),
}) as unknown as z<Config>

export function apply(ctx: Context, config: Config = {}): void {
  const prefix = config.path ?? '/openai'
  const refuse = guard(config)
  const models = config.models ?? {}
  const threads = new Threads(ctx, { scope: 'responses', ...(config.classification ? { classification: config.classification } : {}), ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}) })

  const error = (res: ServerResponse, status: number, type: string, message: string, code: string | null = null): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type, code, message } }))
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice(prefix.length) || '/'
    if (req.method === 'HEAD' || (req.method === 'GET' && (path === '/' || path === '/healthz'))) return void res.writeHead(200).end()
    const refused = refuse(req)
    if (refused) return error(res, refused[0], refused[0] === 401 ? 'authentication_error' : 'permission_error', refused[1])
    if (req.method === 'GET' && path === '/v1/models') {
      const data = (['economy', 'standard', 'frontier'] as const).map((tier) => ({ id: `system-${tier}`, object: 'model', created: 1791763200, owned_by: 'system' }))
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data }))
    }
    // No WebSocket transport: 426 makes clients fall back to SSE.
    if (req.method === 'GET' && path === '/v1/responses') return error(res, 426, 'invalid_request_error', 'use HTTP with server-sent events')
    if (req.method !== 'POST') return error(res, 405, 'invalid_request_error', 'method not allowed')
    if (path !== '/v1/responses') return error(res, 404, 'invalid_request_error', `unknown route ${path}`, 'not_found')
    let request: ResponsesRequest
    try {
      request = await readJsonBody(req, MAX_REQUEST_BYTES) as ResponsesRequest
      if (!request || typeof request.model !== 'string' || (typeof request.input !== 'string' && !Array.isArray(request.input))) {
        throw Object.assign(new Error('model and input are required'), { status: 400 })
      }
    } catch (e) {
      return error(res, (e as { status?: number }).status ?? 400, 'invalid_request_error', (e as Error).message)
    }
    await respond(request, res)
  }

  const respond = async (request: ResponsesRequest, res: ServerResponse): Promise<void> => {
    const id = randomBytes(12).toString('hex')
    const createdAt = Math.floor(Date.now() / 1000)
    const pending: ResponseObject = { id: `resp_${id}`, object: 'response', created_at: createdAt, status: 'in_progress', model: request.model, output: [], usage: null }
    let sequence = 0
    const emit = (event: string, data: Record<string, unknown>): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, sequence_number: sequence++, ...data })}\n\n`)
    }
    let ping: NodeJS.Timeout | undefined
    let closed = false
    res.on('close', () => { closed = true })
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      emit('response.created', { response: pending })
      // A known event that changes nothing keeps the client's idle timer from firing during a long turn.
      ping = setInterval(() => emit('response.in_progress', { response: pending }), config.pingMs ?? 10_000)
    }
    try {
      const tier = tierOf(request.model, models)
      const { system, turns } = turnsOf(request)
      const { tools, freeform } = toolsOf(request)
      const outcome = await threads.exchange({
        key: conversationKey(tier, request, system, turns), tier, system, tools, turns,
        closed: () => closed, newId: () => `call_${randomBytes(12).toString('hex')}`,
      })
      if (outcome.kind === 'closed') return
      if (outcome.kind === 'failed') {
        const code = { overloaded: 'server_is_overloaded', invalid: 'invalid_request', api: 'server_error' }[outcome.error]
        if (!request.stream) return error(res, outcome.status, outcome.error === 'invalid' ? 'invalid_request_error' : 'server_error', outcome.message, code)
        emit('response.failed', { response: { ...pending, status: 'failed', error: { code, message: outcome.message } } })
        return void res.end()
      }
      const response = responseOf(id, request.model, createdAt, outcome.text, outcome.calls, freeform, outcome.promptTokens)
      if (!request.stream) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response))
      for (const [event, data] of streamEvents(response)) emit(event, data)
      res.end()
    } finally {
      clearInterval(ping)
    }
  }

  ctx.effect(() => {
    // The token must not travel in clear text over a network (QA-5): no route on such a bind.
    assertSafeBind({ protocol: ctx.webServer.protocol, host: ctx.webServer.host })
    return ctx.webServer.register({ kind: 'prefix', path: prefix, handler: (req, res) => void handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) error(res, 500, 'server_error', (e as Error).message)
      else res.end()
    }) })
  })
}
