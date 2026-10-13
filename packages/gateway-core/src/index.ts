/**
 * Gateway definitions. `ctx.mcp` is the MCP tool registry: plugins contribute tools for their
 * own lifetime; `@tsuuanmi/system-mcp-server` provides it over Streamable HTTP. Contributors
 * depend on this definition only, never on the gateway's implementation. The request guard is
 * shared by every client endpoint (MCP and the protocol gateways).
 * @module @tsuuanmi/system-gateway-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ZodRawShape } from 'zod'

export { assertSafeBind, endpointUrl, type GuardOptions, type GuardResult, guardRequest, hostName, LOOPBACK_HOSTS, readJsonBody, type Scope, SCOPES, scopeToken, scopeTokens, tokenFile, tokenMatches } from './guard.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcp: McpTools
  }
}

/** Who may call a tool (ADR-0023): `operator` holders call every tool; `client` holders only client tools. */
export type ToolScope = 'operator' | 'client'

export interface ToolSpec {
  description: string
  inputSchema: ZodRawShape
  /** Default `operator`: a tool that declares nothing is the operator's (fail closed). */
  scope?: ToolScope
}

/** What a handler knows of its caller: the scope of the token presented (ADR-0023). */
export interface ToolContext {
  scope: ToolScope
}

export type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<CallToolResult>

export abstract class McpTools extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mcp')
  }

  /**
   * Contribute a tool for the calling plugin's lifetime. A name is unique, except that a
   * provider's built-in placeholder may be replaced. `spec.scope` says who may call it.
   */
  abstract tool(name: string, spec: ToolSpec, handler: ToolHandler): void
}
