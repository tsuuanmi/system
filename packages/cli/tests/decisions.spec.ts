// `system decisions list|show|ask|answer|import` (D109): the words and flags it reads, what it sends to
// the tools, what it prints, and that a refusal of the row (a registry with a gap) reaches the operator.
import { describe, expect, it } from 'vitest'
import { parseDecisions, runDecisions, type ToolOutcome } from '../src/index.ts'

const ok = (structured: Record<string, unknown>, text = ''): ToolOutcome => ({ isError: false, text, structured })

describe('parseDecisions', () => {
  it('reads each subcommand into one tool and its arguments', () => {
    expect(parseDecisions(['list'])).toMatchObject({ tool: 'decisions_list', args: {} })
    expect(parseDecisions(['list', '--state', 'asked', '--project', 'alpha', '--after', '4', '--limit', '10', '--json'])).toMatchObject({ tool: 'decisions_list', json: true, args: { state: 'asked', projectId: 'alpha', after: 4, limit: 10 } })
    expect(parseDecisions(['list', '--studio'])).toMatchObject({ args: { studio: true } })
    expect(parseDecisions(['show', 'D12'])).toMatchObject({ tool: 'decisions_show', args: { id: 'D12' } })
    expect(parseDecisions(['ask', 'Which?', '--project', 'alpha', '--option', 'A', '--option', 'B', '--recommend', 'A', '--link', 'T328', '--supersedes', 'D3'])).toMatchObject({
      tool: 'decisions_ask', args: { question: 'Which?', projectId: 'alpha', options: ['A', 'B'], recommendation: 'A', links: ['T328'], supersedes: 'D3' },
    })
    expect(parseDecisions(['answer', 'D12', 'Yes', '--source', 'a message'])).toMatchObject({ tool: 'decisions_answer', args: { id: 'D12', answer: 'Yes', source: 'a message' } })
    expect(parseDecisions(['import', 'decisions.json'])).toMatchObject({ tool: 'decisions_import', file: 'decisions.json' })
  })

  it('refuses what it does not know', () => {
    for (const words of [[], ['frob'], ['show'], ['show', '12'], ['ask'], ['ask', 'q', 'extra'], ['answer', 'D1'], ['answer', 'one', 'x'], ['list', '--state', 'maybe'], ['list', 'D1'], ['ask', 'q', '--supersedes', 'x'], ['import'], ['show', 'D1', '--studio']]) {
      expect(parseDecisions(words), words.join(' ')).toBeUndefined()
    }
  })
})

describe('runDecisions', () => {
  it('prints the decisions a list holds, the cursor, and one decision with what supersedes it', async () => {
    const lines: string[] = []
    const call = async () => ok({ decisions: [{ id: 'D1', state: 'answered', question: 'q?', answer: 'yes', answeredBy: 'lead:alpha', source: 'a message' }], next: 1 })
    expect(await runDecisions(parseDecisions(['list'])!, call, (l) => lines.push(l))).toBe(0)
    expect(lines).toEqual(['D1  answered  studio  q?', '  → yes  (lead:alpha, a message)', 'more: --after 1'])
    lines.length = 0
    await runDecisions(parseDecisions(['show', 'D1'])!, async () => ok({ decision: { id: 'D1', state: 'asked', question: 'q?', options: ['A'] }, supersededBy: ['D2'] }), (l) => lines.push(l))
    expect(lines).toEqual(['D1  asked  studio  q?', '    - A', '  superseded by D2'])
  })

  it('reads the registry file and sends it with its name, and throws the row\'s refusal', async () => {
    const sent: Array<[string, Record<string, unknown>]> = []
    const lines: string[] = []
    const read = (file: string) => JSON.stringify([{ id: 'D1', file }])
    await runDecisions(parseDecisions(['import', '/x/decisions.json'])!, async (tool, args) => { sent.push([tool, args]); return ok({ imported: 1, unchanged: 0, highest: 1 }, 'imported 1 decision(s)') }, (l) => lines.push(l), read)
    expect(sent).toEqual([['decisions_import', { registry: [{ id: 'D1', file: '/x/decisions.json' }], file: 'decisions.json' }]])
    expect(lines).toEqual(['imported 1 decision(s)'])
    const refusal = async () => ({ isError: true, text: 'the registry is refused, and nothing was imported: gap in the numbers: D3 missing', structured: undefined })
    await expect(runDecisions(parseDecisions(['import', 'decisions.json'])!, refusal, () => {}, read)).rejects.toThrow(/gap in the numbers/)
  })

  it('prints the record itself with --json', async () => {
    const lines: string[] = []
    await runDecisions(parseDecisions(['ask', 'q?', '--json'])!, async () => ok({ decision: { id: 'D5', state: 'asked', question: 'q?' } }), (l) => lines.push(l))
    expect(JSON.parse(lines[0]!)).toEqual({ decision: { id: 'D5', state: 'asked', question: 'q?' } })
  })
})
