/**
 * Registers the Gemini Web driver on `ctx.providers` (see driver.ts).
 * @module @tsuuanmi/system-provider-gemini-web
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-artifacts'
import type {} from '@tsuuanmi/system-event-log'
import type { ProviderMode } from '@tsuuanmi/system-provider-core'
import { driftData } from '@tsuuanmi/system-ui-ops'
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
  /**
   * The longest prompt sent, in characters: a longer one is refused before anything is sent.
   * Observed, not published: the site drops a paste of about 30,000 characters or more without an error.
   */
  maxPromptChars?: number
  /** The account's page opens (turns, checks, deletions) are spaced at least this far apart, in milliseconds (default 10 s, at most 10 min); navigations within a page are not. */
  pageGapMs?: number
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
  maxPromptChars: z.natural().min(1).default(30_000).description('The longest prompt sent, in characters; a longer one is refused before anything is sent (observed, not published: the site drops longer pastes without an error)'),
  pageGapMs: z.natural().max(600_000).default(10_000).description('Minimum gap between the opens of the account\'s pages in its login profile, in milliseconds, at most 10 min (ADR-0030); navigations within a page are not spaced'),
})

export function apply(ctx: Context, config: Config = {}): void {
  const driver = new GeminiWebDriver({
    ...(config.origin ? { origin: config.origin } : {}),
    modes: config.modes ?? DEFAULT_MODES,
    defaultMode: config.defaultMode ?? 'flash',
    maxPromptChars: config.maxPromptChars ?? 30_000,
    pageGapMs: config.pageGapMs ?? 10_000,
  })
  // A stale element, with the outline of its region as local-private evidence (docs/design/ui-operations.md#drift-evidence).
  driver.onDrift = (e) => ctx.get('eventLog')?.append({ type: 'ui.drift', data: driftData(e, ctx.get('artifacts')) })
  ctx.providers.register(driver)
}
