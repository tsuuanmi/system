/**
 * Registers the Gemini Web driver on `ctx.providers` (sign-in only so far; see driver.ts).
 * @module @tsuuanmi/system-provider-gemini-web
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GeminiWebDriver } from './driver.ts'

export { GeminiWebDriver, shippedMap } from './driver.ts'

export interface Config {
  /** Site origin (default https://gemini.google.com); tests point it at a local fake. */
  origin?: string
}

export const name = 'provider-gemini-web'
export const inject = ['providers']
export const Config: z<Config> = z.object({
  origin: z.string().description('Site origin (default https://gemini.google.com)'),
})

export function apply(ctx: Context, config: Config = {}): void {
  ctx.providers.register(new GeminiWebDriver(config.origin ? { origin: config.origin } : {}))
}
