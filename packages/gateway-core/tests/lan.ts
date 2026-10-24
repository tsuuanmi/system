/**
 * Test-only: a `ctx.webServer` bound to a LAN address over plain HTTP, as an operator could
 * configure it, for the tests that show a token-gated endpoint registers nothing there (its tokens
 * would cross the network in clear text, QA-5). It keeps every route a plugin registers on it.
 */
import { type Context, Service } from '@deepseek-ai/cordis'

export function lanWebServer(): { LanWebServer: new (ctx: Context) => Service; routes: unknown[] } {
  const routes: unknown[] = []
  class LanWebServer extends Service {
    protocol = 'http:'
    host = '192.0.2.10'
    port = 47317
    constructor(ctx: Context) { super(ctx, 'webServer') }
    register(route: unknown): () => void {
      routes.push(route)
      return () => undefined
    }
  }
  return { LanWebServer, routes }
}
