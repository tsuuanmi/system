// Workers = account × role (PROP-0012 phase F, ADR-0051): Workers derived from role templates and
// assignments, per-account concurrency, load and pending admissions, pools per account, and the
// move from hand-named rows (`system account migrate`), over fake runtimes with scripted homes.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { RunResult, RunSpec } from '@tsuuanmi/system-agent-runtime-core'
import AgentRuntimeRegistry from '@tsuuanmi/system-agent-runtimes'
import Artifacts from '@tsuuanmi/system-artifacts'
import Vault from '@tsuuanmi/system-credentials-vault'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import Leases from '@tsuuanmi/system-leases'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import * as SoftwareDevelopment from '@tsuuanmi/system-profile-software-development'
import type { PoolTemplate } from '@tsuuanmi/system-resources-core'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkRequirement } from '@tsuuanmi/system-workers'
import type { CapabilityDescriptor, WorkerExecution } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { FakeAgentRuntime } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { FakeResources } from '../../../resources-core/conformance/resources.ts'
import { Cutover, planMigration } from '../src/migrate.ts'
import { deriveWorkers } from '../src/roles.ts'
import AgentWorkers, { type AgentWorkerConfig, checkConfig, type Config } from '../src/index.ts'

const schemas = new SchemaRegistry()

class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

/** A fake runtime that records each run's spec and, while `held`, keeps it running until released. */
class GatedRuntime extends FakeAgentRuntime {
  readonly specs: RunSpec[] = []
  running = 0
  most = 0
  held = false
  private readonly waiting: Array<() => void> = []
  override async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void): Promise<RunResult> {
    this.specs.push(spec)
    this.running++
    this.most = Math.max(this.most, this.running)
    try {
      if (this.held) await new Promise<void>((resolve) => this.waiting.push(resolve))
      return await super.run(spec, signal, onHandle)
    } finally {
      this.running--
    }
  }

  release(): void {
    this.held = false
    for (const go of this.waiting.splice(0)) go()
  }
}

const A = 'fake-a'
const B = 'fake-b'
const C = 'fake-c'
const TEMPLATE: PoolTemplate = { template: 'plan', group: A, kind: 'interactive', windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18000 }] }

interface Booted {
  ctx: Context
  dir: string
  homes: Record<string, string>
  runtimes: Record<string, GatedRuntime>
  mcp: RecordingMcp
  stop: () => Promise<void>
}

/**
 * A daemon with a vault, the `agents` source, and three fake runtimes, each with its own home (`C`'s
 * reader is not verified on its version); `dir` reused stands for a restart. Returns undefined
 * `ctx.agentWorkers` when the row refuses its configuration.
 */
async function boot(config: Partial<Config>, options: { dir?: string; ledger?: boolean } = {}): Promise<Booted> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'system-agent-roles-'))
  if (!options.dir) onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const homes = Object.fromEntries([A, B, C].map((kind) => [kind, join(dir, `home-${kind}`)]))
  for (const home of Object.values(homes)) mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(join(dir, 'ws'), { recursive: true })
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
    ...(options.ledger ? [ctx.plugin(FakeResources, { pools: [], templates: [TEMPLATE] })] : []),
    ctx.plugin(RecordingMcp), ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry),
  ]
  await Promise.all(fibers)
  const agents = ctx.plugin(AgentWorkers, { workers: [], accountHomes: join(dir, 'agent-homes'), probeTtlMs: 0, ...config } as Config)
  try {
    await agents
  } catch {
    // refused at load: the test asserts there is no ctx.agentWorkers
  }
  fibers.push(agents)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const runtimes = { [A]: new GatedRuntime(A, '1.0.0', homes[A]), [B]: new GatedRuntime(B, '1.0.0', homes[B]), [C]: new GatedRuntime(C, '9.9.9', homes[C]) }
  for (const runtime of Object.values(runtimes)) ctx.agentRuntimes.register(runtime)
  const stop = async (): Promise<void> => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  onTestFinished(stop)
  return { ctx, dir, homes, runtimes, mcp: (ctx as unknown as { mcp: RecordingMcp }).mcp, stop }
}

const accounts = (b: Booted) => b.ctx.agentWorkers.agentAccounts
/** Enroll a slot of a runtime, signed in as `login`; the account id. */
async function enroll(b: Booted, runtime: string, login: string, slot?: number): Promise<string> {
  const begun = await accounts(b).begin({ provider: runtime, ...(slot ? { slot } : {}) })
  FakeAgentRuntime.signIn(begun.account.home, login)
  const verified = await accounts(b).verify({ provider: runtime, slot: begun.account.slot })
  return verified.accountId ?? ''
}
const requirement = (): WorkRequirement => ({
  schema: 'work-requirement@1.0', objective: 'review', capabilities: ['review', 'local-data'], data: { classification: 'operator-shared', refs: [] },
  egressPolicy: 'egress.classification-and-secrets', tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.answer' },
})
const start = (b: Booted, worker: string, key: string, sessionId?: string): WorkerExecution =>
  b.ctx.workers.source('agents')!.start({ key, worker, prompt: key, ...(sessionId ? { sessionId } : {}), requirement: requirement(), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never })
const wait = (b: Booted, run: WorkerExecution | string): Promise<WorkerExecution> => b.ctx.workers.source('agents')!.wait(typeof run === 'string' ? run : run.id, 10_000)
const described = async (b: Booted): Promise<Map<string, CapabilityDescriptor>> => new Map((await b.ctx.workers.list()).map((d) => [d.worker, d]))
const call = async (b: Booted, tool: string, args: Record<string, unknown>) => {
  const result = await b.mcp.tools.get(tool)!.handler(args, { scope: 'operator' }) as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }
  if (!result.isError) schemas.assertDef('mcp-agent-accounts@1.2', `${tool.replaceAll('_', '-')}-output`, result.structuredContent)
  return result
}
const enrollments = (b: Booted) => (b.ctx.store.db.prepare("SELECT id FROM artifacts WHERE kind = 'decision' ORDER BY created_at, rowid").all() as Array<{ id: string }>)
  .map((row) => b.ctx.artifacts.get(row.id as `sha256:${string}`)!.body as { decisionType: string; question: string; inputs: string[]; decider: { id: string }; outcome: { option: string; detail: Record<string, unknown> } })
  .filter((d) => d.decisionType === 'enrollment')
