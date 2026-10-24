import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as Gateway from '../src/index.ts'
import { type MessagesRequest, messageOf, streamEvents, systemText, turnsOf } from '../src/index.ts'

describe('Messages ↔ neutral turns', () => {
  it('drops client billing metadata from the system prompt, and maps tool use and results', () => {
    expect(systemText([{ type: 'text', text: 'x-anthropic-billing-header: v=1' }, { type: 'text', text: 'Be helpful.' }])).toBe('Be helpful.')
    const turns = turnsOf({ model: 'm', messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'body' }], is_error: true }] },
    ] })
    expect(turns).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: 'hi' }] },
      { role: 'assistant', parts: [{ kind: 'text', text: 'reading' }, { kind: 'call', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } }] },
      { role: 'user', parts: [{ kind: 'result', id: 'toolu_1', text: 'body', error: true }] },
    ])
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
  // The gateways take the model scope's token only (ADR-0023); the others are written to be refused.
  writeFileSync(join(dir, 'model.token'), Buffer.alloc(32, 9), { mode: 0o600 })
  writeFileSync(join(dir, 'client.token'), Buffer.alloc(32, 8), { mode: 0o600 })
  writeFileSync(join(dir, 'operator.token'), Buffer.alloc(32, 7), { mode: 0o600 })
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(StubWorkflow), ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }), ctx.plugin(Gateway, { tokenDir: dir })]
  await Promise.all(fibers)
  onTestFinished(async () => { for (const f of [...fibers].reverse()) await f.dispose() })
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const base = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}/anthropic`
  const auth = { authorization: `Bearer ${Buffer.alloc(32, 9).toString('base64url')}`, 'content-type': 'application/json' }
  return { base, auth, workflow: (ctx as unknown as { workflow: StubWorkflow }).workflow }
}

const TOOLS = [{ name: 'Read', description: 'Reads a file.', input_schema: { properties: { file_path: { type: 'string' } }, required: ['file_path'] } }]

describe('Anthropic Messages gateway over HTTP', () => {
  it('registers nothing on a plain-HTTP bind beyond loopback: the token would travel in clear text (QA-5)', async () => {
    const routes: unknown[] = []
    class LanWebServer extends Service {
      protocol = 'http:'
      host = '192.0.2.10'
      port = 47317
      constructor(ctx: Context) { super(ctx, 'webServer') }
      register(route: unknown): () => void { routes.push(route); return () => undefined }
    }
    const ctx = new Context()
    const dir = mkdtempSync(join(tmpdir(), 'system-gw-lan-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    await ctx.plugin(Store, { path: join(dir, 'system.db') })
    await ctx.plugin(StubWorkflow)
    await ctx.plugin(LanWebServer)
    try {
      await ctx.plugin(Gateway, { tokenDir: dir })
    } catch {
      // the refusal itself is the point
    }
    expect(routes).toEqual([])
  })

  it('guards like the MCP endpoint: token, no browser origin', async () => {
    const { base, auth } = await boot()
    const body = JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] })
    expect((await fetch(`${base}/v1/messages`, { method: 'POST', body })).status).toBe(401)
    // Only the model scope reaches a model gateway: the client and operator tokens do not (ADR-0023).
    for (const fill of [8, 7]) {
      expect((await fetch(`${base}/v1/messages`, { method: 'POST', body, headers: { authorization: `Bearer ${Buffer.alloc(32, fill).toString('base64url')}` } })).status).toBe(401)
    }
    expect((await fetch(`${base}/v1/messages`, { method: 'POST', body, headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${base}/v1/messages`, { method: 'POST', body, headers: { 'x-api-key': auth.authorization.slice(7) } })).status).toBe(200)
    expect((await fetch(`${base}/api/hello`, { method: 'HEAD' })).status).toBe(200)
    expect((await (await fetch(`${base}/v1/models`, { headers: auth })).json()).data.map((m: { id: string }) => m.id)).toEqual(['system-economy', 'system-standard', 'system-frontier'])
  })

  it('turns a proposed call into tool_use, then sends only the tool result into the same conversation (REQ-GW-2)', async () => {
    const { base, auth, workflow } = await boot()
    workflow.answers = ['I will read it.\n<call tool="Read">{"file_path": "/repo/README.md"}</call>', 'The heading is "system".']
    const first: MessagesRequest = { model: 'claude-opus-5-5', system: 'Be brief.', tools: TOOLS, messages: [{ role: 'user', content: 'What is the first heading of README.md?' }] }
    const one = await (await fetch(`${base}/v1/messages`, { method: 'POST', headers: auth, body: JSON.stringify(first) })).json()
    expect(one).toMatchObject({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'I will read it.' }, { type: 'tool_use', name: 'Read', input: { file_path: '/repo/README.md' } }] })
    expect(one.content[1].id).toMatch(/^toolu_/)
    const second: MessagesRequest = { ...first, messages: [...first.messages, { role: 'assistant', content: one.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: one.content[1].id, content: '# system' }] }] }
    const two = await (await fetch(`${base}/v1/messages`, { method: 'POST', headers: auth, body: JSON.stringify(second) })).json()
    expect(two).toMatchObject({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'The heading is "system".' }] })
    expect(workflow.starts[1]).toMatchObject({ sessionId: 'ses_1' })
    expect(String(workflow.starts[1]!.input)).toMatch(/^TOOL_RESULT Read \(toolu_[0-9a-f]+\):\n# system/)
  })

  it('streams server-sent events for stream: true (REQ-GW-5)', async () => {
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
