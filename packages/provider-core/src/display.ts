/**
 * The `ctx.display` seam (docs/design/browser-runtime.md#display-modes-ctxdisplay):
 * where a headed browser draws. Provider turns always ask for `invisible`, which a
 * provider plugin implements (Xvfb on Linux, an off-screen window elsewhere); it never
 * means headless and never falls back to the operator's screen. `visible` is the
 * operator's own `DISPLAY`, for login and debugging, and is the same for every provider.
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import { ProviderError } from './errors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    display: Display
  }
}

export type DisplayMode = 'invisible' | 'visible'

export interface PreparedDisplay {
  kind: 'virtual' | 'offscreen' | 'visible'
  /** Environment overrides for the browser process, e.g. `{ DISPLAY: ':7' }`. */
  env: Record<string, string>
  /** Window flags; an invisible window keeps an explicit size and is never minimized. */
  windowArgs: string[]
  /** A fixed viewport, or `null` to use the window's natural one. */
  viewport: { width: number; height: number } | null
  /** Increments each time the provider replaces a lost display. */
  generation: number
  /** Aborts (with a `session_broken` reason) when this display dies: browsers on it must close. */
  lost: AbortSignal
}

const NEVER_LOST = new AbortController().signal

export abstract class Display extends Service {
  constructor(ctx: Context) {
    super(ctx, 'display')
  }

  async prepare(mode: DisplayMode): Promise<PreparedDisplay> {
    return mode === 'visible' ? this.visible() : await this.prepareInvisible()
  }

  /** A headed display the operator cannot see; must fail closed rather than become visible. */
  protected abstract prepareInvisible(): Promise<PreparedDisplay>

  private visible(): PreparedDisplay {
    const display = process.env.DISPLAY
    if (!display) {
      throw new ProviderError('config_error', 'visible mode needs a DISPLAY the operator can see: use a desktop, SSH X11 forwarding, or the remote login view')
    }
    return { kind: 'visible', env: { DISPLAY: display }, windowArgs: ['--window-size=1280,900'], viewport: { width: 1280, height: 900 }, generation: 0, lost: NEVER_LOST }
  }
}
