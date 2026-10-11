/**
 * `ctx.providers`: the provider driver registry (docs/architecture/plugin-model.md#seam-catalog).
 * Driver plugins register on load and are removed on unload; the runtime looks drivers up
 * by the account's provider name and never branches on it (ADR-0005).
 * @module @tsuuanmi/system-providers
 */
import type { Context } from '@deepseek-ai/cordis'
import { ProviderError, type ProviderDriver, ProviderRegistry } from '@tsuuanmi/system-provider-core'

export class Providers extends ProviderRegistry {
  private readonly drivers = new Map<string, ProviderDriver>()

  constructor(ctx: Context) {
    super(ctx)
  }

  /** Register a driver for the calling plugin's lifetime. */
  register(driver: ProviderDriver): void {
    if (this.drivers.has(driver.provider)) throw new Error(`provider ${driver.provider} is already registered`)
    this.ctx.effect(() => {
      this.drivers.set(driver.provider, driver)
      return () => {
        if (this.drivers.get(driver.provider) === driver) this.drivers.delete(driver.provider)
      }
    })
  }

  get(provider: string): ProviderDriver {
    const driver = this.drivers.get(provider)
    if (!driver) throw new ProviderError('config_error', `no driver is registered for provider ${provider}`)
    return driver
  }

  list(): string[] {
    return [...this.drivers.keys()]
  }
}

export default Providers
