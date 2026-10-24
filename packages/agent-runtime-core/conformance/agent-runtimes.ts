/**
 * Conformance suites for `ctx.agentRuntimes` (plugin rule 7): one for the registry, one for
 * every provider. A provider's test supplies it wired to a scripted agent that answers with
 * the prompt it received (`echo: <prompt>`) and reports the native handle `h-1`. A provider
 * whose agent reports what it consumed has the scripted agent report it too, so the suite checks
 * it; one that reports nothing passes as it is. A provider that reads who is signed in to a home
 * also runs the identity suite, with a harness that signs scripted homes in and out; the fake
 * {@link FakeAgentRuntime} passes every suite here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type AgentRuntimeProvider, type IdentityReading, type LoginCommand, type ProbeOptions, type RunMetering, type RunObserver, type RunResult, type RunSpec, type RuntimeEvidence, type TokenUsage,
  accountIdOf, identityHmac, maskEmail, observe, probeIn,
} from '../src/index.ts'

const provider = (kind: string): AgentRuntimeProvider => ({
  kind,
  probe: async () => ({ available: true, detail: 'test', sandboxes: ['read-only'], resume: false, executes: false, readsConfined: true, gatesToolCalls: true }),
  run: async () => ({ text: '' }),
})

/** `plugin` provides `ctx.agentRuntimes` with no required config. */
export function agentRuntimesConformance(name: string, plugin: Parameters<Context['plugin']>[0]): void {
  describe(`ctx.agentRuntimes conformance: ${name}`, () => {
    it('registers a provider for the contributing plugin\'s lifetime only, and refuses a duplicate kind', async () => {
      const ctx = new Context()
      await ctx.plugin(plugin)
      const fiber = ctx.plugin({ inject: ['agentRuntimes'], apply: (c: Context) => c.agentRuntimes.register(provider('b')) })
      await fiber
      ctx.agentRuntimes.register(provider('a'))
      expect(ctx.agentRuntimes.list()).toEqual(['a', 'b'])
      expect(ctx.agentRuntimes.get('b')?.kind).toBe('b')
      expect(() => ctx.agentRuntimes.register(provider('a'))).toThrow()
      await fiber.dispose()
      expect(ctx.agentRuntimes.list()).toEqual(['a'])
      expect(ctx.agentRuntimes.get('b')).toBeUndefined()
    })
  })
}

const COUNTS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'] as const

const expectUsage = (usage: TokenUsage, what: string): void => {
  for (const key of COUNTS) {
    const value = usage[key]
    if (value !== undefined) expect(Number.isInteger(value) && value >= 0, `${what}.${key} is a count`).toBe(true)
  }
  // Normalized: input includes its cached part (schemas/common.v1.json tokenUsage).
  expect(usage.inputTokens, `${what}: inputTokens includes cache read and cache creation`).toBeGreaterThanOrEqual((usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0))
}

const isTime = (value: string): boolean => Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)

/**
 * What a run reports it consumed holds together, or is absent: counts are whole and normalized,
 * per-model counts sum to the totals, and rate-limit observations carry an opaque window, a
 * status, and ISO times. A provider's own tests also apply it to the metering a failed run carries.
 */
