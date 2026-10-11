/**
 * Registers the ChatGPT Web driver on `ctx.providers`. The local overlay of healed
 * candidates is read from `<DSH_HOME>/system/ui/chatgpt-web.overlay.yaml` when present.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHome } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-providers'
import type { ProviderMode } from '@tsuuanmi/system-provider-core'
import { ChatGptWebDriver } from './driver.ts'

export interface Config {
  /** Site origin (default https://chatgpt.com); tests point it at a local fake. */
  origin?: string
  /** Local overlay file (default `<DSH_HOME>/system/ui/chatgpt-web.overlay.yaml`). */
  overlayPath?: string
  /**
   * Named mode presets: a model and a Power level as the site names them (models seen on
   * 2026-10-12: Latest, GPT-6, GPT-5.6 Sol, GPT-5.5; levels: Instant, Medium, High). Account
   * catalogs map tiers to these names.
   */
  modes?: Record<string, ProviderMode>
  /** Preset for turns whose tier maps to no preset. */
  defaultMode?: string
}

const DEFAULT_MODES: Record<string, ProviderMode> = {
  instant: { model: 'Latest', effort: 'Instant' },
  medium: { model: 'Latest', effort: 'Medium' },
  high: { model: 'Latest', effort: 'High' },
}

export const name = 'provider-chatgpt-web'
export const inject = ['providers']
export const Config: z<Config> = z.object({
  origin: z.string().description('Site origin (default https://chatgpt.com)'),
  overlayPath: z.string().description('Local UI overlay file'),
  modes: z.dict(z.object({ model: z.string(), effort: z.string() })).default(DEFAULT_MODES).description('Named mode presets (model and Power level)'),
  defaultMode: z.string().default('instant').description('Preset for turns whose tier maps to no preset'),
})

export function apply(ctx: Context, config: Config = {}): void {
  const overlayPath = config.overlayPath ?? join(dshHome(), 'system', 'ui', 'chatgpt-web.overlay.yaml')
  const overlay = existsSync(overlayPath) ? readFileSync(overlayPath, 'utf8') : undefined
  ctx.providers.register(new ChatGptWebDriver({
    ...(config.origin ? { origin: config.origin } : {}),
    ...(overlay ? { overlay } : {}),
    modes: config.modes ?? DEFAULT_MODES,
    defaultMode: config.defaultMode ?? 'instant',
  }))
}
