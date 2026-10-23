/**
 * Builds the files of a release (ADR-0026, PROP-0003 M6d). dist/release/ holds the assets, flat,
 * as a GitHub release lists them:
 * - one `pnpm pack` tarball per workspace package (`workspace:*` becomes the exact version);
 * - a CycloneDX SBOM per package (`pnpm sbom`, production dependencies);
 * - SHA256SUMS over both, in `sha256sum -c` format.
 * dist/release-notes.md holds the notes: the changelog section of each package that changed.
 *
 * Fails closed, before building:
 * - the packages must share one version (the lockstep group);
 * - the version is not a prerelease (none is released yet);
 * - `--tag` names that version;
 * - the version has a changelog entry;
 * - a patch release keeps the DSH pins of the previous release tag.
 * After packing, every `@tsuuanmi/*` dependency of a tarball must be another tarball at exactly
 * that version. Nothing is published. `--verify` runs only the checks before building; it needs
 * no install (Node strips the types), so the release workflow runs it first. pnpm is the version
 * `packageManager` pins, found as `scripts/pnpm.ts` says, never whichever comes first on PATH.
 *
 *   pnpm release:artifacts [--tag v<version>]
 *   node scripts/release-artifacts.ts --verify --tag v<version>
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pnpm } from './pnpm.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
export const OUT = join(root, 'dist', 'release')
export const NOTES = join(root, 'dist', 'release-notes.md')

export interface WorkspacePackage { name: string; version: string; dir: string }

/** The package manifests the globs of pnpm-workspace.yaml match, for reading an old revision. */
export const MANIFEST = /^(schemas|packages\/[^/]+|packages\/plugins\/[^/]+)\/package\.json$/

/** Every workspace package, as pnpm lists them (the workspace root left out). */
export function workspacePackages(): WorkspacePackage[] {
  const listed = JSON.parse(pnpm(['ls', '-r', '--depth', '-1', '--json'])) as Array<{ name: string; version: string; path: string }>
  return listed
    .filter((p) => relative(root, p.path) !== '')
    .map((p) => ({ name: p.name, version: p.version, dir: p.path }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The one version of the lockstep group; throws when the packages disagree. */
export function lockstepVersion(packages: WorkspacePackage[]): string {
  const versions = [...new Set(packages.map((p) => p.version))]
  if (versions.length !== 1) {
    throw new Error(`packages must share one version (ADR-0026), found ${packages.map((p) => `${p.name}@${p.version}`).join(', ')}`)
  }
  return versions[0]!
}

/** The body of the `## <version>` section of a Changesets CHANGELOG, or undefined. */
export function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${version}`)
  if (start < 0) return undefined
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}

/**
 * Every `@deepseek-ai/*` dependency any manifest declares, dev included, as sorted `name@version`
 * lines. Each must be one exact version (CON-8): under a range the lockfile could move DSH while
 * the manifests stay the same.
 */
export function dshPins(manifests: Array<Record<string, unknown>>): string[] {
  const kinds = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']
  const pins = manifests.flatMap((m) => kinds.flatMap((kind) => Object.entries((m[kind] ?? {}) as Record<string, string>)
    .filter(([name]) => name.startsWith('@deepseek-ai/'))
    .map(([name, spec]) => {
      if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(spec)) throw new Error(`${String(m.name)}: ${name} must be pinned to one exact version (CON-8), not ${spec}`)
      return `${name}@${spec}`
    })))
  return [...new Set(pins)].sort()
}

const parse = (version: string): [number, number, number] | undefined => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}
const compare = (a: [number, number, number], b: [number, number, number]): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** The latest `v<x.y.z>` tag below the version, or undefined for a first release. */
export function previousRelease(tags: string[], version: string): string | undefined {
  const current = parse(version)
  if (!current) throw new Error(`not a release version: ${version}`)
  return tags
    .flatMap((tag) => {
      const v = parse(tag)
      return v && tag.startsWith('v') && compare(v, current) < 0 ? [{ tag, v }] : []
    })
    .sort((a, b) => compare(b.v, a.v))[0]?.tag
}

/** ADR-0026: a DSH pin bump ships only in a minor or major release. */
export function checkDshPins(previous: { version: string; pins: string[] }, current: { version: string; pins: string[] }): void {
  const [a, b] = [parse(previous.version)!, parse(current.version)!]
  const patch = a[0] === b[0] && a[1] === b[1]
  const changed = previous.pins.join('\n') !== current.pins.join('\n')
  if (patch && changed) {
    const added = current.pins.filter((p) => !previous.pins.includes(p))
    const removed = previous.pins.filter((p) => !current.pins.includes(p))
    const changes = [...added.map((p) => `+${p}`), ...removed.map((p) => `-${p}`)]
    throw new Error(`a DSH pin changed in patch release ${current.version} (ADR-0026: minor or major only): ${changes.join(', ')}`)
  }
}

/** The package manifests of the workspace at a git revision. */
export function manifestsAt(revision: string): Array<Record<string, unknown>> {
  const git = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  return git(['ls-tree', '-r', '--name-only', revision]).split('\n')
    .filter((path) => MANIFEST.test(path))
    .map((path) => JSON.parse(git(['show', `${revision}:${path}`])) as Record<string, unknown>)
}

/** Each `@tsuuanmi/*` dependency of a packed manifest that no packed manifest provides at exactly that version. */
export function unresolvedWorkspaceDependencies(manifests: Array<{ name: string; version: string } & Record<string, unknown>>): string[] {
  const packed = new Set(manifests.map((m) => `${m.name}@${m.version}`))
  const kinds = ['dependencies', 'peerDependencies', 'optionalDependencies']
  return manifests.flatMap((m) => kinds.flatMap((kind) => Object.entries((m[kind] ?? {}) as Record<string, string>)
    .filter(([name, spec]) => name.startsWith('@tsuuanmi/') && !packed.has(`${name}@${spec}`))
    .map(([name, spec]) => `${m.name} → ${name}@${spec}`)))
}

/** True when a changelog section says only that the lockstep group moved its dependencies. */
export function onlyDependencyBumps(section: string): boolean {
  return section.split('\n').every((line) => /^\s*(#+ .*|-?\s*Updated dependencies.*|-\s*@tsuuanmi\/\S+@\S+|No changes in this release\.)?\s*$/.test(line))
}

/** Release notes: the section of each package that changed in the version, under its name. */
export function releaseNotes(packages: WorkspacePackage[], version: string): string {
  const sections = packages.flatMap((p) => {
    const file = join(p.dir, 'CHANGELOG.md')
    const body = existsSync(file) ? changelogSection(readFileSync(file, 'utf8'), version) : undefined
    return body && !onlyDependencyBumps(body) ? [`### ${p.name}\n\n${body.replace(/^###/gm, '####')}`] : []
  })
  if (sections.length === 0) throw new Error(`no CHANGELOG.md has a "## ${version}" entry: add a changeset, then run \`pnpm version-packages\``)
  return `# ${version}\n\n${sections.join('\n\n')}\n`
}

/** `sha256sum -c` lines for every file in dir (flat, as release assets are), sorted by name. */
export function checksums(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile()) throw new Error(`release assets are flat files: ${entry.name} is not one`)
      return `${createHash('sha256').update(readFileSync(join(dir, entry.name))).digest('hex')}  ${entry.name}`
    })
    .sort((a, b) => a.slice(66).localeCompare(b.slice(66)))
    .join('\n') + '\n'
}

