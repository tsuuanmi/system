import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { affected, changedSince, checkScope, filters, graph, GROUPS, groupOf, packages, related, specFiles, splitArgs } from './test-groups.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const all = packages()
const deps = graph(all)
const names = Object.keys(GROUPS)
const of = (...paths: string[]) => affected(paths, all, deps)

describe('the runner\'s arguments (T247)', () => {
  it('takes vitest\'s arguments after `--`, and for `group` also where a runner dropped the `--`: the names end at the first option or path', () => {
    expect(splitArgs(['group', 'surfaces', '--', 'a/b.spec.ts', '-t', 'x'])).toEqual({ command: 'group', rest: ['surfaces'], extra: ['a/b.spec.ts', '-t', 'x'] })
    expect(splitArgs(['group', 'surfaces', 'libs', 'a/b.spec.ts', '--testNamePattern', 'x'])).toEqual({ command: 'group', rest: ['surfaces', 'libs'], extra: ['a/b.spec.ts', '--testNamePattern', 'x'] })
    expect(splitArgs(['group', 'surfaces', '--reporter=dot'])).toEqual({ command: 'group', rest: ['surfaces'], extra: ['--reporter=dot'] })
    // A misspelt group is still a name, and still refused.
    expect(splitArgs(['group', 'survaces'])).toEqual({ command: 'group', rest: ['survaces'], extra: [] })
    // `affected` keeps its own options: only `--` gives vitest anything.
    expect(splitArgs(['affected', '--base', 'main'])).toEqual({ command: 'affected', rest: ['--base', 'main'], extra: [] })
  })
})

