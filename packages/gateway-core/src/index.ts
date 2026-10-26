/**
 * Gateway definitions. `ctx.mcp` is the MCP tool registry: plugins contribute tools for their
 * own lifetime; `@tsuuanmi/system-mcp-server` provides it over Streamable HTTP. Contributors
 * depend on this definition only, never on the gateway's implementation. The request guard is
 * shared by every client endpoint (MCP and the protocol gateways), and the roster (./roster.ts) by
 * every surface that shows the Workers.
 * @module @tsuuanmi/system-gateway-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ZodRawShape } from 'zod'

export {
  type Availability, type AvailabilityState, formatRoster, type Known, projectRoster, readCapacity, readRoster, type Roster, type RosterAccount, type RosterAccountRecord, type RosterAgentAccount, ROSTER_BOUNDS, ROSTER_SCHEMA,
  type RosterDescriptor, type RosterEntry, type RosterInput, type RosterPool, type RosterPoolView, type RosterRun, type RosterScope, type RosterServices, type RosterSourceRead, type RosterStartedBy, type RosterTask,
  type RosterWebsiteAccount, type RosterWindow, type RosterWork, type RosterLiveness, type RosterLivenessRead, type RosterLivenessRun,
} from './roster.ts'
export {
  accountName, canTakeStep, type Capacity, type CapacityAccount, CAPACITY_BOUNDS, type CapacityCannotWork, type CapacityFree, type CapacityInput, type CapacityList, type CapacityNoQuota, type CapacityQuota,
  type CapacityReady, type CapacityStalled, type CapacityStep, type CapacityTaskRead, type CapacityUnread, type CapacityWindow, formatCapacity, projectCapacity, quotaPoolsOf,
} from './capacity.ts'
export {
  type Ability, abilityOf, type AvailabilityEvent, availabilityChanges, EXCLUDED_REASONS, type RecordedAbility, recordedAbility, UNAVAILABLE_REASONS, type UnavailableReason, WORKER_AVAILABLE_EVENT, WORKER_UNAVAILABLE_EVENT,
} from './availability-events.ts'
export { assertSafeBind, endpointUrl, type GuardOptions, type GuardResult, guardRequest, hostName, LOOPBACK_HOSTS, readJsonBody, type Scope, SCOPES, scopeToken, scopeTokens, tokenFile, tokenMatches } from './guard.ts'
export { issueLeadToken, LEAD_PROJECT, LEAD_QUEUE_CLASSES, LEAD_RIGHTS, type LeadDecision, leadId, leadMayDecide, leadTokenFile, leadTokens, listLeads, revokeLeadToken } from './lead.ts'
export { outline, reply } from './reply.ts'

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
  /**
   * An `operator` tool a project's lead may also call (ADR-0076): the closed list of them. A tool
   * without it is never served to a lead token; one with it checks the lead's rights itself, from
   * `ToolContext.lead`, and refuses what is not on the list.
   */
  lead?: true
}

/**
 * What a handler knows of its caller: the scope of the token presented (ADR-0023), and, for a
 * project's lead token, the project (the scope is then `client`, and the decider `lead:<project>`).
 */
export interface ToolContext {
  scope: ToolScope
  lead?: string
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
