/**
 * The text tool protocol for website models (ADR-0022): pure functions, no I/O. A turn lists the
 * client's tools compactly and asks for `<call tool="…">{json}</call>` tags; the answer is parsed
 * back into calls, which each gateway emits in its own wire format. Model text only proposes
 * calls; the client runs them (INV-6).
 */

export type Tier = 'economy' | 'standard' | 'frontier'

/** A client tool, whatever its wire format: a name, a description, and its top-level parameters. */
export interface ToolSpec {
  name: string
  description?: string
  properties?: Record<string, { type?: string | string[]; description?: string }>
  required?: string[]
}

/** One piece of a client turn, in a gateway-neutral form. */
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'call'; id: string; name: string; input: unknown }
  | { kind: 'result'; id: string; text: string; error?: boolean }

export interface Turn {
  role: 'user' | 'assistant' | 'system'
  parts: Part[]
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

/** Tools in a compact form: name, top-level parameters, and the description's first sentence. */
export function renderTools(tools: readonly ToolSpec[]): string {
  return tools.map((tool) => {
    const first = (tool.description ?? '').split(/(?<=[.!?])\s|\n/)[0]!.trim().slice(0, 240)
    const props = Object.entries(tool.properties ?? {}).map(([name, p]) => {
      const type = Array.isArray(p.type) ? p.type.join('|') : p.type ?? 'any'
      return `${name}${tool.required?.includes(name) ? '' : '?'}: ${type}`
    })
    return `- ${tool.name}(${props.join(', ')})${first ? ` — ${first}` : ''}`
  }).join('\n')
}

// Observed live (ADR-0022): ChatGPT hides tool-call-shaped JSON that ends a reply (`TOOL_CALL {…}`,
// `CALL Name {…}`) as a native call, and its renderer collapses runs of spaces outside code blocks.
const PROTOCOL = [
  'You are the model behind a coding agent: a program on the user\'s computer that gives you its tools, listed below.',
  'They are not functions of this chat, and you do not use any built-in tool feature for them. You use a tool by writing a call tag as plain text in your reply.',
  'The agent reads your reply, runs each call on the user\'s computer, and sends you the output in its next message as TOOL_RESULT.',
  'A call tag, exactly: <call tool="Read">{"file_path": "/absolute/path"}</call>',
  '(the tool name, then its arguments as one JSON object, then the closing tag). Write several tags to make several calls.',
  'Put all your call tags in one fenced code block (```), one tag per line, so that spaces and indentation in the arguments survive.',
  'This is how you read files, run commands, and edit code. Never say that you cannot access the user\'s files and never ask the user to paste them: write the call tag.',
  'Never invent tool results. When the task is done, reply with the final answer only, with no call tag.',
].join('\n')

const CONTINUE = 'Continue the task with these results: reply only with more call tags (in a code block) if you need them, or give the final answer.'

/** Sent once when a tooled answer has no call and claims it cannot reach the user's files. */
export const NUDGE = 'You can: the agent runs the tools for you. Write the call tag now, for example <call tool="Read">{"file_path": "/absolute/path"}</call>, in a fenced code block in your reply. Reply only with call tags.'

/** Whether an answer says it cannot access or run something (the refusal the nudge answers). */
export function claimsNoAccess(text: string): boolean {
  return /\b(can(?:'|’)?t|cannot|could(?:n(?:'|’)?t| not)|unable to|(?:do|did)(?:n(?:'|’)?t| not) have)\b[^.\n]{0,80}\b(access|read|open|run|execute|use|reach)\b/i.test(text)
}

/** One turn as text: its words, its calls as tags, and tool results labelled by call. */
export function renderTurn(turn: Turn, names: ReadonlyMap<string, string>): string {
  return turn.parts.map((part) => {
    if (part.kind === 'text') return part.text
    if (part.kind === 'call') return `<call tool="${part.name}">${JSON.stringify(part.input ?? {})}</call>`
    const clipped = part.text.length > MAX_RESULT_CHARS ? `${part.text.slice(0, MAX_RESULT_CHARS)}\n…(truncated, ${part.text.length} chars)` : part.text
    return `TOOL_RESULT ${names.get(part.id) ?? 'tool'} (${part.id})${part.error ? ' ERROR' : ''}:\n${clipped}`
  }).filter(Boolean).join('\n\n')
}

/** The first turn of a provider conversation: protocol, tools, the agent's instructions, the history, a closing reminder. */
export function renderOpening(system: string, tools: readonly ToolSpec[], turns: readonly Turn[], names: ReadonlyMap<string, string>): string {
  const head = tools.length ? `${PROTOCOL}\n\nTools:\n${renderTools(tools)}` : 'Answer the request at the end. Reply with the answer only.'
  return [
    head,
    ...(system ? [`The agent's own instructions (follow their intent):\n<agent-instructions>\n${system}\n</agent-instructions>`] : []),
    `Conversation:\n${turns.map((t) => `[${t.role}]\n${renderTurn(t, names)}`).join('\n\n')}`,
    ...(tools.length ? [closing(turns)] : []),
  ].join('\n\n')
}

/** The closing reminder, quoting the user's latest request (clients bury it among reminders). */
function closing(turns: readonly Turn[]): string {
  const user = [...turns].reverse().find((t) => t.role === 'user')
  const texts = (user?.parts ?? []).flatMap((p) => (p.kind === 'text' ? [p.text] : []))
  const request = [...texts].reverse().find((t) => t.trim() && !/^\s*<(system-reminder|environment_context)>/.test(t))?.trim()
  const quoted = request ? `The user's request: ${request.length > 2000 ? `${request.slice(0, 2000)}…` : request}\n` : ''
  return `${quoted}If it needs a file, a command, or any other tool, reply now with only call tags in a code block; otherwise give the final answer.`
}

/** A later turn: only what the provider conversation has not seen (its own replies are not resent). */
export function renderSuffix(turns: readonly Turn[], names: ReadonlyMap<string, string>): string {
  const fresh = turns.filter((t) => t.role !== 'assistant')
  const text = fresh.map((t) => (t.role === 'system' ? `[system]\n${renderTurn(t, names)}` : renderTurn(t, names))).join('\n\n')
  return fresh.some((t) => t.parts.some((p) => p.kind === 'result')) ? `${text}\n\n${CONTINUE}` : text
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
    if (end < 0 || !offered.has(name)) continue
    try {
      const input = JSON.parse(answer.slice(start, end + 1)) as unknown
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue
      calls.push({ id: newId(), name, input: input as Record<string, unknown> })
      const close = /^\s*<\/call>/.exec(answer.slice(end + 1))?.[0].length ?? 0
      text = text.replace(answer.slice(at, end + 1 + close), '')
    } catch {
      // not a call: it stays as text
    }
  }
  // A code block holding the calls leaves its rendered label line ("Code", "xml", …) behind.
  if (calls.length) text = text.replace(/^[ \t]*(?:code|copy code|copy|xml|html|json|text|plaintext)[ \t]*$/gim, '')
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

/** A rough token count for usage reports (no tokenizer for website models). */
export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4))
