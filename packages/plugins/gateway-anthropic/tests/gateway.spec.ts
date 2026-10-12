import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import * as Gateway from '../src/index.ts'
import { claimsNoAccess, type MessagesRequest, NUDGE, parseToolCalls, renderOpening, renderTools, streamEvents, messageOf, tierOf } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('Messages ↔ website turn protocol (ADR-0022)', () => {
  it('maps model names to tiers', () => {
    expect(tierOf('system-frontier', {})).toBe('frontier')
    expect(tierOf('claude-haiku-5-5', { haiku: 'economy' })).toBe('economy')
    expect(tierOf('claude-opus-5-5', { haiku: 'economy' })).toBe('standard')
  })

  it('lists tools compactly, and renders the opening turn without client billing metadata', () => {
    const tools = [{ name: 'Read', description: 'Reads a file. Long details follow.', input_schema: { properties: { file_path: { type: 'string' }, limit: { type: 'number' } }, required: ['file_path'] } }]
    expect(renderTools(tools)).toBe('- Read(file_path: string, limit?: number) — Reads a file.')
    const opening = renderOpening({ model: 'm', system: [{ type: 'text', text: 'x-anthropic-billing-header: v=1' }, { type: 'text', text: 'Be helpful.' }], tools, messages: [{ role: 'user', content: 'hi' }] }, new Map())
    expect(opening).toContain('<call tool="Read">{"file_path"')
    expect(opening).toContain('<agent-instructions>\nBe helpful.\n</agent-instructions>')
    expect(opening.trimEnd().endsWith("The user's request: hi\nIf it needs a file, a command, or any other tool, reply now with only call tags; otherwise give the final answer.")).toBe(true)
    expect(opening).not.toContain('billing')
    expect(opening).toContain('[user]\nhi')
  })

  it('takes only well-formed calls to offered tools; the rest stays text', () => {
    let n = 0
    const id = () => `toolu_${++n}`
    const answer = 'Let me look.\n<call tool="Read">{"file_path": "/a {b}.txt"}</call>\n<call tool="Rm">{}</call>\n<call tool="Read">["bad"]</call> <call tool="Read">{"file_path": "/broken"</call>'
    const parsed = parseToolCalls(answer, new Set(['Read']), id)
    expect(parsed.calls).toEqual([{ id: 'toolu_1', name: 'Read', input: { file_path: '/a {b}.txt' } }])
    expect(parsed.text).toContain('Let me look.')
    expect(parsed.text).not.toContain('"/a {b}.txt"')
    expect(parsed.text).toContain('<call tool="Rm">{}</call>')
    expect(parseToolCalls('Just an answer.', new Set(['Read']), id)).toEqual({ text: 'Just an answer.', calls: [] })
  })

  it('recognises a claim that the model cannot reach the agent tools', () => {
    expect(claimsNoAccess("I can't access the specified local README.md through the tools available.")).toBe(true)
    expect(claimsNoAccess('I couldn’t access calc.py, so the bug remains.')).toBe(true)
    expect(claimsNoAccess('add() returns a - b; it cannot return the sum. Fixed.')).toBe(false)
  })

  it('streams in the Messages event order, with the final text equal to the deltas', () => {
    const message = messageOf('msg_1', 'm', 'reading', [{ id: 'toolu_1', name: 'Read', input: { file_path: '/x' } }], 10)
    const events = streamEvents(message)
    expect(events.map(([e]) => e)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    expect(message.stop_reason).toBe('tool_use')
    expect(JSON.stringify(events[5]![1])).toContain('input_json_delta')
  })
})

/** A stand-in engine: answers ask runs from a script, and records what it was asked. */
class StubWorkflow extends Service {
  readonly starts: Array<Record<string, unknown>> = []
  answers: string[] = []
  constructor(ctx: Context) {
    super(ctx, 'workflow')
  }
  start(input: Record<string, unknown>) {
    this.starts.push(input)
    const answer = this.answers.shift() ?? 'ok'
    return { runId: `run_${this.starts.length}`, template: 'ask', status: 'completed', specHash: 'sha256:0', sessionId: (input.sessionId as string) ?? `ses_${this.starts.length}`, answer, nodes: [], createdAt: '', updatedAt: '' }
  }
  async wait() {
    throw new Error('not used')
  }
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'system-gw-'))
  const tokenFile = join(dir, 'mcp.token')
  writeFileSync(tokenFile, Buffer.alloc(32, 9), { mode: 0o600 })
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(StubWorkflow), ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }), ctx.plugin(Gateway, { tokenFile })]
  await Promise.all(fibers)
  cleanups.push(async () => { for (const f of [...fibers].reverse()) await f.dispose() }, () => rmSync(dir, { recursive: true, force: true }))
  const base = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}/anthropic`
  const auth = { authorization: `Bearer ${Buffer.alloc(32, 9).toString('base64url')}`, 'content-type': 'application/json' }
  return { base, auth, workflow: (ctx as unknown as { workflow: StubWorkflow }).workflow }
}

const TOOLS = [{ name: 'Read', description: 'Reads a file.', input_schema: { properties: { file_path: { type: 'string' } }, required: ['file_path'] } }]

describe('Anthropic Messages gateway over HTTP', () => {
  it('guards like the MCP endpoint: token, no browser origin', async () => {
    const { base, auth } = await boot()
    const body = JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] })
    expect((await fetch(`${base}/v1/messages`, { method: 'POST', body })).status).toBe(401)
    expect((await fetch(`${base}/v1/messages`, { method: 'POST', body, headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${base}/v1/messages`, { method: 'POST', body, headers: { 'x-api-key': auth.authorization.slice(7) } })).status).toBe(200)
    expect((await fetch(`${base}/api/hello`, { method: 'HEAD' })).status).toBe(200)
    expect((await (await fetch(`${base}/v1/models`, { headers: auth })).json()).data.map((m: { id: string }) => m.id)).toEqual(['system-economy', 'system-standard', 'system-frontier'])
  })

  it('turns a proposed call into tool_use, then sends only the tool result into the same conversation', async () => {
    const { base, auth, workflow } = await boot()
    workflow.answers = ['I will read it.\n<call tool="Read">{"file_path": "/repo/README.md"}</call>', 'The heading is "system".']
    const first: MessagesRequest = { model: 'claude-opus-5-5', system: 'Be brief.', tools: TOOLS, messages: [{ role: 'user', content: 'What is the first heading of README.md?' }] }
    const one = await (await fetch(`${base}/v1/messages`, { method: 'POST', headers: auth, body: JSON.stringify(first) })).json()
    expect(one).toMatchObject({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'I will read it.' }, { type: 'tool_use', name: 'Read', input: { file_path: '/repo/README.md' } }] })
    expect(workflow.starts[0]).toMatchObject({ template: 'ask', tier: 'standard', persist: true, classification: 'operator-shared' })
    const toolUse = one.content[1]
    const second: MessagesRequest = { ...first, messages: [...first.messages, { role: 'assistant', content: one.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '# system' }] }] }
    const two = await (await fetch(`${base}/v1/messages`, { method: 'POST', headers: auth, body: JSON.stringify(second) })).json()
    expect(two).toMatchObject({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'The heading is "system".' }] })
    // Same provider conversation; only the new suffix, labelled by tool.
    expect(workflow.starts[1]).toMatchObject({ sessionId: 'ses_1' })
    expect(String(workflow.starts[1]!.input)).toMatch(new RegExp(`^TOOL_RESULT Read \\(${toolUse.id}\\):\\n# system\\n\\nContinue the task`))
  })

  it('nudges once, in the same conversation, when a tooled answer claims it cannot reach files', async () => {
    const { base, auth, workflow } = await boot()
    workflow.answers = ["I can't access README.md from here.", '<call tool="Read">{"file_path": "/repo/README.md"}</call>']
    const request: MessagesRequest = { model: 'claude-opus-5-5', tools: TOOLS, messages: [{ role: 'user', content: 'Heading of README.md?' }] }
    const reply = await (await fetch(`${base}/v1/messages`, { method: 'POST', headers: auth, body: JSON.stringify(request) })).json()
    expect(reply).toMatchObject({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read' }] })
    expect(workflow.starts[1]).toMatchObject({ sessionId: 'ses_1', input: NUDGE })
    expect(workflow.starts).toHaveLength(2)
  })

  it('streams server-sent events for stream: true', async () => {
    const { base, auth, workflow } = await boot()
    workflow.answers = ['four']
    const res = await fetch(`${base}/v1/messages?beta=true`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'claude-haiku-5-5', stream: true, messages: [{ role: 'user', content: '2+2?' }] }) })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const text = await res.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('"text":"four"')
    expect(text).toContain('event: message_stop')
    expect(workflow.starts[0]).toMatchObject({ tier: 'economy' })
  })
})