describe('what test:affected counts as changed (T265)', () => {
  it('leaves out a command sandbox\'s empty placeholders in the worktree (.bashrc, .gitconfig, .claude/…), but keeps one with content, a tracked change to one, and every other new file', () => {
    const repo = mkdtempSync(join(tmpdir(), 'system-test-groups-'))
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' })
      git('init', '-q', '-b', 'main')
      writeFileSync(join(repo, '.gitmodules'), '')
      git('add', '.gitmodules')
      git('commit', '-q', '-m', 'base')
      // What Claude Code's sandbox leaves in the directory its commands start in: empty files and directories.
      for (const file of ['.bashrc', '.profile', '.zshrc', '.mcp.json', '.idea']) writeFileSync(join(repo, file), '')
      mkdirSync(join(repo, '.claude'))
      writeFileSync(join(repo, '.claude', 'settings.json'), '')
      mkdirSync(join(repo, '.vscode'))
      symlinkSync('/dev/null', join(repo, '.gitconfig'))
      expect(changedSince('main', repo)).toEqual([])
      // A Worker's own: a placeholder path with content, a placeholder name elsewhere, a tracked change, and any other file.
      writeFileSync(join(repo, '.profile'), 'export X=1\n')
      mkdirSync(join(repo, 'docs'))
      writeFileSync(join(repo, 'docs', '.bashrc'), '')
      writeFileSync(join(repo, '.gitmodules'), '[submodule "x"]\n')
      writeFileSync(join(repo, 'notes.md'), 'x\n')
      expect(changedSince('main', repo)).toEqual(['.gitmodules', '.profile', 'docs/.bashrc', 'notes.md'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('related tests (T299)', () => {
  const suite = specFiles()
  const relatedTo = (...paths: string[]) => related(paths, all, deps, suite)
  const pkgOf = (spec: string) => all.filter((p) => spec.startsWith(p.path)).sort((a, b) => b.path.length - a.path.length)[0]!.id
  /** Whether a package's tests reach `target`'s code through the graph, by a walk of its own. */
  const dependsOn = (id: string, target: string): boolean => {
    const seen = new Set<string>()
    const walk = (node: string): boolean => {
      if (node === `${target}:src`) return true
      if (seen.has(node)) return false
      seen.add(node)
      return [...(deps.imports.get(node) ?? [])].some(walk)
    }
    return walk(`${id}:test`)
  }

  it('selects a package\'s source change to that package\'s tests and its dependents\' only, with the scripts\' repository checks', () => {
    const picked = relatedTo('packages/plugins/provider-gemini-web/src/driver.ts').tests
    expect(picked.length).toBeGreaterThan(0)
    expect(picked.length).toBeLessThan(suite.length)
    expect(picked.some((t) => pkgOf(t) === 'provider-gemini-web')).toBe(true)
    for (const spec of picked) {
      const id = pkgOf(spec)
      // Or one that locates a data file of the package (`new URL`): reached all the same, no further.
      const reads = deps.reads.get(`${id}:test`)?.has('provider-gemini-web') === true
      expect(id === 'scripts' || id === 'provider-gemini-web' || dependsOn(id, 'provider-gemini-web') || reads, spec).toBe(true)
    }
    // Every test of the package and of each dependent is in: nothing it covers is left out.
    for (const spec of suite) {
      if (pkgOf(spec) === 'provider-gemini-web' || dependsOn(pkgOf(spec), 'provider-gemini-web')) expect(picked, spec).toContain(spec)
    }
    // A package no other depends on selects its own tests, not the kernel's.
    expect(relatedTo('packages/plugins/workflow/src/engine.ts').tests.some((t) => pkgOf(t) === 'store')).toBe(false)
  })

  it('selects a changed test file itself and no other test of its package', () => {
    const spec = suite.find((t) => t.startsWith('packages/plugins/workflow/tests/'))!
    expect(relatedTo(spec)).toEqual({ tests: [spec], changed: [] })
  })

  it('selects the whole suite for a package.json, the lockfile, a vitest config, or a tsconfig, whichever directory it is in', () => {
    for (const path of ['package.json', 'packages/plugins/workflow/package.json', 'pnpm-lock.yaml', 'vitest.config.ts', 'tsconfig.json', 'packages/libs/tsconfig.build.json', 'somewhere/new.ts']) {
      const result = relatedTo('packages/plugins/provider-gemini-web/src/driver.ts', path)
      expect(result.everything, path).toBe(path)
      expect(result.tests, path).toEqual(suite)
    }
  })

  it('reads an acceptance\'s change from the commit its run\'s worktree was cut at: what its branch gained before (a package.json) never widens it; none recorded, or the landing, runs the whole suite', () => {
    expect(checkScope({})).toEqual({})
    expect(checkScope({ SYSTEM_CHECK_SCOPE: 'acceptance', SYSTEM_CHECK_BASE: 'a1b2c3d4e5f6' })).toEqual({ base: 'a1b2c3d4e5f6' })
    for (const env of [{ SYSTEM_CHECK_SCOPE: 'landing' }, { SYSTEM_CHECK_SCOPE: 'landing', SYSTEM_CHECK_BASE: 'a1b2c3d4e5f6' }, { SYSTEM_CHECK_SCOPE: 'acceptance' }, { SYSTEM_CHECK_SCOPE: 'acceptance', SYSTEM_CHECK_BASE: '--all' }, { SYSTEM_CHECK_SCOPE: 'other' }]) {
      expect(checkScope(env).full, JSON.stringify(env)).toEqual(expect.any(String))
    }
    // main, then a dev branch that gained a package.json change, then the run's worktree cut from dev.
    const repo = mkdtempSync(join(tmpdir(), 'system-test-groups-'))
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'package.json'), '{}\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', 'dev')
    writeFileSync(join(repo, 'package.json'), '{"x":1}\n')
    git('commit', '-q', '-am', 'dev gains a manifest change')
    const forkedAt = git('rev-parse', 'HEAD')
    mkdirSync(join(repo, 'packages', 'plugins', 'provider-gemini-web', 'src'), { recursive: true })
    writeFileSync(join(repo, 'packages', 'plugins', 'provider-gemini-web', 'src', 'driver.ts'), 'export {}\n')
    const base = checkScope({ SYSTEM_CHECK_SCOPE: 'acceptance', SYSTEM_CHECK_BASE: forkedAt }).base!
    const own = changedSince(base, repo)
    expect(own).toEqual(['packages/plugins/provider-gemini-web/src/driver.ts'])
    expect(relatedTo(...own).everything).toBeUndefined()
    // Read since main, as before, it took the branch's package.json for the run's and ran everything.
    expect(changedSince('main', repo)).toContain('package.json')
  })

  it('selects the scripts\' tests for documentation, and nothing for no change', () => {
    const docs = relatedTo('docs/engineering/testing.md').tests
    expect(docs.length).toBeGreaterThan(0)
    expect(docs.every((t) => t.startsWith('scripts/'))).toBe(true)
    expect(relatedTo().tests).toEqual([])
  })
})

describe('test groups (docs/engineering/testing.md#test-groups)', () => {
  it('puts every workspace package in exactly one group, and every test file of the suite in exactly one group\'s filters', () => {
    for (const pkg of all.filter((p) => p.id !== 'scripts')) {
      expect(names.filter((name) => GROUPS[name]!.packages.includes(pkg.id)), pkg.id).toHaveLength(1)
    }
    for (const id of names.flatMap((name) => GROUPS[name]!.packages)) expect(all.some((p) => p.id === id), `${id} is a package`).toBe(true)
    expect(groupOf('scripts')).toBe('libs')
    // The suite's files, as vitest.config.ts includes them.
    const suite = execFileSync('git', ['ls-files', ':(glob)scripts/**/*.spec.ts', ':(glob)packages/**/tests/**/*.spec.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
    expect(suite.length).toBeGreaterThan(100)
    for (const file of suite) expect(names.filter((name) => filters(name, all).some((f) => file.startsWith(f))), file).toHaveLength(1)
  })

  it('runs the groups whose tests depend on a changed package\'s code or test files, transitively, test helpers included', () => {
    // The engine's browser tests drive the fake sites, so a change to a driver's fixture reaches them,
    // but not the agent Workers' tests, which compose the engine's code, never its tests.
    expect(deps.imports.get('workflow:test')).toContain('provider-gemini-web:test')
    expect(of('packages/plugins/provider-gemini-web/fixtures/fake-gemini.ts').groups).toEqual(['workflow', 'websites', 'surfaces', 'libs'])
    // A helper's own imports count: the browser tests' support starts display-virtual's Xvfb, so a
    // change there reaches every suite that uses that support.
    expect(of('packages/plugins/display-virtual/src/xvfb.ts').groups).toEqual(expect.arrayContaining(['workflow', 'websites', 'surfaces']))
    // The kernel's code reaches every group; the engine's code never reaches the kernel.
    expect(of('packages/plugins/leases/src/index.ts').groups).toEqual(names)
    expect(of('packages/plugins/workflow/src/engine.ts').groups).not.toContain('kernel')
  })

  it('reaches what reads a changed package\'s data file, and nothing that depends on the reader', () => {
    // The agent Workers' tests read the bundle's patch file; the bundle composes every plugin, yet a
    // plugin's change is no change to that file.
    expect(deps.reads.get('agent-workers:test')).toContain('system-bundle')
    expect(of('packages/plugins/provider-gemini-web/src/driver.ts').groups).not.toContain('workers')
    expect(of('packages/system-bundle/cordis.patch.yml').groups).toContain('workers')
  })

  it('runs every group for a schema, a root configuration, CI, or a path it cannot place; the scripts\' group for documentation', () => {
    for (const path of ['schemas/brief.v1.json', 'package.json', 'pnpm-lock.yaml', 'vitest.config.ts', '.github/workflows/ci.yml', 'somewhere/new.ts']) {
      expect(of(path).groups, path).toEqual(names)
    }
    expect(of('schemas/brief.v1.json').everything).toBeUndefined()
    expect(of('package.json').everything).toBe('package.json')
    for (const path of ['docs/engineering/testing.md', 'README.md', '.changeset/kept-tabs.md']) expect(of(path).groups, path).toEqual(['libs'])
    expect(of().groups).toEqual([])
  })
})
