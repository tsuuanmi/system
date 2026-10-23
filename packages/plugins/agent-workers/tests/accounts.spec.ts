// Agent accounts (PROP-0012 phase E, ADR-0051): enrollment slots, identity by keyed hash, quarantine,
// and the `enrollment` decisions, over the fake runtime with scripted homes (no real home is read).
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AgentRuntimeProvider, IdentityReading } from '@tsuuanmi/system-agent-runtime-core'
import AgentRuntimeRegistry from '@tsuuanmi/system-agent-runtimes'
import Artifacts from '@tsuuanmi/system-artifacts'
import Vault from '@tsuuanmi/system-credentials-vault'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import Leases from '@tsuuanmi/system-leases'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkRequirement } from '@tsuuanmi/system-workers'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeAgentRuntime } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { type AgentAccount, assess } from '../src/accounts.ts'
import AgentWorkers, { type Config } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})
const schemas = new SchemaRegistry()

/** A `ctx.mcp` that keeps contributed tools, so a test calls a handler as the operator would. */
class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

const KIND = 'fake-runtime'

interface Booted {
  ctx: Context
  dir: string
  /** The fake runtime's own home: slot 1 adopts it. */
  home: string
  mcp: RecordingMcp
  stop: () => Promise<void>
}

/** A daemon with a vault, the `agents` source, and a fake runtime whose own home is `home`; `dir` reused stands for a restart. */
async function boot(options: { config?: Partial<Config>; dir?: string; runtime?: (home: string) => AgentRuntimeProvider; vault?: boolean } = {}): Promise<Booted> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'system-agent-accounts-'))
  const home = join(dir, 'own-home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(join(dir, 'ws'), { recursive: true })
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ...(options.vault === false ? [] : [ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') })]),
    ctx.plugin(RecordingMcp), ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry),
    ctx.plugin(AgentWorkers, {
      workers: [{ id: 'reviewer', runtime: KIND, workspace: join(dir, 'ws'), sandbox: 'read-only', tier: 'standard' }],
      providers: [{ provider: KIND, slots: 2 }], accountHomes: join(dir, 'agent-homes'), probeTtlMs: 0, ...options.config,
    } as Config),
  ]
  await Promise.all(fibers)
  // The tools are contributed once ctx.mcp is seen.
  await new Promise((resolve) => setTimeout(resolve, 0))
  ctx.agentRuntimes.register(options.runtime ? options.runtime(home) : new FakeAgentRuntime(KIND, '1.0.0', home))
  const stop = async (): Promise<void> => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  cleanups.push(stop)
  if (!options.dir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { ctx, dir, home, mcp: (ctx as unknown as { mcp: RecordingMcp }).mcp, stop }
}

const accounts = (b: Booted) => b.ctx.agentWorkers.agentAccounts
/** Every `enrollment` decision recorded, oldest first. */
const decisions = (b: Booted) => (b.ctx.store.db.prepare("SELECT id FROM artifacts WHERE kind = 'decision' ORDER BY created_at, rowid").all() as Array<{ id: string }>)
  .map((row) => b.ctx.artifacts.get(row.id as `sha256:${string}`)!.body as { decisionType: string; inputs: string[]; outcome: { option: string; detail: Record<string, unknown> }; candidates: Array<{ option: string; selected: boolean }> })
  .filter((d) => d.decisionType === 'enrollment')
const requirement = (): WorkRequirement => ({
  schema: 'work-requirement@1.0', objective: 'review', capabilities: ['review', 'local-data'], data: { classification: 'operator-shared', refs: [] },
  egressPolicy: 'egress.classification-and-secrets', tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.answer' },
})
const call = async (b: Booted, tool: string, args: Record<string, unknown>) => {
  const result = await b.mcp.tools.get(tool)!.handler(args, { scope: 'operator' })
  return result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }
}

