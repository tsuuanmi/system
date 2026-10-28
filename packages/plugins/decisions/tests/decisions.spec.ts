// The operator's decisions (PROP-0019 section 2.7, D109): one sequence per studio that two writers never
// share (in one process and across processes), an answered record that never changes and is never
// deleted, a correction that supersedes, a lead token that asks and reads for its own project and never
// answers as the operator, and a one-time import that refuses a gap or a duplicate and runs twice
// without a change. Times are named, never read from the clock (docs/engineering/testing.md).
import { fork } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { McpTools, type ToolContext, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import * as Decisions from '../src/index.ts'
import { type Actor, DecisionLog, DecisionsError, MCP_DECISIONS, type OperatorDecision } from '../src/index.ts'
import { MAX_ENTRIES } from '../src/registry.ts'

const schemas = new SchemaRegistry()
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const T0 = new Date('2026-10-27T09:00:00.000Z')
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000)
const OPERATOR: Actor = { kind: 'operator' }
const lead = (project: string): Actor => ({ kind: 'lead', project })

/** A `ctx.mcp` that keeps contributed tools, so a test calls a handler as a token would. */
class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'system-decisions-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The row mounted on a store (and a recording MCP endpoint), and a log over the same store for direct calls. */
async function boot(dir = tempDir(), mcp = false): Promise<{ ctx: Context; decisions: DecisionLog; dir: string }> {
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db'), busyTimeoutMs: 30_000 })]
  if (mcp) fibers.push(ctx.plugin(RecordingMcp))
  await Promise.all(fibers)
  const row = ctx.plugin(Decisions, {})
  fibers.push(row)
  await row
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanups.push(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    await new Promise((resolve) => setImmediate(resolve))
  })
  return { ctx, decisions: new DecisionLog(ctx), dir }
}

