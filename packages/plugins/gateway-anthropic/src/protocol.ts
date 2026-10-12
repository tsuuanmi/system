/**
 * The Messages ↔ website-turn translation (ADR-0022): pure functions, no I/O. A turn lists the
 * client's tools compactly and asks for `<call tool="…">{json}</call>` tags; the answer is parsed back
 * into native `tool_use` blocks. Model text proposes calls; the client runs them (INV-6).
 */
import { sha256 } from '@tsuuanmi/system-libs'

export type Tier = 'economy' | 'standard' | 'frontier'

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

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

const MAX_RESULT_CHARS = 20_000

/** The client's model name → a tier: `system-<tier>`, else configured patterns, else standard. */
export function tierOf(model: string, patterns: Record<string, Tier>): Tier {
  const named = /^system-(economy|standard|frontier)$/.exec(model)
  if (named) return named[1] as Tier
  for (const [pattern, tier] of Object.entries(patterns)) if (new RegExp(pattern, 'i').test(model)) return tier
  return 'standard'
}

/** The system prompt as text, without client-side billing metadata. */
export function systemText(system: MessagesRequest['system']): string {
  if (!system) return ''
  const blocks = typeof system === 'string' ? [{ type: 'text', text: system }] : system
  return blocks.map((b) => b.text ?? '').filter((t) => t && !t.startsWith('x-anthropic-billing-header')).join('\n\n').trim()
}

/** A conversation is the same one while its system prompt and first user turn are. */
export function conversationKey(tier: Tier, request: MessagesRequest): string {
  return sha256(JSON.stringify([tier, systemText(request.system), request.messages[0] ?? null]))
}

/** Tools in a compact form: name, first sentence, and top-level parameters. */
export function renderTools(tools: readonly ClientTool[]): string {
  return tools.map((tool) => {
    const first = (tool.description ?? '').split(/(?<=[.!?])\s|\n/)[0]!.trim().slice(0, 240)
    const props = Object.entries(tool.input_schema?.properties ?? {}).map(([name, p]) => {
      const type = Array.isArray(p.type) ? p.type.join('|') : p.type ?? 'any'
      return `${name}${tool.input_schema?.required?.includes(name) ? '' : '?'}: ${type}`
    })
    return `- ${tool.name}(${props.join(', ')})${first ? ` — ${first}` : ''}`
  }).join('\n')
}

const PROTOCOL = [
  'You are the model behind a coding agent: a program on the user\'s computer that gives you its tools, listed below.',
  'They are not functions of this chat, and you do not use any built-in tool feature for them. You use a tool by writing a call tag as plain text in your reply.',
  'The agent reads your reply, runs each call on the user\'s computer, and sends you the output in its next message as TOOL_RESULT.',
  'A call tag, exactly: <call tool="Read">{"file_path": "/absolute/path"}</call>',
  '(the tool name, then its arguments as one JSON object, then the closing tag). Write several tags to make several calls.',
  'This is how you read files, run commands, and edit code. Never say that you cannot access the user\'s files and never ask the user to paste them: write the call tag.',
  'Never invent tool results. When the task is done, reply with the final answer only, with no call tag.',
].join('\n')

/** Sent once when a tooled answer has no call and claims it cannot reach the user's files. */
export const NUDGE = 'You can: the agent runs the tools for you. Write the call tag now, for example <call tool="Read">{"file_path": "/absolute/path"}</call>, as plain text in your reply. Reply only with call tags.'