const until = (check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => vi.waitFor(async () => {
  if (!(await check())) throw new Error('timed out')
}, { timeout: ms, interval: 10 })

const ROLE = (id: string, extra: Record<string, unknown> = {}) => ({ id, workspace: '/srv/ws', sandbox: 'read-only' as const, tier: 'standard' as const, ...extra })
const ACC1 = `${A}:0123456789abcdef`
const ACC2 = `${A}:fedcba9876543210`
const ACC3 = `${B}:00000000000000aa`

describe('Workers = account × role: derivation (ADR-0051)', () => {
  it('derives agent:<accountId>/<role> per assignment and role, the same whatever the order of roles and assignments, never a hand-made name', () => {
    const roles = [ROLE('review', { runtimes: { [A]: { maxTurns: 4 }, [B]: { model: 'm' } } }), ROLE('research')]
    const assignments = [{ account: ACC3, roles: ['review'] }, { account: ACC1, roles: ['review', 'research'] }]
    const providers = [{ provider: A, pool: 'plan', windows: { five_hour: 'five-hour' }, limitCooldownSeconds: 600 }]
    const first = deriveWorkers(roles, assignments, providers)
    expect(first.map((w) => w.id)).toEqual([`${ACC1}/research`, `${ACC1}/review`, `${ACC3}/review`])
    expect(deriveWorkers([...roles].reverse(), [...assignments].reverse(), providers)).toEqual(first)
    expect(first.find((w) => w.id === `${ACC1}/review`)).toMatchObject({
      runtime: A, maxTurns: 4, pool: `plan/${ACC1}`, account: ACC1, windows: { five_hour: 'five-hour' }, limitCooldownSeconds: 600, derived: { accountId: ACC1, role: 'review' },
    })
    // What draws on what is the provider's: every role of the account draws on its one pool; another runtime's Workers are not metered.
    expect(first.find((w) => w.id === `${ACC1}/research`)).toMatchObject({ pool: `plan/${ACC1}` })
    expect(first.find((w) => w.id === `${ACC3}/review`)).toMatchObject({ runtime: B, model: 'm' })
    expect(first.find((w) => w.id === `${ACC3}/review`)).not.toHaveProperty('pool')
  })

  it('gives every Worker of a role the role\'s description, and refuses one that is not plain text on one line of at most 200 characters (T85)', () => {
    const roles = [ROLE('review', { description: 'Reviews the studio\'s diffs before they merge' }), ROLE('research')]
    const derived = deriveWorkers(roles, [{ account: ACC1, roles: ['review', 'research'] }, { account: ACC3, roles: ['review'] }], [])
    expect(derived.filter((w) => w.derived.role === 'review').map((w) => w.description)).toEqual(['Reviews the studio\'s diffs before they merge', 'Reviews the studio\'s diffs before they merge'])
    expect(derived.find((w) => w.derived.role === 'research')).not.toHaveProperty('description')
    for (const bad of ['', 'two\nlines', 'x'.repeat(201), 42]) {
      expect(() => deriveWorkers([ROLE('review', { description: bad })], [], []), String(bad)).toThrow(/roles\[0\] \(review\)\.description must be plain text on one line, 1 to 200 characters/)
    }
  })

  it('takes an account\'s display label for people only: the Worker ids stay agent:<accountId>/<role>, and a label that is not plain text on one line of at most 64 characters is refused (T103)', () => {
    const labelled = deriveWorkers([ROLE('review')], [{ account: ACC1, roles: ['review'], label: 'science' }], [])
    expect(labelled).toEqual(deriveWorkers([ROLE('review')], [{ account: ACC1, roles: ['review'] }], []))
    expect(labelled.map((w) => w.id)).toEqual([`${ACC1}/review`])
    for (const bad of ['', 'two\nlines', 'x'.repeat(65), 42]) {
      expect(() => deriveWorkers([ROLE('review')], [{ account: ACC1, roles: ['review'], label: bad as string }], []), String(bad)).toThrow(/assignments\[0\] \(fake-a:0123456789abcdef\)\.label must be plain text on one line, 1 to 64 characters/)
    }
    expect(checkConfig({ roles: [ROLE('review')], assignments: [{ account: ACC1, roles: ['review'], label: 'lead' }] })).toEqual([])
  })

  it('refuses a malformed, repeated, or unknown role or account, and a review member with no family on its runtime', () => {
    const ok = [ROLE('review')]
    expect(() => deriveWorkers(ok, [{ account: 'claude-1', roles: ['review'] }], [])).toThrow(/not an agent account id/)
    expect(() => deriveWorkers(ok, [{ account: ACC1, roles: ['review'] }, { account: ACC1, roles: ['review'] }], [])).toThrow(/assigned twice/)
    expect(() => deriveWorkers(ok, [{ account: ACC1, roles: ['develop'] }], [])).toThrow(/no role "develop"/)
    expect(() => deriveWorkers(ok, [{ account: ACC1, roles: [] }], [])).toThrow(/at least one role/)
    expect(() => deriveWorkers([ROLE('review'), ROLE('review')], [], [])).toThrow(/defined twice/)
    expect(() => deriveWorkers([ROLE('Review')], [], [])).toThrow(/must match/)
    expect(() => deriveWorkers([ROLE('review', { workspace: 'rel' })], [], [])).toThrow(/absolute/)
    expect(() => deriveWorkers([ROLE('review', { reviewMember: true })], [{ account: ACC1, roles: ['review'] }], [])).toThrow(/names the family of fake-a/)
    expect(() => deriveWorkers([ROLE('review', { reviewMember: true, sandbox: 'workspace-write' })], [], [])).toThrow(/read-only/)
    expect(() => deriveWorkers([ROLE('a', { worktreePerRun: true }), ROLE('b')], [], [])).toThrow(/share the workspace/)
  })

  it('gives a role\'s Workers its kinds of work, and refuses kinds that are malformed, repeated, empty, or on a review member (REQ-WRK-11, ADR-0057)', () => {
    const [code, docs, review] = deriveWorkers([ROLE('code', { kinds: ['code'] }), ROLE('docs', { kinds: ['docs', 'tests'] }), ROLE('review')], [{ account: ACC1, roles: ['code', 'docs', 'review'] }], [])
    expect([code!.kinds, docs!.kinds, review!.kinds]).toEqual([['code'], ['docs', 'tests'], undefined])
    expect(() => deriveWorkers([ROLE('code', { kinds: [] })], [], [])).toThrow(/kinds must list 1 to 16/)
    expect(() => deriveWorkers([ROLE('code', { kinds: ['Code'] })], [], [])).toThrow(/"Code" is not a kind of work/)
    expect(() => deriveWorkers([ROLE('code', { kinds: ['code', 'code'] })], [], [])).toThrow(/name a kind twice/)
    expect(() => deriveWorkers([ROLE('member', { reviewMember: true, kinds: ['code'] })], [], [])).toThrow(/not for a review member/)
  })

  it('checks a row as its load does, before a host starts on it (system check): the operations examples pass, a disagreement on worktreePerRun, a bad kind, or a setup no worktree runs does not (D36, ADR-0057, ADR-0058)', () => {
    const rowOf = (file: string, id = 'agent-workers'): Record<string, unknown> => {
      const rows = parseYaml(readFileSync(fileURLToPath(new URL(`../../../../docs/operations/examples/${file}`, import.meta.url)), 'utf8')) as Array<{ id: string; config: Record<string, unknown> }>
      return rows.find((r) => r.id === id)!.config
    }
    for (const file of ['live-base.patch.yml', 'work-kinds.patch.yml']) {
      expect(checkConfig(rowOf(file)), file).toEqual([])
      expect(() => AgentWorkers.Config(rowOf(file) as never), file).not.toThrow()
    }
    // D36: one writing Claude Code Worker on the system repository, given every change to it (the
    // operator's request of 2026-10-25), one Codex Worker given the validation alone, and every
    // Worker on that workspace in a worktree per run; the profile row writes out the shipped kinds.
    const workers = rowOf('work-kinds.patch.yml').workers as AgentWorkerConfig[]
    expect(workers.filter((w) => w.sandbox === 'workspace-write').map((w) => [w.id, w.runtime, w.kinds])).toEqual([['claude-code', 'claude-agent-sdk', ['code', 'docs', 'tests']], ['codex-writer', 'codex-sdk', ['validation']]])
    const profile = rowOf('work-kinds.patch.yml', 'profile-software-development')
    expect(SoftwareDevelopment.checkConfig(profile)).toEqual([])
    expect(SoftwareDevelopment.Config(profile as never)).toEqual({ kinds: SoftwareDevelopment.DEFAULT_KINDS })
    const system = workers.filter((w) => w.workspace === '/home/tan/workspaces/system')
    expect(system.every((w) => w.worktreePerRun === true)).toBe(true)
    // T99 D5: a digest asks for a read-only Worker on the economy tier only, never one of the
    // standard reviewers: exactly one such Worker, given no kinds and no review team seat, and
    // outside the repository (its sources come in its brief); the reviewers stay standard.
    expect(workers.filter((w) => w.sandbox === 'read-only' && w.tier === 'economy').map((w) => [w.id, w.runtime, w.kinds, w.reviewMember, w.worktreePerRun, w.workspace])).toEqual([
      ['claude-digest', 'claude-agent-sdk', undefined, undefined, undefined, '/home/tan/experiments/review-member/empty'],
    ])
    expect(workers.filter((w) => w.sandbox === 'read-only' && w.id !== 'claude-digest').every((w) => w.tier === 'standard')).toBe(true)
    expect(checkConfig({ workers: system.map((w) => (w.id === 'codex-review' ? { ...w, worktreePerRun: false } : w)) })).toEqual([expect.stringMatching(/share the workspace \/home\/tan\/workspaces\/system, and only one of them works in a worktree per run/)])
    expect(checkConfig({ workers: [{ ...system[0]!, kinds: ['Code'] }] })).toEqual([expect.stringMatching(/kinds "Code" is not a kind of work/)])
    expect(checkConfig({ roles: [ROLE('code', { kinds: [] })], assignments: [{ account: ACC1, roles: ['code'] }] })).toEqual([expect.stringMatching(/kinds must list 1 to 16/)])
    // A worktree setup as its load checks it (ADR-0058): a repository's, of a Worker with worktreePerRun.
    expect(checkConfig({ workers: system, worktreeSetup: [{ repository: '/home/tan/workspaces/system', commands: ['pnpm install --offline'] }] })).toEqual([])
    expect(checkConfig({ workers: system, worktreeSetup: [{ repository: '/home/tan/workspaces/other', commands: ['pnpm install --offline'] }] })).toEqual([expect.stringMatching(/is the workspace of no Worker with worktreePerRun, so its setup would never run/)])
  })

  it('describes a hand-named Worker with its description (capability-descriptor@1.7), one without as before, and refuses a bad one at load (T85)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-described-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    mkdirSync(join(dir, 'ws'), { recursive: true })
    const row = (id: string, extra: Partial<AgentWorkerConfig> = {}): AgentWorkerConfig => ({ id, runtime: A, workspace: join(dir, 'ws'), sandbox: 'read-only', tier: 'standard', ...extra })
    const b = await boot({ workers: [row('reviewer', { description: 'Reads the diffs and reports what it finds' }), row('plain')] }, { dir })
    const workers = await described(b)
    expect(workers.get('agent:reviewer')).toMatchObject({ schema: 'capability-descriptor@1.7', description: 'Reads the diffs and reports what it finds' })
    expect(workers.get('agent:plain')).toMatchObject({ schema: 'capability-descriptor@1.5' })
    expect(workers.get('agent:plain')).not.toHaveProperty('description')
    for (const descriptor of workers.values()) schemas.assertRecord(descriptor)
    await b.stop()
    const refused = await boot({ workers: [row('reviewer', { description: 'line one\nline two' })] }, { dir })
    expect(refused.ctx.get('agentWorkers')).toBeUndefined()
  })

  it('refuses both shapes in one row, and per-account settings beside hand-named Workers, at load', async () => {
    const both = await boot({ workers: [{ id: 'reviewer', runtime: A, workspace: '/srv/ws', sandbox: 'read-only', tier: 'standard' }], roles: [ROLE('review')], assignments: [{ account: ACC1, roles: ['review'] }] })
    expect(both.ctx.get('agentWorkers')).toBeUndefined()
    const settings = await boot({ workers: [{ id: 'reviewer', runtime: A, workspace: '/srv/ws', sandbox: 'read-only', tier: 'standard' }], providers: [{ provider: A, maxConcurrentRunsPerAccount: 2 }] })
    expect(settings.ctx.get('agentWorkers')).toBeUndefined()
  })
})

