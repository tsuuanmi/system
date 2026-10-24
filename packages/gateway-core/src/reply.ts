/**
 * A tool's answer, sent once (QA-12; mcp-server README "Replies"): the answer is the structured
 * content, and the text block beside it is a short summary of it, never the same JSON again. The
 * MCP clients in use hand a model the structured content when a result carries it, so the text is
 * for a person, a log, or a client that shows text only.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** The answer `structured`, with `summary` as its text block. */
export function reply(structured: object, summary: string): CallToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent: { ...structured } as Record<string, unknown> }
}

/** The most characters `outline` gives, and the most of one string value it quotes. */
const OUTLINE_CHARS = 300
const VALUE_CHARS = 60

/**
 * A one-line outline of a structured answer, for a tool with no summary of its own: each top-level
 * field, a scalar as it is (a long string cut), a list by its length, and an object by its own
 * fields one level down, at most 300 characters in all.
 */
export function outline(value: object): string {
  const line = fields(value, 1)
  return line.length > OUTLINE_CHARS ? `${line.slice(0, OUTLINE_CHARS - 1)}…` : line
}

function fields(value: object, depth: number): string {
  return Object.entries(value).filter(([, v]) => v !== undefined).map(([key, v]) => `${key}: ${brief(v, depth)}`).join('; ')
}

function brief(value: unknown, depth: number): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  if (value !== null && typeof value === 'object') return depth > 0 ? `{${fields(value, depth - 1).replaceAll('; ', ', ')}}` : '{…}'
  if (typeof value === 'string') return value.length > VALUE_CHARS ? `${value.slice(0, VALUE_CHARS - 1)}…` : value
  return String(value)
}
