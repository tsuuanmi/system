/**
 * `display-virtual`: the Linux provider of `ctx.display` (docs/design/browser-runtime.md
 * #display-modes-ctxdisplay). Invisible mode is headed Chrome on one plugin-owned Xvfb,
 * shared by every browser of the profile and health-monitored: when it dies, the
 * prepared display's `lost` signal aborts and the next `prepare` starts a new
 * generation. It fails closed: no headless mode and no fallback to the operator's screen.
 * @module @tsuuanmi/system-display-virtual
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Display, type PreparedDisplay, ProviderError } from '@tsuuanmi/system-provider-core'
import { type SpawnXvfb, type XvfbHandle, startXvfb } from './xvfb.ts'

export { type SpawnXvfb, type XvfbExit, type XvfbHandle, type XvfbOptions, startXvfb } from './xvfb.ts'

export interface Config {
  /** Xvfb executable (default `Xvfb` on PATH). */
  xvfbPath?: string
  /** How long Xvfb may take to report its display (default 5 s). */
  startupTimeoutMs?: number
  /** Per-signal wait when stopping Xvfb (default 2 s). */
  shutdownTimeoutMs?: number
}

interface Active {
  xvfb: XvfbHandle
  prepared: PreparedDisplay
  lost: AbortController
}

export class VirtualDisplay extends Display {
  static Config: z<Config> = z.object({
    xvfbPath: z.string().default('Xvfb').description('Xvfb executable'),
    startupTimeoutMs: z.natural().default(5000).description('Xvfb startup timeout in milliseconds'),
    shutdownTimeoutMs: z.natural().default(2000).description('Per-signal wait when stopping Xvfb, in milliseconds'),
  })

  /** Overridable in tests. */
  protected platform: NodeJS.Platform = process.platform
  protected spawnXvfb: SpawnXvfb | undefined = undefined

  private active: Active | undefined
  private starting: Promise<PreparedDisplay> | undefined
  private generation = 0
  private disposed = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    ctx.effect(() => async () => {
      this.disposed = true
      await this.starting?.catch(() => undefined)
      const active = this.active
      this.active = undefined
      if (!active) return
      active.lost.abort(new ProviderError('session_broken', 'virtual display stopped'))
      await active.xvfb.stop()
    })
  }

  protected prepareInvisible(): Promise<PreparedDisplay> {
    if (this.disposed) return Promise.reject(new ProviderError('session_broken', 'display-virtual is disposed'))
    if (this.platform !== 'linux') {
      return Promise.reject(new ProviderError('config_error', 'display-virtual runs on Linux only; this platform needs an off-screen display provider'))
    }
    if (this.active) return Promise.resolve(this.active.prepared)
    this.starting ??= this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async start(): Promise<PreparedDisplay> {
    const xvfb = await startXvfb({
      executable: this.config.xvfbPath ?? 'Xvfb',
      startupTimeoutMs: this.config.startupTimeoutMs ?? 5000,
      shutdownTimeoutMs: this.config.shutdownTimeoutMs ?? 2000,
      ...(this.spawnXvfb ? { spawn: this.spawnXvfb } : {}),
    })
    const lost = new AbortController()
    const prepared: PreparedDisplay = {
      kind: 'virtual',
      env: { DISPLAY: xvfb.display, XAUTHORITY: xvfb.authority },
      windowArgs: ['--window-size=1920,1080'],
      viewport: null,
      generation: ++this.generation,
      lost: lost.signal,
    }
    const active: Active = { xvfb, prepared, lost }
    this.active = active
    void xvfb.exited.then(({ code, signal }) => {
      if (this.active === active) this.active = undefined
      lost.abort(new ProviderError('session_broken', `Xvfb ${xvfb.display} exited (code ${String(code)}, signal ${String(signal)})`))
    })
    if (this.disposed) {
      // Disposal raced the startup: the disposer stops whatever `active` holds.
      return Promise.reject(new ProviderError('session_broken', 'display-virtual is disposed'))
    }
    return prepared
  }
}

export default VirtualDisplay
