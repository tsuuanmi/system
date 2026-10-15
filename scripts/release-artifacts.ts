/**
 * Builds the files of a release (ADR-0026, PROP-0003 M6d). dist/release/ holds the assets, flat,
 * as a GitHub release lists them:
 * - one `pnpm pack` tarball per workspace package (`workspace:*` becomes the exact version);
 * - a CycloneDX SBOM per package (`pnpm sbom`, production dependencies);
 * - SHA256SUMS over both, in `sha256sum -c` format.
 * dist/release-notes.md holds the notes: the changelog section of each package that changed.
 * Fails closed: the packages must share one version (the lockstep group), `--tag` must name
 * that version, and the version must have a changelog entry. Nothing is published.
 *
 *   pnpm release:artifacts [--tag v<version>]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
export const OUT = join(root, 'dist', 'release')
export const NOTES = join(root, 'dist', 'release-notes.md')

export interface WorkspacePackage { name: string; version: string; dir: string }

/** Every package under packages/ and packages/plugins/, by its package.json. */
export function workspacePackages(base = root): WorkspacePackage[] {
  const dirs = [join(base, 'packages'), join(base, 'packages', 'plugins')]
  return dirs.flatMap((parent) => readdirSync(parent, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(parent, d.name, 'package.json')))
    .map((d) => {
      const pkg = JSON.parse(readFileSync(join(parent, d.name, 'package.json'), 'utf8')) as { name: string; version: string }
      return { name: pkg.name, version: pkg.version, dir: join(parent, d.name) }
    }))
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

function main(): void {
  const tagAt = process.argv.indexOf('--tag')
  const tag = tagAt >= 0 ? process.argv[tagAt + 1] : undefined
  const packages = workspacePackages()
  const version = lockstepVersion(packages)
  if (tagAt >= 0 && tag !== `v${version}`) throw new Error(`tag ${tag ?? '(missing)'} does not name the packages' version v${version}`)
  const notes = releaseNotes(packages, version)

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const pnpm = (args: string[]): void => {
    execFileSync('pnpm', args, { cwd: root, stdio: 'inherit' })
  }
  pnpm(['build'])
  for (const p of packages) pnpm(['--filter', p.name, 'pack', '--pack-destination', OUT])
  pnpm(['sbom', '--sbom-format', 'cyclonedx', '--prod', '--split', '--filter', './packages/**', '--out', join(OUT, '%s-%v.cdx.json')])
  writeFileSync(join(OUT, 'SHA256SUMS'), checksums(OUT))
  writeFileSync(NOTES, notes)
  console.log(`release ${version}: ${packages.length} packages, their SBOMs, and SHA256SUMS in ${relative(root, OUT)}; notes in ${relative(root, NOTES)}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