describe('agent accounts: slots are homes (ADR-0051, REQ-ACC-11)', () => {
  it('takes the lowest free slot, adopting the runtime\'s own home as slot 1 where it is, the others owner-only under accountHomes; no free slot is refused', async () => {
    const b = await boot()
    const first = await accounts(b).begin({ provider: KIND })
    expect(first).toMatchObject({ adopted: true, account: { provider: KIND, slot: 1, home: b.home, status: 'enrolled' }, login: { command: 'fake-login', env: { FAKE_HOME: b.home } } })
    const second = await accounts(b).begin({ provider: KIND })
    const slot2 = join(b.dir, 'agent-homes', KIND, '2')
    expect(second).toMatchObject({ adopted: false, account: { slot: 2, home: slot2, status: 'enrolled' } })
    expect(statSync(slot2).mode & 0o777).toBe(0o700)
    expect(statSync(join(b.dir, 'agent-homes')).mode & 0o777).toBe(0o700)
    await expect(accounts(b).begin({ provider: KIND })).rejects.toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/every slot of fake-runtime is taken \(2\).*slots.*system account remove/) })
    await expect(accounts(b).begin({ provider: KIND, slot: 3 })).rejects.toMatchObject({ kind: 'invalid_input' })
    for (const account of accounts(b).list()) schemas.assertRecord(account)
    // Each slot taken is recorded first, as enrolled, with no principal (INV-13).
    expect(decisions(b).map((d) => [d.outcome.option, d.outcome.detail.slot])).toEqual([['enrolled', 1], ['enrolled', 2]])
  })

  it('refuses a runtime that is not registered, gives no sign-in command, or cannot name a namespace', async () => {
    const b = await boot()
    await expect(accounts(b).begin({ provider: 'absent-runtime' })).rejects.toMatchObject({ kind: 'config_error' })
    b.ctx.agentRuntimes.register({ kind: 'no-login', probe: async () => new FakeAgentRuntime().probe(), run: async () => ({ text: '' }) })
    await expect(accounts(b).begin({ provider: 'no-login' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/no sign-in command/) })
    await expect(accounts(b).begin({ provider: 'acp:agent' })).rejects.toMatchObject({ kind: 'invalid_input' })
    expect(accounts(b).list()).toEqual([])
  })
})

describe('agent accounts: the id comes from the verified login (ADR-0051)', () => {
  it('derives the id from the keyed hash, the same after a restart and a re-login; another install key gives another; no principal is in any record or decision (INV-8)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-accounts-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const b = await boot({ dir })
    await accounts(b).begin({ provider: KIND })
    FakeAgentRuntime.signIn(b.home, 'alice.secret@example.test')
    const ready = await accounts(b).verify({ provider: KIND, slot: 1 })
    expect(ready).toMatchObject({ status: 'ready', accountId: expect.stringMatching(/^fake-runtime:[0-9a-f]{16}$/), hint: 'a…@example.test', identity: { reader: 'fake-login-file', runtimeVersion: '1.0.0' } })
    expect(ready.accountId).toBe(`${KIND}:${ready.identity!.hmac.slice(0, 16)}`)
    // A re-login of the same principal in its own home: the same account.
    const again = await accounts(b).begin({ accountId: ready.accountId! })
    expect(again.account.slot).toBe(1)
    FakeAgentRuntime.signIn(b.home, 'alice.secret@example.test')
    expect((await accounts(b).verify({ accountId: ready.accountId! })).accountId).toBe(ready.accountId)
    await b.stop()
    // A restart: the key is the vault's, so the same login reads as the same id.
    const restarted = await boot({ dir })
    expect((await accounts(restarted).verify({ provider: KIND, slot: 1 })).accountId).toBe(ready.accountId)
    const all = JSON.stringify([accounts(restarted).list(), decisions(restarted)])
    expect(all).not.toMatch(/alice/)
    expect(decisions(restarted).map((d) => d.outcome.option)).toEqual(['enrolled', 'ready'])
    // The ready decision's input is the slot's earlier decision.
    expect(decisions(restarted)[1]!.inputs).toHaveLength(1)
    await restarted.stop()
    // Another install (another vault, so another key): the same login is another id.
    rmSync(join(dir, 'vault.enc'))
    rmSync(join(dir, 'vault.key'))
    rmSync(join(dir, 'system.db'))
    const other = await boot({ dir })
    await accounts(other).begin({ provider: KIND })
    expect((await accounts(other).verify({ provider: KIND, slot: 1 })).accountId).not.toBe(ready.accountId)
  })

  it('reads nothing without the vault: no key, no id, the slot stays enrolled (INV-2)', async () => {
    const b = await boot({ vault: false })
    await accounts(b).begin({ provider: KIND })
    FakeAgentRuntime.signIn(b.home, 'alice@example.test')
    await expect(accounts(b).verify({ provider: KIND, slot: 1 })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/credential vault/) })
    expect(accounts(b).list()[0]).toMatchObject({ status: 'enrolled' })
  })
})

