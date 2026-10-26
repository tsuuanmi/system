/** Conformance suite for `ctx.providers` (plugin rule 7). */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ProviderDriver } from '../src/driver.ts'
import { ProviderError } from '../src/errors.ts'
import type {} from '../src/registry.ts'

const driver = (provider: string): ProviderDriver => ({
  provider, capabilities: ['reason'], loginUrl: 'https://example.test/login', stateOrigins: ['https://example.test'],
  checkAuth: async () => 'signed-in', identity: async () => 'id', ask: async () => ({ text: '', binding: undefined, mode: {} }),
  snapshot: async () => ({ text: '', running: false }),
})

/** `plugin` provides `ctx.providers` with no required config. */
export function providerRegistryConformance(name: string, plugin: Parameters<Context['plugin']>[0]): void {
  describe(`ctx.providers conformance: ${name}`, () => {
    it('registers for the contributing plugin\'s lifetime only', async () => {
      const ctx = new Context()
      await ctx.plugin(plugin)
      const fiber = ctx.plugin({ inject: ['providers'], apply: (c: Context) => c.providers.register(driver('a')) })
      await fiber
      expect(ctx.providers.list()).toEqual(['a'])
      expect(ctx.providers.get('a').provider).toBe('a')
      await fiber.dispose()
      expect(ctx.providers.list()).toEqual([])
    })

    it('refuses a duplicate name and fails closed on an unknown provider', async () => {
      const ctx = new Context()
      await ctx.plugin(plugin)
      ctx.providers.register(driver('a'))
      expect(() => ctx.providers.register(driver('a'))).toThrow()
      expect(() => ctx.providers.get('missing')).toThrow(ProviderError)
    })

    it('hands a driver\'s checkAuth the optional save option a Save gives, and keeps a driver that takes none (additive, ADR-0036)', async () => {
      const ctx = new Context()
      await ctx.plugin(plugin)
      const seen: unknown[] = []
      // A driver that reads a Save's check apart from a turn's, and one written before the option.
      ctx.providers.register({ ...driver('a'), checkAuth: async (_page, options) => (seen.push(options), options?.save ? 'signed-in' : 'unknown') })
      ctx.providers.register(driver('b'))
      expect(await ctx.providers.get('a').checkAuth({}, { save: true })).toBe('signed-in')
      expect(await ctx.providers.get('a').checkAuth({})).toBe('unknown')
      expect(seen).toEqual([{ save: true }, undefined])
      expect(await ctx.providers.get('b').checkAuth({}, { save: true })).toBe('signed-in')
    })
  })
}
