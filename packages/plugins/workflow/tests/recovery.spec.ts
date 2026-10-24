import { describe, expect, it } from 'vitest'
import { errorLine } from '../src/recovery.ts'

describe('a failure\'s message as one line for a decision (errorLine)', () => {
  it('never carries text a browser\'s call log echoes from a typing call into a decision', () => {
    expect(errorLine('locator.fill: Timeout\n\u001b[2m  - waiting for fill("my private prompt")\u001b[22m')).toBe('locator.fill: Timeout - waiting for fill(…)')
    // An escaped quote inside the typed text does not end it early.
    expect(errorLine('locator.type: x, type("say \\"hi\\" and my secret") failed')).toBe('locator.type: x, type(…) failed')
    expect(errorLine("press: pressSequentially('it\\'s my secret')")).toBe('press: pressSequentially(…)')
  })
})
