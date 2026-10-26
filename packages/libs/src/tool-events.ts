/**
 * The agent Workers' tool-gate events as their contract declares them (`schemas/agent-tool-event.v1.json`,
 * T211): `agent-workers.tool.denied`, `.deferred`, `.notified`, and `.checks-pending`, each event
 * type's data under its own definition. Event data carries no schema tag, so a reader names the
 * definition by the event's type and validates; an entry that does not validate is counted apart,
 * never guessed at (INV-14). The fields T207 added are optional: an entry from before it stays valid.
 */
import { SchemaRegistry } from './schemas.ts'

/** The schema tag the tool events' data is validated under. */
export const AGENT_TOOL_EVENT_SCHEMA = 'agent-tool-event@1.2'

/** Each tool event type, and the definition of its data; `.web` since 1.2 (T262: a research role's web call). */
export const AGENT_TOOL_EVENTS = {
  'agent-workers.tool.denied': 'denied',
  'agent-workers.tool.deferred': 'deferred',
  'agent-workers.tool.notified': 'notified',
  'agent-workers.tool.checks-pending': 'checks-pending',
  'agent-workers.tool.web': 'web',
} as const
export type AgentToolEventType = keyof typeof AGENT_TOOL_EVENTS

/** What every tool event names. */
export interface AgentToolCall {
  agentRun: string
  worker: string
  /** The Worker's runtime (since T207). */
  workerKind?: string
  tool: string
  actionClass?: string
}

/** `agent-workers.tool.denied` data; `reason` onwards since T207. */
export interface AgentToolDenial extends AgentToolCall {
  reason?: string
  explanation?: string
  requestId?: string
  decision?: `sha256:${string}`
}

/** The most characters a denial's `explanation` holds, as the schema bounds it. */
export const AGENT_TOOL_EXPLANATION_MAX = 300

let registry: SchemaRegistry | undefined
const schemas = (): SchemaRegistry => (registry ??= new SchemaRegistry())

/** The data of a tool event of type `type`, or undefined when it is not valid under its definition (or the type is no tool event). */
export function agentToolEventOf(type: string, data: unknown): AgentToolCall | undefined {
  const def = Object.hasOwn(AGENT_TOOL_EVENTS, type) ? AGENT_TOOL_EVENTS[type as AgentToolEventType] : undefined
  if (!def) return undefined
  try {
    schemas().assertDef(AGENT_TOOL_EVENT_SCHEMA, def, data)
    return data as AgentToolCall
  } catch {
    return undefined
  }
}

/** An `agent-workers.tool.denied` entry's data as its denial, or undefined when it is not a valid one. */
export function agentToolDenialOf(data: unknown): AgentToolDenial | undefined {
  return agentToolEventOf('agent-workers.tool.denied', data) as AgentToolDenial | undefined
}

/** The reason codes the schema declares, in its order: what a denial's `reason` may be. */
export function agentToolDenialReasons(): readonly string[] {
  const schema = schemas().schemaOf(AGENT_TOOL_EVENT_SCHEMA) as { $defs: { reason: { enum: string[] } } }
  return schema.$defs.reason.enum
}
