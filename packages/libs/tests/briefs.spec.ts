import { describe, expect, it } from 'vitest'
import { type Brief, BriefError, bodyText, canonicalJson, type ContentId, QUESTION_LIMITS, questionsOf, type ReadArtifact, renderBrief, startPrompt } from '../src/index.ts'

const REPORT = `sha256:${'a'.repeat(64)}` as ContentId
const LOG = `sha256:${'b'.repeat(64)}` as ContentId
const BRIEF = `sha256:${'c'.repeat(64)}` as ContentId
const MISSING = `sha256:${'d'.repeat(64)}` as ContentId

const brief = (extra: Partial<Brief> = {}): Brief => ({
  schema: 'brief@1.1', goal: 'Compact the report', acceptance: [{ id: 'contract', statement: 'passes acceptance.answer' }],
  artifacts: [{ ref: REPORT, role: 'input', note: 'the result of node research:1' }],
  instructions: [{ text: 'Compact this:\n<report>\n' }, { artifact: 0 }, { text: '\n</report>' }],
  budget: { remaining: [] }, sandbox: { mode: 'read-only', network: 'allow-list', commands: false }, classification: 'public', ...extra,
})

const store = new Map<string, ReadArtifact>([
  [REPORT, { bodySchema: 'provider-answer@1.0', body: { schema: 'provider-answer@1.0', text: 'the {{input}} report' }, classification: 'public' }],
  [LOG, { bodySchema: 'evidence-table@1.0', body: { z: 1, a: 'x' }, classification: 'operator-shared' }],
])
const read = (ref: ContentId): ReadArtifact | undefined => store.get(ref)

