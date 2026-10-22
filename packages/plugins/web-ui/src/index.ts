/**
 * The operator's web UI (REQ-HOST "Web UI: status, watch"): runs, their steps, and each
 * step's decision chain, plus the operator's approve, deciding vote on a tie, stop, and continue;
 * and, when `ctx.approvals` is present, the approval queue by batch with the operator's verdicts
 * (docs/design/approvals.md). It is served on the DSH webserver under `/ui`, which is loopback-only:
 * - the page and script carry no data, under a strict content security policy;
 * - the token arrives in the URL fragment (never sent to a server), and the script sends it as
 *   a bearer token to `/ui/api`;
 * - the API accepts a loopback host only, no foreign Origin, and the operator token in constant time.
 * @module @tsuuanmi/system-web-ui
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { assertSafeBind, guardRequest, LOOPBACK_HOSTS, readJsonBody, scopeToken, tokenFile } from '@tsuuanmi/system-gateway-core'
import { type ApprovalRequest, ApprovalsError, type Subject, type Verdict } from '@tsuuanmi/system-approvals-core'
import { dshHome, registerSecretPath } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-workflow'
import { APP_CSS, APP_JS, PAGE } from './assets.ts'

export interface Config {
  /** Directory of the scope token files (default `<DSH_HOME>/system`); the UI takes `operator.token` (ADR-0023). */
  tokenDir?: string
  allowedHosts?: string[]
}

export const name = 'web-ui'
export const inject = ['webServer', 'workflow']
export const Config: z<Config> = z.object({
  tokenDir: z.string().description('Directory of the scope token files (default <DSH_HOME>/system); the UI takes operator.token'),
  allowedHosts: z.array(z.string()).default([...LOOPBACK_HOSTS]).description('Host names the UI answers'),
}) as unknown as z<Config>

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const MAX_BODY = 16_384
/** Verdicts one call takes at most, as `approvals_decide` does (a batch holds at most 50). */
export const MAX_VERDICTS = 50
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const SUBJECT_TYPES: ReadonlyArray<Subject['type']> = ['content', 'git-head', 'pull-request', 'artifact', 'external']

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const noteOf = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : undefined

/**
 * One verdict as the page sent it, with the exact subject the page showed (INV-5), or why it is
 * refused. A verdict with no note of its own takes the call's `note`.
 */
function verdictOf(value: unknown, note: string | undefined): Verdict | string {
  if (!isObject(value)) return 'a verdict is {requestId, subject, verdict, note?}'
  const { requestId, subject, verdict } = value
  if (typeof requestId !== 'string' || !ID.test(requestId)) return 'requestId is not a request id'
  if (verdict !== 'approved' && verdict !== 'rejected') return 'verdict must be approved or rejected'
  if (!isObject(subject) || !SUBJECT_TYPES.includes(subject.type as Subject['type']) || typeof subject.ref !== 'string' || !subject.ref || subject.ref.length > 512
    || (subject.version !== undefined && (typeof subject.version !== 'string' || subject.version.length > 128))) return 'subject must be the exact subject the page showed'
  const own = noteOf(value.note) ?? note
  return { requestId, subject: { type: subject.type as Subject['type'], ref: subject.ref, ...(subject.version !== undefined ? { version: subject.version as string } : {}) }, verdict, ...(own ? { note: own } : {}) }
}

/** Open and batched requests in listing order (by batch, then expiry), grouped by batch; the unbatched last. */
export function byBatch(requests: readonly ApprovalRequest[]): Array<{ batchId?: string; requests: ApprovalRequest[] }> {
  const groups: Array<{ batchId?: string; requests: ApprovalRequest[] }> = []
  for (const request of requests) {
    const last = groups.at(-1)
    if (last && last.batchId === request.batchId) last.requests.push(request)
    else groups.push({ ...(request.batchId ? { batchId: request.batchId } : {}), requests: [request] })
  }
  return groups
}

