/**
 * Conformance suites for `ctx.agentRuntimes` (plugin rule 7): one for the registry, one for
 * every provider. A provider's test supplies it wired to a scripted agent that answers with
 * the prompt it received (`echo: <prompt>`) and reports the native handle `h-1`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentRuntimeProvider } from '../src/index.ts'

const provider = (kind: string): AgentRuntimeProvider => ({
  kind,
  probe: async () => ({ available: true, detail: 'test', sandboxes: ['read-only'], resume: false }),
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
    })

    it('runs a task to its terminal event and reports the native handle as soon as it exists', async () => {
      const handles: string[] = []
      const result = await make().run({ prompt: 'hello', workspace, sandbox: 'read-only' }, new AbortController().signal, (h) => handles.push(h))
      expect(result.text).toBe('echo: hello')
      expect(result.nativeHandle).toBe('h-1')
      expect(handles).toEqual(['h-1'])
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

    it('stops when aborted and reports it as aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(make().run({ prompt: 'x', workspace, sandbox: 'read-only' }, controller.signal)).rejects.toMatchObject({ kind: 'aborted' })
    })
  })
}
