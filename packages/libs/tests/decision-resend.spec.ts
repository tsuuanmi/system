// decision@1.9 (ADR-0062): the recovery outcome `resend` is refused before 1.9, and every other
// recovery keeps its version, so earlier decisions keep their ids.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SchemaRegistry } from '../src/index.ts'

const registry = new SchemaRegistry()
type Json = Record<string, any>
const example = (name: string): Json => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../schemas/examples/${name}.json`, import.meta.url)), 'utf8')) as Json
const valid = (tag: string, value: unknown): boolean => {
  try {
    registry.assert(tag, value)
    return true
  } catch {
    return false
  }
}

describe('decision@1.9', () => {
  it('adds the recovery outcome resend, refused before 1.9 (INV-13, INV-14)', () => {
    const resend = example('decision.recovery-resend')
    expect(valid('decision@1.9', resend)).toBe(true)
    for (const earlier of ['decision@1.8', 'decision@1.0']) expect(valid(earlier, { ...resend, schema: earlier }), earlier).toBe(false)
  })

  it('changes no other recovery: one that waits stays at 1.8, and one that fails saying why it was not resent at 1.0', () => {
    const wait = example('decision.recovery-wait')
    expect(valid('decision@1.8', wait)).toBe(true)
    const resend = example('decision.recovery-resend')
    const fail = { ...resend, schema: 'decision@1.0', outcome: { option: 'fail' }, candidates: resend.candidates.map((c: Json) => ({ ...c, selected: c.option === 'fail' })) }
    // A failure that says why it was not resent keeps its version.
    expect(valid('decision@1.0', fail)).toBe(true)
  })
})