export function apply(ctx: Context, config: Config = {}): void {
  const operator = scopeToken(config.tokenDir ?? join(dshHome(), 'system'), 'operator')
  // Agent Workers never read the operator token, wherever tokenDir puts it (ADR-0024).
  ctx.effect(() => registerSecretPath(tokenFile(config.tokenDir ?? join(dshHome(), 'system'), 'operator')))
  const hosts = config.allowedHosts ?? LOOPBACK_HOSTS

  const send = (res: ServerResponse, status: number, body: string, type: string): void => {
    res.writeHead(status, {
      'content-type': type, 'cache-control': 'no-store', 'content-security-policy': CSP,
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    }).end(body)
  }
  const json = (res: ServerResponse, status: number, value: unknown): void => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8')

  /** Loopback host, no foreign Origin, the bearer token: or the reason it is refused. */
  const refuse = (req: IncomingMessage): [number, string] | undefined => {
    const verdict = guardRequest(req, { tokens: { operator }, allowedHosts: hosts, sameOrigin: true })
    return verdict.ok ? undefined : [verdict.status, verdict.reason]
  }

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('a JSON body is required'), { status: 415 })
    const value = (await readJsonBody(req, MAX_BODY)) ?? {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Object.assign(new Error('a JSON object is required'), { status: 400 })
    return value as Record<string, unknown>
  }

  /**
   * The approval queue, when `ctx.approvals` is present (else 503): `GET approvals` lists open and
   * batched requests by batch; `POST approvals/decide` takes the operator's verdicts, each on the
   * exact subject the page showed. With `batchId`, every verdict must be for a request of that
   * batch, or nothing is decided. The UI is the operator's channel (ADR-0023): its verdicts go to
   * `ctx.approvals.decide` as the operator's (INV-6), at the wall clock.
   */
  const queue = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const approvals = ctx.get('approvals')
    if (!approvals) return json(res, 503, { error: 'the approval queue is not running' })
    if (path === 'approvals') return req.method === 'GET' ? json(res, 200, { batches: byBatch(await approvals.list()) }) : json(res, 405, { error: 'method not allowed' })
    if (path !== 'approvals/decide') return json(res, 404, { error: 'not found' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    try {
      const body = await readJson(req)
      const list = body.verdicts
      if (!Array.isArray(list) || !list.length || list.length > MAX_VERDICTS) return json(res, 400, { error: `verdicts must be a list of 1 to ${MAX_VERDICTS}` })
      const note = noteOf(body.note)
      const verdicts: Verdict[] = []
      for (const [i, value] of list.entries()) {
        const verdict = verdictOf(value, note)
        if (typeof verdict === 'string') return json(res, 400, { error: `verdict ${i}: ${verdict}; nothing was decided` })
        verdicts.push(verdict)
      }
      if (body.batchId !== undefined) {
        if (typeof body.batchId !== 'string' || !ID.test(body.batchId)) return json(res, 400, { error: 'batchId is not a batch id' })
        // A batch verdict counts only for the requests of the batch the page showed.
        for (const v of verdicts) {
          if ((await approvals.get(v.requestId))?.batchId !== body.batchId) return json(res, 409, { error: `${v.requestId} is not in batch ${body.batchId}; nothing was decided` })
        }
      }
      return json(res, 200, { results: await approvals.decide(verdicts, new Date()) })
    } catch (error) {
      const status = error instanceof ApprovalsError ? 400 : (error as { status?: number }).status ?? 409
      return json(res, status, { error: (error as Error).message })
    }
  }

  const api = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const refused = refuse(req)
    if (refused) return json(res, refused[0], { error: refused[1] })
    if (path === 'approvals' || path.startsWith('approvals/')) return queue(req, res, path)
    const workflow = ctx.workflow
    if (req.method === 'GET' && path === 'runs') return json(res, 200, { runs: workflow.usage(100) })
    const match = /^runs\/([A-Za-z0-9_-]{1,100})(?:\/(approve|vote|stop|continue))?$/.exec(path)
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
        // The plan the page showed: the engine decides only that one (INV-5).
        const plan = typeof body.plan === 'string' && /^sha256:[0-9a-f]+$/.test(body.plan) ? body.plan : undefined
        return json(res, 200, { run: workflow.approve(runId, { verdict: body.verdict, ...(note ? { note } : {}), ...(plan ? { plan } : {}) }) })
      }
      if (action === 'vote') {
        // The tie the page showed: the engine decides only that one. The UI is the operator's (ADR-0023).
        const decision = typeof body.decision === 'string' && /^sha256:[0-9a-f]+$/.test(body.decision) ? body.decision : undefined
        const option = typeof body.option === 'string' && /^[A-Za-z0-9-]{1,16}$/.test(body.option) ? body.option : undefined
        const rationale = typeof body.rationale === 'string' ? body.rationale.trim().slice(0, 2000) : ''
        if (!decision || !option || !rationale) return json(res, 400, { error: 'a vote needs the tie decision, an option, and a rationale' })
        return json(res, 200, { run: workflow.vote(runId, { decision, option, rationale, by: 'operator' }) })
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

  ctx.effect(() => {
    // The token must not travel in clear text over a network (QA-5): no route on such a bind.
    assertSafeBind({ protocol: ctx.webServer.protocol, host: ctx.webServer.host })
    return ctx.webServer.register({ kind: 'prefix', path: '/ui', handler })
  })
}
