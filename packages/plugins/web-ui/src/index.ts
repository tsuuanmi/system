/**
 * The operator's web UI (REQ-HOST "Web UI: status, watch"): runs, their steps, and each
 * step's decision chain, plus the operator's approve, stop, and continue. It is served on the
 * DSH webserver under `/ui`, which is loopback-only:
 * - the page and script carry no data, under a strict content security policy;
 * - the token arrives in the URL fragment (never sent to a server), and the script sends it as
 *   a bearer token to `/ui/api`;
 * - the API accepts a loopback host only, no foreign Origin, and the token in constant time.
 * @module @tsuuanmi/system-web-ui
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { dshHome, readOrCreateSecretFile } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-workflow'
import { APP_CSS, APP_JS, PAGE } from './assets.ts'

export interface Config {
  /** The bearer token file shared with the MCP endpoint (default `<DSH_HOME>/system/mcp.token`). */
  tokenFile?: string
  allowedHosts?: string[]
}

export const name = 'web-ui'
export const inject = ['webServer', 'workflow']
export const Config: z<Config> = z.object({
  tokenFile: z.string().description('Bearer token file (default: the MCP token)'),
  allowedHosts: z.array(z.string()).default(['127.0.0.1', 'localhost', '[::1]']).description('Host names the UI answers'),
}) as unknown as z<Config>

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const MAX_BODY = 16_384

export function apply(ctx: Context, config: Config = {}): void {
  const token = readOrCreateSecretFile(config.tokenFile ?? join(dshHome(), 'system', 'mcp.token'), 32).toString('base64url')
  const hosts = config.allowedHosts ?? ['127.0.0.1', 'localhost', '[::1]']
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

  const send = (res: ServerResponse, status: number, body: string, type: string): void => {
    res.writeHead(status, {
      'content-type': type, 'cache-control': 'no-store', 'content-security-policy': CSP,
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    }).end(body)
  }
  const json = (res: ServerResponse, status: number, value: unknown): void => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8')

  /** Loopback host, no foreign Origin, the bearer token: or the reason it is refused. */
  const refuse = (req: IncomingMessage): [number, string] | undefined => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (!hosts.includes(host)) return [421, 'host not allowed']
    const origin = req.headers.origin
    if (origin !== undefined && origin !== `http://${req.headers.host}`) return [403, 'foreign origin']
    const header = req.headers.authorization ?? ''
    const presented = /^bearer /i.test(header) ? header.slice(7) : ''
    if (!timingSafeEqual(digest(presented), digest(token))) return [401, 'missing or invalid token']
    return undefined
  }

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('a JSON body is required'), { status: 415 })
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 })
      chunks.push(chunk as Buffer)
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('a JSON object is required'), { status: 400 })
    return value as Record<string, unknown>
  }

  const api = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const refused = refuse(req)
    if (refused) return json(res, refused[0], { error: refused[1] })
    const workflow = ctx.workflow
    if (req.method === 'GET' && path === 'runs') return json(res, 200, { runs: workflow.usage(100) })
    const match = /^runs\/([A-Za-z0-9_-]{1,100})(?:\/(approve|stop|continue))?$/.exec(path)
    if (!match) return json(res, 404, { error: 'not found' })
    const [, runId, action] = match as unknown as [string, string, string | undefined]
    if (!action && req.method === 'GET') {
      const run = workflow.get(runId)
      return run ? json(res, 200, { run, explain: workflow.explain(runId) }) : json(res, 404, { error: `unknown run ${runId}` })
    }
    if (!action || req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    try {
      const body = await readJson(req)
      if (action === 'approve') {
        if (body.verdict !== 'approved' && body.verdict !== 'rejected') return json(res, 400, { error: 'verdict must be approved or rejected' })
        const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : undefined
        return json(res, 200, { run: workflow.approve(runId, { verdict: body.verdict, ...(note ? { note } : {}) }) })
      }
      if (action === 'stop') return json(res, 200, { run: await workflow.stop(runId, typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : undefined) })
      return json(res, 200, { run: workflow.continue(runId, typeof body.nodeId === 'string' ? body.nodeId : undefined) })
    } catch (error) {
      const status = (error as { status?: number }).status ?? 409
      return json(res, status, { error: (error as Error).message })
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/^\/ui\/?/, '')
    if (path.startsWith('api/')) return api(req, res, path.slice(4))
    if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain')
    if (path === '' ) return send(res, 200, PAGE, 'text/html; charset=utf-8')
    if (path === 'app.js') return send(res, 200, APP_JS, 'text/javascript; charset=utf-8')
    if (path === 'app.css') return send(res, 200, APP_CSS, 'text/css; charset=utf-8')
    return send(res, 404, 'not found', 'text/plain')
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/ui', handler }))
}
