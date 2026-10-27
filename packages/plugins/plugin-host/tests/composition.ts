import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Composition } from '../../../plugin-host-core/conformance/plugin-host.ts'
import type { LoaderEntry, LoaderView } from '../src/index.ts'

/** A row of a {@link liveLoader}: the plugin it runs when on, and its configuration as the loader holds it. */
export interface LiveRow { id: string; name: string; mounted: boolean; plugin?: unknown; config?: Record<string, unknown> }

/**
 * A loader whose entries run their plugins in `ctx` and are turned as DSH's `Entry.update` turns
 * them: off disposes the running fiber (not awaited, as the loader does) and writes nothing back; on
 * applies the plugin again.
 */
export function liveLoader(ctx: Context, profile: string, rows: readonly LiveRow[]): LoaderView {
  const entries = rows.map((row) => {
    const entry: LoaderEntry = {
      options: { id: row.id, name: row.name, ...(row.config ? { config: row.config } : {}) },
      disabled: !row.mounted,
      update: async ({ disabled }) => {
        entry.disabled = disabled
        if (disabled) void entry.fiber?.dispose()
        else if (row.plugin) entry.fiber = ctx.plugin(row.plugin as never, (row.config ?? {}) as never) as never
      },
    }
    if (row.mounted && row.plugin) entry.fiber = ctx.plugin(row.plugin as never, (row.config ?? {}) as never) as never
    return entry
  })
  return { ctx: { baseUrl: pathToFileURL(`${profile}/`).href }, *entries() { yield* entries } }
}

/** A loader as DSH's shows the composition's rows, resolving them from `profile`. */
export const stubLoader = (profile: string, rows: Composition['rows']): LoaderView => ({
  ctx: { baseUrl: pathToFileURL(`${profile}/`).href },
  *entries() {
    for (const row of rows) yield { options: { id: row.id, name: row.name }, disabled: !row.mounted }
  },
})

/** Install each package of a composition into `dir`'s node_modules, with its manifest when it ships one. */
export function install(dir: string, packages: Composition['packages']): void {
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
  for (const [name, manifest] of Object.entries(packages)) {
    const root = join(dir, 'node_modules', name)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    if (manifest !== undefined) writeFileSync(join(root, 'plugin-manifest.json'), manifest)
  }
}
