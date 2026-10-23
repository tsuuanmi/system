import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Composition } from '../../../plugin-host-core/conformance/plugin-host.ts'
import type { LoaderView } from '../src/index.ts'

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