describe('agent accounts: quarantine (ADR-0051, REQ-ACC-7, REQ-ACC-11)', () => {
  const enrolled = async (b: Booted, login: string, slot = 1): Promise<AgentAccount> => {
    const begun = await accounts(b).begin({ provider: KIND, slot })
    FakeAgentRuntime.signIn(begun.account.home, login)
    return accounts(b).verify({ provider: KIND, slot })
  }

  it('quarantines a slot re-signed as another principal (changed), keeping the account it should hold; accept takes the new one as a new account', async () => {
    const b = await boot()
    const alice = await enrolled(b, 'alice@example.test')
    FakeAgentRuntime.signIn(b.home, 'bob@example.test')
    const changed = await accounts(b).verify({ provider: KIND, slot: 1 })
    expect(changed).toMatchObject({ status: 'quarantined', quarantine: { reason: 'changed' }, accountId: alice.accountId, identity: { hmac: alice.identity!.hmac } })
    schemas.assertRecord(changed)
    // Never lifted by itself: the same reading again changes nothing, and nothing new is decided.
    const before = decisions(b).length
    expect(await accounts(b).verify({ provider: KIND, slot: 1 })).toMatchObject({ status: 'quarantined', quarantine: { reason: 'changed' } })
    expect(decisions(b)).toHaveLength(before)
    const bob = await accounts(b).verify({ provider: KIND, slot: 1 }, { accept: true })
    expect(bob).toMatchObject({ status: 'ready' })
    expect(bob.accountId).not.toBe(alice.accountId)
    expect(decisions(b).at(-1)!.outcome).toMatchObject({ option: 'ready', detail: { accountId: bob.accountId, previousAccountId: alice.accountId } })
    // Accept is for a changed slot only.
    await expect(accounts(b).verify({ provider: KIND, slot: 1 }, { accept: true })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('quarantines both slots of one principal (duplicate), each with its own decision', async () => {
    const b = await boot()
    await enrolled(b, 'alice@example.test')
    const second = await enrolled(b, 'alice@example.test', 2)
    expect(second).toMatchObject({ status: 'quarantined', quarantine: { reason: 'duplicate' } })
    expect(accounts(b).list().map((a) => [a.slot, a.status, a.quarantine?.reason])).toEqual([[1, 'quarantined', 'duplicate'], [2, 'quarantined', 'duplicate']])
    expect(decisions(b).filter((d) => d.outcome.option === 'quarantined').map((d) => [d.outcome.detail.slot, d.outcome.detail.reason])).toEqual([[2, 'duplicate'], [1, 'duplicate']])
    // An id held twice names no one slot.
    await expect(accounts(b).verify({ accountId: second.accountId! })).rejects.toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/duplicate/) })
    // Resolved by the operator: slot 2 signs in as another, then each slot is verified again.
    FakeAgentRuntime.signIn(join(b.dir, 'agent-homes', KIND, '2'), 'bob@example.test')
    expect(await accounts(b).verify({ provider: KIND, slot: 2 })).toMatchObject({ status: 'quarantined', quarantine: { reason: 'changed' } })
    await accounts(b).remove({ provider: KIND, slot: 2 })
    expect(await accounts(b).verify({ provider: KIND, slot: 1 })).toMatchObject({ status: 'ready' })
  })

  it('quarantines a principal read in part, and two principals under one short id, as ambiguous', async () => {
    const readings = new Map<string, IdentityReading>()
    const scripted = (home: string): AgentRuntimeProvider => Object.assign(new FakeAgentRuntime(KIND, '1.0.0', home), { identity: async (at: string) => readings.get(at)! })
    const b = await boot({ runtime: scripted })
    const slot2 = join(b.dir, 'agent-homes', KIND, '2')
    await accounts(b).begin({ provider: KIND })
    readings.set(b.home, { status: 'ambiguous', reason: 'the sign-in names no user', reader: 'r', runtimeVersion: '1' })
    expect(await accounts(b).verify({ provider: KIND, slot: 1 })).toMatchObject({ status: 'quarantined', quarantine: { reason: 'ambiguous' } })
    // Two different full hashes with one short form: neither id names one principal.
    readings.set(b.home, { status: 'verified', hmac: `abcdef0123456789${'1'.repeat(48)}`, reader: 'r', runtimeVersion: '1' })
    readings.set(slot2, { status: 'verified', hmac: `abcdef0123456789${'2'.repeat(48)}`, reader: 'r', runtimeVersion: '1' })
    expect(await accounts(b).verify({ provider: KIND, slot: 1 })).toMatchObject({ status: 'ready', accountId: `${KIND}:abcdef0123456789` })
    await accounts(b).begin({ provider: KIND })
    expect(await accounts(b).verify({ provider: KIND, slot: 2 })).toMatchObject({ status: 'quarantined', quarantine: { reason: 'ambiguous' } })
    expect(accounts(b).list().map((a) => a.quarantine?.reason)).toEqual(['ambiguous', 'ambiguous'])
  })

  it('quarantines an account no verified reader can read (unverified): an unpinned version, or a runtime with no reader', async () => {
    const b = await boot({ runtime: (home) => new FakeAgentRuntime(KIND, '9.9.9', home) })
    await accounts(b).begin({ provider: KIND })
    FakeAgentRuntime.signIn(b.home, 'alice@example.test')
    const unverified = await accounts(b).verify({ provider: KIND, slot: 1 })
    expect(unverified).toMatchObject({ status: 'quarantined', quarantine: { reason: 'unverified' } })
    expect(unverified).not.toHaveProperty('accountId')
    const none = await boot({ runtime: (home) => Object.assign(new FakeAgentRuntime(KIND, '1.0.0', home), { identity: undefined }) })
    await accounts(none).begin({ provider: KIND })
    expect(await accounts(none).verify({ provider: KIND, slot: 1 })).toMatchObject({ status: 'quarantined', quarantine: { reason: 'unverified' } })
  })

  it('reads a slot no one is signed in to as signed-out, and frees a slot on removal, keeping its home', async () => {
    const b = await boot()
    await accounts(b).begin({ provider: KIND })
    expect(await accounts(b).verify({ provider: KIND, slot: 1 })).toMatchObject({ status: 'signed-out' })
    const removed = await accounts(b).remove({ provider: KIND, slot: 1 })
    expect(removed.slot).toBe(1)
    expect(accounts(b).list()).toEqual([])
    expect(existsSync(b.home)).toBe(true)
    expect(decisions(b).map((d) => d.outcome.option)).toEqual(['enrolled', 'signed-out', 'removed'])
    // The slot is free again.
    expect((await accounts(b).begin({ provider: KIND })).account.slot).toBe(1)
  })

  it('judges by a pure rule: a missing, unverified, or ambiguous reading keeps the pinned principal on the record', () => {
    const current: AgentAccount = {
      schema: 'agent-account@1.0', provider: 'p', slot: 1, home: '/h', status: 'ready', accountId: `p:${'a'.repeat(16)}`,
      identity: { hmac: 'a'.repeat(64), reader: 'r', runtimeVersion: '1', verifiedAt: '2026-10-24T00:00:00Z' }, revision: 1, updatedAt: '2026-10-24T00:00:00Z',
    }
    for (const reading of [{ status: 'missing', reason: 'x' }, { status: 'unverified', reason: 'x' }, { status: 'ambiguous', reason: 'x' }] as const) {
      expect(assess(current, reading, [], 'now', false).next).toMatchObject({ accountId: current.accountId, identity: current.identity })
    }
  })
})

