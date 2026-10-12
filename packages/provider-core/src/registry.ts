/**
 * The `ctx.providers` seam: the provider driver registry (ADR-0005). Driver plugins register
 * for their own lifetime; the runtime looks drivers up by provider name and never branches on
 * it. `@tsuuanmi/system-providers` provides it.
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type { ProviderDriver } from './driver.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    providers: ProviderRegistry
  }
}

export abstract class ProviderRegistry extends Service {
  constructor(ctx: Context) {
    super(ctx, 'providers')
  }

  /** Register a driver for the calling plugin's lifetime; a provider name is unique. */
  abstract register(driver: ProviderDriver): void
  /** The driver for `provider`, or a `config_error`. */
  abstract get(provider: string): ProviderDriver
  /** Registered provider names. */
  abstract list(): string[]
}
