import { describe, expect, it } from 'vitest'
import { type Brief, BriefError, bodyText, canonicalJson, type ContentId, type ReadArtifact, renderBrief, startPrompt } from '../src/index.ts'

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