describe('Workers = account × role: in the agents source (ADR-0051, REQ-ACC-11)', () => {
  it('admits an account\'s Workers only while it is ready, runs each in its account\'s home, and names every role of an account as siblings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-roles-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    // Enrolled first on a row with no Workers, then the row assigns the accounts by the ids verified.
    const first = await boot({ providers: [{ provider: A, slots: 2 }] }, { dir })
    const acc1 = await enroll(first, A, 'alice@example.test')
    const acc2 = await enroll(first, A, 'bob@example.test')
    await first.stop()
    const roles = [ROLE('review', { workspace: join(dir, 'ws') }), ROLE('research', { workspace: join(dir, 'ws') })]
    const b = await boot({ providers: [{ provider: A, slots: 2 }], roles, assignments: [{ account: acc1, roles: ['research', 'review'] }, { account: acc2, roles: ['review'] }, { account: ACC3, roles: ['review'] }] }, { dir })
    const workers = await described(b)
    expect([...workers.keys()].sort()).toEqual([`agent:${ACC3}/review`, `agent:${acc1}/research`, `agent:${acc1}/review`, `agent:${acc2}/review`].sort())
    expect(workers.get(`agent:${acc1}/review`)).toMatchObject({ state: 'ready', provider: A, family: A, account: { id: acc1, group: A, mode: 'assigned' }, load: { running: 0, queued: 0, pending: 0, slots: 1 } })
    // An assigned account no slot holds takes no work, and says why.
    expect(workers.get(`agent:${ACC3}/review`)).toMatchObject({ state: 'unavailable', capabilities: [] })
    expect(b.ctx.workers.siblings(`agent:${acc1}/review`)).toEqual([`agent:${acc1}/research`, `agent:${acc1}/review`])
    expect(b.ctx.workers.siblings(`agent:${acc2}/review`)).toEqual([`agent:${acc2}/review`])
    // Slot 1 is the runtime's own home, so its runs name none; slot 2's run in slot 2's home.
    expect(await wait(b, start(b, `agent:${acc1}/review`, 'one').id)).toMatchObject({ status: 'completed' })
    expect(await wait(b, start(b, `agent:${acc2}/review`, 'two').id)).toMatchObject({ status: 'completed' })
    expect(b.runtimes[A]!.specs.map((s) => s.home)).toEqual([undefined, join(dir, 'agent-homes', A, '2')])
    // Re-signed as another person: the probe's re-read quarantines the account, and only its Workers stop.
    FakeAgentRuntime.signIn(join(dir, 'agent-homes', A, '2'), 'carol@example.test')
    const after = await described(b)
    expect(after.get(`agent:${acc2}/review`)!.state).toBe('unavailable')
    expect(after.get(`agent:${acc1}/review`)!.state).toBe('ready')
    expect(accounts(b).list().find((a) => a.slot === 2)).toMatchObject({ status: 'quarantined', quarantine: { reason: 'changed' } })
    // A run queued on it fails before anything is sent.
    expect(await wait(b, start(b, `agent:${acc2}/review`, 'three').id)).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error' } })
    // The listing names each account's own Workers.
    const listed = await call(b, 'account_agents', {})
    expect((listed.structuredContent!.accounts as Array<{ account: { slot: number }; workers: string[] }>).map((a) => [a.account.slot, a.workers]))
      .toEqual([[1, [`agent:${acc1}/research`, `agent:${acc1}/review`]], [2, [`agent:${acc2}/review`]]])
  })

  it('takes no work on an unverified account (no verified reader), unlike a hand-named Worker in its home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-roles-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const b = await boot({}, { dir })
    await accounts(b).begin({ provider: C })
    FakeAgentRuntime.signIn(b.homes[C]!, 'dana@example.test')
    expect(await accounts(b).verify({ provider: C, slot: 1 })).toMatchObject({ status: 'quarantined', quarantine: { reason: 'unverified' } })
    // It has no account id, so no assignment can name it: an assignment of an id it might have reads unavailable.
    const derived = await boot({ roles: [ROLE('review', { workspace: join(dir, 'ws') })], assignments: [{ account: `${C}:${'1'.repeat(16)}`, roles: ['review'] }] }, { dir })
    expect((await described(derived)).get(`agent:${C}:${'1'.repeat(16)}/review`)!.state).toBe('unavailable')
  })
})

