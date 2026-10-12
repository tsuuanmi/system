import { Context } from '@deepseek-ai/cordis'
import { ProviderError, type ProviderDriver } from '@tsuuanmi/system-provider-core'
import { describe, expect, it } from 'vitest'
import Providers from '../src/index.ts'

const driver = (provider: string): ProviderDriver => ({
  provider, capabilities: ['reason'], loginUrl: 'https://example.test/login', stateOrigins: ['https://example.test'],
  checkAuth: async () => 'signed-in', identity: async () => 'user-1', ask: async () => ({ text: 'ok', binding: undefined, mode: {} }), snapshot: async () => ({ text: '', running: false }),
})

describe('ctx.providers', () => {
  it('registers drivers from plugins and removes them when the plugin unloads (INV-10)', async () => {
    const ctx = new Context()
    await ctx.plugin(Providers)
    const fiber = ctx.plugin({ inject: ['providers'], apply: (c: Context) => { c.providers.register(driver('site-a')) } })
    await fiber
    expect(ctx.providers.list()).toEqual(['site-a'])
    expect(ctx.providers.get('site-a').provider).toBe('site-a')
    await fiber.dispose()
    expect(ctx.providers.list()).toEqual([])
  })

  it('refuses duplicates and fails closed on an unknown provider', async () => {
    const ctx = new Context()
    await ctx.plugin(Providers)
    ctx.providers.register(driver('site-a'))
    expect(() => ctx.providers.register(driver('site-a'))).toThrow(/already registered/)
    expect(() => ctx.providers.get('nope')).toThrow(ProviderError)
  })
})

const { providerRegistryConformance } = await import('../../../provider-core/conformance/providers.ts')
providerRegistryConformance('providers', Providers)
