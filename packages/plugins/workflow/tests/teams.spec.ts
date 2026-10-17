import { describe, expect, it } from 'vitest'
import type { TeamRole } from '../src/spec.ts'
import { ballotShape, parseBallot, parseFindings } from '../src/teams.ts'

/** A member that fills in the prompt's shape exactly as shown, for the option it chose. */
function asShown(shape: string, options: readonly string[], choice: string): string {
  const strongest = JSON.parse(/"strongest": (\{[^}]*\})/.exec(shape)![1]!) as Record<string, string>
  return JSON.stringify({ choice, ranking: [choice, ...options.filter((o) => o !== choice)], rationale: 'why', evidence: [], strongest, objections: [], confidence: 'high' })
}

describe('team ballots', () => {
  it('asks for a ballot shape that is accepted whichever option the member chooses, not only the first', () => {
    const cases: Array<[TeamRole['kind'], string[]]> = [['review', ['pass', 'changes']], ['brainstorm', ['O1', 'O2']], ['brainstorm', ['O1', 'O2', 'O3']]]
    for (const [kind, options] of cases) {
      for (const debate of [false, true]) {
        const shape = ballotShape({ kind } as TeamRole, options, debate)
        for (const choice of options) expect(parseBallot(asShown(shape, options, choice), options), `${kind} ${choice}`).toMatchObject({ choice })
      }
    }
  })
})

describe('team answers', () => {
  const json = JSON.stringify({ findings: [{ severity: 'blocking', claim: 'The lease leaks', evidence: 'line 3' }] }, null, 2)
  const found = [{ severity: 'blocking', claim: 'The lease leaks', evidence: 'line 3' }]

  it('reads the findings an answer ends with, whatever it quoted before them', () => {
    const answers = {
      // A code block before the JSON block: its closing fence is not the next block's opening.
      'a quoted code block': ['The lease:', '```ts', 'const lease = acquire()', '```', 'is never released.', '```json', json, '```'].join('\n'),
      // Unfenced, after prose and code with braces of their own.
      'braces before it': `In \`f() { ... }\` the \`{ lease }\` is kept:\n${json}`,
      // A longer fence holds a shorter one, and tildes fence as backticks do.
      'nested fences': ['````md', '```', 'x', '```', '````', '~~~json', json, '~~~'].join('\n'),
      // As a site renders it when its Copy is not used: a label before, a caution after.
      'rendered text': `Use \`{}\` here.\nJSON\n${json}\nUse code with caution.`,
      // A last block that is no JSON object (an example after the findings) does not hide them.
      'an example after it': ['```json', json, '```', 'For instance:', '```ts', 'f({ a: 1 })', '```'].join('\n'),
    }
    for (const [name, text] of Object.entries(answers)) expect(parseFindings(text), name).toEqual(found)
  })

  it('refuses an answer with no findings object, saying why', () => {
    const last = ['```json', json, '```', 'An example:']
    for (const text of [
      'No JSON here.', '```ts\nconst a = { b: 1 }\n```', '{"findings": "none"}',
      // The last JSON block decides: a list or an object of another shape there is refused, never read past.
      [...last, '```json', '[{"severity": "info"}]', '```'].join('\n'),
      [...last, '```json', '{"choice": "pass"}', '```'].join('\n'),
    ]) {
      expect(parseFindings(text)).toMatch(/no JSON object holding "findings"/)
    }
  })
})