describe('Workers = account × role: per account (PROP-0012 phase F)', () => {
  async function twoRoles(maxConcurrentRunsPerAccount?: number) {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-roles-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ providers: [{ provider: A, slots: 2 }] }, { dir })
    const acc1 = await enroll(first, A, 'alice@example.test')
    const acc2 = await enroll(first, A, 'bob@example.test')
    await first.stop()
    const roles = [ROLE('review', { workspace: join(dir, 'ws') }), ROLE('research', { workspace: join(dir, 'ws') })]
    const b = await boot({
      providers: [{ provider: A, slots: 2, ...(maxConcurrentRunsPerAccount ? { maxConcurrentRunsPerAccount } : {}) }], roles,
      assignments: [{ account: acc1, roles: ['research', 'review'] }, { account: acc2, roles: ['review'] }],
    }, { dir })
    return { b, acc1, acc2 }
  }

  it('runs one run at a time per account across its roles (maxConcurrentRunsPerAccount 1), while another account runs at once, and reports the account\'s load', async () => {
    const { b, acc1, acc2 } = await twoRoles()
    const runtime = b.runtimes[A]!
    runtime.held = true
    const r1 = start(b, `agent:${acc1}/review`, 'r1')
    const r2 = start(b, `agent:${acc1}/research`, 'r2')
    const r3 = start(b, `agent:${acc2}/review`, 'r3')
    await until(() => runtime.running === 2)
    // acc1 runs one of its two; acc2 runs its own beside it.
    const load = (await described(b)).get(`agent:${acc1}/research`)!
    expect(load).toMatchObject({ state: 'busy', load: { running: 1, queued: 1, pending: 0, slots: 1 } })
    expect((await described(b)).get(`agent:${acc2}/review`)).toMatchObject({ state: 'busy', load: { running: 1, queued: 0, slots: 1 } })
    runtime.release()
    expect((await Promise.all([r1, r2, r3].map((r) => wait(b, r.id)))).map((r) => r.status)).toEqual(['completed', 'completed', 'completed'])
    expect(runtime.most).toBe(2)
    expect((await described(b)).get(`agent:${acc1}/review`)).toMatchObject({ state: 'ready', load: { running: 0, queued: 0 } })
  })

  it('runs two of an account\'s roles at once with maxConcurrentRunsPerAccount 2, never two runs of one Worker', async () => {
    const { b, acc1 } = await twoRoles(2)
    const runtime = b.runtimes[A]!
    runtime.held = true
    const runs = [start(b, `agent:${acc1}/review`, 'r1'), start(b, `agent:${acc1}/research`, 'r2'), start(b, `agent:${acc1}/review`, 'r3')]
    await until(() => runtime.running === 2)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runtime.running).toBe(2)
    expect((await described(b)).get(`agent:${acc1}/review`)).toMatchObject({ load: { running: 2, queued: 1, slots: 2 }, state: 'busy' })
    runtime.release()
    await Promise.all(runs.map((r) => wait(b, r.id)))
    expect(runtime.most).toBe(2)
  })

  it('counts an admission routed to an account in its pending load until it is released (ADR-0033)', async () => {
    const { b, acc1 } = await twoRoles()
    const release = b.ctx.workers.source('agents')!.reserve!(`agent:${acc1}/review`)
    expect((await described(b)).get(`agent:${acc1}/research`)!.load).toMatchObject({ pending: 1 })
    release()
    release()
    expect((await described(b)).get(`agent:${acc1}/research`)!.load).toMatchObject({ pending: 0 })
  })

  it('meters each account on its own pool of the provider\'s template, declared to the ledger for ready accounts only: a limit on one account never closes another\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-roles-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ providers: [{ provider: A, slots: 2 }] }, { dir })
    const acc1 = await enroll(first, A, 'alice@example.test')
    const acc2 = await enroll(first, A, 'bob@example.test')
    await first.stop()
    const b = await boot({
      providers: [{ provider: A, slots: 2, pool: 'plan', windows: { five_hour: 'five-hour' } }],
      roles: [ROLE('review', { workspace: join(dir, 'ws') })], assignments: [{ account: acc1, roles: ['review'] }, { account: acc2, roles: ['review'] }, { account: ACC2, roles: ['review'] }],
    }, { dir, ledger: true })
    // No reading yet: each pool is unknown, so closed (INV-2); the never-enrolled account has none.
    await described(b)
    expect((await b.ctx.resources.pools()).map((p) => [p.pool, p.account])).toEqual([[`plan/${acc1}`, acc1], [`plan/${acc2}`, acc2]].sort())
    const window = TEMPLATE.windows[0]!
    const read = (account: string, state: 'ok' | 'limited') => b.ctx.resources.observe({
      schema: 'limit-state@1.0', pool: `plan/${account}`, account, window, state, ...(state === 'limited' ? { resetsAt: new Date(Date.now() + 3_600_000).toISOString() } : {}), source: 'runtime-result', observedAt: new Date().toISOString(),
    })
    await read(acc1, 'limited')
    await read(acc2, 'ok')
    const workers = await described(b)
    expect(workers.get(`agent:${acc1}/review`)).toMatchObject({ state: 'quota-exhausted', account: { id: acc1, limitUntil: expect.any(String) } })
    expect(workers.get(`agent:${acc2}/review`)!.state).toBe('ready')
    const done = await wait(b, start(b, `agent:${acc2}/review`, 'metered'))
    expect(done.status).toBe('completed')
    expect((await b.ctx.resources.usage({ account: acc2 })).records).toEqual([])
    expect(done.decisions).toHaveLength(2)
  })
})

