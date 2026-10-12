/**
 * MCP Streamable HTTP endpoint inside the system profile, on DSH `ctx.webServer`
 * (ADR-0011, M0 spike), published as **`ctx.mcp`** so other plugins contribute tools for
 * their own lifetime (everything is a plugin). Claude Code, Codex, and the `system` CLI
 * connect with the URL and bearer token from the 0600 discovery file. `ask`, `research`,
 * and `result` are placeholders that report "not installed" unless the workflow engine
 * (`ctx.workflow`) contributes them.
 * @module @tsuuanmi/system-mcp-server
 */
import { readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { dshHome, ensurePrivateDir, readOrCreateSecretFile, writeFileDurable } from '@tsuuanmi/system-libs'
import { z as zod } from 'zod'
import { assertSafeBind, endpointUrl, guardRequest } from './guard.ts'

export { assertSafeBind, endpointUrl, guardRequest, hostName, tokenMatches } from './guard.ts'


export interface Config {
  path?: string
  tokenFile?: string
  discoveryFile?: string
  allowedHosts?: string[]
  maxBodyBytes?: number
}

export type { ToolHandler, ToolSpec } from '@tsuuanmi/system-gateway-core'

interface Tool {
  spec: ToolSpec
  handler: ToolHandler
  /** Built-in placeholders may be replaced by a contributing plugin. */
  placeholder: boolean
}

const NOT_INSTALLED =
  'The provider runtime is not installed in this build yet; ask/research arrive with MVP slice 1 (milestone M1.5, docs/proposals/roadmap.md).'

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('request body too large'), { status: 413 })
    chunks.push(chunk)
  }
  return size ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : undefined
}

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
    tokenFile: z.string().description('Bearer token secret file; defaults to <DSH_HOME>/system/mcp.token'),
    discoveryFile: z.string().description('0600 discovery file {url, tokenFile, pid}; defaults to <DSH_HOME>/system/mcp.json'),
    allowedHosts: z.array(z.string()).default(['127.0.0.1', 'localhost', '[::1]']).description('Accepted Host header names'),
    maxBodyBytes: z.natural().default(1_048_576).description('Largest accepted request body'),
  })

  private readonly tools = new Map<string, Tool>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.builtins()
    const path = config.path ?? '/mcp'
    const allowedHosts = config.allowedHosts ?? ['127.0.0.1', 'localhost', '[::1]']
    const maxBodyBytes = config.maxBodyBytes ?? 1_048_576
    const tokenFile = config.tokenFile ?? join(dshHome(), 'system', 'mcp.token')
    const discoveryFile = config.discoveryFile ?? join(dshHome(), 'system', 'mcp.json')
    const token = readOrCreateSecretFile(tokenFile, 32).toString('base64url')

    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const verdict = guardRequest(req, { token, allowedHosts })
      if (!verdict.ok) {
        res.writeHead(verdict.status, { 'content-type': 'text/plain' }).end(verdict.reason)
        return
      }
      let body: unknown
      try {
        body = await readBody(req, maxBodyBytes)
      } catch (error) {
        res.writeHead((error as { status?: number }).status ?? 400, { 'content-type': 'text/plain' }).end('invalid request body')
        return
      }
      const server = this.createServer()
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
      writeDiscovery(discoveryFile, { url: endpointUrl(bound, path), tokenFile, pid: process.pid })
      return () => {
        unregister()
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

  /** Build the per-request MCP server from the registered tools. */
  createServer(): McpServer {
    const server = new McpServer({ name: 'system', version: '0.0.0' })
    for (const [name, tool] of this.tools) server.registerTool(name, tool.spec, tool.handler as never)
    return server
  }

  private builtins(): void {
    const notInstalled: ToolHandler = async () => ({ isError: true, content: [{ type: 'text', text: NOT_INSTALLED }] })
    const session = { sessionId: zod.string().max(200).optional().describe('Continue an existing system session') }
    const idempotency = { clientRequestId: zod.string().max(200).optional().describe('Retry-safe request key') }
    const placeholder = (name: string, spec: ToolSpec): void => {
      this.tools.set(name, { spec, handler: notInstalled, placeholder: true })
    }
    placeholder('ask', {
      description: 'Ask a website Worker (separate chat quota). Returns a runId to poll with result.',
      inputSchema: { prompt: zod.string().min(1).max(32_000), tier: zod.enum(['economy', 'standard', 'frontier']).optional(), ...session, ...idempotency },
    })
    placeholder('research', {
      description: 'Research a question with the research profile (hypotheses, a cited review, evidence, critique, conclusions). Returns a runId immediately.',
      inputSchema: { question: zod.string().min(1).max(32_000), ...idempotency },
    })
    placeholder('result', {
      description: 'Fetch the result of a run, waiting up to waitSeconds.',
      inputSchema: { runId: zod.string().max(200), waitSeconds: zod.number().int().min(0).max(55).optional() },
    })
    this.tools.set('status', {
      placeholder: false,
      spec: { description: 'Health of the system harness: stage, store, artifacts, installed providers.', inputSchema: {} },
      handler: async () => {
        const artifacts = this.ctx.get('artifacts')
        const providers = this.ctx.get('providers')
        const status = {
          harness: 'system',
          stage: 'M2',
          store: this.ctx.get('store') ? 'ok' : 'absent',
          artifacts: artifacts ? artifacts.list({ limit: 1000 }).length : null,
          kernel: ['store', 'blobs', 'eventLog', 'leases', 'artifacts', 'credentials'].filter((key) => this.ctx.get(key) !== undefined),
          providers: providers ? providers.list() : [],
        }
        return { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status }
      },
    })
  }
}

export default McpEndpoint