export function expectConsistentMetering(metering: RunMetering): void {
  if (metering.resultId !== undefined) expect(metering.resultId.length).toBeGreaterThan(0)
  if (metering.model !== undefined) expect(metering.model.length).toBeGreaterThan(0)
  if (metering.turns !== undefined) expect(Number.isInteger(metering.turns) && metering.turns >= 0).toBe(true)
  if (metering.costUsd !== undefined) expect(Number.isFinite(metering.costUsd) && metering.costUsd >= 0).toBe(true)
  if (metering.usage) expectUsage(metering.usage, 'usage')
  if (metering.models) {
    expect(metering.usage, 'per-model usage comes with its totals').toBeDefined()
    expect(new Set(metering.models.map((m) => m.model)).size, 'each model once').toBe(metering.models.length)
    for (const m of metering.models) {
      expect(m.model.length).toBeGreaterThan(0)
      expectUsage(m.usage, m.model)
      if (m.costUsd !== undefined) expect(Number.isFinite(m.costUsd) && m.costUsd >= 0).toBe(true)
    }
    for (const key of COUNTS) {
      expect(metering.models.reduce((n, m) => n + (m.usage[key] ?? 0), 0), `${key} is the sum over models`).toBe(metering.usage![key] ?? 0)
    }
  }
  for (const limit of metering.limits ?? []) {
    expect(limit.window.length, 'a limit names its window').toBeGreaterThan(0)
    expect(['allowed', 'warning', 'rejected']).toContain(limit.status)
    expect(isTime(limit.observedAt), 'observedAt is an ISO time').toBe(true)
    if (limit.resetsAt !== undefined) expect(isTime(limit.resetsAt), 'resetsAt is an ISO time').toBe(true)
    if (limit.usedPercentage !== undefined) expect(limit.usedPercentage >= 0 && limit.usedPercentage <= 100).toBe(true)
  }
}