// The live patch's three hand-named Workers, on three fake runtimes standing for Claude Code, Codex, and the Antigravity CLI.
const LIVE = (ws: string): AgentWorkerConfig[] => [
  { id: 'claude-research', runtime: A, workspace: ws, sandbox: 'read-only', tier: 'standard', maxTurns: 4 },
  { id: 'codex-review', runtime: B, workspace: ws, sandbox: 'read-only', tier: 'standard' },
  { id: 'agy-review', runtime: C, workspace: ws, sandbox: 'read-only', tier: 'standard', model: 'model-c-1' },
]

describe('before the move: the hand-named rows route exactly as before (PROP-0012 phase F rollout)', () => {
  it('describes them as before this phase (no load, the runtime as the account, every Worker of a runtime its siblings), runs two of one runtime at once, counts nothing pending, and declares nothing to the ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-roles-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const ws = join(dir, 'ws')
    const b = await boot({ workers: [...LIVE(ws), { id: 'claude-second', runtime: A, workspace: ws, sandbox: 'read-only', tier: 'standard' }] }, { dir, ledger: true })
    const workers = await described(b)
    for (const id of ['agent:claude-research', 'agent:codex-review', 'agent:agy-review']) {
      const d = workers.get(id)!
      expect(Object.keys(d).sort(), id).toEqual(['account', 'capabilities', 'family', 'locality', 'observedAt', 'provider', 'quotaClass', 'schema', 'state', 'tier', 'worker'])
      expect(d).toMatchObject({ state: 'ready', account: { id: d.provider, group: d.provider, mode: 'assigned' }, family: d.provider })
    }
    expect(b.ctx.workers.siblings('agent:claude-research')).toEqual(['agent:claude-research', 'agent:claude-second'])
    // The route is as before: the first of equals by id, nothing about load in its reasons.
    const routed = await b.ctx.workers.route(requirement())
    expect(routed.worker.worker).toBe('agent:agy-review')
    expect(JSON.stringify(b.ctx.artifacts.get(routed.decisions.route)!.body)).not.toMatch(/busy|load \d/)
    // Two Workers of one home run at once, each one at a time, as before.
    const runtime = b.runtimes[A]!
    runtime.held = true
    const runs = [start(b, 'agent:claude-research', 'x'), start(b, 'agent:claude-second', 'y')]
    await until(() => runtime.running === 2)
    runtime.release()
    expect((await Promise.all(runs.map((r) => wait(b, r.id)))).map((r) => r.status)).toEqual(['completed', 'completed'])
    expect(runtime.specs.every((s) => s.home === undefined)).toBe(true)
    b.ctx.workers.source('agents')!.reserve!('agent:claude-research')
    expect((await described(b)).get('agent:claude-research')).not.toHaveProperty('load')
    expect(await b.ctx.resources.pools()).toEqual([])
    // Enrollment as before: unverified slot 1 (no reader) keeps its Worker running, until the move.
    await accounts(b).begin({ provider: C })
    FakeAgentRuntime.signIn(b.homes[C]!, 'dana@example.test')
    await accounts(b).verify({ provider: C, slot: 1 })
    expect((await described(b)).get('agent:agy-review')!.state).toBe('ready')
  })
})