const refused = (run: () => unknown): DecisionsError => {
  try {
    run()
  } catch (error) {
    if (error instanceof DecisionsError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('the record', () => {
  const asked: OperatorDecision = { schema: 'operator-decision@1.0', id: 'D5', state: 'asked', question: 'q', askedAt: T0.toISOString(), askedBy: 'operator', revision: 0 }
  const valid = (record: unknown): boolean => { try { schemas.assert('operator-decision@1.0', record); return true } catch { return false } }

  it('has an asked state without an answer and an answered state with its answer, who recorded it, and when', () => {
    expect(valid(asked)).toBe(true)
    expect(valid({ ...asked, answer: 'yes' })).toBe(false)
    const answered = { ...asked, state: 'answered', answer: 'yes', answeredAt: at(1).toISOString(), answeredBy: 'operator', revision: 1 }
    expect(valid(answered)).toBe(true)
    for (const field of ['answer', 'answeredAt', 'answeredBy']) expect(valid(Object.fromEntries(Object.entries(answered).filter(([k]) => k !== field))), field).toBe(false)
    expect(valid({ ...answered, answeredBy: 'somebody' })).toBe(false)
    expect(valid({ ...answered, answeredBy: 'lead:alpha', source: 'a message' })).toBe(true)
  })

  it('refuses an answer a lead recorded without where the operator said it, as a stored record too', () => {
    const answered = { ...asked, state: 'answered', answer: 'yes', answeredAt: at(1).toISOString(), revision: 1 }
    expect(valid({ ...answered, answeredBy: 'lead:alpha' })).toBe(false)
    expect(valid({ ...answered, answeredBy: 'lead:alpha', source: 'the operator\'s message' })).toBe(true)
    // The operator's own answer needs none.
    expect(valid({ ...answered, answeredBy: 'operator' })).toBe(true)
  })

  it('holds a record of the import to its file, and only such a record names one', () => {
    const imported = { ...asked, askedBy: 'import', importedFrom: 'decisions.json' }
    expect(valid(imported)).toBe(true)
    expect(valid({ ...asked, askedBy: 'import' })).toBe(false)
    expect(valid({ ...asked, importedFrom: 'decisions.json' })).toBe(false)
    const answered = { ...imported, state: 'answered', answer: 'yes', answeredAt: at(1).toISOString(), answeredBy: 'import', revision: 1 }
    expect(valid(answered)).toBe(true)
    expect(valid({ ...asked, state: 'answered', answer: 'yes', answeredAt: at(1).toISOString(), answeredBy: 'import', revision: 1 })).toBe(false)
  })

  it('numbers a decision D<n> and names a project only by its id', () => {
    for (const id of ['D0', 'D01', 'd5', '5', 'D', 'D1x']) expect(valid({ ...asked, id }), id).toBe(false)
    expect(valid({ ...asked, projectId: 'alpha' })).toBe(true)
    expect(valid({ ...asked, projectId: '' })).toBe(false)
    expect(valid({ ...asked, supersedes: 'D4' })).toBe(true)
    expect(valid({ ...asked, supersedes: 'four' })).toBe(false)
  })

  it('is bounded and closed (INV-9)', () => {
    expect(valid({ ...asked, options: Array.from({ length: 21 }, () => 'x') })).toBe(false)
    expect(valid({ ...asked, links: Array.from({ length: 21 }, () => 'x') })).toBe(false)
    expect(valid({ ...asked, question: 'x'.repeat(4001) })).toBe(false)
    expect(valid({ ...asked, extra: true })).toBe(false)
  })
})

describe('the sequence', () => {
  it('gives each question the studio\'s next number, project and studio-wide alike, in order', async () => {
    const { decisions } = await boot()
    const ids = [
      decisions.ask({ question: 'one' }, OPERATOR, at(0)),
      decisions.ask({ question: 'two', projectId: 'alpha' }, OPERATOR, at(1)),
      decisions.ask({ question: 'three' }, lead('beta'), at(2)),
    ].map((d) => d.id)
    expect(ids).toEqual(['D1', 'D2', 'D3'])
    expect(decisions.list({}, OPERATOR).decisions.map((d) => d.id)).toEqual(['D1', 'D2', 'D3'])
  })

  it('never gives two concurrent writers one number: two plugin instances on one store file', async () => {
    const one = await boot()
    const two = await boot(one.dir)
    const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push((i % 2 ? two : one).decisions.ask({ question: `q${i}` }, OPERATOR, at(i)).id)
    expect(new Set(ids).size).toBe(20)
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => `D${i + 1}`))
  })

  it('never gives two processes racing for the next number one number (BEGIN IMMEDIATE), and leaves no gap', async () => {
    const { dir, decisions } = await boot()
    const worker = fileURLToPath(new URL('./race-worker.ts', import.meta.url))
    const children = ['a', 'b', 'c', 'd'].map((label) => fork(worker, [join(dir, 'system.db'), label, '5'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }))
    const results = children.map((child) => new Promise<string[]>((resolve, reject) => {
      child.on('message', (m) => m !== 'ready' && resolve(JSON.parse(String(m)) as string[]))
      child.on('exit', (code) => code !== 0 && reject(new Error(`race worker exited ${code}`)))
    }))
    await Promise.all(children.map((child) => new Promise<void>((resolve) => child.on('message', (m) => m === 'ready' && resolve()))))
    for (const child of children) child.send('go')
    const all = (await Promise.all(results)).flat()
    expect(new Set(all).size).toBe(20)
    expect(decisions.list({ limit: 200 }, OPERATOR).decisions.map((d) => d.id)).toEqual(Array.from({ length: 20 }, (_, i) => `D${i + 1}`))
  }, 120_000)

  it('keeps the sequence across a restart', async () => {
    const one = await boot()
    one.decisions.ask({ question: 'before' }, OPERATOR, at(0))
    const two = await boot(one.dir)
    expect(two.decisions.ask({ question: 'after' }, OPERATOR, at(1)).id).toBe('D2')
  })
})

describe('asking, answering, and correcting', () => {
  it('records the answer on the same number, once, and never changes or deletes an answered record', async () => {
    const { decisions, ctx } = await boot()
    const q = decisions.ask({ question: 'merge on dev?', options: ['yes', 'no'], recommendation: 'yes', links: ['T328'] }, OPERATOR, at(0))
    expect(q).toMatchObject({ id: 'D1', state: 'asked', askedBy: 'operator', revision: 0, options: ['yes', 'no'] })
    const a = decisions.answer({ id: 'D1', answer: 'yes' }, OPERATOR, at(1))
    expect(a).toMatchObject({ id: 'D1', state: 'answered', answer: 'yes', answeredBy: 'operator', answeredAt: at(1).toISOString(), askedAt: at(0).toISOString(), revision: 1 })
    expect(refused(() => decisions.answer({ id: 'D1', answer: 'no' }, OPERATOR, at(2))).code).toBe('conflict')
    expect(refused(() => decisions.answer({ id: 'D9', answer: 'no' }, OPERATOR, at(2))).code).toBe('not-found')
    // The store itself refuses what the service would never do.
    const db = ctx.store.db
    expect(() => db.prepare('DELETE FROM operator_decisions WHERE id = ?').run('D1')).toThrow(/never deleted/)
    expect(() => db.prepare("UPDATE operator_decisions SET record = '{}' WHERE id = ?").run('D1')).toThrow(/never changes/)
    expect(decisions.show('D1', OPERATOR)?.decision.answer).toBe('yes')
  })

  it('corrects by a new record that supersedes the old one, which stays as it was', async () => {
    const { decisions } = await boot()
    decisions.ask({ question: 'a?' }, OPERATOR, at(0))
    const old = decisions.answer({ id: 'D1', answer: 'A' }, OPERATOR, at(1))
    const fix = decisions.ask({ question: 'a? (corrected)', supersedes: 'D1' }, OPERATOR, at(2))
    expect(fix).toMatchObject({ id: 'D2', supersedes: 'D1' })
    expect(decisions.show('D1', OPERATOR)).toEqual({ decision: old, supersededBy: ['D2'] })
    expect(refused(() => decisions.ask({ question: 'x', supersedes: 'D40' }, OPERATOR, at(3))).code).toBe('not-found')
    // A refused write takes no number.
    expect(decisions.ask({ question: 'next' }, OPERATOR, at(4)).id).toBe('D3')
  })

  it('lists what waits, a page at a time', async () => {
    const { decisions } = await boot()
    for (let i = 0; i < 5; i++) decisions.ask({ question: `q${i}` }, OPERATOR, at(i))
    decisions.answer({ id: 'D2', answer: 'ok' }, OPERATOR, at(9))
    expect(decisions.list({ state: 'asked' }, OPERATOR).decisions.map((d) => d.id)).toEqual(['D1', 'D3', 'D4', 'D5'])
    const page = decisions.list({ limit: 2 }, OPERATOR)
    expect(page).toMatchObject({ next: 2 })
    expect(decisions.list({ limit: 2, after: page.next! }, OPERATOR).decisions.map((d) => d.id)).toEqual(['D3', 'D4'])
    expect(refused(() => decisions.list({ limit: 201 }, OPERATOR)).code).toBe('invalid')
  })
})

describe('a lead token', () => {
  const call = async (ctx: Context, tool: string, args: Record<string, unknown>, context: ToolContext) => (ctx.mcp as RecordingMcp).tools.get(tool)!.handler(args, context)
  const LEAD: ToolContext = { scope: 'client', lead: 'alpha' }
  const OPERATOR_CONTEXT: ToolContext = { scope: 'operator' }

  it('is a lead tool: the operator\'s scope, served to a lead token only because it checks the rights itself', async () => {
    const { ctx } = await boot(undefined, true)
    const tools = (ctx.mcp as RecordingMcp).tools
    expect([...tools.keys()].sort()).toEqual(['decisions_answer', 'decisions_ask', 'decisions_import', 'decisions_list', 'decisions_show'])
    for (const [name, { spec }] of tools) expect([name, spec.scope, spec.lead], name).toEqual([name, 'operator', name === 'decisions_import' ? undefined : true])
  })

  it('provides no seam: the row is its tools, and nothing is added to ctx', async () => {
    const { ctx } = await boot(undefined, true)
    expect((ctx as unknown as Record<string, unknown>)['operatorDecisions']).toBeUndefined()
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../plugin-manifest.json', import.meta.url)), 'utf8')) as { provides: unknown[] }
    expect(manifest.provides).toEqual([])
  })

  it('holds every call to mcp-decisions@1.0: a refused input does nothing, and each output is the contract\'s', async () => {
    const { ctx, decisions } = await boot(undefined, true)
    const tooLong = await call(ctx, 'decisions_ask', { question: 'x'.repeat(4001) }, OPERATOR_CONTEXT)
    expect(tooLong.isError).toBe(true)
    expect(JSON.stringify(tooLong.content)).toContain('invalid input, nothing done')
    const extra = await call(ctx, 'decisions_answer', { id: 'D1', answer: 'yes', answeredBy: 'operator' }, LEAD)
    expect(extra.isError).toBe(true)
    expect(JSON.stringify(extra.content)).toContain('invalid input, nothing done')
    expect(decisions.list({}, OPERATOR).decisions).toEqual([])
    const outputs: Array<[string, Record<string, unknown>]> = []
    const run = async (tool: string, args: Record<string, unknown>) => {
      const result = await call(ctx, tool, args, OPERATOR_CONTEXT)
      expect(result.isError, tool).toBeFalsy()
      outputs.push([tool, result.structuredContent as Record<string, unknown>])
    }
    await run('decisions_ask', { question: 'q?', options: ['A', 'B'], links: ['T328'] })
    await run('decisions_answer', { id: 'D1', answer: 'A' })
    await run('decisions_ask', { question: 'q? (corrected)', supersedes: 'D1' })
    await run('decisions_list', { limit: 1 })
    await run('decisions_show', { id: 'D1' })
    const fresh = await boot(undefined, true)
    const imported = await call(fresh.ctx, 'decisions_import', { registry: [{ id: 'D1', question: 'q', status: 'asked', asked: '2026-10-25' }], file: 'decisions.json' }, OPERATOR_CONTEXT)
    outputs.push(['decisions_import', imported.structuredContent as Record<string, unknown>])
    for (const [tool, output] of outputs) expect(() => schemas.assertDef(MCP_DECISIONS, `${tool.replaceAll('_', '-')}-output`, output), tool).not.toThrow()
    const example = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../schemas/examples/mcp-decisions.answer.json', import.meta.url)), 'utf8')) as { input: Record<string, unknown>; output: { decision: Record<string, unknown> } }
    expect(() => schemas.assert(MCP_DECISIONS, example)).not.toThrow()
    expect(() => schemas.assert(MCP_DECISIONS, { ...example, output: { decision: { ...example.output.decision, state: 'asked' } } })).toThrow()
    expect(() => schemas.assert(MCP_DECISIONS, { ...example, input: { ...example.input, answeredBy: 'operator' } })).toThrow()
  })

  it('asks for its own project only, and the record says the lead asked', async () => {
    const { ctx, decisions } = await boot(undefined, true)
    const own = await call(ctx, 'decisions_ask', { question: 'ship it?' }, LEAD)
    expect(own.isError).toBeFalsy()
    expect(own.structuredContent).toMatchObject({ decision: { id: 'D1', projectId: 'alpha', askedBy: 'lead:alpha' } })
    const other = await call(ctx, 'decisions_ask', { question: 'ship it?', projectId: 'beta' }, LEAD)
    expect(other.isError).toBe(true)
    expect(JSON.stringify(other.content)).toContain('another project')
    expect(decisions.list({}, OPERATOR).decisions).toHaveLength(1)
  })

  it('cannot answer as the operator: an answer is its own, on the operator\'s word, for its own project only', async () => {
    const { ctx, decisions } = await boot(undefined, true)
    decisions.ask({ question: 'alpha?', projectId: 'alpha' }, OPERATOR, at(0))
    decisions.ask({ question: 'beta?', projectId: 'beta' }, OPERATOR, at(1))
    decisions.ask({ question: 'everyone?' }, OPERATOR, at(2))
    // No word of the operator's: refused.
    const bare = await call(ctx, 'decisions_answer', { id: 'D1', answer: 'yes' }, LEAD)
    expect(bare.isError).toBe(true)
    expect(JSON.stringify(bare.content)).toContain('operator\'s word')
    // Another project's, and a studio-wide one: only the operator answers them.
    for (const id of ['D2', 'D3']) {
      const refusal = await call(ctx, 'decisions_answer', { id, answer: 'yes', source: 'the operator said so' }, LEAD)
      expect(refusal.isError, id).toBe(true)
      expect(JSON.stringify(refusal.content)).toContain('only the operator')
    }
    expect(decisions.list({ state: 'answered' }, OPERATOR).decisions).toEqual([])
    // Its own, with the source: recorded as the lead's, never as the operator's.
    const own = await call(ctx, 'decisions_answer', { id: 'D1', answer: 'yes', source: 'the operator\'s message, 09:12' }, LEAD)
    expect(own.isError).toBeFalsy()
    expect(own.structuredContent).toMatchObject({ decision: { id: 'D1', state: 'answered', answeredBy: 'lead:alpha', source: 'the operator\'s message, 09:12' } })
    // The operator's token answers as the operator.
    const mine = await call(ctx, 'decisions_answer', { id: 'D2', answer: 'no' }, OPERATOR_CONTEXT)
    expect(mine.structuredContent).toMatchObject({ decision: { id: 'D2', answeredBy: 'operator' } })
    // A token of neither kind (a client token, a lead-less one) reaches nothing.
    const stranger = await call(ctx, 'decisions_answer', { id: 'D3', answer: 'no' }, { scope: 'client' })
    expect(stranger.isError).toBe(true)
    expect(decisions.show('D3', OPERATOR)?.decision.state).toBe('asked')
  })

  it('reads its own project\'s decisions and the studio-wide ones, never another project\'s', async () => {
    const { ctx, decisions } = await boot(undefined, true)
    decisions.ask({ question: 'alpha?', projectId: 'alpha' }, OPERATOR, at(0))
    decisions.ask({ question: 'beta?', projectId: 'beta' }, OPERATOR, at(1))
    decisions.ask({ question: 'everyone?' }, OPERATOR, at(2))
    const list = await call(ctx, 'decisions_list', {}, LEAD)
    expect((list.structuredContent as { decisions: OperatorDecision[] }).decisions.map((d) => d.id)).toEqual(['D1', 'D3'])
    expect(((await call(ctx, 'decisions_list', { studio: true }, LEAD)).structuredContent as { decisions: OperatorDecision[] }).decisions.map((d) => d.id)).toEqual(['D3'])
    expect((await call(ctx, 'decisions_list', { projectId: 'beta' }, LEAD)).isError).toBe(true)
    expect((await call(ctx, 'decisions_show', { id: 'D3' }, LEAD)).isError).toBeFalsy()
    expect((await call(ctx, 'decisions_show', { id: 'D2' }, LEAD)).isError).toBe(true)
    expect(((await call(ctx, 'decisions_list', {}, OPERATOR_CONTEXT)).structuredContent as { decisions: OperatorDecision[] }).decisions).toHaveLength(3)
  })

  it('corrects only a decision of its own project, and never imports', async () => {
    const { ctx, decisions } = await boot(undefined, true)
    decisions.ask({ question: 'beta?', projectId: 'beta' }, OPERATOR, at(0))
    decisions.ask({ question: 'everyone?' }, OPERATOR, at(1))
    expect((await call(ctx, 'decisions_ask', { question: 'fix', supersedes: 'D1' }, LEAD)).isError).toBe(true)
    expect((await call(ctx, 'decisions_ask', { question: 'fix', supersedes: 'D2' }, LEAD)).isError).toBe(true)
    expect(refused(() => decisions.import([{ id: 'D1', question: 'q', status: 'asked', asked: '2026-10-25' }], 'decisions.json', lead('alpha'))).code).toBe('forbidden')
    expect(decisions.list({}, OPERATOR).decisions).toHaveLength(2)
  })
})

describe('the import', () => {
  const entry = (n: number, extra: Record<string, unknown> = {}) => ({ id: `D${n}`, question: `question ${n}`, status: 'answered', asked: '2026-10-25', answered: '2026-10-26T10:00:00Z', answer: `answer ${n}`, ...extra })
  const registry = (...numbers: number[]) => numbers.map((n) => entry(n))
  const message = (run: () => unknown): string => refused(run).message

  it('reads a registry into numbered records, and the next question follows the highest number', async () => {
    const { decisions } = await boot()
    const result = decisions.import({ decisions: [...registry(1, 2), entry(3, { status: 'asked', answered: undefined, answer: undefined, options: ['A: yes', { label: 'B: no' }], project: 'system', links: ['T328'] })] }, 'decisions.json', OPERATOR)
    expect(result).toEqual({ imported: 3, unchanged: 0, highest: 3 })
    expect(decisions.show('D1', OPERATOR)?.decision).toMatchObject({ state: 'answered', answer: 'answer 1', askedAt: '2026-10-25T00:00:00.000Z', answeredAt: '2026-10-26T10:00:00.000Z', askedBy: 'import', answeredBy: 'import', importedFrom: 'decisions.json' })
    expect(decisions.show('D3', OPERATOR)?.decision).toMatchObject({ state: 'asked', projectId: 'system', options: ['A: yes', 'B: no'], links: ['T328'] })
    expect(decisions.ask({ question: 'next' }, OPERATOR, at(0)).id).toBe('D4')
  })

  it('refuses a gap in the numbers, naming it, and writes nothing', async () => {
    const { decisions } = await boot()
    expect(message(() => decisions.import(registry(1, 2, 4, 5), 'decisions.json', OPERATOR))).toMatch(/gap in the numbers: D3 missing below D5/)
    expect(message(() => decisions.import(registry(2, 3), 'decisions.json', OPERATOR))).toMatch(/gap in the numbers: D1 missing/)
    expect(message(() => decisions.import(registry(1, 5, 6, 9), 'decisions.json', OPERATOR))).toMatch(/gap in the numbers: D2 to D4, D7 to D8 missing below D9/)
    expect(decisions.list({}, OPERATOR).decisions).toEqual([])
    expect(decisions.ask({ question: 'first' }, OPERATOR, at(0)).id).toBe('D1')
  })

  it('refuses a gap at once whatever the highest number: its work is bounded by the entries, not by the number (INV-9)', async () => {
    const { decisions } = await boot()
    // Were the gap found by counting up to the highest number, this would loop a billion times.
    expect(message(() => decisions.import([entry(999_999_999)], 'decisions.json', OPERATOR))).toMatch(/gap in the numbers: D1 to D999999998 missing below D999999999/)
    // Many gaps: a bounded list of ranges, and how many more.
    const sparse = Array.from({ length: 30 }, (_, i) => entry((i + 1) * 1000))
    const refusal = message(() => decisions.import(sparse, 'decisions.json', OPERATOR))
    expect(refusal).toMatch(/gap in the numbers: D1 to D999, D1001 to D1999,/)
    expect(refusal).toMatch(/and 10 more range\(s\)/)
    expect(decisions.list({}, OPERATOR).decisions).toEqual([])
  })

  it('refuses a registry past its bound before reading an entry, and names the gap before the entries\' own problems', async () => {
    const { decisions } = await boot()
    const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => entry(i + 1))
    expect(message(() => decisions.import(many, 'decisions.json', OPERATOR))).toMatch(new RegExp(`more than ${MAX_ENTRIES} decisions`))
    expect(message(() => decisions.import({ decisions: many }, 'decisions.json', OPERATOR))).toMatch(new RegExp(`more than ${MAX_ENTRIES} decisions`))
    const bad = [...Array.from({ length: 25 }, (_, i) => entry(i + 1, { status: 'maybe' })), entry(40)]
    const refusal = message(() => decisions.import(bad, 'decisions.json', OPERATOR))
    expect(refusal).toMatch(/refused, and nothing was imported: gap in the numbers: D26 to D39 missing below D40/)
    expect(refusal).toMatch(/and 6 more$/)
    expect(decisions.list({}, OPERATOR).decisions).toEqual([])
  })

  it('refuses a duplicated number, and writes nothing', async () => {
    const { decisions } = await boot()
    expect(message(() => decisions.import([...registry(1, 2), entry(2)], 'decisions.json', OPERATOR))).toMatch(/D2: the number is in the file twice/)
    expect(message(() => decisions.import([...registry(1), { ...entry(2), id: 'D1' }], 'decisions.json', OPERATOR))).toMatch(/the number is in the file twice/)
    expect(decisions.list({}, OPERATOR).decisions).toEqual([])
  })

  it('refuses an entry it cannot read exactly, and a file that is no registry', async () => {
    const { decisions } = await boot()
    expect(message(() => decisions.import([entry(1, { status: 'maybe' })], 'f.json', OPERATOR))).toMatch(/D1: status is "maybe"/)
    expect(message(() => decisions.import([entry(1, { asked: undefined })], 'f.json', OPERATOR))).toMatch(/D1: no asked time/)
    expect(message(() => decisions.import([entry(1, { answer: undefined })], 'f.json', OPERATOR))).toMatch(/D1: answered, but no answer/)
    expect(message(() => decisions.import([entry(1, { question: 'x'.repeat(4001) })], 'f.json', OPERATOR))).toMatch(/D1:/)
    expect(message(() => decisions.import('nope', 'f.json', OPERATOR))).toMatch(/not a decision registry/)
    expect(message(() => decisions.import([], 'f.json', OPERATOR))).toMatch(/no decision/)
    expect(decisions.list({}, OPERATOR).decisions).toEqual([])
  })

  it('is idempotent: a second run changes nothing, also once a question was answered or asked here since', async () => {
    const { decisions } = await boot()
    const file = [...registry(1, 2), entry(3, { status: 'asked', answered: undefined, answer: undefined })]
    expect(decisions.import(file, 'decisions.json', OPERATOR)).toEqual({ imported: 3, unchanged: 0, highest: 3 })
    const before = JSON.stringify(decisions.list({}, OPERATOR))
    expect(decisions.import(file, 'decisions.json', OPERATOR)).toEqual({ imported: 0, unchanged: 3, highest: 3 })
    expect(JSON.stringify(decisions.list({}, OPERATOR))).toBe(before)
    decisions.answer({ id: 'D3', answer: 'done' }, OPERATOR, at(0))
    decisions.ask({ question: 'new' }, OPERATOR, at(1))
    expect(decisions.import(file, 'decisions.json', OPERATOR)).toEqual({ imported: 0, unchanged: 3, highest: 3 })
    expect(decisions.show('D3', OPERATOR)?.decision.answer).toBe('done')
    expect(decisions.list({}, OPERATOR).decisions).toHaveLength(4)
  })

  it('refuses a registry that differs from what is stored, or into a log that holds other decisions', async () => {
    const { decisions } = await boot()
    decisions.import(registry(1, 2), 'decisions.json', OPERATOR)
    expect(message(() => decisions.import([entry(1, { answer: 'changed' }), entry(2)], 'decisions.json', OPERATOR))).toMatch(/D1 differs from the one stored/)
    const other = await boot()
    other.decisions.ask({ question: 'mine' }, OPERATOR, at(0))
    expect(message(() => other.decisions.import(registry(1, 2), 'decisions.json', OPERATOR))).toMatch(/D1 differs from the one stored/)
    expect(other.decisions.list({}, OPERATOR).decisions).toHaveLength(1)
  })
})