describe('briefs', () => {
  it('tells a Worker how to ask instead of answering only when the brief offers it (brief@1.2 ask)', () => {
    const asking = renderBrief(brief({ schema: 'brief@1.2', projectId: 'p1', taskId: 't1', attempt: 1, ask: { maxQuestions: 3 } }), read)
    expect(asking).toContain('answer with only this JSON object and nothing else: {"questions": ["..."]}, with 1 to 3 questions of at most 500 characters each')
    expect(renderBrief(brief({ projectId: 'p1', taskId: 't1', attempt: 1 }), read)).not.toContain('"questions"')
  })

  it('says what checks each criterion of a board task that names it, before the instructions (brief@1.3 check)', () => {
    const checked = renderBrief(brief({
      schema: 'brief@1.3', projectId: 'p1', taskId: 't1', attempt: 1,
      acceptance: [{ id: 'a1', statement: 'pnpm test passes', check: 'tests' }, { id: 'a2', statement: 'the benchmark records a speed-up' }],
    }), read)
    expect(checked).toContain('Acceptance criteria:\n- a1: pnpm test passes (check: tests)\n- a2: the benchmark records a speed-up\n')
    expect(checked.indexOf('Acceptance criteria:')).toBeLessThan(checked.indexOf('Compact this:'))
  })

  it('names a brief\'s files only when its source writes them into the run\'s workspace (brief@1.2 files)', () => {
    const filed = brief({ schema: 'brief@1.2', projectId: 'p1', taskId: 't1', attempt: 1, files: [{ path: '.system/TASKS.md', ref: LOG, note: 'the board of p1' }] })
    expect(renderBrief(filed, read, { placesFiles: true })).toContain('Files in your workspace, written by system before this run (read-only; edits are never read back):\n- .system/TASKS.md: the board of p1')
    // Never inlined: the file's text is not part of the prompt either way.
    expect(renderBrief(filed, read, { placesFiles: true })).not.toContain('"z":1')
    expect(renderBrief(filed, read)).not.toContain('.system/TASKS.md')
  })

  it('reads questions only from an answer that is wholly one questions object, bounded (INV-9)', () => {
    expect(questionsOf('{"questions": ["Which band width?", " Keep the old API? "]}')).toEqual(['Which band width?', 'Keep the old API?'])
    expect(questionsOf('```json\n{"questions": ["Which band width?"]}\n```')).toEqual(['Which band width?'])
    expect(questionsOf('```\n{"questions": ["Which band width?"]}\n```')).toEqual(['Which band width?'])
    const long = 'x'.repeat(QUESTION_LIMITS.chars + 1)
    for (const answer of [
      'Done. {"questions": ["a"]}', '{"questions": []}', '{"questions": ["a"], "result": "b"}', '{"questions": "a"}', '{"questions": [""]}', '{"questions": [1]}',
      `{"questions": ["${long}"]}`, JSON.stringify({ questions: Array.from({ length: 9 }, (_, i) => `q${i}`) }), '["a"]', 'not json', '```python\n{"questions": ["a"]}\n```',
      'x'.repeat(100_000),
    ]) expect(questionsOf(answer), answer.slice(0, 60)).toBeUndefined()
    expect(questionsOf('{"questions": ["a", "b", "c"]}', 2)).toBeUndefined()
    expect(questionsOf(JSON.stringify({ questions: ['é'.repeat(QUESTION_LIMITS.chars)] }))).toHaveLength(1)
  })

  it('renders instructions in order, each pointer replaced verbatim by its artifact\'s text and never expanded again', () => {
    expect(renderBrief(brief(), read)).toBe('Compact this:\n<report>\nthe {{input}} report\n</report>')
  })

  it('reads a body with no text as its canonical JSON, as a quote check does', () => {
    expect(bodyText({ z: 1, a: 'x' })).toBe(canonicalJson({ a: 'x', z: 1 }))
    expect(bodyText({ text: 'plain' })).toBe('plain')
  })

  it('states a board task\'s goal and criteria first, and appends the pointers its instructions do not place, with their role', () => {
    const task = brief({
      projectId: 'p1', taskId: 't1', attempt: 2, goal: 'Make the kernel faster', acceptance: [{ id: 'a1', statement: 'tests pass' }],
      artifacts: [{ ref: REPORT, role: 'input' }, { ref: LOG, role: 'prior', note: 'attempt 1' }], openQuestions: ['Band width?'],
      instructions: [{ text: 'Go on: ' }, { artifact: 0 }],
    })
    expect(renderBrief(task, read)).toBe([
      'Board task t1 of project p1, attempt 2.\nGoal: Make the kernel faster\nAcceptance criteria:\n- a1: tests pass\nOpen questions:\n- Band width?',
      'Go on: the {{input}} report',
      `Read these too:\n\n<artifact id="${LOG}" role="prior" note="attempt 1">\n${canonicalJson({ a: 'x', z: 1 })}\n</artifact>`,
    ].join('\n\n'))
  })

  it('renders a brief without instructions from its goal, criteria, and pointers', () => {
    const { instructions: _, ...bare } = brief()
    expect(renderBrief({ ...bare, schema: 'brief@1.0' }, read)).toBe(`Goal: Compact the report\nAcceptance criteria:\n- contract: passes acceptance.answer\n\nRead these too:\n\n<artifact id="${REPORT}" role="input" note="the result of node research:1">\nthe {{input}} report\n</artifact>`)
  })

  it('refuses a pointer that is not stored, or an index the brief does not have: nothing is sent (INV-2)', () => {
    expect(() => renderBrief(brief({ artifacts: [{ ref: MISSING, role: 'input' }] }), read)).toThrow(BriefError)
    expect(() => renderBrief(brief({ instructions: [{ artifact: 1 }] }), read)).toThrow(/place artifact 1, and it points at 1/)
  })

  it('takes a start\'s prompt, or renders its brief, at the requirement\'s classification, the work\'s own (INV-12)', () => {
    const requirement = { data: { classification: 'public' as const } }
    expect(startPrompt({ prompt: 'q', requirement }, read)).toEqual({ prompt: 'q', classification: 'public' })
    const local = new Map(store).set(BRIEF, { bodySchema: 'brief@1.1', body: brief(), classification: 'local-private' })
    expect(startPrompt({ brief: BRIEF, requirement }, (ref) => local.get(ref))).toEqual({ prompt: 'Compact this:\n<report>\nthe {{input}} report\n</report>', classification: 'public' })
    expect(() => startPrompt({ requirement }, read)).toThrow(/exactly one/)
    expect(() => startPrompt({ prompt: 'q', brief: BRIEF, requirement }, read)).toThrow(/exactly one/)
    expect(() => startPrompt({ brief: REPORT, requirement }, read)).toThrow(/not a brief/)
    expect(() => startPrompt({ brief: MISSING, requirement }, read)).toThrow(/not stored/)
  })
})
