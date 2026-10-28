import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { redOnBase, type Runner, type TestRun } from './red-on-base.ts'

/** This repository's root, whose `node_modules` holds the vitest the real runner starts. */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The real runner starts vitest twice per check.
vi.setConfig({ testTimeout: 120_000 })

// The check `red-on-base` (T306c, ADR-0079): the test files a result adds or changes are run on the
// result's base tree, with the result's tests copied over, and must fail there and pass on the result.
// The runner is injected: here it reads the tree it is given, so what each test sees is the tree's.

const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' })

/** A repository with a base commit, then the files `base` holds; returns its directory and the base commit. */
function repository(base: Record<string, string>): { dir: string; base: string; write: (files: Record<string, string>) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'system-red-on-base-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const write = (files: Record<string, string>): void => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
  }
  git(dir, 'init', '-q')
  write(base)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'base')
  return { dir, base: git(dir, 'rev-parse', 'HEAD').trim(), write }
}

/**
 * A runner that judges a spec file by the tree it is given: it is red when the tree's `feature.txt`
 * does not say `new`, or when the file itself says `broken`. Every file holds one test, `works`.
 */
const byTree: Runner = (dir, files): TestRun => ({
  output: '',
  files: files.map((path) => {
    const red = !readFileSync(join(dir, 'feature.txt'), 'utf8').includes('new') || readFileSync(join(dir, path), 'utf8').includes('broken')
    return { path, failed: red, passed: red ? [] : ['works'], failedTests: red ? ['works'] : [] }
  }),
})

/** A runner for which every test passes, wherever it runs. */
const alwaysGreen: Runner = (_dir, files): TestRun => ({ output: '', files: files.map((path) => ({ path, failed: false, passed: ['works'], failedTests: [] })) })