/** Whether an answer says it cannot access or run something (the refusal the nudge answers). */
export function claimsNoAccess(text: string): boolean {
  return /\b(can(?:'|’)?t|cannot|could(?:n(?:'|’)?t| not)|unable to|(?:do|did)(?:n(?:'|’)?t| not) have)\b[^.\n]{0,80}\b(access|read|open|run|execute|use|reach)\b/i.test(text)
}

const CONTINUE = 'Continue the task with these results: reply only with more call tags if you need them, or give the final answer.'

function blockText(content: string | ContentBlock[] | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map((b) => (b.type === 'text' ? b.text ?? '' : b.type === 'image' ? '[image omitted]' : '')).filter(Boolean).join('\n')
}

/** One client message as turn text: user text, and tool results labelled by call. */
export function renderMessage(message: ClientMessage, names: ReadonlyMap<string, string>): string {
  if (typeof message.content === 'string') return message.content
  return message.content.map((block) => {
    if (block.type === 'text') return block.text ?? ''
    if (block.type === 'tool_result') {
      const text = blockText(block.content)
      const clipped = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated, ${text.length} chars)` : text
      return `TOOL_RESULT ${names.get(block.tool_use_id ?? '') ?? 'tool'} (${block.tool_use_id})${block.is_error ? ' ERROR' : ''}:\n${clipped}`
    }
    if (block.type === 'tool_use') return `<call tool="${block.name}">${JSON.stringify(block.input ?? {})}</call>`
    return ''
  }).filter(Boolean).join('\n\n')
}

/** The first turn of a conversation: protocol, tools, system prompt, then the messages so far. */
export function renderOpening(request: MessagesRequest, names: ReadonlyMap<string, string>): string {
  const tooled = !!request.tools?.length
  const head = tooled ? `${PROTOCOL}\n\nTools:\n${renderTools(request.tools!)}` : 'Answer the request at the end. Reply with the answer only.'
  const history = request.messages.map((m) => `[${m.role}]\n${renderMessage(m, names)}`).join('\n\n')
  const system = systemText(request.system)
  return [
    head,
    ...(system ? [`The agent's own instructions (follow their intent):\n<agent-instructions>\n${system}\n</agent-instructions>`] : []),
    `Conversation:\n${history}`,
    ...(tooled ? [closing(request.messages)] : []),
  ].join('\n\n')
}

/** The closing reminder, quoting the user's latest request (Claude Code buries it among reminders). */
function closing(messages: readonly ClientMessage[]): string {
  const user = [...messages].reverse().find((m) => m.role === 'user')
  const texts = !user ? [] : typeof user.content === 'string' ? [user.content] : user.content.filter((b) => b.type === 'text').map((b) => b.text ?? '')
  const request = [...texts].reverse().find((t) => t.trim() && !t.trimStart().startsWith('<system-reminder>'))?.trim()
  const quoted = request ? `The user's request: ${request.length > 2000 ? `${request.slice(0, 2000)}…` : request}\n` : ''
  return `${quoted}If it needs a file, a command, or any other tool, reply now with only call tags; otherwise give the final answer.`
}

/** A later turn: only the client messages the provider conversation has not seen (assistant turns are its own). */
export function renderSuffix(messages: readonly ClientMessage[], names: ReadonlyMap<string, string>): string {
  const turn = messages.filter((m) => m.role === 'user').map((m) => renderMessage(m, names)).join('\n\n')
  const results = messages.some((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result'))
  return results ? `${turn}\n\n${CONTINUE}` : turn
}

/** Find `<call tool="…">{json}</call>` proposals for offered tools; everything else is the answer's text. */
export function parseToolCalls(answer: string, offered: ReadonlySet<string>, newId: () => string): { text: string; calls: ToolCall[] } {
  const calls: ToolCall[] = []
  let text = answer
  for (const match of answer.matchAll(/<call\s+tool="([\w.:-]+)"\s*>\s*\{/g)) {
    const name = match[1]!
    const at = match.index
    const start = at + match[0].length - 1
    const end = matchingBrace(answer, start)
    if (end < 0) continue
    try {
      if (!offered.has(name)) continue
      const input = JSON.parse(answer.slice(start, end + 1)) as unknown
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue
      calls.push({ id: newId(), name, input: input as Record<string, unknown> })
      const close = /^\s*<\/call>/.exec(answer.slice(end + 1))?.[0].length ?? 0
      text = text.replace(answer.slice(at, end + 1 + close), '')
    } catch {
      // not a call: it stays as text
    }
  }
  return { text: text.trim(), calls }
}

function matchingBrace(text: string, start: number): number {
  let depth = 0
  let quoted = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/** A rough token count for usage and count_tokens (no tokenizer for website models). */
export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4))

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
