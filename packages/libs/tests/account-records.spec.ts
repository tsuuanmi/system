// The agent account records (PROP-0012, ADR-0051, ADR-0052) refuse what their protocols forbid.
// Each case starts from a valid example in schemas/examples and breaks one rule.
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
const without = (value: Json, key: string): Json => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key))

describe('agent-account@1.0', () => {
  const tag = 'agent-account@1.0'
  const ready = example('agent-account.ready')
  const quarantined = example('agent-account.quarantined')

  it('admits a ready account only with its id and its verified identity, and never with a quarantine', () => {
    expect(valid(tag, ready)).toBe(true)
    expect(valid(tag, without(ready, 'accountId'))).toBe(false)
    expect(valid(tag, without(ready, 'identity'))).toBe(false)
    expect(valid(tag, { ...ready, quarantine: quarantined.quarantine })).toBe(false)
  })

  it('derives the id from the provider and a short hash, never a hand-made name (REQ-ACC-1)', () => {
    expect(valid(tag, { ...ready, accountId: 'claude-main' })).toBe(false)
    expect(valid(tag, { ...ready, accountId: 'claude-agent-sdk:1' })).toBe(false)
    expect(valid(tag, { ...ready, identity: { ...ready.identity, hmac: 'jane@example.com' } })).toBe(false)
  })

  it('says why an account is quarantined, and carries no quarantine in any other status', () => {
    expect(valid(tag, quarantined)).toBe(true)
    expect(valid(tag, without(quarantined, 'quarantine'))).toBe(false)
    expect(valid(tag, { ...quarantined, quarantine: { ...quarantined.quarantine, reason: 'expired' } })).toBe(false)
    expect(valid(tag, { ...quarantined, status: 'enrolled' })).toBe(false)
    expect(valid(tag, without({ ...quarantined, status: 'enrolled' }, 'quarantine'))).toBe(true)
  })

  it('names the account a changed or duplicate principal was, since it was read whole', () => {
    const duplicate = { ...quarantined, quarantine: { ...quarantined.quarantine, reason: 'duplicate' } }
    expect(valid(tag, duplicate)).toBe(false)
    expect(valid(tag, { ...duplicate, accountId: 'antigravity-cli:0123456789abcdef' })).toBe(true)
  })

  it('keeps a slot a bounded number and a home an absolute path (INV-9)', () => {
    expect(valid(tag, { ...ready, slot: 0 })).toBe(false)
    expect(valid(tag, { ...ready, slot: 65 })).toBe(false)
    expect(valid(tag, { ...ready, home: 'agent-homes/claude-agent-sdk/1' })).toBe(false)
  })
})

describe('capability-descriptor@1.5', () => {
  const descriptor = example('capability-descriptor.account')

  it('adds the account a Worker runs on, refused before 1.5, its mode assigned or pooled', () => {
    expect(valid('capability-descriptor@1.5', descriptor)).toBe(true)
    expect(valid('capability-descriptor@1.5', { ...descriptor, schema: 'capability-descriptor@1.4' })).toBe(false)
    expect(valid('capability-descriptor@1.5', { ...descriptor, account: { ...descriptor.account, mode: 'rotating' } })).toBe(false)
    expect(valid('capability-descriptor@1.5', { ...descriptor, account: without(descriptor.account, 'group') })).toBe(false)
    expect(valid('capability-descriptor@1.5', { ...descriptor, account: without(descriptor.account, 'limitUntil') })).toBe(true)
  })
})

describe('decision@1.8', () => {
  it('adds the enrollment decision and the recovery outcome wait, each refused before 1.8 (INV-13, INV-14)', () => {
    for (const name of ['decision.enrollment', 'decision.recovery-wait']) {
      const decision = example(name)
      expect(valid('decision@1.8', decision), name).toBe(true)
      expect(valid('decision@1.8', { ...decision, schema: 'decision@1.7' }), name).toBe(false)
    }
    // Any other recovery outcome keeps its version, so earlier decisions keep their ids.
    const retry = { ...example('decision.recovery-wait'), schema: 'decision@1.0', outcome: { option: 'retry' } }
    retry.candidates = retry.candidates.map((c: Json) => ({ ...c, selected: c.option === 'retry' }))
    expect(valid('decision@1.0', retry)).toBe(true)
  })
})
