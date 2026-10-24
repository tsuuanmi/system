import { describe, expect, it } from 'vitest'
import { outline, reply } from '../src/index.ts'

describe('a tool reply (QA-12)', () => {
  it('sends the answer once, as structured content, with a summary as its text', () => {
    const answer = { runs: [{ runId: 'run_1' }], next: 'c2' }
    expect(reply(answer, '1 run')).toEqual({ content: [{ type: 'text', text: '1 run' }], structuredContent: answer })
  })

  it('outlines an answer in one bounded line: scalars as they are, lists by length, objects one level down', () => {
    expect(outline({ task: { taskId: 't1', state: 'ready', deps: ['a', 'b'], lease: { holder: 'h' } }, next: null, page: 2, gone: undefined }))
      .toBe('task: {taskId: t1, state: ready, deps: 2 items, lease: {…}}; next: null; page: 2')
    expect(outline({ text: 'x'.repeat(100) })).toBe(`text: ${'x'.repeat(59)}…`)
    const long = outline(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field${i}`, 'value'])))
    expect([...long].length).toBe(300)
    expect(long.endsWith('…')).toBe(true)
  })
})
