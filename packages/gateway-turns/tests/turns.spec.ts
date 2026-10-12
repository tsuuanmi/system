import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import { claimsNoAccess, NUDGE, parseToolCalls, renderOpening, renderSuffix, renderTools, Threads, tierOf, type Turn } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('the text tool protocol (ADR-0022)', () => {
  it('maps model names to tiers', () => {
    expect(tierOf('system-frontier', {})).toBe('frontier')
    expect(tierOf('claude-haiku-5-5', { haiku: 'economy' })).toBe('economy')
    expect(tierOf('claude-opus-5-5', { haiku: 'economy' })).toBe('standard')
  })

  it('lists tools compactly, and closes the opening turn by quoting the request (not a reminder)', () => {
    const tools = [{ name: 'Read', description: 'Reads a file. Long details follow.', properties: { file_path: { type: 'string' }, limit: { type: 'number' } }, required: ['file_path'] }]
    expect(renderTools(tools)).toBe('- Read(file_path: string, limit?: number) — Reads a file.')
    const turns: Turn[] = [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }, { kind: 'text', text: '<system-reminder>noise</system-reminder>' }] }]
    const opening = renderOpening('Be helpful.', tools, turns, new Map())
    expect(opening).toContain('<call tool="Read">{"file_path"')
    expect(opening).toContain('<agent-instructions>\nBe helpful.\n</agent-instructions>')
    expect(opening).toContain('[user]\nhi')
    expect(opening.trimEnd().endsWith("The user's request: hi\nIf it needs a file, a command, or any other tool, reply now with only call tags in a code block; otherwise give the final answer.")).toBe(true)
  })

  it('takes only well-formed calls to offered tools; the rest stays text', () => {
    let n = 0
    const id = () => `call_${++n}`
    const answer = 'Let me look.\n<call tool="Read">{"file_path": "/a {b}.txt"}</call>\n<call tool="Rm">{}</call>\n<call tool="Read">["bad"]</call> <call tool="Read">{"file_path": "/broken"</call>'
    const parsed = parseToolCalls(answer, new Set(['Read']), id)
    expect(parsed.calls).toEqual([{ id: 'call_1', name: 'Read', input: { file_path: '/a {b}.txt' } }])
    expect(parsed.text).toContain('Let me look.')
    expect(parsed.text).not.toContain('"/a {b}.txt"')
    expect(parsed.text).toContain('<call tool="Rm">{}</call>')
    expect(parseToolCalls('Just an answer.', new Set(['Read']), id)).toEqual({ text: 'Just an answer.', calls: [] })
    // As read from a rendered code block: the label line goes, the indentation stays.
    const block = parseToolCalls('Code\n<call tool="Read">{"file_path": "/x", "s": "a\\n    b"}</call>', new Set(['Read']), id)
    expect(block).toEqual({ text: '', calls: [{ id: 'call_2', name: 'Read', input: { file_path: '/x', s: 'a\n    b' } }] })
  })

  it('renders a later turn without the assistant replies, labelling results by tool', () => {
    const names = new Map([['c1', 'Read']])
    const suffix = renderSuffix([{ role: 'user', parts: [{ kind: 'result', id: 'c1', text: '# system' }] }], names)
    expect(suffix).toMatch(/^TOOL_RESULT Read \(c1\):\n# system\n\nContinue the task/)
    expect(renderSuffix([{ role: 'user', parts: [{ kind: 'text', text: 'thanks' }] }], names)).toBe('thanks')
  })

  it('recognises a claim that the model cannot reach the agent tools', () => {
    expect(claimsNoAccess("I can't access the specified local README.md through the tools available.")).toBe(true)
    expect(claimsNoAccess('I couldn’t access calc.py, so the bug remains.')).toBe(true)
    expect(claimsNoAccess('add() returns a - b; it cannot return the sum. Fixed.')).toBe(false)
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
  const dir = mkdtempSync(join(tmpdir(), 'system-gwt-'))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(StubWorkflow)]
  await Promise.all(fibers)
  cleanups.push(async () => { for (const f of [...fibers].reverse()) await f.dispose() }, () => rmSync(dir, { recursive: true, force: true }))
  const workflow = (ctx as unknown as { workflow: StubWorkflow }).workflow
  return { threads: new Threads(ctx, { scope: 'test' }), workflow }
}

const TOOLS = [{ name: 'Read', properties: { file_path: { type: 'string' } }, required: ['file_path'] }]
const ASK: Turn = { role: 'user', parts: [{ kind: 'text', text: 'Heading of README.md?' }] }

describe('threads', () => {
  it('opens a provider conversation, then sends only what follows the last assistant turn into it', async () => {
    const { threads, workflow } = await boot()
    workflow.answers = ['<call tool="Read">{"file_path": "/repo/README.md"}</call>', 'The heading is "system".']
    const one = await threads.exchange({ key: 'k', tier: 'standard', system: 'Be brief.', tools: TOOLS, turns: [ASK], closed: () => false })
    expect(one).toMatchObject({ kind: 'reply', text: '', calls: [{ name: 'Read', input: { file_path: '/repo/README.md' } }] })
    expect(workflow.starts[0]).toMatchObject({ template: 'ask', tier: 'standard', persist: true, classification: 'operator-shared' })
    const call = (one as { calls: Array<{ id: string }> }).calls[0]!
    const turns: Turn[] = [ASK, { role: 'assistant', parts: [{ kind: 'call', id: call.id, name: 'Read', input: {} }] }, { role: 'user', parts: [{ kind: 'result', id: call.id, text: '# system' }] }]
    expect(await threads.exchange({ key: 'k', tier: 'standard', system: 'Be brief.', tools: TOOLS, turns, closed: () => false })).toMatchObject({ kind: 'reply', text: 'The heading is "system".', calls: [] })
    expect(workflow.starts[1]).toMatchObject({ sessionId: 'ses_1' })
    expect(String(workflow.starts[1]!.input)).toMatch(new RegExp(`^TOOL_RESULT Read \\(${call.id}\\):\\n# system\\n\\nContinue the task`))
  })

  it('resumes only the conversation the history came from: another client, or an edited history, opens a fresh one', async () => {
    const { threads, workflow } = await boot()
    workflow.answers = ['<call tool="Read">{"file_path": "/repo/README.md"}</call>', 'fresh for the other client', 'fresh after the edit']
    const one = await threads.exchange({ key: 'k', tier: 'standard', system: 'Be brief.', tools: TOOLS, turns: [ASK], closed: () => false })
    const call = (one as { calls: Array<{ id: string }> }).calls[0]!
    // A second client with the same opening (same key) and its own call: never answered in the first one's conversation.
    const other: Turn[] = [ASK, { role: 'assistant', parts: [{ kind: 'call', id: 'toolu_other', name: 'Read', input: {} }] }, { role: 'user', parts: [{ kind: 'result', id: 'toolu_other', text: 'private file' }] }]
    expect(await threads.exchange({ key: 'k', tier: 'standard', system: 'Be brief.', tools: TOOLS, turns: other, closed: () => false })).toMatchObject({ kind: 'reply', text: 'fresh for the other client' })
    expect(workflow.starts[1]).toMatchObject({ persist: true })
    expect(workflow.starts[1]).not.toHaveProperty('sessionId')
    // The first client's history, with an earlier turn edited after the fact: not resumed either.
    const edited: Turn[] = [{ role: 'user', parts: [{ kind: 'text', text: 'Heading of CHANGELOG.md?' }] }, { role: 'assistant', parts: [{ kind: 'call', id: call.id, name: 'Read', input: {} }] }, { role: 'user', parts: [{ kind: 'result', id: call.id, text: '# system' }] }]
    expect(await threads.exchange({ key: 'k', tier: 'standard', system: 'Be brief.', tools: TOOLS, turns: edited, closed: () => false })).toMatchObject({ kind: 'reply', text: 'fresh after the edit' })
    expect(workflow.starts[2]).not.toHaveProperty('sessionId')
  })

  it('nudges once, in the same conversation, when a tooled answer claims it cannot reach files', async () => {
    const { threads, workflow } = await boot()
    workflow.answers = ["I can't access README.md from here.", "I still can't access it."]
    const reply = await threads.exchange({ key: 'k', tier: 'standard', system: '', tools: TOOLS, turns: [ASK], closed: () => false })
    expect(reply).toMatchObject({ kind: 'reply', text: "I still can't access it.", calls: [] })
    expect(workflow.starts[1]).toMatchObject({ sessionId: 'ses_1', input: NUDGE })
    expect(workflow.starts).toHaveLength(2)
  })
})
