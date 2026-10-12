// M0 spike: an MCP Streamable HTTP endpoint inside a DSH profile, on ctx.webServer.
// Throwaway probe; the real MCP server plugin is decided after the candidate review.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

export const name = 'system-probe'
export const inject = ['webServer']

export function apply(ctx, config) {
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: '/mcp',
    handler: async (req, res) => {
      if (req.headers.authorization !== `Bearer ${config.token}`) {
        res.statusCode = 401
        res.end('unauthorized')
        return
      }
      if (req.method !== 'GET' && req.headers.origin) {
        res.statusCode = 403
        res.end('origin rejected')
        return
      }
      const server = new McpServer({ name: 'system-probe', version: '0.0.0' })
      server.tool('ping', 'Health probe', async () => ({ content: [{ type: 'text', text: 'pong' }] }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        transport.close()
        server.close()
      })
      await server.connect(transport)
      let body = ''
      for await (const chunk of req) body += chunk
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
    },
  })
  ctx.effect(() => dispose)
}
