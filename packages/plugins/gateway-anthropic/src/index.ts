/**
 * The Anthropic Messages gateway (docs/design/gateways.md, ADR-0022): Claude Code points its
 * base URL here and uses a website model as its model. Each request is an `ask` run on the
 * workflow engine (routed, egress-checked, receipted, explainable). A client conversation is
 * bound to one persistent provider conversation by its stable prefix; later requests send only
 * the new suffix (tool results, new user turns). The client's tools reach the model through a
 * text protocol; the client runs every call under its own sandbox and approvals (INV-6).
 * @module @tsuuanmi/system-gateway-anthropic
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { dshHome, readOrCreateSecretFile } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'
import type { RunView } from '@tsuuanmi/system-workflow'
import {
  claimsNoAccess, conversationKey, estimateTokens, type MessagesRequest, messageOf, NUDGE, parseToolCalls, renderOpening, renderSuffix, streamEvents, type Tier, tierOf,
} from './protocol.ts'

export * from './protocol.ts'

export interface Config {
  path?: string
  /** Bearer token file (default: the MCP token). */
  tokenFile?: string
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
  tokenFile: z.string().description('Bearer token file (default: the MCP token)'),
  allowedHosts: z.array(z.string()).default(['127.0.0.1', 'localhost', '[::1]']),
  models: z.dict(z.union(['economy', 'standard', 'frontier'])).default({ haiku: 'economy' }).description('Model-name patterns → tier'),
  classification: z.union(['public', 'operator-shared', 'local-private']).default('operator-shared').description('Classification of what the client sends'),
  timeoutMs: z.natural().min(1000).default(15 * 60_000),
  pingMs: z.natural().min(100).default(10_000),
}) as unknown as z<Config>

const MAX_BODY = 16 * 1024 * 1024

interface Conversation {
  key: string
  session_id: string
  sent: number
  names: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const prefix = config.path ?? '/anthropic'
  const token = readOrCreateSecretFile(config.tokenFile ?? join(dshHome(), 'system', 'mcp.token'), 32).toString('base64url')
  const hosts = config.allowedHosts ?? ['127.0.0.1', 'localhost', '[::1]']
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  const models = config.models ?? { haiku: 'economy' }

  ctx.store.migrate('gateway-anthropic', [{
    version: 1,
    sql: 'CREATE TABLE gateway_conversations (key TEXT PRIMARY KEY, session_id TEXT NOT NULL, sent INTEGER NOT NULL, names TEXT NOT NULL, updated_at TEXT NOT NULL);',
  }])

  /** Loopback host, no browser Origin, the bearer token (or x-api-key): or why not. */
  const refuse = (req: IncomingMessage): [number, string] | undefined => {
    if (!hosts.includes((req.headers.host ?? '').replace(/:\d+$/, ''))) return [421, 'host not allowed']
    if (req.headers.origin !== undefined) return [403, 'browser origins are not accepted']
    const header = req.headers.authorization ?? ''
    const presented = /^bearer /i.test(header) ? header.slice(7) : String(req.headers['x-api-key'] ?? '')
    if (!timingSafeEqual(digest(presented), digest(token))) return [401, 'missing or invalid token']
    return undefined
  }

