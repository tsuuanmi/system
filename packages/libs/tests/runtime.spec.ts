import { describe, expect, it } from 'vitest'
import { nodeVersionProblem, sqliteRuntimeProblem } from '../src/index.ts'

describe('the supported Node runtime (CON-2, REQ-HOST-2)', () => {
  it('accepts Node ^24.18.1 || >=26.5.1 and refuses every other release, naming the range', () => {
    for (const version of ['24.18.1', '24.21.0', '26.5.1', '26.11.1', '27.0.0']) expect([version, nodeVersionProblem(version)]).toEqual([version, undefined])
    for (const version of ['22.23.3', '24.16.0', '24.18.0', '25.9.0', '26.1.0', '26.5.0']) {
      expect(nodeVersionProblem(version)).toBe(`Node ${version} is not supported; system needs Node ^24.18.1 || >=26.5.1 (docs/requirements/constraints.md, CON-2)`)
    }
  })

  it('accepts this runtime, whose node:sqlite reads back text with a NUL intact', () => {
    expect(sqliteRuntimeProblem()).toBeUndefined()
  })

  it('refuses a supported version whose node:sqlite still cuts text at a NUL (checked by behavior too)', () => {
    const problem = sqliteRuntimeProblem((text) => text.slice(0, text.indexOf('\u0000')), '24.21.0')
    expect(problem).toBe('node:sqlite in Node 24.21.0 does not read back text containing a NUL character intact; system needs Node ^24.18.1 || >=26.5.1 (docs/requirements/constraints.md, CON-2)')
  })
})