describe('agent accounts: the Workers in an enrolled home (ADR-0051, INV-2)', () => {
  it('admits the Workers of the runtime\'s own home only while its account is ready, or unverified for want of a reader; not while it is enrolled, signed out, or quarantined', async () => {
    const b = await boot()
    const state = async () => (await b.ctx.workers.list()).find((w) => w.worker === 'agent:reviewer')!.state
    // Not enrolled: as before enrollment.
    expect(await state()).toBe('ready')
    await accounts(b).begin({ provider: KIND })
    expect(await state()).toBe('unavailable')
    FakeAgentRuntime.signIn(b.home, 'alice@example.test')
    await accounts(b).verify({ provider: KIND, slot: 1 })
    expect(await state()).toBe('ready')
    // Re-signed as another person: the probe's re-read quarantines it, recorded first.
    FakeAgentRuntime.signIn(b.home, 'bob@example.test')
    expect(await state()).toBe('unavailable')
    expect(accounts(b).list()[0]).toMatchObject({ status: 'quarantined', quarantine: { reason: 'changed' } })
    expect(decisions(b).at(-1)!.outcome).toMatchObject({ option: 'quarantined', detail: { reason: 'changed' } })
    // The probe's re-read never lifts it, even once the pinned principal is back.
    FakeAgentRuntime.signIn(b.home, 'alice@example.test')
    expect(await state()).toBe('unavailable')
    expect((await accounts(b).verify({ provider: KIND, slot: 1 })).status).toBe('ready')
    expect(await state()).toBe('ready')
    const unverified = await boot({ runtime: (home) => new FakeAgentRuntime(KIND, '9.9.9', home) })
    await accounts(unverified).begin({ provider: KIND })
    await accounts(unverified).verify({ provider: KIND, slot: 1 })
    expect((await unverified.ctx.workers.list())[0]!.state).toBe('ready')
  })

  it('fails a run whose home changed principal between its admission and its start, unsubmitted, and quarantines the account', async () => {
    const b = await boot({ config: { probeTtlMs: 60_000 } })
    await accounts(b).begin({ provider: KIND })
    FakeAgentRuntime.signIn(b.home, 'alice@example.test')
    await accounts(b).verify({ provider: KIND, slot: 1 })
    const admitted = await b.ctx.workers.route(requirement())
    expect(admitted.worker.worker).toBe('agent:reviewer')
    FakeAgentRuntime.signIn(b.home, 'bob@example.test')
    const source = b.ctx.workers.source('agents')!
    const done = await source.wait(source.start({ key: 'k', worker: 'agent:reviewer', prompt: 'review', requirement: requirement(), decisions: admitted.decisions }).id, 10_000)
    expect(done).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringMatching(/quarantined \(changed\)/) } })
    expect(accounts(b).list()[0]).toMatchObject({ status: 'quarantined', quarantine: { reason: 'changed' } })
  })
})

