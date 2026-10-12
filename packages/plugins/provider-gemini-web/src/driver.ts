/**
 * The Gemini Web driver (provider `gemini-web`), sign-in only so far: an operator can sign a
 * Google account in through the remote login desktop and save it, and the account's page can be
 * read to build the rest of the UI map. It proves no routing capability yet, so no Worker
 * serves work from it; asking fails closed.
 */
import { readFileSync } from 'node:fs'
import { type AskResult, type AuthState, type ProviderDriver, ProviderError, type TurnSnapshot } from '@tsuuanmi/system-provider-core'
import { UiEngine, type UiMap, loadUiMap } from '@tsuuanmi/system-ui-ops'
import type { Page } from 'patchright-core'

const MAP_URL = new URL('../ui/gemini-web.ui.yaml', import.meta.url)

/** The shipped map, with an optional local overlay merged after it. */
export function shippedMap(overlay?: string): UiMap {
  return loadUiMap(readFileSync(MAP_URL, 'utf8'), overlay)
}

export interface DriverOptions {
  /** Site origin (default https://gemini.google.com); tests point it at a local fake. */
  origin?: string
  overlay?: string
  readyMs?: number
}

export class GeminiWebDriver implements ProviderDriver<Page> {
  readonly provider = 'gemini-web'
  /** Nothing is proven yet: Workers on this provider are not admitted for any work. */
  readonly capabilities = [] as const
  readonly loginUrl: string
  /** Google's sign-in lives on google.com; Gemini on its own subdomain. */
  readonly stateOrigins: readonly string[]
  private readonly map: UiMap
  private readonly origin: string

  constructor(private readonly options: DriverOptions = {}) {
    this.map = shippedMap(options.overlay)
    this.origin = (options.origin ?? 'https://gemini.google.com').replace(/\/$/, '')
    this.loginUrl = `${this.origin}/app`
    this.stateOrigins = options.origin ? [this.origin] : ['https://gemini.google.com', 'https://accounts.google.com', 'https://www.google.com', 'https://google.com']
  }

  async checkAuth(page: Page): Promise<AuthState> {
    if (!page.url().startsWith(this.origin)) await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' })
    const engine = new UiEngine(page, this.map, { heal: false })
    try {
      await engine.waitFor({ anyOf: [{ state: 'auth.signed-in' }, { state: 'auth.signed-out' }] }, this.options.readyMs ?? 30_000)
    } catch {
      return 'unknown'
    }
    return (await engine.state('auth.signed-out')) ? 'signed-out' : 'signed-in'
  }

  /** The account named on its own Google Account button; only a hash of it is ever stored. */
  async identity(page: Page): Promise<string> {
    const engine = new UiEngine(page, this.map, { heal: false })
    const label = await (await engine.resolve('auth.account', this.options.readyMs ?? 30_000)).locator.first().getAttribute('aria-label')
    if (!label) throw new ProviderError('session_broken', 'gemini-web: the account button has no name')
    return label.replace(/^Google Account:\s*/, '').trim()
  }

  async ask(): Promise<AskResult> {
    throw new ProviderError('config_error', 'gemini-web: conversations are not built yet (sign-in only)')
  }

  async snapshot(): Promise<TurnSnapshot> {
    throw new ProviderError('config_error', 'gemini-web: conversations are not built yet (sign-in only)')
  }
}
