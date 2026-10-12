/**
 * The OpenAI Responses wire format ↔ the gateways' neutral turns (ADR-0022): pure functions, no
 * I/O. Calls parsed from the answer become `function_call` items (or `custom_tool_call` for a
 * freeform tool); the client runs them (INV-6). Event shapes follow what Codex consumes: every
 * item is opened and closed (`output_item.added` … `.done`), and the stream ends with exactly
 * one terminal event carrying numeric usage.
 */
import { createHash } from 'node:crypto'
import { estimateTokens, type Part, type Tier, type ToolCall, type ToolSpec, type Turn } from '@tsuuanmi/system-gateway-turns'

export interface ContentPart {
  type: string
  text?: string
}

export interface InputItem {
  type?: string
  role?: 'user' | 'assistant' | 'system' | 'developer'
  content?: string | ContentPart[]
  call_id?: string
  name?: string
  arguments?: string
  input?: string
  output?: string | ContentPart[]
}

export interface ClientTool {
  type: string
  name?: string
  description?: string
  parameters?: { properties?: ToolSpec['properties']; required?: string[] }
}

export interface ResponsesRequest {
  model: string
  instructions?: string | null
  input: string | InputItem[]
  tools?: ClientTool[]
  stream?: boolean
  prompt_cache_key?: string
  parallel_tool_calls?: boolean
}

/** The client's tools the model can use: functions, and freeform (`custom`) tools as one `input` string. */
export function toolsOf(request: ResponsesRequest): { tools: ToolSpec[]; freeform: Set<string> } {
  const tools: ToolSpec[] = []
  const freeform = new Set<string>()
  for (const tool of request.tools ?? []) {
    if (!tool.name) continue
    if (tool.type === 'function') {
      tools.push({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.parameters?.properties ? { properties: tool.parameters.properties } : {}),
        ...(tool.parameters?.required ? { required: tool.parameters.required } : {}),
      })
    } else if (tool.type === 'custom') {
      freeform.add(tool.name)
      tools.push({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), properties: { input: { type: 'string', description: 'the raw input' } }, required: ['input'] })
    }
    // Hosted tools (web_search, image_generation) and namespaces are not offered to a website model.
  }
  return { tools, freeform }
}

const text = (content: InputItem['content'] | InputItem['output']): string => {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map((c) => (c.type === 'input_image' ? '[image omitted]' : c.text ?? '')).filter(Boolean).join('\n')
}

/**
 * Responses input → the agent's instructions and neutral turns. Instructions, and developer or
 * system messages before the first user message, are the instructions; later ones are system
 * turns. Reasoning and hosted-tool items are not replayed to a website model.
 */
export function turnsOf(request: ResponsesRequest): { system: string; turns: Turn[] } {
  const items: InputItem[] = typeof request.input === 'string' ? [{ type: 'message', role: 'user', content: request.input }] : request.input
  const system: string[] = request.instructions ? [request.instructions] : []
  const turns: Turn[] = []
  const push = (role: Turn['role'], part: Part): void => {
    const last = turns.at(-1)
    if (last?.role === role) last.parts.push(part)
    else turns.push({ role, parts: [part] })
  }
  for (const item of items) {
    const type = item.type ?? 'message'
    if (type === 'message') {
      const body = text(item.content)
      if (!body) continue
      if (item.role === 'developer' || item.role === 'system') {
        if (!turns.some((t) => t.role === 'user')) system.push(body)
        else push('system', { kind: 'text', text: body })
      } else push(item.role === 'assistant' ? 'assistant' : 'user', { kind: 'text', text: body })
    } else if (type === 'function_call') {
      let input: unknown = item.arguments ?? '{}'
      try {
        input = JSON.parse(item.arguments ?? '{}')
      } catch {
        // replayed as the raw string
      }
      push('assistant', { kind: 'call', id: item.call_id ?? '', name: item.name ?? '', input })
    } else if (type === 'custom_tool_call') {
      push('assistant', { kind: 'call', id: item.call_id ?? '', name: item.name ?? '', input: { input: item.input ?? '' } })
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      push('user', { kind: 'result', id: item.call_id ?? '', text: text(item.output) })
    }
  }
  return { system: system.join('\n\n'), turns }
}