describe('agent accounts: the operator\'s MCP tools (mcp-agent-accounts@1.0)', () => {
  it('enrolls, lists, and removes through account_enroll, account_agents, and account_remove, operator scope, each output as its schema says', async () => {
    const b = await boot()
    for (const tool of ['account_enroll', 'account_remove', 'account_agents', 'account_migrate']) expect(b.mcp.tools.get(tool)!.spec.scope).toBe('operator')
    const begun = await call(b, 'account_enroll', { step: 'begin', provider: KIND })
    expect(begun.isError).toBeUndefined()
    expect(begun.structuredContent).toMatchObject({ adopted: true, account: { slot: 1, status: 'enrolled' }, workers: ['agent:reviewer'], login: { command: 'fake-login' } })
    FakeAgentRuntime.signIn(b.home, 'alice@example.test')
    const verified = await call(b, 'account_enroll', { step: 'verify', provider: KIND, slot: 1 })
    expect(verified.structuredContent).toMatchObject({ account: { status: 'ready' } })
    const listed = await call(b, 'account_agents', {})
    schemas.assertDef('mcp-agent-accounts@1.0', 'account-agents-output', listed.structuredContent)
    expect(listed.structuredContent).toMatchObject({ providers: [{ provider: KIND, slots: 2, taken: 1, identity: true, login: true }] })
    const accountId = (verified.structuredContent!.account as AgentAccount).accountId!
    expect((await call(b, 'account_remove', { accountId })).structuredContent).toMatchObject({ removed: { accountId } })
    expect(JSON.stringify(listed)).not.toMatch(/alice/)
  })

  it('refuses an input its schema refuses, and a call that fails, doing nothing', async () => {
    const b = await boot()
    for (const args of [{ step: 'verify', provider: KIND }, { step: 'begin', provider: KIND, accountId: `${KIND}:${'0'.repeat(16)}` }, { step: 'begin', provider: KIND, accept: true }, { step: 'other' }]) {
      const result = await call(b, 'account_enroll', args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(result.content[0]!.text).toMatch(/invalid input/)
    }
    expect((await call(b, 'account_remove', { provider: KIND })).isError).toBe(true)
    const missing = await call(b, 'account_remove', { provider: KIND, slot: 1 })
    expect(missing).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^invalid_input: slot 1 of fake-runtime holds no account/) }] })
    expect(accounts(b).list()).toEqual([])
  })
})
