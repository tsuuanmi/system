/**
 * Versions a release (ADR-0026): `changeset version` bumps the lockstep group and writes each
 * CHANGELOG, then this release's code seeds its store fixture for the upgrade suite
 * (`gen:upgrade-fixture v<version>`, never edited afterwards). Commit the result, then tag
 * `v<version>` on main ([releasing](../docs/engineering/releasing.md)).
 *
 *   pnpm version-packages
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lockstepVersion, workspacePackages } from './release-artifacts.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = (args: string[]): void => {
  execFileSync('pnpm', args, { cwd: root, stdio: 'inherit' })
}

const before = lockstepVersion(workspacePackages())
run(['exec', 'changeset', 'version'])
const version = lockstepVersion(workspacePackages())
if (version === before) throw new Error(`no pending changeset: the packages stay at ${version}`)
run(['gen:upgrade-fixture', `v${version}`])
console.log(`versioned ${before} → ${version}; seeded the v${version} upgrade fixture`)
