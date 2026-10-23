/**
 * Versions a release (ADR-0026): `changeset version` bumps the lockstep group and writes each
 * CHANGELOG. The bundle's presets are layers inside the bundle package, not workspace packages, so
 * their manifests get the version here, and every plugin manifest takes its package's new version
 * (`gen:manifests`). Then this release's code seeds its store fixture for the
 * upgrade suite (`gen:upgrade-fixture v<version>`, never edited afterwards). Commit the result, then tag
 * `v<version>` on main ([releasing](../docs/engineering/releasing.md)).
 *
 *   pnpm version-packages
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pnpm } from './pnpm.ts'
import { lockstepVersion, workspacePackages } from './release-artifacts.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
// The pnpm package.json pins (scripts/pnpm.ts).
const run = (args: string[]): void => {
  pnpm(args, 'inherit')
}

const before = lockstepVersion(workspacePackages())
run(['exec', 'changeset', 'version'])
const version = lockstepVersion(workspacePackages())
if (version === before) throw new Error(`no pending changeset: the packages stay at ${version}`)
const presets = join(root, 'packages', 'system-bundle', 'presets')
for (const preset of readdirSync(presets)) {
  const file = join(presets, preset, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as { version: string }
  writeFileSync(file, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
}
run(['gen:manifests'])
run(['gen:upgrade-fixture', `v${version}`])
console.log(`versioned ${before} → ${version}; seeded the v${version} upgrade fixture`)