describe('system account migrate (PROP-0012 phase F: migration from hand-named rows)', () => {
  async function live() {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-roles-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const ws = join(dir, 'ws')
    const config = { workers: LIVE(ws) }
    const b = await boot(config, { dir })
    return { b, dir, ws, config }
  }

  it('prints the move and changes nothing: blockers until slot 1 of each runtime is enrolled and ready; one role review with what each runtime sets; assignments by the verified ids', async () => {
    const { b, ws } = await live()
    const before = await call(b, 'account_migrate', {})
    expect(before.structuredContent).toMatchObject({ outcome: 'planned' })
    expect((before.structuredContent!.plan as { blockers: string[] }).blockers).toEqual([
      expect.stringMatching(/no account is enrolled in fake-a's home: enroll it first \(system account login fake-a/),
      expect.stringMatching(/no account is enrolled in fake-b's home/),
      expect.stringMatching(/no account is enrolled in fake-c's home/),
    ])
    const a = await enroll(b, A, 'alice@example.test')
    const bb = await enroll(b, B, 'bob@example.test')
    await accounts(b).begin({ provider: C })
    FakeAgentRuntime.signIn(b.homes[C]!, 'dana@example.test')
    await accounts(b).verify({ provider: C, slot: 1 })
    const decided = enrollments(b).length
    const planned = await call(b, 'account_migrate', {})
    const plan = planned.structuredContent!.plan as ReturnType<typeof planMigration>
    expect(plan.roles).toEqual([{ id: 'review', workspace: ws, sandbox: 'read-only', tier: 'standard', runtimes: { [A]: { maxTurns: 4 }, [C]: { model: 'model-c-1' } } }])
    expect(plan.assignments).toEqual([{ account: a, roles: ['review'] }, { account: bb, roles: ['review'] }].sort((x, y) => (x.account < y.account ? -1 : 1)))
    expect(plan.workers.map((w) => [w.from, w.to])).toEqual([['agent:agy-review', undefined], ['agent:claude-research', `agent:${a}/review`], ['agent:codex-review', `agent:${bb}/review`]])
    // Antigravity's account cannot be verified: the cutover waits for it, or the operator stops its Workers (open question 1).
    expect(plan.blockers).toEqual([expect.stringMatching(/fake-c's home \(slot 1\) is quarantined \(unverified\).*the cutover waits.*--stop fake-c/)])
    expect(planned.structuredContent!.row).toEqual({ accountHomes: join(b.dir, 'agent-homes'), probeTtlMs: 0, providers: plan.providers, roles: plan.roles, assignments: plan.assignments })
    // Nothing changed: no decision, the hand-named Workers run as before.
    expect(enrollments(b)).toHaveLength(decided)
    expect(await wait(b, start(b, 'agent:codex-review', 'still'))).toMatchObject({ status: 'completed' })
    const refused = await call(b, 'account_migrate', { apply: true })
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^invalid_input: the cutover is refused, nothing changed/) }] })
    expect(enrollments(b)).toHaveLength(decided)
    expect(b.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM agent_cutover').get()).toEqual({ n: 0 })
  })

  it('applies once (recorded per Worker and as the cutover, sessions and runs moved), then refuses the hand-named rows; applying again changes nothing; a rollback puts exactly the moved ones back and lets them load again', async () => {
    const { b, dir, config } = await live()
    const a = await enroll(b, A, 'alice@example.test')
    const bb = await enroll(b, B, 'bob@example.test')
    // A conversation on the Codex Worker before the move.
    expect(await wait(b, start(b, 'agent:codex-review', 'turn-1', 'ses_codex'))).toMatchObject({ status: 'completed' })
    // Refused while a run of an old Worker is queued (drain first).
    b.runtimes[B]!.held = true
    const queued = start(b, 'agent:codex-review', 'held')
    await until(() => b.runtimes[B]!.running === 1)
    const busy = await call(b, 'account_migrate', { apply: true, stop: [C] })
    expect(busy).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/queued or running; drain first/) }] })
    b.runtimes[B]!.release()
    await wait(b, queued.id)
    const decided = enrollments(b).length
    const applied = await call(b, 'account_migrate', { apply: true, stop: [C] })
    expect(applied.structuredContent).toMatchObject({ outcome: 'applied', moved: { sessions: 1, runs: 2 }, cutover: { decision: expect.stringMatching(/^sha256:/) } })
    const recorded = enrollments(b).slice(decided)
    expect(recorded.map((d) => [d.decider.id, d.outcome.option, d.outcome.detail.from ?? null])).toEqual([
      ['agent-workers.migration', 'stopped', 'agent:agy-review'], ['agent-workers.migration', 'migrated', 'agent:claude-research'], ['agent-workers.migration', 'migrated', 'agent:codex-review'],
      ['agent-workers.migration', 'applied', null],
    ])
    // Each move's input is its account's enrollment decision; the cutover's are the moves.
    expect(recorded[1]!.inputs).toHaveLength(1)
    expect(recorded[3]!.inputs).toHaveLength(3)
    expect(b.ctx.workers.affinity('ses_codex')).toEqual([`agent:${bb}/review`])
    // In this process the hand-named Workers stop at once; nothing new starts on them.
    expect([...(await described(b)).values()].map((d) => d.state)).toEqual(['unavailable', 'unavailable', 'unavailable'])
    expect(() => start(b, 'agent:claude-research', 'after')).toThrow(/moved them to accounts × roles/)
    // Idempotent: applied again, nothing new.
    expect((await call(b, 'account_migrate', { apply: true, stop: [C] })).structuredContent).toMatchObject({ outcome: 'already-applied' })
    expect(enrollments(b)).toHaveLength(decided + 4)
    const row = applied.structuredContent!.row as Partial<Config>
    await b.stop()

    // The hand-named rows are refused at load from now on, naming the way forward and back.
    const refused = await boot(config, { dir })
    expect(refused.ctx.get('agentWorkers')).toBeUndefined()
    await refused.stop()
    // The printed row loads: the Codex conversation stays on its account, now its derived Worker.
    const derived = await boot(row, { dir })
    const workers = await described(derived)
    expect([...workers.keys()].sort()).toEqual([`agent:${a}/review`, `agent:${bb}/review`].sort())
    expect(workers.get(`agent:${bb}/review`)!.state).toBe('ready')
    expect(derived.ctx.workers.affinity('ses_codex')).toEqual([`agent:${bb}/review`])
    expect(await wait(derived, start(derived, `agent:${bb}/review`, 'turn-2'))).toMatchObject({ status: 'completed' })
    const cutover = applied.structuredContent!.cutover as { decision: string }
    expect((await call(derived, 'account_migrate', {})).structuredContent).toMatchObject({ outcome: 'planned', cutover: { decision: cutover.decision } })

    // Rollback: the moved session and runs go back (the run made since stays on the derived Worker), and the refusal is lifted.
    const undone = await call(derived, 'account_migrate', { rollback: true })
    expect(undone.structuredContent).toMatchObject({ outcome: 'rolled-back', moved: { sessions: 1, runs: 2 } })
    expect(enrollments(derived).at(-1)).toMatchObject({ outcome: { option: 'rolled-back' } })
    expect((await call(derived, 'account_migrate', { rollback: true })).structuredContent).toMatchObject({ outcome: 'not-applied' })
    expect(derived.ctx.store.db.prepare('SELECT worker, COUNT(*) AS n FROM agent_runs GROUP BY worker ORDER BY worker').all()).toEqual([
      { worker: 'agent:codex-review', n: 2 }, { worker: `agent:${bb}/review`, n: 1 },
    ])
    await derived.stop()
    const back = await boot(config, { dir })
    expect(back.ctx.get('agentWorkers')).toBeDefined()
    expect(back.ctx.workers.affinity('ses_codex')).toEqual(['agent:codex-review'])
    expect((await described(back)).get('agent:codex-review')!.state).toBe('ready')
  })

  it('plans a role per distinct work setting and per repeated runtime, a provider\'s pool as a template, and stops a move whose rows disagree on what they draw on', () => {
    const accountsOf = (...runtimes: string[]) => runtimes.map((provider, i) => ({
      schema: 'agent-account@1.0' as const, provider, slot: 1, home: `/h/${provider}`, status: 'ready' as const, accountId: `${provider}:${String(i).padStart(16, '0')}`, revision: 1, updatedAt: 'x',
    }))
    const runtimes = new Map([[A, { home: `/h/${A}` }], [B, { home: `/h/${B}` }]])
    const pools = [{ pool: 'plan-a', account: 'acct-a', kind: 'interactive' as const, windows: [{ id: 'five-hour', kind: 'rolling' as const }], unknown: 'unavailable' as const, readings: [], available: true }]
    const rows: AgentWorkerConfig[] = [
      { id: 'a-review', runtime: A, workspace: '/w', sandbox: 'read-only', tier: 'standard', pool: 'plan-a', account: 'acct-a', windows: { five_hour: 'five-hour' } },
      { id: 'a-second', runtime: A, workspace: '/w', sandbox: 'read-only', tier: 'standard', pool: 'plan-a', account: 'acct-a', windows: { five_hour: 'five-hour' } },
      { id: 'b-dev', runtime: B, workspace: '/w', sandbox: 'workspace-write', tier: 'standard' },
    ]
    const plan = planMigration({ rows, providers: [{ provider: A, slots: 3 }], accounts: accountsOf(A, B), runtimes, pools, stop: [] })
    expect(plan.roles.map((r) => r.id)).toEqual(['review', 'review-2', 'develop'])
    expect(plan.workers.map((w) => [w.from, w.to])).toEqual([['agent:a-review', `agent:${A}:${'0'.repeat(16)}/review`], ['agent:a-second', `agent:${A}:${'0'.repeat(16)}/review-2`], ['agent:b-dev', `agent:${B}:${'0'.repeat(15)}1/develop`]])
    expect(plan.providers).toEqual([{ provider: A, slots: 3, pool: 'plan-a', windows: { five_hour: 'five-hour' }, maxConcurrentRunsPerAccount: 2 }, { provider: B }])
    expect(plan.templates).toEqual([{ template: 'plan-a', group: A, kind: 'interactive', windows: [{ id: 'five-hour', kind: 'rolling' }] }])
    expect(plan.blockers).toEqual([])
    // Deterministic: the same input, the same plan.
    expect(planMigration({ rows: [...rows].reverse(), providers: [{ provider: A, slots: 3 }], accounts: accountsOf(A, B), runtimes, pools, stop: [] })).toEqual(plan)
    const mixed = planMigration({ rows: [rows[0]!, { ...rows[1]!, pool: undefined, account: undefined, windows: undefined }], providers: [], accounts: accountsOf(A), runtimes, pools, stop: [] })
    expect(mixed.blockers).toEqual([expect.stringMatching(/draw on different pools/), expect.stringMatching(/map limit windows differently/)])
  })

  it('keeps the kinds of work of the rows: rows of other kinds are other roles, and rows of one kind, in any order, one role (ADR-0057)', () => {
    const accounts = [A, B].map((provider, i) => ({
      schema: 'agent-account@1.0' as const, provider, slot: 1, home: `/h/${provider}`, status: 'ready' as const, accountId: `${provider}:${String(i).padStart(16, '0')}`, revision: 1, updatedAt: 'x',
    }))
    const runtimes = new Map([[A, { home: `/h/${A}` }], [B, { home: `/h/${B}` }]])
    const writer = { workspace: '/w', sandbox: 'workspace-write' as const, tier: 'standard' as const, worktreePerRun: true }
    const rows: AgentWorkerConfig[] = [
      { id: 'a-code', runtime: A, ...writer, kinds: ['code'] },
      { id: 'b-docs', runtime: B, ...writer, kinds: ['tests', 'docs'] },
      { id: 'b-writer', runtime: B, ...writer },
    ]
    const plan = planMigration({ rows, providers: [], accounts, runtimes, pools: undefined, stop: [] })
    expect(plan.roles.map((r) => [r.id, r.kinds])).toEqual([['develop', ['code']], ['develop-2', ['docs', 'tests']], ['develop-3', undefined]])
    expect(plan.blockers).toEqual([])
    const one = planMigration({ rows: [rows[0]!, { ...rows[1]!, kinds: ['code'] }], providers: [], accounts, runtimes, pools: undefined, stop: [] })
    expect(one.roles.map((r) => [r.id, r.kinds])).toEqual([['develop', ['code']]])
  })

  it('keeps a role\'s description when its rows agree on it, and none when they do not (rule version 3, T103)', () => {
    const accounts = [A, B].map((provider, i) => ({
      schema: 'agent-account@1.0' as const, provider, slot: 1, home: `/h/${provider}`, status: 'ready' as const, accountId: `${provider}:${String(i).padStart(16, '0')}`, revision: 1, updatedAt: 'x',
    }))
    const runtimes = new Map([[A, { home: `/h/${A}` }], [B, { home: `/h/${B}` }]])
    const reader = { workspace: '/w', sandbox: 'read-only' as const, tier: 'standard' as const }
    const agree: AgentWorkerConfig[] = [{ id: 'a-review', runtime: A, ...reader, description: 'Reviews a change' }, { id: 'b-review', runtime: B, ...reader, description: 'Reviews a change' }]
    expect(planMigration({ rows: agree, providers: [], accounts, runtimes, pools: undefined, stop: [] }).roles).toEqual([{ id: 'review', ...reader, description: 'Reviews a change' }])
    for (const differ of [[agree[0]!, { ...agree[1]!, description: 'Reviews another way' }], [agree[0]!, { ...agree[1]!, description: undefined }]]) {
      expect(planMigration({ rows: differ, providers: [], accounts, runtimes, pools: undefined, stop: [] }).roles).toEqual([{ id: 'review', ...reader }])
    }
  })

  it('stops the move for a runtime that reads no identity, whose account cannot be enrolled, until its Workers are stopped (T103)', () => {
    const accounts = [{ schema: 'agent-account@1.0' as const, provider: A, slot: 1, home: `/h/${A}`, status: 'ready' as const, accountId: `${A}:${'0'.repeat(16)}`, revision: 1, updatedAt: 'x' }]
    const runtimes = new Map([[A, { home: `/h/${A}`, identity: true }], [C, { home: `/h/${C}`, identity: false }]])
    const rows: AgentWorkerConfig[] = [{ id: 'a-review', runtime: A, workspace: '/w', sandbox: 'read-only', tier: 'standard' }, { id: 'c-review', runtime: C, workspace: '/w', sandbox: 'read-only', tier: 'standard' }]
    const waiting = planMigration({ rows, providers: [], accounts, runtimes, pools: undefined, stop: [] })
    expect(waiting.blockers).toEqual([expect.stringMatching(/^fake-c has no verified way to read who is signed in \(no identity reader\), so no account of it can be enrolled.*the cutover waits until its identity can be verified, or stop its Workers at the cutover \(--stop fake-c/)])
    const stopped = planMigration({ rows, providers: [], accounts, runtimes, pools: undefined, stop: [C] })
    expect(stopped.blockers).toEqual([])
    expect(stopped.workers.find((w) => w.from === 'agent:c-review')).toMatchObject({ why: expect.stringMatching(/stopped by the operator at the cutover$/) })
    expect(stopped.workers.find((w) => w.from === 'agent:c-review')).not.toHaveProperty('to')
  })

  // T98's live patch: rows with kinds and descriptions, so the plan's roles carry both; the planner
  // gave roles kinds and the tool's schema refused them, after an apply would have committed.
  it('plans, applies, and rolls back through account_migrate a move whose roles have kinds and descriptions, each output as mcp-agent-accounts@1.2 says (T103)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-roles-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const ws = join(dir, 'ws')
    const row = (id: string, runtime: string, extra: Partial<AgentWorkerConfig>): AgentWorkerConfig => ({ id, runtime, workspace: ws, sandbox: 'read-only', tier: 'standard', ...extra })
    const config = {
      workers: [
        row('claude-code', A, { sandbox: 'workspace-write', kinds: ['code'], description: 'Writes the code' }),
        row('codex-writer', B, { sandbox: 'workspace-write', kinds: ['tests', 'docs'], description: 'Writes the docs and the tests' }),
        row('claude-research', A, { description: 'Reviews a change' }),
        row('codex-review', B, { description: 'Reviews a change' }),
        row('agy-review', C, { description: 'Reviews a change with a third family' }),
        row('claude-member', A, { tier: 'frontier', description: 'Gives a second opinion' }),
        row('codex-member', B, { tier: 'frontier', description: 'Gives a second opinion' }),
      ],
    }
    const b = await boot(config, { dir })
    const a = await enroll(b, A, 'alice@example.test')
    const bb = await enroll(b, B, 'bob@example.test')
    expect(await wait(b, start(b, 'agent:codex-review', 'turn-1', 'ses_codex'))).toMatchObject({ status: 'completed' })
    const planned = await call(b, 'account_migrate', { stop: [C] })
    expect(planned.isError).toBeUndefined()
    const plan = planned.structuredContent!.plan as ReturnType<typeof planMigration>
    expect(plan.roles.map((r) => [r.id, r.sandbox, r.tier, r.kinds, r.description])).toEqual([
      // The read-only rows of three runtimes disagree on their description: their role has none.
      ['review', 'read-only', 'standard', undefined, undefined],
      ['develop', 'workspace-write', 'standard', ['code'], 'Writes the code'],
      ['review-2', 'read-only', 'frontier', undefined, 'Gives a second opinion'],
      ['develop-2', 'workspace-write', 'standard', ['docs', 'tests'], 'Writes the docs and the tests'],
    ])
    expect(plan.blockers).toEqual([])
    const applied = await call(b, 'account_migrate', { apply: true, stop: [C] })
    expect(applied.isError).toBeUndefined()
    expect(applied.structuredContent).toMatchObject({ outcome: 'applied', plan, moved: { sessions: 1, runs: 1 }, cutover: { plan } })
    expect(enrollments(b).filter((d) => d.decider.id === 'agent-workers.migration').map((d) => d.decider)).toEqual(Array(8).fill({ type: 'rule', id: 'agent-workers.migration', version: '3' }))
    const row2 = applied.structuredContent!.row as Partial<Config>
    expect(row2.roles).toEqual(plan.roles)
    await b.stop()
    // The printed row loads, and each derived Worker describes its role's kinds and description.
    const derived = await boot(row2, { dir })
    const workers = await described(derived)
    expect(workers.get(`agent:${a}/develop`)).toMatchObject({ kinds: ['code'], description: 'Writes the code' })
    expect(workers.get(`agent:${bb}/develop-2`)).toMatchObject({ kinds: ['docs', 'tests'], description: 'Writes the docs and the tests' })
    expect(workers.get(`agent:${bb}/review`)).not.toHaveProperty('description')
    expect(derived.ctx.workers.affinity('ses_codex')).toEqual([`agent:${bb}/review`])
    const undone = await call(derived, 'account_migrate', { rollback: true })
    expect(undone.isError).toBeUndefined()
    expect(undone.structuredContent).toMatchObject({ outcome: 'rolled-back', plan, moved: { sessions: 1, runs: 1 } })
    expect(derived.ctx.workers.affinity('ses_codex')).toEqual(['agent:codex-review'])
  })

  it('refuses an apply whose output its schema refuses before anything is decided or moved, where it used to commit and only then report the defect (T103)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-roles-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const ws = join(dir, 'ws')
    // A workspace longer than a plan's role may name (4096): the row loads, and its plan is one the schema refuses.
    const config = { workers: [...LIVE(ws), { id: 'long-writer', runtime: A, workspace: `/${'w'.repeat(5000)}`, sandbox: 'workspace-write' as const, tier: 'standard' as const }] }
    const b = await boot(config, { dir })
    await enroll(b, A, 'alice@example.test')
    await enroll(b, B, 'bob@example.test')
    expect(await wait(b, start(b, 'agent:codex-review', 'turn-1', 'ses_codex'))).toMatchObject({ status: 'completed' })
    const decided = enrollments(b).length
    // The plan alone changes nothing, and still says it is a defect.
    expect(await call(b, 'account_migrate', { stop: [C] })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^account_migrate made an output its schema refuses \(a defect\): .*workspace/) }] })
    const refused = await call(b, 'account_migrate', { apply: true, stop: [C] })
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^account_migrate would make an output its schema refuses \(a defect\), so nothing changed: .*workspace/) }] })
    // Nothing was decided, applied, or moved: the hand-named Workers run on.
    expect(enrollments(b)).toHaveLength(decided)
    expect(b.ctx.store.db.prepare('SELECT (SELECT COUNT(*) FROM agent_cutover) AS cutover, (SELECT COUNT(*) FROM agent_cutover_moves) AS moves').get()).toEqual({ cutover: 0, moves: 0 })
    expect(b.ctx.workers.affinity('ses_codex')).toEqual(['agent:codex-review'])
    expect(await wait(b, start(b, 'agent:codex-review', 'still'))).toMatchObject({ status: 'completed' })
  })

  it('runs the cutover\'s check after every write and before the commit: a check that throws leaves an apply and a rollback undone (T103)', async () => {
    const { b, ws } = await live()
    await enroll(b, A, 'alice@example.test')
    const bb = await enroll(b, B, 'bob@example.test')
    expect(await wait(b, start(b, 'agent:codex-review', 'turn-1', 'ses_codex'))).toMatchObject({ status: 'completed' })
    const runtimes = new Map([A, B, C].map((kind) => [kind, { home: b.homes[kind] }]))
    const plan = planMigration({ rows: LIVE(ws), providers: [], accounts: accounts(b).list(), runtimes, pools: undefined, stop: [C] })
    expect(plan.blockers).toEqual([])
    const cutover = new Cutover(b.ctx)
    const decided = enrollments(b).length
    let seen: unknown
    expect(() => cutover.apply(plan, () => undefined, (applied) => {
      seen = applied
      throw new Error('a defect')
    })).toThrow('a defect')
    // The check saw the cutover as it would have stood, and none of it stands.
    expect(seen).toMatchObject({ applied: true, moved: { sessions: 1, runs: 1 } })
    expect(cutover.state()).toBeUndefined()
    expect(enrollments(b)).toHaveLength(decided)
    expect(b.ctx.workers.affinity('ses_codex')).toEqual(['agent:codex-review'])
    expect(cutover.apply(plan, () => undefined).applied).toBe(true)
    expect(b.ctx.workers.affinity('ses_codex')).toEqual([`agent:${bb}/review`])
    const applied = enrollments(b).length
    expect(() => cutover.rollback(() => {
      throw new Error('a defect')
    })).toThrow('a defect')
    expect(cutover.state()).toMatchObject({ plan })
    expect(enrollments(b)).toHaveLength(applied)
    expect(b.ctx.workers.affinity('ses_codex')).toEqual([`agent:${bb}/review`])
    expect(cutover.rollback()).toMatchObject({ rolledBack: true, moved: { sessions: 1, runs: 1 } })
    expect(b.ctx.workers.affinity('ses_codex')).toEqual(['agent:codex-review'])
  })
})
