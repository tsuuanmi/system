import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { changelogSection, checkDshPins, checksums, dshPins, lockstepVersion, MANIFEST, onlyDependencyBumps, previousRelease, releaseNotes, unresolvedWorkspaceDependencies, workspacePackages } from './release-artifacts.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'system-release-'))
  temps.push(dir)
  return dir
}

const CHANGELOG = '# @tsuuanmi/system-cli\n\n## 1.1.0\n\n### Minor Changes\n\n- abc123: re-plan\n\n## 1.0.0\n\n### Major Changes\n\n- first\n'

describe('release artifacts (ADR-0026)', () => {
  it('every workspace package is in the one lockstep version and ships only declared files', () => {
    const packages = workspacePackages()
    expect(packages.map((p) => p.name)).toContain('@tsuuanmi/system-schemas')
    expect(() => lockstepVersion(packages)).not.toThrow()
    expect(dshPins(packages.map((p) => JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8')) as Record<string, unknown>)).length).toBeGreaterThan(0)
    for (const p of packages) {
      const files = (JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8')) as { files?: string[] }).files
      expect(files, p.name).toBeDefined()
    }
  })

  it('reads the same packages from an old revision as pnpm lists now', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter((path) => MANIFEST.test(path)).sort()
    expect(tracked).toEqual(workspacePackages().map((p) => join(relative(root, p.dir), 'package.json')).sort())
  })

  it('finds a tarball dependency that no tarball provides at exactly its version', () => {
    const libs = { name: '@tsuuanmi/system-libs', version: '1.0.0', dependencies: { '@tsuuanmi/system-schemas': '1.0.0', 'yaml': '2.0.0' } }
    const cli = { name: '@tsuuanmi/system-cli', version: '1.0.0', dependencies: { '@tsuuanmi/system-libs': '1.0.0' }, peerDependencies: { '@tsuuanmi/system-bundle': '0.9.0' } }
    expect(unresolvedWorkspaceDependencies([libs, cli])).toEqual(['@tsuuanmi/system-libs → @tsuuanmi/system-schemas@1.0.0', '@tsuuanmi/system-cli → @tsuuanmi/system-bundle@0.9.0'])
    expect(unresolvedWorkspaceDependencies([libs, { name: '@tsuuanmi/system-schemas', version: '1.0.0' }])).toEqual([])
  })

  it('refuses packages that disagree on the version, naming them', () => {
    expect(() => lockstepVersion([{ name: 'a', version: '1.0.0', dir: '' }, { name: 'b', version: '1.1.0', dir: '' }])).toThrow(/a@1.0.0, b@1.1.0/)
  })

  it('reads one version section of a changelog, and nothing for an unknown version', () => {
    expect(changelogSection(CHANGELOG, '1.1.0')).toBe('### Minor Changes\n\n- abc123: re-plan')
    expect(changelogSection(CHANGELOG, '1.0.0')).toBe('### Major Changes\n\n- first')
    expect(changelogSection(CHANGELOG, '1.0')).toBeUndefined()
  })

  it('tells a section that only moves the group\'s dependencies from one with a change', () => {
    expect(onlyDependencyBumps('### Patch Changes\n\n- @tsuuanmi/system-libs@1.0.0\n  - @tsuuanmi/system-provider-core@1.0.0')).toBe(true)
    expect(onlyDependencyBumps('### Patch Changes\n\n- Updated dependencies [abc123]\n  - @tsuuanmi/system-libs@1.0.1')).toBe(true)
    expect(onlyDependencyBumps('No changes in this release.')).toBe(true)
    expect(onlyDependencyBumps('### Minor Changes\n\n- abc123: re-plan\n- @tsuuanmi/system-libs@1.1.0')).toBe(false)
  })

  it('notes name each package that changed, and fail closed when none did', () => {
    const base = temp()
    const dirs = ['cli', 'libs', 'store'].map((name) => join(base, name))
    for (const dir of dirs) mkdirSync(dir)
    writeFileSync(join(dirs[0]!, 'CHANGELOG.md'), CHANGELOG)
    writeFileSync(join(dirs[2]!, 'CHANGELOG.md'), '# @tsuuanmi/system-store\n\n## 1.1.0\n\n### Patch Changes\n\n- @tsuuanmi/system-libs@1.1.0\n')
    const packages = ['cli', 'libs', 'store'].map((name, i) => ({ name: `@tsuuanmi/system-${name}`, version: '1.1.0', dir: dirs[i]! }))
    expect(releaseNotes(packages, '1.1.0')).toBe('# 1.1.0\n\n### @tsuuanmi/system-cli\n\n#### Minor Changes\n\n- abc123: re-plan\n')
    expect(() => releaseNotes(packages, '2.0.0')).toThrow(/no CHANGELOG.md has a "## 2.0.0" entry/)
    expect(() => releaseNotes(packages.slice(1), '1.1.0')).toThrow(/no CHANGELOG.md has a "## 1.1.0" entry/)
  })

  it('writes checksums of flat assets that sha256sum verifies, and refuses a nested directory', () => {
    const dir = temp()
    writeFileSync(join(dir, 'b.tgz'), 'tarball')
    writeFileSync(join(dir, 'a.cdx.json'), '{}')
    const sums = checksums(dir)
    expect(sums.trim().split('\n').map((line) => line.slice(66))).toEqual(['a.cdx.json', 'b.tgz'])
    writeFileSync(join(dir, 'SHA256SUMS'), sums)
    expect(execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: dir, encoding: 'utf8' })).toBe('a.cdx.json: OK\nb.tgz: OK\n')
    mkdirSync(join(dir, 'sbom'))
    expect(() => checksums(dir)).toThrow(/sbom is not one/)
  })

  it('collects every DSH pin of every manifest once, whatever the dependency kind', () => {
    expect(dshPins([
      { dependencies: { '@deepseek-ai/cordis': '4.0.5-alpha.1', 'yaml': '2.0.0' } },
      { peerDependencies: { '@deepseek-ai/cordis': '4.0.5-alpha.1' }, devDependencies: { '@deepseek-ai/dsh': '0.2.1-alpha.2' } },
    ])).toEqual(['@deepseek-ai/cordis@4.0.5-alpha.1', '@deepseek-ai/dsh@0.2.1-alpha.2'])
    expect(() => dshPins([{ name: 'x', dependencies: { '@deepseek-ai/dsh': '^0.2.1-alpha.2' } }])).toThrow('x: @deepseek-ai/dsh must be pinned to one exact version (CON-8), not ^0.2.1-alpha.2')
  })

  it('finds the latest release tag below the version, and none before the first release', () => {
    expect(previousRelease(['v1.0.0', 'v1.2.0', 'v1.10.0', 'v2.0.0', 'other', 'v1.3.0-rc.1'], '1.11.0')).toBe('v1.10.0')
    expect(previousRelease(['v1.0.0'], '1.0.0')).toBeUndefined()
    expect(previousRelease([], '1.0.0')).toBeUndefined()
  })

  it('refuses a DSH pin bump in a patch release, and allows it in a minor one (ADR-0026)', () => {
    const before = { version: 'v1.2.3', pins: ['@deepseek-ai/cordis@4.0.5-alpha.1'] }
    const bumped = ['@deepseek-ai/cordis@4.0.6-alpha.1']
    expect(() => checkDshPins(before, { version: '1.2.4', pins: bumped })).toThrow('patch release 1.2.4 (ADR-0026: minor or major only): +@deepseek-ai/cordis@4.0.6-alpha.1, -@deepseek-ai/cordis@4.0.5-alpha.1')
    expect(() => checkDshPins(before, { version: '1.3.0', pins: bumped })).not.toThrow()
    expect(() => checkDshPins(before, { version: '1.2.4', pins: before.pins })).not.toThrow()
    expect(() => checkDshPins(before, { version: '1.2.4', pins: [...before.pins, ...bumped] })).toThrow(/: \+@deepseek-ai\/cordis@4.0.6-alpha.1$/)
  })
})
