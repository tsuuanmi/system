import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { affected, changedSince, filters, graph, GROUPS, groupOf, packages, splitArgs } from './test-groups.ts'

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
