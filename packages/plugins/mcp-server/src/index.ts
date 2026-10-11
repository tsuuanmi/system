/**
 * MCP Streamable HTTP endpoint inside the system profile, on DSH `ctx.webServer`
 * (ADR-0011, M0 spike). Claude Code and Codex connect with the URL and bearer token from
 * the 0600 discovery file. Tools follow the MVP slice 1 surface; `ask`, `research`, and
 * `result` report "not installed" until the provider runtime lands (M1.5).
 * @module @tsuuanmi/system-mcp-server
 */
import { randomBytes } from 'node:crypto'
import { constants, closeSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { dshHome, ensurePrivateDir, readOrCreateSecretFile } from '@tsuuanmi/system-libs'
import { z as zod } from 'zod'
import { guardRequest } from './guard.ts'

export { guardRequest, hostName, tokenMatches } from './guard.ts'

export const name = 'system-mcp-server'
export const inject = ['webServer']

export interface Config {
  path?: string
  tokenFile?: string
  discoveryFile?: string
  allowedHosts?: string[]
  maxBodyBytes?: number
}

export const Config: z<Config> = z.object({
  path: z.string().default('/mcp').description('Route on the DSH webserver'),
  tokenFile: z.string().description('Bearer token secret file; defaults to <DSH_HOME>/system/mcp.token'),
  discoveryFile: z.string().description('0600 discovery file {url, tokenFile, pid}; defaults to <DSH_HOME>/system/mcp.json'),
  allowedHosts: z.array(z.string()).default(['127.0.0.1', 'localhost', '[::1]']).description('Accepted Host header names'),
  maxBodyBytes: z.natural().default(1_048_576).description('Largest accepted request body'),
})

const NOT_INSTALLED =
  'The provider runtime is not installed in this build yet; ask/research arrive with MVP slice 1 (milestone M1.5, docs/proposals/roadmap.md).'

/** Build the per-request MCP server with the slice 1 tool surface. */
export function createMcpServer(ctx: Context): McpServer {
  const server = new McpServer({ name: 'system', version: '0.0.0' })
  const notInstalled = async () => ({ isError: true, content: [{ type: 'text' as const, text: NOT_INSTALLED }] })
  const session = { sessionId: zod.string().max(200).optional().describe('Continue an existing system session') }
  const idempotency = { clientRequestId: zod.string().max(200).optional().describe('Retry-safe request key') }

  server.registerTool('ask', {
    description: 'Ask a website Worker (separate chat quota). Returns a sessionId to poll with status/result.',
    inputSchema: { prompt: zod.string().min(1).max(32_000), tier: zod.enum(['economy', 'standard', 'frontier']).optional(), ...session, ...idempotency },
  }, notInstalled)
  server.registerTool('research', {
    description: 'Run provider-native Deep Research on a website Worker. Returns a sessionId immediately.',
    inputSchema: { question: zod.string().min(1).max(32_000), ...session, ...idempotency },
  }, notInstalled)
  server.registerTool('result', {
    description: 'Fetch the result of a session, with an opaque cursor for long-polling.',
    inputSchema: { sessionId: zod.string().max(200), cursor: zod.string().max(200).optional() },
  }, notInstalled)
  server.registerTool('status', {
    description: 'Health of the system harness: stage, store, artifacts, installed providers.',
    inputSchema: {},
  }, async () => {
    const artifacts = ctx.get('artifacts')
    const status = {
      harness: 'system',
      stage: 'M0',
      store: ctx.get('store') ? 'ok' : 'absent',
      artifacts: artifacts ? artifacts.list({ limit: 1000 }).length : null,
      kernel: ['store', 'blobs', 'eventLog', 'leases', 'artifacts', 'credentials'].filter((key) => ctx.get(key) !== undefined),
      providers: [] as string[],
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(status) }], structuredContent: status }
  })
  return server
}

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
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeSync(fd, `${JSON.stringify(contents, null, 2)}\n`)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
}

export function apply(ctx: Context, config: Config): void {
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
    const server = createMcpServer(ctx)
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
    const unregister = ctx.webServer.register({ kind: 'exact', path, handler })
    writeDiscovery(discoveryFile, { url: `http://127.0.0.1:${ctx.webServer.port}${path}`, tokenFile, pid: process.pid })
    return () => {
      unregister()
      rmSync(discoveryFile, { force: true })
    }
  })
}
