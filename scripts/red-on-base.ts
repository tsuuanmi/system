/**
 * The check `red-on-base` (T306c, ADR-0079; `pnpm check:red-on-base`): a test that passes on the tree
 * its change started from proves nothing of the change. The test files a result adds or changes are run
 * on the result's base tree (the commit its worktree was cut at, `SYSTEM_CHECK_BASE`, set by
 * agent-workers) with the result's tests copied over; each must be red there (a test file that cannot
 * load, a missing module, is red) and green on the result. A file the runner reported nothing of (it
 * never started, or its configuration failed first) is no evidence, and fails the check. It prints the
 * end of both runs' output, then exits 0 when every file is red then green, and 1 with one
 * `FAIL red-on-base: …` line per test file that is not, naming the file and its tests.
 *
 * A result that changes no code has nothing for the base to lack (documents alone, or tests alone: the
 * code under test is already there), and passes. A refactor (`SYSTEM_CHECK_REFACTOR=1`, set when the
 * task's criteria say `refactor: no behaviour change`) is held to the opposite: no existing test file
 * may be changed or deleted, and it is never run on the base; the `tests` check runs the related suite.
 *
 * The base tree is a `git archive` of the base commit in a temporary directory, its `node_modules`
 * mirrored from the result's tree link by link, workspace packages pointing at the base tree's own
 * sources, so that nothing the result added is seen from the base. The result's tree is only read.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What a run of some test files came to: each file, whether the runner reported it failed (a failing
 * test, or a file that could not load, a missing module), the tests that passed and failed in it; a
 * file the runner reported nothing of (it never started, or crashed before loading it) is `notRun`,
 * never `failed`: no evidence either way.
 */
export interface TestRun {
  files: Array<{ path: string; failed: boolean; passed: string[]; failedTests: string[]; notRun?: true }>
  /** What the run printed, the end of it: the check prints it, so it reaches the dossier with the verdict. */
  output: string
  /** The runner's exit code; null when it ended on a signal or did not start. */
  exitCode?: number | null
}

/** Runs the test files `files` (repository-relative) of the tree in `dir`. */
export type Runner = (dir: string, files: string[]) => TestRun

export interface Verdict {
  ok: boolean
  /** The lines to print: `FAIL red-on-base: …` for each problem, `red-on-base: …` for the rest. */
  lines: string[]
}

interface Change { status: 'A' | 'M' | 'D'; path: string }

const SPEC = /\.spec\.[cm]?[jt]sx?$/
const isTest = (path: string): boolean => SPEC.test(path) || /(^|\/)tests\//.test(path)
/** Documents, changesets, and the dot-files a command sandbox leaves in a worktree (but for `.github/`): read by nothing that runs. */
const isDocument = (path: string): boolean => path.startsWith('docs/') || path.startsWith('.changeset/') || path.endsWith('.md') || (path.startsWith('.') && !path.startsWith('.github/'))