/** `make` returns the provider under test, wired to the scripted agent described above. */
export function agentRuntimeProviderConformance(name: string, make: () => AgentRuntimeProvider): void {
  describe(`agent runtime provider conformance: ${name}`, () => {
    const workspace = mkdtempSync(join(tmpdir(), 'system-agent-'))
    afterAll(() => rmSync(workspace, { recursive: true, force: true }))

    it('probes without running a task, and names the policies it can enforce', async () => {
      const evidence = await make().probe()
      expect(typeof evidence.available).toBe('boolean')
      expect(evidence.detail.length).toBeGreaterThan(0)
      expect(evidence.sandboxes.every((s) => s === 'read-only' || s === 'workspace-write')).toBe(true)
      // The scripted agent's test wires a working confinement, so a ready provider proves it (ADR-0024).
      expect(evidence.readsConfined).toBe(evidence.available)
    })

    it('runs a task to its terminal event and reports the native handle as soon as it exists', async () => {
      const handles: string[] = []
      const result = await make().run({ prompt: 'hello', workspace, sandbox: 'read-only' }, new AbortController().signal, (h) => handles.push(h))
      expect(result.text).toBe('echo: hello')
      expect(result.nativeHandle).toBe('h-1')
      expect(handles).toEqual(['h-1'])
    })

    it('reports what a run consumed consistently, or not at all: input includes its cached part, per-model counts sum to the totals, limit windows stay opaque (INV-11)', async () => {
      const result = await make().run({ prompt: 'hello', workspace, sandbox: 'read-only' }, new AbortController().signal)
      expectConsistentMetering(result)
    })

    it('refuses a policy it cannot enforce exactly, before running anything (never loosens)', async () => {
      const runtime = make()
      const supported = (await runtime.probe()).sandboxes
      for (const sandbox of ['read-only', 'workspace-write'] as const) {
        if (supported.includes(sandbox)) continue
        await expect(runtime.run({ prompt: 'x', workspace, sandbox }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
      }
      await expect(runtime.run({ prompt: 'x', workspace: 'relative/path', sandbox: 'read-only' }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
    })

    it('refuses a run with a tool gate it cannot ask before every tool call, before running anything (never ignores it)', async () => {
      const runtime = make()
      const evidence = await runtime.probe()
      expect(typeof evidence.gatesToolCalls).toBe('boolean')
      if (evidence.gatesToolCalls) return
      const asked: string[] = []
      const toolGate = async (call: { tool: string }) => {
        asked.push(call.tool)
        return { decision: 'deny' as const, reason: 'test' }
      }
      await expect(runtime.run({ prompt: 'x', workspace, sandbox: 'read-only', toolGate }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
      expect(asked).toEqual([])
    })

    it('reports its agent process and its activity consistently, or not at all: one process with a positive pid, activity times in order and within the run (PROP-0013)', async () => {
      const processes: Array<{ pid: number }> = []
      const activity: number[] = []
      const before = Date.now()
      await make().run({ prompt: 'hello', workspace, sandbox: 'read-only' }, new AbortController().signal, undefined, {
        onProcess: (p) => processes.push(p), onActivity: (at) => activity.push(at),
      })
      const after = Date.now()
      expect(processes.length, 'at most one agent process').toBeLessThanOrEqual(1)
      for (const p of processes) expect(Number.isInteger(p.pid) && p.pid > 0, 'a positive pid').toBe(true)
      for (let i = 0; i < activity.length; i++) {
        expect(activity[i]! >= before && activity[i]! <= after, 'within the run').toBe(true)
        if (i) expect(activity[i]!, 'in order').toBeGreaterThanOrEqual(activity[i - 1]!)
      }
      // An observer that throws changes nothing about the run.
      const result = await make().run({ prompt: 'hello', workspace, sandbox: 'read-only' }, new AbortController().signal, undefined, {
        onProcess: () => { throw new Error('observer') }, onActivity: () => { throw new Error('observer') },
      })
      expect(result.text).toBe('echo: hello')
    })

    it('stops when aborted and reports it as aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(make().run({ prompt: 'x', workspace, sandbox: 'read-only' }, controller.signal)).rejects.toMatchObject({ kind: 'aborted' })
    })

    it('refuses a run naming a home it does not run in, before running anything (never runs another account in its own home; ADR-0051)', async () => {
      const runtime = make()
      if ((await runtime.probe()).homes) {
        // One that runs in a named home still refuses a home that is not an absolute path.
        await expect(runtime.run({ prompt: 'x', workspace, sandbox: 'read-only', home: 'relative/home' }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
        return
      }
      await expect(runtime.run({ prompt: 'x', workspace, sandbox: 'read-only', home: workspace }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
    })
  })
}

/**
 * What a provider's test supplies to check its identity reader (ADR-0051): the provider wired to
 * its scripted agent, and a way to sign a home in as a scripted login (an opaque string, an email
 * here, which the harness writes where the reader reads it) and to sign it out.
 */
export interface IdentityHarness {
  make: () => AgentRuntimeProvider
  signIn: (home: string, login: string) => void | Promise<void>
  signOut: (home: string) => void | Promise<void>
}

/**
 * Conformance of a provider that reads who is signed in to a home (`identity`, `loginCommand`,
 * `RunSpec.home`; ADR-0051): one login gives one keyed hash across reads, a restart, and a re-login;
 * two logins two, another key another; a home it cannot read is never verified; nothing it returns
 * holds the principal; and its sign-in command names the home and no session bus.
 */
export function agentRuntimeIdentityConformance(name: string, harness: IdentityHarness): void {
  describe(`agent runtime identity conformance: ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'system-agent-homes-'))
    afterAll(() => rmSync(root, { recursive: true, force: true }))
    let n = 0
    const home = (): string => {
      const dir = join(root, `slot-${++n}`)
      mkdirSync(dir, { mode: 0o700 })
      return dir
    }
    const KEY = new Uint8Array(32).fill(7)
    const OTHER_KEY = new Uint8Array(32).fill(9)
    const verified = (reading: IdentityReading): Extract<IdentityReading, { status: 'verified' }> => {
      expect(reading.status, `verified: ${'reason' in reading ? reading.reason : ''}`).toBe('verified')
      return reading as Extract<IdentityReading, { status: 'verified' }>
    }
    const read = (runtime: AgentRuntimeProvider, at: string, key = KEY): Promise<IdentityReading> => {
      expect(runtime.identity, `${name} reads identity`).toBeTypeOf('function')
      return runtime.identity!(at, key)
    }

    it('reads one login as one keyed hash across reads, a restart, and a re-login, pinned to its reader and version', async () => {
      const at = home()
      await harness.signIn(at, 'alice@example.test')
      const first = verified(await read(harness.make(), at))
      expect(first.hmac).toMatch(/^[0-9a-f]{64}$/)
      expect(first.reader.length).toBeGreaterThan(0)
      expect(first.runtimeVersion.length).toBeGreaterThan(0)
      // A new provider stands for a restart; signing the same login in again for a re-login or a refreshed token.
      expect(verified(await read(harness.make(), at)).hmac).toBe(first.hmac)
      await harness.signIn(at, 'alice@example.test')
      expect(verified(await read(harness.make(), at)).hmac).toBe(first.hmac)
      expect(accountIdOf(harness.make().kind, first.hmac)).toBe(`${harness.make().kind}:${first.hmac.slice(0, 16)}`)
    })

    it('tells two logins apart, and finds one login in two homes as one, a duplicate the caller quarantines (REQ-ACC-1, REQ-ACC-7)', async () => {
      const [a, b, c] = [home(), home(), home()]
      await harness.signIn(a, 'alice@example.test')
      await harness.signIn(b, 'bob@example.test')
      await harness.signIn(c, 'alice@example.test')
      const runtime = harness.make()
      const [ha, hb, hc] = [verified(await read(runtime, a)).hmac, verified(await read(runtime, b)).hmac, verified(await read(runtime, c)).hmac]
      expect(ha).not.toBe(hb)
      expect(hc).toBe(ha)
    })

    it('keys the hash: another install key gives another hash for the same login', async () => {
      const at = home()
      await harness.signIn(at, 'alice@example.test')
      const runtime = harness.make()
      expect(verified(await read(runtime, at, OTHER_KEY)).hmac).not.toBe(verified(await read(runtime, at)).hmac)
    })

    it('never verifies a home it cannot read: signed out, never signed in, or not there (REQ-ACC-11, INV-2)', async () => {
      const runtime = harness.make()
      const out = home()
      await harness.signIn(out, 'alice@example.test')
      await harness.signOut(out)
      for (const at of [out, home(), join(root, 'absent')]) {
        const reading = await read(runtime, at)
        expect(reading.status, at).not.toBe('verified')
        expect('reason' in reading && reading.reason.length > 0, 'it says why').toBe(true)
      }
    })

    it('returns no principal: only the keyed hash and a masked hint leave it (INV-8)', async () => {
      const at = home()
      await harness.signIn(at, 'carol.secret@example.test')
      const reading = verified(await read(harness.make(), at))
      expect(JSON.stringify(reading)).not.toMatch(/carol\.secret/)
      if (reading.hint !== undefined) expect(reading.hint).toBe(maskEmail('carol.secret@example.test'))
    })

    it('gives the sign-in command for a home: it names the home, and sets no session bus', () => {
      const runtime = harness.make()
      expect(runtime.loginCommand, `${name} gives its sign-in command`).toBeTypeOf('function')
      const at = join(root, 'login-home')
      const login = runtime.loginCommand!(at)
      expect(login.command.length).toBeGreaterThan(0)
      expect([...login.args, ...Object.values(login.env)].some((value) => value.includes(at)), 'the home is named').toBe(true)
      expect(Object.keys(login.env)).not.toContain('DBUS_SESSION_BUS_ADDRESS')
    })

    it('runs in the home a run names, and probes a named home only through probeIn (ADR-0051)', async () => {
      const runtime = harness.make()
      expect((await runtime.probe()).homes).toBe(true)
      const at = home()
      await harness.signIn(at, 'alice@example.test')
      expect((await probeIn(runtime, at)).available).toBe(true)
      expect((await probeIn(runtime, 'relative/home')).available).toBe(false)
      const result = await runtime.run({ prompt: 'hello', workspace: root, sandbox: 'read-only', home: at }, new AbortController().signal)
      expect(result.text).toBe('echo: hello')
    })
  })
}

/**
 * A fake agent runtime with scripted homes (ADR-0051), for the suites above and for consumers' tests:
 * a home is signed in when it holds `fake-login.json` (`{ "user": <login> }`, written by
 * {@link FakeAgentRuntime.signIn}); its reader is verified on `version` only. It answers a run with
 * `echo: <prompt>` and the handle `h-1`, runs read-only only, and gates tool calls.
 */
export class FakeAgentRuntime implements AgentRuntimeProvider {
  static readonly FILE = 'fake-login.json'
  static readonly VERIFIED = ['1.0.0']

  /** `home`: its own configured home, which a Worker source adopts as slot 1 (optional, as on the seam). */
  constructor(readonly kind = 'fake-runtime', private readonly version = '1.0.0', readonly home?: string) {}

  static signIn(home: string, login: string): void {
    writeFileSync(join(home, FakeAgentRuntime.FILE), JSON.stringify({ user: login }), { mode: 0o600 })
  }

  static signOut(home: string): void {
    rmSync(join(home, FakeAgentRuntime.FILE), { force: true })
  }

  async probe(options: ProbeOptions = {}): Promise<RuntimeEvidence> {
    const base: RuntimeEvidence = { available: true, detail: `fake ${this.version}`, version: this.version, sandboxes: ['read-only'], resume: false, executes: false, readsConfined: true, gatesToolCalls: true, homes: true }
    if (options.home === undefined) return base
    const user = this.user(options.home)
    return user ? base : { ...base, available: false, detail: `${options.home} is not signed in` }
  }

  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void, observer?: RunObserver): Promise<RunResult> {
    const refuse = (message: string): Error => Object.assign(new Error(`${this.kind}: ${message}`), { kind: 'config_error' })
    if (!isAbsolute(spec.workspace)) throw refuse('the workspace must be an absolute path')
    if (spec.sandbox !== 'read-only') throw refuse(`only read-only is offered, not ${spec.sandbox}`)
    if (spec.home !== undefined && (!isAbsolute(spec.home) || !existsSync(spec.home))) throw refuse(`the home ${spec.home} is not an existing absolute path`)
    if (signal.aborted) throw Object.assign(new Error(`${this.kind}: aborted`), { kind: 'aborted' })
    // It starts no process of its own, so it reports none: only its activity (PROP-0013).
    observe(observer, { activity: Date.now() })
    onHandle?.('h-1')
    return { text: `echo: ${spec.prompt}`, nativeHandle: 'h-1' }
  }

  async identity(home: string, key: Uint8Array): Promise<IdentityReading> {
    const reader = 'fake-login-file'
    if (!FakeAgentRuntime.VERIFIED.includes(this.version)) return { status: 'unverified', reason: `no reader is verified for version ${this.version}`, reader, runtimeVersion: this.version }
    if (!existsSync(join(home, FakeAgentRuntime.FILE))) return { status: 'missing', reason: 'the home holds no sign-in', reader, runtimeVersion: this.version }
    const user = this.user(home)
    if (!user) return { status: 'ambiguous', reason: 'the sign-in names no user', reader, runtimeVersion: this.version }
    const hint = maskEmail(user)
    return { status: 'verified', hmac: identityHmac(key, this.kind, { user }), reader, runtimeVersion: this.version, ...(hint ? { hint } : {}) }
  }

  loginCommand(home: string): LoginCommand {
    return { command: 'fake-login', args: ['--home', home], env: { FAKE_HOME: home } }
  }

  /** The signed-in user of a home, or undefined when it holds none, or none whole. */
  private user(home: string): string | undefined {
    try {
      const user = (JSON.parse(readFileSync(join(home, FakeAgentRuntime.FILE), 'utf8')) as { user?: unknown }).user
      return typeof user === 'string' && user.length ? user : undefined
    } catch {
      return undefined
    }
  }
}