/** One client conversation: Codex's thread id when it sends one, else the stable prefix. */
export function conversationKey(tier: Tier, request: ResponsesRequest, system: string, turns: readonly Turn[]): string {
  const basis = request.prompt_cache_key ? ['thread', request.prompt_cache_key] : ['prefix', system, turns.find((t) => t.role === 'user') ?? null]
  return createHash('sha256').update(JSON.stringify([tier, ...basis])).digest('hex')
}

export type OutputItem =
  | { type: 'message'; id: string; status: 'completed'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string; annotations: [] }> }
  | { type: 'function_call'; id: string; status: 'completed'; call_id: string; name: string; arguments: string }
  | { type: 'custom_tool_call'; id: string; status: 'completed'; call_id: string; name: string; input: string }

export interface ResponseObject {
  id: string
  object: 'response'
  created_at: number
  status: 'in_progress' | 'completed' | 'failed'
  model: string
  output: OutputItem[]
  usage: { input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details: { cached_tokens: number }; output_tokens_details: { reasoning_tokens: number } } | null
  error?: { code: string; message: string } | null
}

/** The finished response: the answer's text as one message, then each call as its own item. */
export function responseOf(id: string, model: string, createdAt: number, answer: string, calls: readonly ToolCall[], freeform: ReadonlySet<string>, inputTokens: number): ResponseObject {
  const output: OutputItem[] = []
  if (answer) output.push({ type: 'message', id: `msg_${id}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: answer, annotations: [] }] })
  calls.forEach((call, i) => {
    output.push(freeform.has(call.name)
      ? { type: 'custom_tool_call', id: `ctc_${id}_${i}`, status: 'completed', call_id: call.id, name: call.name, input: typeof call.input.input === 'string' ? call.input.input : JSON.stringify(call.input) }
      // Never "": Codex replays the arguments, and an empty string fails its JSON parse.
      : { type: 'function_call', id: `fc_${id}_${i}`, status: 'completed', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) || '{}' })
  })
  const outputTokens = estimateTokens(answer + calls.map((c) => JSON.stringify(c.input)).join(''))
  return {
    id: `resp_${id}`, object: 'response', created_at: createdAt, status: 'completed', model, output,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  }
}

/** The SSE events after `response.created` for a finished response; the final text equals the deltas. */
export function streamEvents(response: ResponseObject): Array<[string, Record<string, unknown>]> {
  const events: Array<[string, Record<string, unknown>]> = []
  response.output.forEach((item, output_index) => {
    if (item.type === 'message') {
      const answer = item.content[0]!.text
      const part = { type: 'output_text', text: '', annotations: [] }
      events.push(['response.output_item.added', { output_index, item: { ...item, status: 'in_progress', content: [] } }])
      events.push(['response.content_part.added', { item_id: item.id, output_index, content_index: 0, part }])
      events.push(['response.output_text.delta', { item_id: item.id, output_index, content_index: 0, delta: answer }])
      events.push(['response.output_text.done', { item_id: item.id, output_index, content_index: 0, text: answer }])
      events.push(['response.content_part.done', { item_id: item.id, output_index, content_index: 0, part: { ...part, text: answer } }])
    } else if (item.type === 'function_call') {
      events.push(['response.output_item.added', { output_index, item: { ...item, status: 'in_progress', arguments: '' } }])
      events.push(['response.function_call_arguments.delta', { item_id: item.id, output_index, delta: item.arguments }])
      events.push(['response.function_call_arguments.done', { item_id: item.id, output_index, arguments: item.arguments }])
    } else {
      events.push(['response.output_item.added', { output_index, item: { ...item, status: 'in_progress', input: '' } }])
      events.push(['response.custom_tool_call_input.delta', { item_id: item.id, output_index, delta: item.input }])
      events.push(['response.custom_tool_call_input.done', { item_id: item.id, output_index, input: item.input }])
    }
    events.push(['response.output_item.done', { output_index, item }])
  })
  events.push(['response.completed', { response }])
  return events
}