/** The paths that differ between `base` and the tree in `repo`: committed, staged, unstaged, and untracked. */
function changesSince(repo: string, base: string): Change[] {
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
  const changes = new Map<string, Change>()
  const diff = git('diff', '--name-status', '--no-renames', '-z', base).split('\0')
  for (let i = 0; i + 1 < diff.length; i += 2) {
    const status = diff[i]!.slice(0, 1)
    if (status === 'A' || status === 'M' || status === 'D') changes.set(diff[i + 1]!, { status, path: diff[i + 1]! })
  }
  for (const path of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) changes.set(path, { status: 'A', path })
  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** The base tree's directories (at most three deep, never `node_modules` or `.git`) that the result's tree gave a `node_modules`. */
function mirrorModules(from: string, to: string, fromRoot: string, toRoot: string, depth = 0): void {
  const modules = join(from, 'node_modules')
  if (existsSync(modules)) {
    mkdirSync(join(to, 'node_modules'), { recursive: true })
    const link = (source: string, target: string): void => {
      let real: string
      try {
        real = realpathSync(source)
      } catch {
        return
      }
      // A workspace package is the base tree's own copy; everything else (the store's packages) is shared as it is.
      const inside = real.startsWith(fromRoot + sep) && !real.includes(`${sep}node_modules${sep}`)
      symlinkSync(inside ? join(toRoot, relative(fromRoot, real)) : real, target)
    }
    for (const name of readdirSync(modules)) {
      if (name.startsWith('.')) continue
      if (name.startsWith('@')) {
        mkdirSync(join(to, 'node_modules', name), { recursive: true })
        for (const sub of readdirSync(join(modules, name))) link(join(modules, name, sub), join(to, 'node_modules', name, sub))
      } else link(join(modules, name), join(to, 'node_modules', name))
    }
  }
  if (depth >= 3) return
  for (const entry of readdirSync(to, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') mirrorModules(join(from, entry.name), join(to, entry.name), fromRoot, toRoot, depth + 1)
  }
}

/** The base commit's files in a new directory, with the result's test files copied over them. */
function baseTree(repo: string, base: string, tests: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'system-red-on-base-tree-'))
  try {
    const archive = execFileSync('git', ['-C', repo, 'archive', '--format=tar', base], { maxBuffer: 1 << 30 })
    execFileSync('tar', ['-x', '-C', dir], { input: archive })
    mirrorModules(realpathSync(repo), dir, realpathSync(repo), dir)
    for (const path of tests) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      copyFileSync(join(repo, path), join(dir, path))
    }
    return dir
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

/** vitest's own report, as the runner reads it. */
interface Report { testResults?: Array<{ name: string; status: string; message?: string; assertionResults?: Array<{ fullName: string; status: string }> }> }

/**
 * How much the check prints in all (INV-9): the record of a check keeps the last 4000 characters of
 * what its command printed (agent-workers `CHECK_OUTPUT_TAIL`), and the package runner adds a few lines
 * of its own around the script's. Everything the check prints, both runs' output and the verdicts,
 * fits this budget, so the record and the dossier keep all of it.
 */
const PRINT_BUDGET = 3600
/** The verdict lines' share of the budget, and each line's bound; the runs' output takes the rest. */
const VERDICT_CHARS = 1200
const VERDICT_LINE_CHARS = 240

/**
 * Runs the test files with the vitest of the tree's own `node_modules`: its default report is the
 * output, its JSON report what each file came to. No JSON report (vitest did not start, or its
 * configuration failed before it loaded a test) reports nothing of any file: each is `notRun`.
 */
const vitestRunner: Runner = (dir, files) => {
  const out = mkdtempSync(join(tmpdir(), 'system-red-on-base-out-'))
  try {
    const report = join(out, 'report.json')
    // Neither the check's scope nor a parent vitest's own variables reach the run; no colours in what is printed.
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'SYSTEM_CHECK_SCOPE' && !key.startsWith('VITEST') && key !== 'FORCE_COLOR'))
    env['NO_COLOR'] = '1'
    const ran = spawnSync(process.execPath, [join(dir, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...files, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`], { cwd: dir, encoding: 'utf8', env, maxBuffer: 1 << 28 })
    const output = `${ran.stdout ?? ''}${ran.stderr ?? ''}${ran.error ? `\n${ran.error.message}` : ''}`
    let parsed: Report = {}
    try {
      parsed = JSON.parse(readFileSync(report, 'utf8')) as Report
    } catch {
      // No report: no file is known to have run, and the output says why.
    }
    const real = realpathSync(dir)
    const byPath = new Map((parsed.testResults ?? []).map((r) => [relative(real, r.name), r]))
    return {
      output, exitCode: ran.status,
      files: files.map((path) => {
        const found = byPath.get(path)
        // A file the run did not report did not run: it is evidence of nothing, neither red nor green.
        if (!found) return { path, failed: false, passed: [], failedTests: [], notRun: true as const }
        const tests = found.assertionResults ?? []
        return { path, failed: found.status !== 'passed', passed: tests.filter((t) => t.status === 'passed').map((t) => t.fullName), failedTests: tests.filter((t) => t.status === 'failed').map((t) => t.fullName) }
      }),
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

const named = (tests: readonly string[]): string => (tests.length ? ` (${tests.slice(0, 5).join('; ')}${tests.length > 5 ? `; and ${tests.length - 5} more` : ''})` : '')

/** How many characters lines take as printed, one per line with its newline. */
const printedSize = (lines: readonly string[]): number => lines.reduce((n, l) => n + l.length + 1, 0)

/** A line cut to `chars`, marked when cut. */
const cut = (line: string, chars: number): string => (line.length > chars ? `${line.slice(0, chars - 1)}…` : line)

/**
 * The verdict lines as the check prints them, within {@link VERDICT_CHARS}: each cut to
 * {@link VERDICT_LINE_CHARS}, the `FAIL` lines first, then the rest; what does not fit is counted in
 * one closing line, which says how many of those failed, so a failure is never hidden by the bound.
 */
function verdictBlock(verdicts: readonly string[]): string[] {
  const ordered = [...verdicts.filter((v) => v.startsWith('FAIL')), ...verdicts.filter((v) => !v.startsWith('FAIL'))].map((v) => cut(v, VERDICT_LINE_CHARS))
  // Room for the closing line, whenever one may be needed.
  const room = VERDICT_CHARS - 120
  const shown: string[] = []
  for (const line of ordered) {
    if (printedSize([...shown, line]) > room) break
    shown.push(line)
  }
  const left = ordered.slice(shown.length)
  const failed = left.filter((v) => v.startsWith('FAIL')).length
  if (!left.length) return shown
  return [...shown, `${failed ? 'FAIL red-on-base: and' : 'red-on-base: and'} ${left.length} more file verdict(s) not shown within the output bound, ${failed} of them failed`]
}

/** The heading of a run's output: where it ran and its exit code. */
const headingOf = (where: string, run: TestRun): string => `--- red-on-base: the run on ${where} (exit ${run.exitCode === undefined ? 'unknown' : run.exitCode ?? 'none'}), the end of its output:`

/** A run's output as the check prints it: its heading, then the end of what it printed, within `chars`. */
function outputOf(heading: string, run: TestRun, chars: number): string[] {
  const text = run.output.trim()
  const tail = text.length > chars ? `…${text.slice(-(chars - 1))}` : text
  return [heading, ...(tail ? tail.split('\n') : ['(it printed nothing)'])]
}

/**
 * Everything the check prints after running the tests, within {@link PRINT_BUDGET}: both runs' output
 * first, the verdicts last (the record keeps the end). The verdicts take what they need of their share,
 * and the two runs share the rest equally, so neither run's output is ever pushed out by the verdicts.
 */
function printed(base: { where: string; run: TestRun }, result: { where: string; run: TestRun }, verdicts: readonly string[]): string[] {
  const block = verdictBlock(verdicts)
  const headings = [headingOf(base.where, base.run), headingOf(result.where, result.run)]
  // Each run's tail is printed with the line breaks it holds, and at most one more line ("(it printed nothing)" or the "…").
  const share = Math.floor((PRINT_BUDGET - printedSize(block) - printedSize(headings)) / 2) - 2
  return [...outputOf(headings[0]!, base.run, share), ...outputOf(headings[1]!, result.run, share), ...block]
}

/**
 * The check on the tree in `repo`, whose change started from commit `base`: `refactor` holds it to no
 * existing test changed; otherwise each test file it adds or changes must fail on the base tree (with
 * the result's tests copied over it) and pass on the result. `run` runs test files in a tree.
 */
export function redOnBase(options: { repo: string; base: string; refactor: boolean; run?: Runner }): Verdict {
  const { repo, base, refactor, run = vitestRunner } = options
  const changes = changesSince(repo, base)
  const tests = changes.filter((c) => isTest(c.path))
  if (refactor) {
    const edited = tests.filter((c) => c.status !== 'A')
    // One line per test it changed, within the same bound as any verdict: however many, the record keeps the lines.
    if (edited.length) return { ok: false, lines: verdictBlock(edited.map((c) => `FAIL red-on-base: the result of a refactor (no behaviour change) ${c.status === 'M' ? 'edits' : 'deletes'} an existing test: ${c.path}`)) }
    return { ok: true, lines: [`red-on-base: a refactor (no behaviour change): no existing test changed (${tests.length} test file(s) added); the related tests run as the tests check`] }
  }
  if (!changes.some((c) => !isTest(c.path) && !isDocument(c.path))) {
    return { ok: true, lines: [`red-on-base: ${changes.some((c) => isTest(c.path)) ? 'only tests' : 'only documents'} changed: no code for the base to lack`] }
  }
  const present = tests.filter((c) => c.status !== 'D')
  const specs = present.filter((c) => SPEC.test(c.path)).map((c) => c.path)
  if (!specs.length) return { ok: false, lines: ['FAIL red-on-base: the result changes code and adds or changes no test file: a change of behaviour shows its criteria in tests that fail without it'] }
  const dir = baseTree(repo, base, present.map((c) => c.path))
  try {
    const onBase = run(dir, specs)
    const onResult = run(repo, specs)
    const verdicts: string[] = []
    for (const path of specs) {
      const before = onBase.files.find((f) => f.path === path)
      const after = onResult.files.find((f) => f.path === path)
      // A file a runner reported nothing of is no evidence: never read as red on the base, nor green on the result.
      if (!after || after.notRun) verdicts.push(`FAIL red-on-base: ${path} did not run on the result: the runner reported nothing of it (see its output above)`)
      else if (after.failed) verdicts.push(`FAIL red-on-base: ${path} fails on the result${named(after.failedTests)}: a test that fails there proves nothing`)
      else if (!before || before.notRun) verdicts.push(`FAIL red-on-base: ${path} did not run on the base tree: the runner reported nothing of it (it did not start, or failed before loading the file; see its output above), so nothing shows it fails there`)
      else if (!before.failed) verdicts.push(`FAIL red-on-base: ${path} passes on the base tree${named(before.passed)}: it proves nothing of the change`)
      else verdicts.push(`red-on-base: ${path} fails on the base tree${named(before.failedTests)} and passes on the result${named(after.passed)}`)
    }
    // Both runs' output and the verdicts, within the budget the check's record keeps whole.
    return { ok: !verdicts.some((l) => l.startsWith('FAIL')), lines: printed({ where: `the base tree ${base}`, run: onBase }, { where: 'the result', run: onResult }, verdicts) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function main(): number {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const base = process.env['SYSTEM_CHECK_BASE']
  if (!base || !/^[0-9a-f]{7,64}$/.test(base)) {
    console.error('FAIL red-on-base: no commit the run\'s worktree was cut at (SYSTEM_CHECK_BASE), so there is no base tree to run the tests on')
    return 2
  }
  const verdict = redOnBase({ repo, base, refactor: process.env['SYSTEM_CHECK_REFACTOR'] === '1' })
  for (const line of verdict.lines) console.log(line)
  return verdict.ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
