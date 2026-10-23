import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import { PLUGIN_HOST_CONTRACT } from '@tsuuanmi/system-plugin-host-core'
import Store from '@tsuuanmi/system-store'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { pluginHostSuite } from '../../../plugin-host-core/conformance/plugin-host.ts'
import StorePluginHost from '../src/index.ts'
import { install, stubLoader } from './composition.ts'

// The store-backed provider, reading its rows from a loader and each manifest from its package's directory.
runSuite(pluginHostSuite, {
  name: '@tsuuanmi/system-plugin-host',
  contract: PLUGIN_HOST_CONTRACT,
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-plugin-host-conformance-'))
    const profile = join(dir, 'profile')
    let fibers: Array<ReturnType<Context['plugin']>> = []
    const stop = async (): Promise<void> => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      fibers = []
    }
    return {
      start: async (composition) => {
        await stop()
        install(profile, composition.packages)
        const ctx = new Context()
        const loader = stubLoader(profile, composition.rows)
        fibers = [
          ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}),
          ctx.plugin({ name: 'loader', apply: (c: Context) => void c.provide('loader', loader) }),
          ctx.plugin(StorePluginHost, { allowWithoutManifest: composition.allowWithoutManifest ?? [] }),
        ]
        await Promise.all(fibers)
        return ctx
      },
      dispose: async () => {
        await stop()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})
