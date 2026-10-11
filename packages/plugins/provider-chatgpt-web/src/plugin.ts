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
import { ChatGptWebDriver } from './driver.ts'

export interface Config {
  /** Site origin (default https://chatgpt.com); tests point it at a local fake. */
  origin?: string
  /** Local overlay file (default `<DSH_HOME>/system/ui/chatgpt-web.overlay.yaml`). */
  overlayPath?: string
}

export const name = 'provider-chatgpt-web'
export const inject = ['providers']
export const Config: z<Config> = z.object({
  origin: z.string().description('Site origin (default https://chatgpt.com)'),
  overlayPath: z.string().description('Local UI overlay file'),
})

export function apply(ctx: Context, config: Config = {}): void {
  const overlayPath = config.overlayPath ?? join(dshHome(), 'system', 'ui', 'chatgpt-web.overlay.yaml')
  const overlay = existsSync(overlayPath) ? readFileSync(overlayPath, 'utf8') : undefined
  ctx.providers.register(new ChatGptWebDriver({
    ...(config.origin ? { origin: config.origin } : {}),
    ...(overlay ? { overlay } : {}),
  }))
}