/** The checks before building; returns what the build needs. */
export function verifyRelease(tag: string | undefined): { packages: WorkspacePackage[]; version: string; notes: string } {
  const packages = workspacePackages()
  const version = lockstepVersion(packages)
  if (version.includes('-')) throw new Error(`prerelease ${version} is not released: no workflow cuts a prerelease yet (releasing.md)`)
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`tag ${tag} does not name the packages' version v${version}`)
  const notes = releaseNotes(packages, version)
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  const pins = dshPins(packages.map((p) => JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8')) as Record<string, unknown>))
  const previous = previousRelease(tags, version)
  if (previous) checkDshPins({ version: previous, pins: dshPins(manifestsAt(previous)) }, { version, pins })
  return { packages, version, notes }
}

function main(): void {
  const tagAt = process.argv.indexOf('--tag')
  if (tagAt >= 0 && !process.argv[tagAt + 1]) throw new Error('--tag needs a value')
  const { packages, version, notes } = verifyRelease(tagAt >= 0 ? process.argv[tagAt + 1] : undefined)
  if (process.argv.includes('--verify')) {
    console.log(`release ${version}: ${packages.length} packages, ready to build`)
    return
  }

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const filters = packages.flatMap((p) => ['--filter', p.name])
  pnpm(['build'], 'inherit')
  for (const p of packages) pnpm(['--filter', p.name, 'pack', '--pack-destination', OUT], 'inherit')
  pnpm(['sbom', '--sbom-format', 'cyclonedx', '--prod', '--split', ...filters, '--out', join(OUT, '%s-%v.cdx.json')], 'inherit')
  const tarballs = readdirSync(OUT).filter((name) => name.endsWith('.tgz'))
  if (tarballs.length !== packages.length) throw new Error(`packed ${tarballs.length} tarballs for ${packages.length} packages`)
  const packed = tarballs.map((name) => JSON.parse(execFileSync('tar', ['-xzOf', join(OUT, name), 'package/package.json'], { encoding: 'utf8' })) as { name: string; version: string } & Record<string, unknown>)
  const unresolved = unresolvedWorkspaceDependencies(packed)
  if (unresolved.length > 0) throw new Error(`a tarball needs a package the release does not carry: ${unresolved.join(', ')}`)
  writeFileSync(join(OUT, 'SHA256SUMS'), checksums(OUT))
  writeFileSync(NOTES, notes)
  console.log(`release ${version}: ${packages.length} packages, their SBOMs, and SHA256SUMS in ${relative(root, OUT)}; notes in ${relative(root, NOTES)}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
