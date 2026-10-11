/**
 * Gateway seam definitions. `ctx.mcp` is the MCP tool registry: plugins contribute tools for
 * their own lifetime; `@tsuuanmi/system-mcp-server` provides it over Streamable HTTP.
 * Contributors depend on this definition only, never on the gateway's implementation.
 * @module @tsuuanmi/system-gateway-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ZodRawShape } from 'zod'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcp: McpTools
  }
}

export interface ToolSpec {
  description: string
  inputSchema: ZodRawShape
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>

export abstract class McpTools extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mcp')
  }

  /**
   * Contribute a tool for the calling plugin's lifetime. A name is unique, except that a
   * provider's built-in placeholder may be replaced.
   */
  abstract tool(name: string, spec: ToolSpec, handler: ToolHandler): void
}
