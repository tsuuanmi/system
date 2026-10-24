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

describe('agent-account@1.1', () => {
  const tag = 'agent-account@1.1'
  const unverified = example('agent-account.unverified-version')

  it('adds what the reading that quarantined an account found, refused before 1.1 and past 300 characters (T103)', () => {
    expect(valid(tag, unverified)).toBe(true)
    expect(valid(tag, { ...unverified, schema: 'agent-account@1.0' })).toBe(false)
    expect(valid(tag, { ...unverified, quarantine: { ...unverified.quarantine, detail: 'x'.repeat(301) } })).toBe(false)
    expect(valid(tag, { ...unverified, quarantine: { ...unverified.quarantine, detail: '' } })).toBe(false)
    // A 1.1 record without a detail, and a 1.0 record, stay valid.
    expect(valid(tag, { ...unverified, quarantine: without(unverified.quarantine, 'detail') })).toBe(true)
    expect(valid(tag, example('agent-account.quarantined'))).toBe(true)
  })
})

describe('mcp-agent-accounts@1.2', () => {
  const migrate = example('mcp-agent-accounts.migrate')
  const output = migrate.output as Json
  const role = (patch: Json): Json => ({ ...output, plan: { ...output.plan, roles: [{ ...output.plan.roles[1], ...patch }] } })
  const ok = (value: Json): boolean => {
    try {
      registry.assertDef('mcp-agent-accounts@1.2', 'account-migrate-output', value)
      return true
    } catch {
      return false
    }
  }

  it('gives a plan\'s role the kinds and description of its rows, bounded as the configuration bounds them (T103)', () => {
    expect(valid('mcp-agent-accounts@1.2', migrate)).toBe(true)
    expect(ok(role({ kinds: ['docs', 'tests'], description: 'Writes the docs and the tests' }))).toBe(true)
    expect(ok(role({ kinds: [] }))).toBe(false)
    expect(ok(role({ kinds: ['Code'] }))).toBe(false)
    expect(ok(role({ kinds: ['code', 'code'] }))).toBe(false)
    expect(ok(role({ description: 'x'.repeat(201) }))).toBe(false)
    expect(ok(role({ owner: 'someone' }))).toBe(false)
  })

  it('lists an account\'s operator label and a runtime\'s title, each bounded (T103)', () => {
    const list = example('mcp-agent-accounts.list')
    expect(valid('mcp-agent-accounts@1.2', list)).toBe(true)
    const account = list.output.accounts[0]
    expect(valid('mcp-agent-accounts@1.2', { ...list, output: { ...list.output, accounts: [{ ...account, label: 'x'.repeat(65) }] } })).toBe(false)
    expect(valid('mcp-agent-accounts@1.2', { ...list, output: { ...list.output, providers: [{ ...list.output.providers[0], title: '' }] } })).toBe(false)
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

describe('capability-descriptor@1.7', () => {
  const described = example('capability-descriptor.description')
  const kinded = example('capability-descriptor.kinds')

  it('adds the operator\'s description, refused before 1.7, beside kinds, which 1.6 and 1.7 carry', () => {
    expect(valid('capability-descriptor@1.7', described)).toBe(true)
    expect(valid('capability-descriptor@1.7', { ...described, schema: 'capability-descriptor@1.6' })).toBe(false)
    expect(valid('capability-descriptor@1.7', { ...kinded, schema: 'capability-descriptor@1.7', description: 'Writes the code' })).toBe(true)
    expect(valid('capability-descriptor@1.6', kinded)).toBe(true)
    expect(valid('capability-descriptor@1.6', { ...kinded, schema: 'capability-descriptor@1.5' })).toBe(false)
  })
})

describe('capability-descriptor@1.8', () => {
  const titled = example('capability-descriptor.title')

  it('adds a title for people, refused before 1.8, on one line of 1 to 64 characters; a description stays valid at 1.8 (T116)', () => {
    expect(valid('capability-descriptor@1.8', titled)).toBe(true)
    expect(valid('capability-descriptor@1.8', { ...titled, schema: 'capability-descriptor@1.7' })).toBe(false)
    for (const title of ['', 'x'.repeat(65), 'two\nlines']) expect(valid('capability-descriptor@1.8', { ...titled, title }), JSON.stringify(title)).toBe(false)
    expect(valid('capability-descriptor@1.8', without(titled, 'title'))).toBe(true)
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
    const wait = example('decision.recovery-wait')
    const retry = { ...wait, schema: 'decision@1.0', outcome: { option: 'retry' }, candidates: wait.candidates.map((c: Json) => ({ ...c, selected: c.option === 'retry' })) }
    expect(valid('decision@1.0', retry)).toBe(true)
  })
})
