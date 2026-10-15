import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { changelogSection, checksums, lockstepVersion, onlyDependencyBumps, releaseNotes, workspacePackages } from './release-artifacts.ts'

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
    expect(packages.length).toBeGreaterThan(30)
    expect(() => lockstepVersion(packages)).not.toThrow()
    for (const p of packages) {
      const files = (JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8')) as { files?: string[] }).files
      expect(files, p.name).toBeDefined()
    }
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
})
