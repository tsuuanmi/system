/**
 * Conformance suites for `ctx.agentRuntimes` (plugin rule 7): one for the registry, one for
 * every provider. A provider's test supplies it wired to a scripted agent that answers with
 * the prompt it received (`echo: <prompt>`) and reports the native handle `h-1`. A provider
 * whose agent reports what it consumed has the scripted agent report it too, so the suite checks
 * it; one that reports nothing passes as it is.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentRuntimeProvider, RunMetering, TokenUsage } from '../src/index.ts'

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

    it('stops when aborted and reports it as aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(make().run({ prompt: 'x', workspace, sandbox: 'read-only' }, controller.signal)).rejects.toMatchObject({ kind: 'aborted' })
    })
  })
}
