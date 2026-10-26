// decision@1.10 (ADR-0076): a `client` decider that is no vote, a project's lead giving an approval or
// an acceptance on its own token as `lead:<project>`, is refused before 1.10; a client decider that
// decides a vote still carries its vote; and nothing else changes.
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

describe('decision@1.10', () => {
  it('takes a lead\'s approval, a client decider with no vote, and refuses it before 1.10', () => {
    const approval = example('decision.approval-lead')
    expect(valid('decision@1.10', approval)).toBe(true)
    expect(() => registry.assertRecord(approval)).not.toThrow()
    // Before 1.10 a client decider carried its vote; an approval is decision@1.4, never 1.1.
    for (const earlier of ['decision@1.4', 'decision@1.1', 'decision@1.9']) expect(valid(earlier, { ...approval, schema: earlier }), earlier).toBe(false)
    // The same record by the operator is a decision@1.4 approval: it is the client decider that needs 1.10.
    expect(valid('decision@1.4', { ...approval, schema: 'decision@1.4', decider: { type: 'operator', id: 'operator', version: '2' } })).toBe(true)
  })

  it('takes a lead\'s acceptance, which has no version of its own, at 1.10 only', () => {
    const acceptance = { ...example('decision.approval-lead'), decisionType: 'acceptance', outcome: { option: 'accept', detail: { taskId: 't1' } },
      candidates: [{ option: 'accept', selected: true, reasons: ['lead:system accepts'] }, { option: 'reject', selected: false, reasons: ['not reject'] }] }
    expect(valid('decision@1.10', acceptance)).toBe(true)
    expect(valid('decision@1.1', { ...acceptance, schema: 'decision@1.1' })).toBe(false)
  })

  it('keeps an operator\'s approval at decision@1.4, still valid at 1.10, and a vote\'s client decider with its vote', () => {
    const expired = example('decision.approval-expired')
    expect(valid('decision@1.4', expired)).toBe(true)
    // The operator's decider, as the queue records it from the lead principal on (version 2).
    const operator = { ...expired, decider: { type: 'operator', id: 'operator', version: '2' } }
    expect(valid('decision@1.4', operator)).toBe(true)
    expect(valid('decision@1.10', operator)).toBe(true)
    // A tie's deciding vote: its client decider carries the vote, at any version from 1.1.
    const vote = example('decision.team-vote')
    expect(vote.decider.type).toBe('client')
    expect(valid(vote.schema, vote)).toBe(true)
    expect(valid(vote.schema, { ...vote, vote: undefined }), 'a vote decision without its vote').toBe(false)
    expect(valid('decision@1.10', { ...vote, schema: 'decision@1.10' })).toBe(true)
  })

  it('does not let a vote decision go without its vote at 1.10', () => {
    const vote = example('decision.team-vote')
    const { vote: _, ...without } = vote
    expect(valid('decision@1.10', { ...without, schema: 'decision@1.10' })).toBe(false)
  })
})
