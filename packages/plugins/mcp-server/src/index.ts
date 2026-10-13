/**
 * MCP Streamable HTTP endpoint inside the system profile, on DSH `ctx.webServer`
 * (ADR-0011, M0 spike), published as **`ctx.mcp`** so other plugins contribute tools for
 * their own lifetime (everything is a plugin). Claude Code, Codex, and the `system` CLI
 * connect with the URL from the 0600 discovery file and a scope's bearer token (ADR-0023): the
 * operator token reaches every tool, the client token only client tools. `ask`, `research`,
 * and `result` are placeholders that report "not installed" unless the workflow engine
 * (`ctx.workflow`) contributes them.
 * @module @tsuuanmi/system-mcp-server
 */
import { readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { assertSafeBind, endpointUrl, guardRequest, LOOPBACK_HOSTS, McpTools, readJsonBody, scopeTokens, SCOPES, tokenFile, type ToolHandler, type ToolScope, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { dshHome, ensurePrivateDir, registerSecretPath, writeFileDurable } from '@tsuuanmi/system-libs'
import { type HealthReport, healthReport } from './health.ts'
import { z as zod } from 'zod'



export interface Config {
  path?: string
  tokenDir?: string
  discoveryFile?: string
  allowedHosts?: string[]
  maxBodyBytes?: number
  /** Free space under the DSH home below which health is degraded (default 1 GiB). */
  minFreeBytes?: number
  /** How far back a provider UI change keeps health degraded (default 24 h). */
  driftWindowHours?: number
}

export type { ToolContext, ToolHandler, ToolScope, ToolSpec } from '@tsuuanmi/system-gateway-core'

interface Tool {
  spec: ToolSpec
  handler: ToolHandler
  /** Built-in placeholders may be replaced by a contributing plugin. */
  placeholder: boolean
}

/** Whether a caller holding `scope` may see and call a tool of `tool` scope. */
const visible = (tool: ToolScope, scope: ToolScope): boolean => scope === 'operator' || tool === 'client'

const NOT_INSTALLED =
  'The workflow engine is not mounted in this composition, so this tool has nothing to run; mount the workflow plugin (the system bundle does).'

function writeDiscovery(path: string, contents: object): void {
  ensurePrivateDir(dirname(path))
  writeFileDurable(path, `${JSON.stringify(contents, null, 2)}\n`, 0o600)
}

/** Remove the discovery file only if this process wrote it (another instance may share DSH_HOME). */
function removeOwnDiscovery(path: string): void {
  try {
    const { pid } = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number }
    if (pid === process.pid) rmSync(path, { force: true })
  } catch {
    // absent or unreadable: nothing of ours to remove
  }
}

export class McpEndpoint extends McpTools {
  static inject = ['webServer']

  static Config: z<Config> = z.object({
    path: z.string().default('/mcp').description('Route on the DSH webserver'),
    tokenDir: z.string().description('Directory of the scope token files operator.token, client.token, model.token; defaults to <DSH_HOME>/system'),
    discoveryFile: z.string().description('0600 discovery file {url, tokenFiles, pid}; defaults to <DSH_HOME>/system/mcp.json'),
    allowedHosts: z.array(z.string()).default([...LOOPBACK_HOSTS]).description('Accepted Host header names'),
    maxBodyBytes: z.natural().default(1_048_576).description('Largest accepted request body'),
    minFreeBytes: z.natural().default(2 ** 30).description('Free space under the DSH home below which health is degraded'),
    driftWindowHours: z.natural().min(1).default(24).description('How long a provider UI change keeps health degraded'),
  })

  private readonly tools = new Map<string, Tool>()

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx)
    this.builtins()
    const path = config.path ?? '/mcp'
    const allowedHosts = config.allowedHosts ?? LOOPBACK_HOSTS
    const maxBodyBytes = config.maxBodyBytes ?? 1_048_576
    const tokenDir = config.tokenDir ?? join(dshHome(), 'system')
    const discoveryFile = config.discoveryFile ?? join(dshHome(), 'system', 'mcp.json')
    // Every scope's token exists once the endpoint runs, so the CLI can hand each one out.
    const tokens = scopeTokens(tokenDir)
    const tokenFiles = Object.fromEntries(SCOPES.map((scope) => [scope, tokenFile(tokenDir, scope)]))
    // Agent Workers never read a control token, wherever tokenDir puts them (ADR-0024).
    ctx.effect(() => {
      const unregister = Object.values(tokenFiles).map(registerSecretPath)
      return () => unregister.forEach((u) => u())
    })

    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      // The model token reaches only the model gateways, never /mcp.
      const verdict = guardRequest(req, { tokens: { operator: tokens.operator, client: tokens.client }, allowedHosts })
      if (!verdict.ok) {
        res.writeHead(verdict.status, { 'content-type': 'text/plain' }).end(verdict.reason)
        return
      }
      const scope = verdict.scope as ToolScope
      let body: unknown
      try {
        body = await readJsonBody(req, maxBodyBytes)
      } catch (error) {
        res.writeHead((error as { status?: number }).status ?? 400, { 'content-type': 'text/plain' }).end('invalid request body')
        return
      }
      const denied = this.outOfScope(body, scope)
      if (denied) {
        // The MCP authorization error for a token without the scope a call needs.
        res.writeHead(403, { 'content-type': 'application/json', 'www-authenticate': `Bearer error="insufficient_scope", scope="${denied.scope}"` })
          .end(JSON.stringify({ error: 'insufficient_scope', error_description: `tool ${denied.tool} needs the ${denied.scope} scope` }))
        return
      }
      const server = this.createServer(scope)
      // Stateless mode needs an explicit `sessionIdGenerator: undefined`; the SDK's option and
      // Transport types are not written for exactOptionalPropertyTypes, hence the boundary casts.
      type TransportOptions = ConstructorParameters<typeof StreamableHTTPServerTransport>[0]
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as unknown as TransportOptions)
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport as unknown as Transport)
      await transport.handleRequest(req, res, body)
    }

    ctx.effect(() => {
      const bound = { protocol: ctx.webServer.protocol, host: ctx.webServer.host, port: ctx.webServer.port }
      assertSafeBind(bound)
      const unregister = ctx.webServer.register({ kind: 'exact', path, handler })
      // Liveness for a supervisor: no token, no data, just that the host answers.
      const unregisterLive = ctx.webServer.register({ kind: 'exact', path: '/healthz', handler: (req, res) => {
        res.writeHead(req.method === 'GET' || req.method === 'HEAD' ? 200 : 405, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(req.method === 'GET' ? 'ok' : undefined)
      } })
      writeDiscovery(discoveryFile, { url: endpointUrl(bound, path), tokenFiles, pid: process.pid })
      return () => {
        unregister()
        unregisterLive()
        removeOwnDiscovery(discoveryFile)
      }
    })
  }

  /**
   * Contribute a tool for the calling plugin's lifetime. A built-in placeholder (such as
   * `ask` before the runtime is installed) may be replaced; any other name is unique.
   */
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    const existing = this.tools.get(name)
    if (existing && !existing.placeholder) throw new Error(`MCP tool ${name} is already registered`)
    const tool: Tool = { spec, handler, placeholder: false }
    this.ctx.effect(() => {
      this.tools.set(name, tool)
      return () => {
        if (this.tools.get(name) !== tool) return
        if (existing) this.tools.set(name, existing)
        else this.tools.delete(name)
      }
    })
  }

  /** Build the per-request MCP server from the tools a caller holding `scope` may use. */
  createServer(scope: ToolScope): McpServer {
    const server = new McpServer({ name: 'system', version: '0.0.0' })
    for (const [name, tool] of this.tools) {
      const { scope: declared = 'operator', ...spec } = tool.spec
      // The SDK passes (args, extra) to a tool with an input schema and (extra) alone otherwise.
      const handler = (args: unknown, extra: unknown): ReturnType<ToolHandler> => tool.handler((extra === undefined ? {} : args) as Record<string, unknown>, { scope })
      if (visible(declared, scope)) server.registerTool(name, { ...spec, _meta: { 'system/scope': declared } }, handler as never)
    }
    return server
  }

  /** The first registered tool a JSON-RPC message (or batch) calls that `scope` may not use. */
  private outOfScope(body: unknown, scope: ToolScope): { tool: string; scope: ToolScope } | undefined {
    for (const message of Array.isArray(body) ? body : [body]) {
      const call = message as { method?: unknown; params?: { name?: unknown } } | null
      if (call?.method !== 'tools/call' || typeof call.params?.name !== 'string') continue
      const declared = this.tools.get(call.params.name)?.spec.scope ?? 'operator'
      if (this.tools.has(call.params.name) && !visible(declared, scope)) return { tool: call.params.name, scope: declared }
    }
    return undefined
  }

  /** The health report; a client caller sees each check's state, the operator also what to do. */
  private async health(scope: ToolScope): Promise<HealthReport> {
    const store = this.ctx.get('store')
    const accounts = this.ctx.get('accounts')
    const workers = this.ctx.get('workers')
    const eventLog = this.ctx.get('eventLog')
    const report = await healthReport({
      dshHome: dshHome(),
      ...(store ? { storeCheck: () => String(Object.values(store.db.prepare('PRAGMA quick_check(1)').get() ?? {})[0]) } : {}),
      ...(accounts ? { accounts: async () => (await accounts.list()).map((a: { id: string; status: string }) => ({ id: a.id, status: a.status })) } : {}),
      ...(workers ? { workers: async () => (await workers.list()).map((w: { worker: string; state: string }) => ({ worker: w.worker, state: w.state })) } : {}),
      ...(eventLog ? { events: (type: string, since: string) => eventLog.query({ type, limit: 1000 }).filter((e: { at: string }) => e.at >= since) } : {}),
      minFreeBytes: this.config.minFreeBytes ?? 2 ** 30,
      driftWindowMs: (this.config.driftWindowHours ?? 24) * 60 * 60_000,
    })
    return scope === 'operator' ? report : { state: report.state, checks: report.checks.map((c) => ({ ...c, detail: c.state === 'ok' ? c.detail : 'ask the operator' })) }
  }

  private builtins(): void {
    // The event log, for the operator (QA-7): by run, session, or type, in order, after a cursor.
    this.tools.set('events', {
      placeholder: false,
      spec: {
        scope: 'operator',
        description: 'Read the event log in order (QA-7): entries after a cursor, optionally for one run, session, or type. Pass the last seq back as afterSeq for the next page.',
        inputSchema: {
          runId: zod.string().max(200).optional(), sessionId: zod.string().max(200).optional(), type: zod.string().max(200).optional(),
          afterSeq: zod.number().int().min(0).optional(), limit: zod.number().int().min(1).max(1000).optional(),
        },
      },
      handler: async (args) => {
        const eventLog = this.ctx.get('eventLog')
        if (!eventLog) return { isError: true, content: [{ type: 'text', text: 'the event log is not mounted in this composition' }] }
        const filter = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))
        const events = eventLog.query(filter) as Array<{ seq: number }>
        const page = { events, next: events.at(-1)?.seq ?? (args.afterSeq as number | undefined) ?? 0 }
        return { content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: page }
      },
    })
    const notInstalled: ToolHandler = async () => ({ isError: true, content: [{ type: 'text', text: NOT_INSTALLED }] })
    const session = { sessionId: zod.string().max(200).optional().describe('Continue an existing system session') }
    const idempotency = { clientRequestId: zod.string().max(200).optional().describe('Retry-safe request key') }
    const placeholder = (name: string, spec: ToolSpec): void => {
      this.tools.set(name, { spec, handler: notInstalled, placeholder: true })
    }
    placeholder('ask', {
      scope: 'client',
      description: 'Ask a website Worker (separate chat quota). Returns a runId to poll with result.',
      inputSchema: { prompt: zod.string().min(1).max(32_000), tier: zod.enum(['economy', 'standard', 'frontier']).optional(), ...session, ...idempotency },
    })
    placeholder('research', {
      scope: 'client',
      description: 'Research a question with the research profile (hypotheses, a cited review, evidence, critique, conclusions). Returns a runId immediately.',
      inputSchema: { question: zod.string().min(1).max(32_000), ...idempotency },
    })
    placeholder('result', {
      scope: 'client',
      description: 'Fetch the result of a run, waiting up to waitSeconds.',
      inputSchema: { runId: zod.string().max(200), waitSeconds: zod.number().int().min(0).max(55).optional() },
    })
    this.tools.set('status', {
      placeholder: false,
      spec: { scope: 'client', description: 'Health of the system harness: each check (runtime, store, disk, vault key, accounts, Workers, provider UI drift) and the worst of them, with what to do for operator callers; plus the kernel services and installed providers.', inputSchema: {} },
      handler: async (_args, { scope }) => {
        const artifacts = this.ctx.get('artifacts')
        const providers = this.ctx.get('providers')
        const status = {
          harness: 'system',
          store: this.ctx.get('store') ? 'ok' : 'absent',
          artifacts: artifacts ? artifacts.list({ limit: 1000 }).length : null,
          kernel: ['store', 'eventLog', 'leases', 'artifacts', 'credentials'].filter((key) => this.ctx.get(key) !== undefined),
          providers: providers ? providers.list() : [],
          health: await this.health(scope),
        }
        return { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status }
      },
    })
  }
}

export default McpEndpoint
