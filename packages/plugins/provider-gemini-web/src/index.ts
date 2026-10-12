/**
 * Registers the Gemini Web driver on `ctx.providers` (see driver.ts).
 * @module @tsuuanmi/system-provider-gemini-web
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ProviderMode } from '@tsuuanmi/system-provider-core'
import { GeminiWebDriver } from './driver.ts'

export { GeminiWebDriver, shippedMap } from './driver.ts'

export interface Config {
  /** Site origin (default https://gemini.google.com); tests point it at a local fake. */
  origin?: string
  /**
   * Named mode presets: a model and a thinking level as the site names them (seen on
   * 2026-10-12: models 3.5 Flash-Lite, 3.8 Flash, 3.1 Pro; levels Low, Medium, High). A model
   * may be named without its version. Account catalogs map tiers to these names.
   */
  modes?: Record<string, ProviderMode>
  /** Preset when a caller names none (the turn runtime always names its Worker's preset). */
  defaultMode?: string
}

const DEFAULT_MODES: Record<string, ProviderMode> = {
  'flash-lite': { model: 'Flash-Lite', effort: 'Low' },
  flash: { model: 'Flash', effort: 'Medium' },
  pro: { model: 'Pro', effort: 'High' },
  // An account without the mode picker: nothing is selected, and nothing is assumed.
  site: {},
}

export const name = 'provider-gemini-web'
export const inject = ['providers']
export const Config: z<Config> = z.object({
  origin: z.string().description('Site origin (default https://gemini.google.com)'),
  modes: z.dict(z.object({ model: z.string(), effort: z.string() })).default(DEFAULT_MODES).description('Named mode presets (model and thinking level); an empty preset selects nothing'),
  defaultMode: z.string().default('flash').description('Preset when a caller names none'),
})

export function apply(ctx: Context, config: Config = {}): void {
  ctx.providers.register(new GeminiWebDriver({
    ...(config.origin ? { origin: config.origin } : {}),
    modes: config.modes ?? DEFAULT_MODES,
    defaultMode: config.defaultMode ?? 'flash',
  }))
}