describe('red-on-base (T306c)', () => {
  it('passes a result whose new test fails on its base tree and passes on the result, running it on the base with the result\'s test copied over', async () => {
    const r = repository({ 'feature.txt': 'old\n' })
    r.write({ 'feature.txt': 'new\n', 'packages/p/tests/feature.spec.ts': 'test\n' })
    const seen: Array<{ dir: string; feature: string; copied: boolean }> = []
    const verdict = redOnBase({
      repo: r.dir, base: r.base, refactor: false,
      run: (dir, files) => {
        seen.push({ dir, feature: readFileSync(join(dir, 'feature.txt'), 'utf8'), copied: files.every((f) => existsSync(join(dir, f))) })
        return byTree(dir, files)
      },
    })
    expect(verdict.ok).toBe(true)
    // First the base tree (old code, the test copied in), then the result's own tree.
    expect(seen.map((s) => [s.feature, s.copied])).toEqual([['old\n', true], ['new\n', true]])
    expect(seen[0]!.dir).not.toBe(r.dir)
    expect(existsSync(seen[0]!.dir), 'the base tree is removed when the check ends').toBe(false)
    expect(verdict.lines.join('\n')).toContain('packages/p/tests/feature.spec.ts')
  })

  it('fails a result whose new test passes on the base, naming the test and its file', async () => {
    const r = repository({ 'feature.txt': 'new\n' })
    r.write({ 'src.ts': 'export const a = 1\n', 'packages/p/tests/a.spec.ts': 'test\n' })
    const verdict = redOnBase({ repo: r.dir, base: r.base, refactor: false, run: alwaysGreen })
    expect(verdict.ok).toBe(false)
    const text = verdict.lines.join('\n')
    expect(text).toMatch(/FAIL red-on-base: packages\/p\/tests\/a\.spec\.ts passes on the base tree/)
    expect(text).toContain('works')
  })

  it('counts a test file that cannot load on the base (a missing module) as red', async () => {
    const r = repository({ 'feature.txt': 'new\n' })
    r.write({ 'src.ts': 'export const a = 1\n', 'packages/p/tests/a.spec.ts': 'test\n' })
    const missing: Runner = (dir, files) => (dir === r.dir ? alwaysGreen(dir, files) : { output: 'Error: Failed to load url ../src/new.ts', files: files.map((path) => ({ path, failed: true, passed: [], failedTests: [] })) })
    expect(redOnBase({ repo: r.dir, base: r.base, refactor: false, run: missing }).ok).toBe(true)
  })

  it('never takes a file the base run reported nothing of for red: a runner that did not start is no evidence, and its output says why', async () => {
    const r = repository({ 'feature.txt': 'old\n' })
    r.write({ 'feature.txt': 'new\n', 'packages/p/tests/a.spec.ts': 'test\n' })
    const crashed: Runner = (dir, files) => (dir === r.dir ? byTree(dir, files)
      : { output: 'Error: failed to load config from vitest.config.ts', exitCode: 1, files: files.map((path) => ({ path, failed: false, passed: [], failedTests: [], notRun: true as const })) })
    const verdict = redOnBase({ repo: r.dir, base: r.base, refactor: false, run: crashed })
    expect(verdict.ok).toBe(false)
    const text = verdict.lines.join('\n')
    expect(text).toMatch(/FAIL red-on-base: packages\/p\/tests\/a\.spec\.ts did not run on the base tree/)
    expect(text).toContain('Error: failed to load config from vitest.config.ts')
  })

  it('prints both runs\' output and every failure within what a check\'s record keeps (its last 4000 characters), however many files and however long their tests\' names', async () => {
    const r = repository({ 'feature.txt': 'new\n' })
    const files = Array.from({ length: 30 }, (_, i) => `packages/p/tests/a-rather-long-file-name-for-the-bound-${i}.spec.ts`)
    r.write({ 'src.ts': 'export const a = 1\n', ...Object.fromEntries(files.map((f) => [f, 'test\n'])) })
    const name = 'it passes on the base tree although its name, like this repository\'s test names, runs well past one hundred and fifty characters, which no bound on a count of names would hold'
    // Every test passes on the base (30 FAIL verdicts), and each run prints far more than the record keeps, its last words a marker.
    const green = (marker: string): Runner => (_dir, specs) => ({ output: `${'x'.repeat(20_000)}\n${marker}`, exitCode: 0, files: specs.map((path) => ({ path, failed: false, passed: [name, name, name, name, name, name], failedTests: [] })) })
    const verdict = redOnBase({ repo: r.dir, base: r.base, refactor: false, run: (dir, specs) => green(dir === r.dir ? 'THE RESULT RUN ENDED' : 'THE BASE RUN ENDED')(dir, specs) })
    expect(verdict.ok).toBe(false)
    const text = verdict.lines.join('\n')
    // The script's budget, 3600 characters, under the 4000 the record keeps (agent-workers CHECK_OUTPUT_TAIL), with room for the package runner's own lines.
    expect(text.length + 1).toBeLessThanOrEqual(3600)
    expect(text).toMatch(/--- red-on-base: the run on the base tree [0-9a-f]+ \(exit 0\)/)
    expect(text).toContain('THE BASE RUN ENDED')
    expect(text).toMatch(/--- red-on-base: the run on the result \(exit 0\)/)
    expect(text).toContain('THE RESULT RUN ENDED')
    expect(text).toMatch(/FAIL red-on-base: packages\/p\/tests\/a-rather-long-file-name-for-the-bound-\d+\.spec\.ts passes on the base tree/)
    // What does not fit is counted, its failures said, never dropped in silence.
    expect(verdict.lines.at(-1)).toMatch(/^FAIL red-on-base: and \d+ more file verdict\(s\) not shown within the output bound, \d+ of them failed$/)
  })

  it('fails a test that is red on the base but also red on the result', async () => {
    const r = repository({ 'feature.txt': 'old\n' })
    r.write({ 'feature.txt': 'new\n', 'packages/p/tests/a.spec.ts': 'broken\n' })
    const verdict = redOnBase({ repo: r.dir, base: r.base, refactor: false, run: byTree })
    expect(verdict.ok).toBe(false)
    expect(verdict.lines.join('\n')).toMatch(/FAIL red-on-base: packages\/p\/tests\/a\.spec\.ts fails on the result/)
  })

  it('fails a change of code that adds or changes no test file', async () => {
    const r = repository({ 'feature.txt': 'old\n' })
    r.write({ 'feature.txt': 'new\n' })
    const verdict = redOnBase({ repo: r.dir, base: r.base, refactor: false, run: alwaysGreen })
    expect(verdict.ok).toBe(false)
    expect(verdict.lines.join('\n')).toMatch(/adds or changes no test file/)
  })

  it('has nothing to be red on in a change of documents or tests alone: it passes, and says why', async () => {
    const r = repository({ 'feature.txt': 'new\n', 'README.md': 'a\n' })
    r.write({ 'README.md': 'b\n', 'docs/x.md': 'c\n', '.changeset/x.md': 'd\n' })
    expect(redOnBase({ repo: r.dir, base: r.base, refactor: false, run: alwaysGreen })).toMatchObject({ ok: true })
    git(r.dir, 'add', '.')
    git(r.dir, 'commit', '-q', '-m', 'docs')
    const next = git(r.dir, 'rev-parse', 'HEAD').trim()
    r.write({ 'packages/p/tests/a.spec.ts': 'test\n' })
    const verdict = redOnBase({ repo: r.dir, base: next, refactor: false, run: alwaysGreen })
    expect(verdict.ok).toBe(true)
    expect(verdict.lines.join('\n')).toMatch(/only tests/)
  })

  it('reads a change committed on top of its base and one left uncommitted or untracked alike', async () => {
    const r = repository({ 'feature.txt': 'old\n' })
    r.write({ 'feature.txt': 'new\n' })
    git(r.dir, 'add', '.')
    git(r.dir, 'commit', '-q', '-m', 'code')
    r.write({ 'packages/p/tests/a.spec.ts': 'test\n' })
    expect(redOnBase({ repo: r.dir, base: r.base, refactor: false, run: byTree }).ok).toBe(true)
  })

  describe('with the real runner: this repository\'s vitest, linked into a small repository (T306c review)', () => {
    /** A repository whose `node_modules` is this one's, ignored by git, so the base tree links the same vitest. */
    const withVitest = (base: Record<string, string>) => {
      const r = repository({ '.gitignore': 'node_modules\n', ...base })
      symlinkSync(join(root, 'node_modules'), join(r.dir, 'node_modules'))
      return r
    }
    const SPEC_FILE = "import { expect, it } from 'vitest'\nimport { answer } from '../src/answer.js'\nit('answers 42', () => expect(answer()).toBe(42))\n"

    it('passes a test whose module is missing on the base and that passes on the result, printing both runs\' output', () => {
      const r = withVitest({ 'README.md': 'x\n' })
      r.write({ 'src/answer.js': 'export const answer = () => 42\n', 'tests/answer.spec.js': SPEC_FILE })
      const verdict = redOnBase({ repo: r.dir, base: r.base, refactor: false })
      const text = verdict.lines.join('\n')
      expect(verdict.ok, text).toBe(true)
      expect(text).toContain('red-on-base: tests/answer.spec.js fails on the base tree')
      // The base run's own words, and the result's, reach what the check prints.
      expect(text).toMatch(/--- red-on-base: the run on the base tree [0-9a-f]+ \(exit 1\)/)
      expect(text).toMatch(/answer\.js/)
      expect(text).toMatch(/--- red-on-base: the run on the result \(exit 0\)/)
      expect(text).toMatch(/1 passed/)
    })

    it('fails when vitest does not start on the base tree (its configuration throws): no report is no evidence', () => {
      const r = withVitest({ 'vitest.config.js': "throw new Error('the base configuration is broken')\n" })
      r.write({ 'vitest.config.js': 'export default {}\n', 'src/answer.js': 'export const answer = () => 42\n', 'tests/answer.spec.js': SPEC_FILE })
      const verdict = redOnBase({ repo: r.dir, base: r.base, refactor: false })
      const text = verdict.lines.join('\n')
      expect(verdict.ok, text).toBe(false)
      expect(text).toMatch(/FAIL red-on-base: tests\/answer\.spec\.js did not run on the base tree/)
      expect(text).toContain('the base configuration is broken')
    })
  })

  describe('a refactor (its criteria say `refactor: no behaviour change`)', () => {
    it('fails when the result edits or deletes an existing test, naming it', async () => {
      const r = repository({ 'feature.txt': 'old\n', 'packages/p/tests/a.spec.ts': 'one\n', 'packages/p/tests/b.spec.ts': 'two\n' })
      r.write({ 'feature.txt': 'old again\n', 'packages/p/tests/a.spec.ts': 'one, loosened\n' })
      rmSync(join(r.dir, 'packages/p/tests/b.spec.ts'))
      const verdict = redOnBase({ repo: r.dir, base: r.base, refactor: true, run: alwaysGreen })
      expect(verdict.ok).toBe(false)
      const text = verdict.lines.join('\n')
      expect(text).toMatch(/FAIL red-on-base: .*packages\/p\/tests\/a\.spec\.ts/)
      expect(text).toContain('packages/p/tests/b.spec.ts')
      expect(text).toMatch(/no behaviour change/)
    })

    it('keeps its verdicts within the same bound however many tests it changed, counting those not shown', async () => {
      const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`packages/p/tests/an-existing-test-with-a-long-name-${i}.spec.ts`, 'one\n']))
      const r = repository({ 'feature.txt': 'old\n', ...many })
      r.write(Object.fromEntries(Object.keys(many).map((f) => [f, 'loosened\n'])))
      const verdict = redOnBase({ repo: r.dir, base: r.base, refactor: true, run: alwaysGreen })
      expect(verdict.ok).toBe(false)
      expect(verdict.lines.join('\n').length).toBeLessThanOrEqual(1200)
      expect(verdict.lines[0]).toMatch(/^FAIL red-on-base: .*edits an existing test: packages\/p\/tests\//)
      expect(verdict.lines.at(-1)).toMatch(/^FAIL red-on-base: and \d+ more file verdict\(s\) not shown within the output bound, \d+ of them failed$/)
    })

    it('passes when no existing test changed, a test it adds never run on the base', async () => {
      const r = repository({ 'feature.txt': 'old\n', 'packages/p/tests/a.spec.ts': 'one\n' })
      r.write({ 'feature.txt': 'old again\n', 'packages/p/tests/new.spec.ts': 'more\n' })
      let ran = 0
      const verdict = redOnBase({ repo: r.dir, base: r.base, refactor: true, run: (dir, files) => { ran++; return alwaysGreen(dir, files) } })
      expect(verdict.ok).toBe(true)
      expect(ran).toBe(0)
    })
  })
})
