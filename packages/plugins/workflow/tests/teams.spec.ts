import { describe, expect, it } from 'vitest'
import type { TeamRole } from '../src/spec.ts'
import { ballotShape, parseBallot } from '../src/teams.ts'

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
