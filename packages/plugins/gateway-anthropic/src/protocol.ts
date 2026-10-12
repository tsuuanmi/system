/**
 * The Messages wire format ↔ the gateways' neutral turns (ADR-0022): pure functions, no I/O.
 * Calls parsed from the answer become `tool_use` blocks; the client runs them (INV-6).
 */
import { estimateTokens, type Part, type Tier, type ToolCall, type ToolSpec, type Turn } from '@tsuuanmi/system-gateway-turns'
import { sha256 } from '@tsuuanmi/system-libs'

export interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | ContentBlock[]
  is_error?: boolean
}

export interface ClientMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface ClientTool {
  name: string
  description?: string
  input_schema?: { properties?: Record<string, { type?: string | string[]; description?: string }>; required?: string[] }
}

export interface MessagesRequest {
  model: string
  system?: string | ContentBlock[]
  messages: ClientMessage[]
  tools?: ClientTool[]
  stream?: boolean
  max_tokens?: number
}

/** The system prompt as text, without client-side billing metadata. */
export function systemText(system: MessagesRequest['system']): string {
  if (!system) return ''
  const blocks = typeof system === 'string' ? [{ type: 'text', text: system }] : system
  return blocks.map((b) => b.text ?? '').filter((t) => t && !t.startsWith('x-anthropic-billing-header')).join('\n\n').trim()
}

/** A conversation is the same one while its tier, system prompt, and first user turn are. */
export function conversationKey(tier: Tier, request: MessagesRequest): string {
  return sha256(JSON.stringify([tier, systemText(request.system), request.messages[0] ?? null]))
}

export function toolsOf(request: MessagesRequest): ToolSpec[] {
  return (request.tools ?? []).map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    ...(t.input_schema?.properties ? { properties: t.input_schema.properties } : {}),
    ...(t.input_schema?.required ? { required: t.input_schema.required } : {}),
  }))
}

function blockText(content: string | ContentBlock[] | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map((b) => (b.type === 'text' ? b.text ?? '' : b.type === 'image' ? '[image omitted]' : '')).filter(Boolean).join('\n')
}

/** Messages → neutral turns: text, `tool_use` calls, and `tool_result` results. */
export function turnsOf(request: MessagesRequest): Turn[] {
  return request.messages.map((m) => ({
    role: m.role,
    parts: typeof m.content === 'string' ? [{ kind: 'text', text: m.content }] : m.content.flatMap((b): Part[] => {
      if (b.type === 'text') return b.text ? [{ kind: 'text', text: b.text }] : []
      if (b.type === 'image') return [{ kind: 'text', text: '[image omitted]' }]
      if (b.type === 'tool_use') return [{ kind: 'call', id: b.id ?? '', name: b.name ?? '', input: b.input }]
      if (b.type === 'tool_result') return [{ kind: 'result', id: b.tool_use_id ?? '', text: blockText(b.content), ...(b.is_error ? { error: true } : {}) }]
      return []
    }),
  }))
}

export interface MessageResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: ContentBlock[]
  stop_reason: 'end_turn' | 'tool_use'
  stop_sequence: null
  usage: { input_tokens: number; output_tokens: number }
}

export function messageOf(id: string, model: string, text: string, calls: readonly ToolCall[], inputTokens: number): MessageResponse {
  const content: ContentBlock[] = [
    ...(text ? [{ type: 'text', text }] : []),
    ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
  ]
  if (!content.length) content.push({ type: 'text', text: '' })
  return {
    id, type: 'message', role: 'assistant', model, content, stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: estimateTokens(text + calls.map((c) => JSON.stringify(c.input)).join('')) },
  }
}

/** The SSE events of a finished message, in the Messages streaming order; the text equals the deltas. */
export function streamEvents(message: MessageResponse): Array<[string, unknown]> {
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 } } }],
  ]
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
      if (block.text) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }])
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }])
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }])
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
  })
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return events
}
