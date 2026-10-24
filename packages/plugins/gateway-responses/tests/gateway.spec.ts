import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as Gateway from '../src/index.ts'
import { type ResponsesRequest, responseOf, streamEvents, toolsOf, turnsOf } from '../src/index.ts'

const TOOLS: ResponsesRequest['tools'] = [
  { type: 'function', name: 'exec_command', description: 'Runs a command.', parameters: { properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { type: 'custom', name: 'apply_patch', description: 'Applies a patch.' },
  { type: 'web_search' },
]

/** The shape Codex sends: developer instructions, environment context, then the request. */
const CODEX: ResponsesRequest = {
  model: 'system-standard', stream: false, prompt_cache_key: 'thread-1', tools: TOOLS,
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are a coding agent.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/w</cwd>\n</environment_context>' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix calc.py.' }] },
  ],
}

describe('Responses ↔ neutral turns', () => {
  it('offers functions and freeform tools (as one input string), not hosted tools', () => {
    const { tools, freeform } = toolsOf(CODEX)
    expect(tools.map((t) => t.name)).toEqual(['exec_command', 'apply_patch'])
    expect(tools[1]).toMatchObject({ properties: { input: { type: 'string' } }, required: ['input'] })
    expect([...freeform]).toEqual(['apply_patch'])
  })

  it('takes leading developer messages as instructions, and replays calls and their outputs', () => {
    const { system, turns } = turnsOf({ ...CODEX, input: [
      ...(CODEX.input as []),
      { type: 'reasoning' },
      { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"cat calc.py"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'def add' },
      { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'c2', output: 'Done' },
      { type: 'message', role: 'developer', content: 'Later note.' },
    ] })
    expect(system).toBe('You are a coding agent.')
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'system'])
    expect(turns[0]!.parts).toHaveLength(2)
    expect(turns[1]!.parts[0]).toEqual({ kind: 'call', id: 'c1', name: 'exec_command', input: { cmd: 'cat calc.py' } })
    expect(turns[3]!.parts[0]).toEqual({ kind: 'call', id: 'c2', name: 'apply_patch', input: { input: '*** Begin Patch' } })
    expect(turns[4]!.parts[0]).toEqual({ kind: 'result', id: 'c2', text: 'Done' })
  })

  it('emits text as a message and calls as function_call or custom_tool_call items, every item opened and closed', () => {
    const response = responseOf('x', 'm', 1, 'Patching.', [
      { id: 'call_1', name: 'exec_command', input: {} },
      { id: 'call_2', name: 'apply_patch', input: { input: '*** Begin Patch\n*** End Patch' } },
    ], new Set(['apply_patch']), 10)
    expect(response.output).toMatchObject([
      { type: 'message', content: [{ type: 'output_text', text: 'Patching.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{}' },
      { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
    ])
    expect(response.usage).toMatchObject({ input_tokens: 10, total_tokens: 10 + response.usage!.output_tokens })
    const events = streamEvents(response).map(([e]) => e)
    expect(events).toEqual([
      'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
      'response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.output_item.done',
      'response.output_item.added', 'response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done', 'response.output_item.done',
      'response.completed',
    ])
  })
})

/** A stand-in engine: answers ask runs from a script, and records what it was asked. */
class StubWorkflow extends Service {
  readonly starts: Array<Record<string, unknown>> = []
  answers: Array<string | Error> = []
  constructor(ctx: Context) {
    super(ctx, 'workflow')
  }
  start(input: Record<string, unknown>) {
    this.starts.push(input)
    const answer = this.answers.shift() ?? 'ok'
    if (answer instanceof Error) return { runId: `run_${this.starts.length}`, template: 'ask', status: 'failed', error: { kind: 'config_error', message: answer.message }, nodes: [], createdAt: '', updatedAt: '' }
    return { runId: `run_${this.starts.length}`, template: 'ask', status: 'completed', specHash: 'sha256:0', sessionId: (input.sessionId as string) ?? `ses_${this.starts.length}`, answer, nodes: [], createdAt: '', updatedAt: '' }
  }
  async wait() {
    throw new Error('not used')
  }
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'system-gwr-'))
  // The gateways take the model scope's token only (ADR-0023); the others are written to be refused.
  writeFileSync(join(dir, 'model.token'), Buffer.alloc(32, 9), { mode: 0o600 })
  writeFileSync(join(dir, 'client.token'), Buffer.alloc(32, 8), { mode: 0o600 })
  writeFileSync(join(dir, 'operator.token'), Buffer.alloc(32, 7), { mode: 0o600 })
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(StubWorkflow), ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }), ctx.plugin(Gateway, { tokenDir: dir })]
  await Promise.all(fibers)
  onTestFinished(async () => { for (const f of [...fibers].reverse()) await f.dispose() })
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const base = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}/openai/v1`
  const auth = { authorization: `Bearer ${Buffer.alloc(32, 9).toString('base64url')}`, 'content-type': 'application/json' }
  return { base, auth, workflow: (ctx as unknown as { workflow: StubWorkflow }).workflow }
}

const post = (base: string, auth: Record<string, string>, body: unknown) => fetch(`${base}/responses`, { method: 'POST', headers: auth, body: JSON.stringify(body) })

describe('Responses gateway over HTTP', () => {
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

  it('guards like the MCP endpoint, lists tier models, and refuses WebSocket upgrades', async () => {
    const { base, auth } = await boot()
    expect((await fetch(`${base}/responses`, { method: 'POST', body: JSON.stringify(CODEX) })).status).toBe(401)
    expect((await fetch(`${base}/responses`, { method: 'POST', body: JSON.stringify(CODEX), headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403)
    expect((await (await fetch(`${base}/models`, { headers: auth })).json()).data.map((m: { id: string }) => m.id)).toEqual(['system-economy', 'system-standard', 'system-frontier'])
    expect((await fetch(`${base}/responses`, { headers: auth })).status).toBe(426)
  })

  it('turns a proposed call into a function_call, then sends only the output into the same conversation (REQ-GW-2)', async () => {
    const { base, auth, workflow } = await boot()
    workflow.answers = ['<call tool="exec_command">{"cmd": "cat calc.py"}</call>', 'Fixed.']
    const one = await (await post(base, auth, CODEX)).json()
    expect(one).toMatchObject({ object: 'response', status: 'completed', output: [{ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat calc.py"}' }] })
    expect(workflow.starts[0]).toMatchObject({ template: 'ask', tier: 'standard', persist: true })
    expect(String(workflow.starts[0]!.input)).toContain("The user's request: Fix calc.py.")
    const call = one.output[0]
    const two = await (await post(base, auth, { ...CODEX, input: [...(CODEX.input as []), call, { type: 'function_call_output', call_id: call.call_id, output: 'def add(a, b): return a - b' }] })).json()
    expect(two.output).toMatchObject([{ type: 'message', content: [{ text: 'Fixed.' }] }])
    expect(workflow.starts[1]).toMatchObject({ sessionId: 'ses_1' })
    expect(String(workflow.starts[1]!.input)).toMatch(/^TOOL_RESULT exec_command \(call_[0-9a-f]+\):\ndef add/)
  })

  it('follows Codex\'s local compaction: the summary request continues the conversation, the compacted history opens a new one', async () => {
    const { base, auth, workflow } = await boot()
    workflow.answers = ['Done.', 'Summary: fixed calc.py.', 'Next answer.']
    const done = await (await post(base, auth, CODEX)).json()
    // Codex asks for a handoff summary in the same thread, with no tools.
    const summary = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'You are performing a CONTEXT CHECKPOINT COMPACTION.' }] }
    await post(base, auth, { ...CODEX, tools: [], input: [...(CODEX.input as []), done.output[0], summary] })
    expect(workflow.starts[1]).toMatchObject({ sessionId: 'ses_1', input: 'You are performing a CONTEXT CHECKPOINT COMPACTION.' })
    // Then it continues from the compacted history: no assistant turn, so a new provider conversation.
    const compacted = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Another language model started to solve this problem… Summary: fixed calc.py.' }] }
    await post(base, auth, { ...CODEX, input: [...(CODEX.input as []), compacted, { type: 'message', role: 'user', content: 'And now?' }] })
    expect(workflow.starts[2]).toMatchObject({ persist: true })
    expect(workflow.starts[2]!.sessionId).toBeUndefined()
  })

  it('streams created, the items, and exactly one terminal event; a failed run is response.failed (REQ-GW-1)', async () => {
    const { base, auth, workflow } = await boot()
    workflow.answers = ['four', new Error('no Worker can take this work')]
    const text = await (await post(base, auth, { ...CODEX, stream: true })).text()
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1])
    expect(events[0]).toBe('response.created')
    expect(events.at(-1)).toBe('response.completed')
    expect(text).toContain('"delta":"four"')
    const seq = [...text.matchAll(/"sequence_number":(\d+)/g)].map((m) => Number(m[1]))
    expect(seq).toEqual(seq.map((_, i) => i))
    const failed = await (await post(base, auth, { ...CODEX, prompt_cache_key: 'thread-2', stream: true })).text()
    expect([...failed.matchAll(/^event: (.+)$/gm)].map((m) => m[1])).toEqual(['response.created', 'response.failed'])
    expect(failed).toContain('no Worker can take this work')
  })
})