  const error = (res: ServerResponse, status: number, type: string, message: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type, message } }))
  }

  const readBody = async (req: IncomingMessage): Promise<MessagesRequest> => {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) throw Object.assign(new Error('request too large'), { status: 413 })
      chunks.push(chunk as Buffer)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MessagesRequest
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages) || !body.messages.length) {
      throw Object.assign(new Error('model and messages are required'), { status: 400 })
    }
    return body
  }

  /** Where this request goes: the bound conversation's new suffix, or a new conversation. */
  const plan = (request: MessagesRequest, tier: Tier): { key: string; prompt: string; sessionId?: string; names: Map<string, string> } => {
    const key = conversationKey(tier, request)
    const bound = ctx.store.db.prepare('SELECT * FROM gateway_conversations WHERE key = ?').get(key) as Conversation | undefined
    const names = new Map<string, string>(bound ? (JSON.parse(bound.names) as Array<[string, string]>) : [])
    for (const message of request.messages) {
      if (typeof message.content !== 'string') for (const b of message.content) if (b.type === 'tool_use' && b.id && b.name) names.set(b.id, b.name)
    }
    if (bound && request.messages.length > bound.sent) {
      return { key, prompt: renderSuffix(request.messages.slice(bound.sent), names), sessionId: bound.session_id, names }
    }
    return { key, prompt: renderOpening(request, names), names }
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
      request = await readBody(req)
    } catch (e) {
      return error(res, (e as { status?: number }).status ?? 400, 'invalid_request_error', (e as Error).message)
    }
    const tier = tierOf(request.model, models)
    const route = plan(request, tier)
    if (path === '/v1/messages/count_tokens') {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: estimateTokens(renderOpening(request, route.names)) }))
    }
    if (path !== '/v1/messages') return error(res, 404, 'not_found_error', `unknown route ${path}`)
    await messages(request, tier, route, res)
  }

  type Outcome = { run: RunView } | { failed: [status: number, type: string, message: string] } | { closed: true }

  /** One ask run on the engine, waited for while the client stays connected. */
  const turn = async (prompt: string, tier: Tier, sessionId: string | undefined, isClosed: () => boolean, deadline: number): Promise<Outcome> => {
    let run: RunView
    try {
      run = ctx.workflow.start({
        template: 'ask', input: prompt, tier, classification: config.classification ?? 'operator-shared',
        ...(sessionId ? { sessionId } : { persist: true }),
      })
    } catch (e) {
      const overloaded = (e as { kind?: string }).kind === 'overloaded'
      return { failed: [overloaded ? 529 : 400, overloaded ? 'overloaded_error' : 'invalid_request_error', (e as Error).message] }
    }
    while (run.status === 'running' && Date.now() < deadline && !isClosed()) run = await ctx.workflow.wait(run.runId, Math.min(30_000, deadline - Date.now()))
    if (isClosed()) return { closed: true }
    if (run.status === 'completed') return { run }
    const message = run.status === 'running' ? `run ${run.runId} did not finish in time` : `${run.error?.kind ?? 'failed'}: ${run.error?.message ?? ''} (system explain ${run.runId})`
    const backoff = run.error?.disposition === 'BACKOFF'
    return { failed: [backoff ? 529 : 500, backoff ? 'overloaded_error' : 'api_error', message] }
  }

  const messages = async (request: MessagesRequest, tier: Tier, route: ReturnType<typeof plan>, res: ServerResponse): Promise<void> => {
    let ping: NodeJS.Timeout | undefined
    let closed = false
    res.on('close', () => { closed = true })
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      ping = setInterval(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), config.pingMs ?? 10_000)
    }
    const fail = (status: number, type: string, message: string): void => {
      if (request.stream) return void res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`)
      return error(res, status, type, message)
    }
    try {
      const deadline = Date.now() + (config.timeoutMs ?? 15 * 60_000)
      const offered = new Set((request.tools ?? []).map((t) => t.name))
      const newId = (): string => `toolu_${randomBytes(12).toString('hex')}`
      let outcome = await turn(route.prompt, tier, route.sessionId, () => closed, deadline)
      if ('closed' in outcome) return
      if ('failed' in outcome) return fail(...outcome.failed)
      let { run } = outcome
      let parsed = parseToolCalls(run.answer ?? '', offered, newId)
      // A web model sometimes forgets that the agent runs its tools: one nudge, in the same conversation.
      if (offered.size && !parsed.calls.length && claimsNoAccess(parsed.text) && run.sessionId) {
        outcome = await turn(NUDGE, tier, run.sessionId, () => closed, deadline)
        if ('closed' in outcome) return
        if ('run' in outcome) {
          run = outcome.run
          parsed = parseToolCalls(run.answer ?? '', offered, newId)
        }
      }
      for (const call of parsed.calls) route.names.set(call.id, call.name)
      // The provider conversation has seen every client message so far, and the reply it gave.
      ctx.store.db.prepare(`INSERT INTO gateway_conversations (key, session_id, sent, names, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET session_id = excluded.session_id, sent = excluded.sent, names = excluded.names, updated_at = excluded.updated_at`)
        .run(route.key, run.sessionId ?? route.sessionId ?? '', request.messages.length + 1, JSON.stringify([...route.names].slice(-500)), new Date().toISOString())
      const message = messageOf(`msg_${run.runId}`, request.model, parsed.text, parsed.calls, estimateTokens(route.prompt))
      if (!request.stream) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message))
      for (const [event, data] of streamEvents(message)) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      res.end()
    } finally {
      clearInterval(ping)
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: prefix, handler: (req, res) => void handle(req, res).catch((e: unknown) => {
    if (!res.headersSent) error(res, 500, 'api_error', (e as Error).message)
    else res.end()
  }) }))
}
