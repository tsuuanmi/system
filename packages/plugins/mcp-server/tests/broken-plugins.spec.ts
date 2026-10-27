import { Context, Service } from '@deepseek-ai/cordis'
import type { PluginRecord } from '@tsuuanmi/system-plugin-host-core'
import { describe, expect, it, onTestFinished } from 'vitest'
import { brokenPlugins } from '../src/index.ts'

/** A plugin host that lists `records`, as the real one lists its composition (T325). */
class Host extends Service {
  static records: PluginRecord[] = []
  constructor(ctx: Context) {
    super(ctx, 'pluginHost')
  }
  list(): PluginRecord[] {
    return Host.records
  }
}

const provider = (seam: string, mounted: boolean, consumes: string[] = []): PluginRecord => ({
  name: `@x/${seam}`, rows: [seam], mounted, manifestState: 'valid',
  manifest: { schema: 'plugin-manifest@1.1', name: `@x/${seam}`, version: '1.0.0', class: { kind: 'family', family: 'surface' }, provides: [{ seam, version: '1.0' }], consumes: consumes.map((seam) => ({ seam, range: '^1.0' })), license: 'MIT' },
})

async function compose(records: PluginRecord[], waiting: Record<string, string[]>): Promise<Context> {
  Host.records = records
  const ctx = new Context()
  const host = ctx.plugin(Host)
  await host
  const fibers: Array<{ dispose(): unknown }> = [host]
  for (const [name, inject] of Object.entries(waiting)) fibers.push(ctx.plugin({ name, inject, apply: () => undefined } as never, {} as never))
  onTestFinished(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  return ctx
}

describe('brokenPlugins: a plugin waiting for a service (T325)', () => {
  it('is off, with its reason, when the only service it waits for is provided by a row that is off', async () => {
    const ctx = await compose([provider('accounts', false)], { Login: ['accounts'] })
    expect(brokenPlugins(ctx)).toEqual([{ name: 'Login', state: 'off', detail: 'waits for service accounts, whose row is off' }])
  })

  it('is off when the row that provides its service is on but waits for a row that is off (display, browser, Login)', async () => {
    const ctx = await compose([provider('display', false), provider('browser', true, ['display'])], { Login: ['browser'] })
    expect(brokenPlugins(ctx)).toEqual([{ name: 'Login', state: 'off', detail: 'waits for service browser, whose row is off' }])
  })

  it('is down when no row provides the service it waits for (INV-2)', async () => {
    const ctx = await compose([provider('accounts', false)], { Login: ['ghost'] })
    expect(brokenPlugins(ctx)).toEqual([{ name: 'Login', state: 'pending', detail: 'waiting for service ghost' }])
  })

  it('is down when the row that provides the service is on, and has not provided it (INV-2)', async () => {
    const ctx = await compose([provider('accounts', true)], { Login: ['accounts'] })
    expect(brokenPlugins(ctx)).toEqual([{ name: 'Login', state: 'pending', detail: 'waiting for service accounts' }])
  })

  it('is down when it waits for one service whose row is off and one no row provides', async () => {
    const ctx = await compose([provider('accounts', false)], { Login: ['accounts', 'ghost'] })
    expect(brokenPlugins(ctx)).toEqual([{ name: 'Login', state: 'pending', detail: 'waiting for service accounts, ghost' }])
  })
})
