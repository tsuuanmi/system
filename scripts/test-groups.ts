/**
 * The main test suite by functional group (docs/engineering/testing.md#test-groups), and the
 * groups a change affects, read from the package graph. A change runs its groups and `pnpm check`;
 * a big update (a contract, seam, or schema change, a batch integration, a release) runs the full
 * gate: `pnpm check`, `pnpm test`, `pnpm test:e2e`, `pnpm test:crash`.
 *
 * - `node --import tsx scripts/test-groups.ts group [<name>...] [-- <vitest args>]`: run those groups' tests; with
 *   no name, list the groups.
 * - `node --import tsx scripts/test-groups.ts affected [--base <ref>] [--dry-run] [-- <vitest args>]`: run the
 *   groups the files changed since `<ref>` (default `origin/main`, else `main`) affect, committed or
 *   not, and nothing more. Under a check (`SYSTEM_CHECK_SCOPE`, set by agent-workers, T299) it runs
 *   instead the tests related to those files (`acceptance`) or the whole suite (`landing`).
 * - `node --import tsx scripts/test-groups.ts related <file>… [--dry-run] [--] [<vitest args>]`: run the test
 *   files related to those files (T299): each given test file, and for any other file the tests of
 *   its package and of every package that depends on it; the whole suite when a file is shared
 *   configuration (`package.json`, the lockfile, `tsconfig*.json`, `vitest*.ts`).
 *
 * The graph has two nodes per package: its code (`src/`, and what its `package.json` depends on)
 * and its tests (everything else: tests, conformance suites, fixtures). A node depends on what its
 * files import or locate as code with `new URL`, by package name (a package's code) or by relative
 * path (whichever side of that package the path is in), and transitively on what that depends on;
 * a package's tests depend on its code. A change reaches every node that depends on a changed one,
 * and the tests of every package that locates a changed package's data file (`new URL` to a
 * configuration or a fixture), that far and no further. A group is affected when the tests of one
 * of its packages are reached. The repository scripts' tests check the whole repository, so every
 * change affects their group. A schema reaches every package through libs; a root configuration
 * file, CI, or any path no rule places affects every group (fail closed).
 *
 * Browser tests (T305: each test gated on a browser by `browser-patchright/tests/support.ts`) run only
 * when the change touches what they exercise: a package of the browser stack (`BROWSER_STACK`), their
 * own file, or a helper in their tests directory; a change that affects everything runs them all.
 * Otherwise the run sets `SYSTEM_SKIP_BROWSER_TESTS=1` and each such test is skipped, while the plain
 * tests beside it run; a spec whose every test is gated (`browserSpecs`) is not even selected. This
 * holds for `related` (the acceptance), for `affected` by hand (`--all-browser` runs them all), and
 * for the landing's whole suite, given the run's starting commit. The daily run of every browser
 * spec on dev's tip inside System (T305b, `workflow`'s `dailyCheck`) is a check of scope `daily`:
 * the whole suite and every browser test with it.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sandboxPlaceholder } from '../packages/libs/src/subjects.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

export interface Group { about: string; packages: readonly string[]; paths?: readonly string[] }

/** The groups, by package directory name (as in `scripts/gen-packages.ts`); every package is in one. */
export const GROUPS: Readonly<Record<string, Group>> = {
  kernel: {
    about: 'the ledger of record and the gates beneath every other group: the store, artifacts, the event log, leases, the credentials vault, turn receipts, egress, and the plugin host',
    packages: ['ledger-core', 'store', 'artifacts', 'event-log', 'leases', 'credentials-vault', 'turn-receipts', 'egress', 'plugin-host-core', 'plugin-host'],
  },
  workflow: {
    about: 'the workflow engine, the board, approvals, resources, digests, landing, worker sessions, the feedback-loop seams, and the profiles that contribute templates',
    packages: ['workflow', 'board-core', 'board', 'approvals-core', 'approvals', 'resources-core', 'resources', 'digest-core', 'digest', 'digest-extractive', 'decision-core', 'landing-core', 'landing-local', 'worker-sessions', 'feedback-core', 'profile-software-development', 'profile-scientific-research'],
  },
  workers: {
    about: 'routing and the Worker sources behind it: agent runtimes and agent Workers, and model Workers',
    packages: ['workers-core', 'workers', 'agent-runtime-core', 'agent-runtimes', 'runtime-claude-agent-sdk', 'runtime-codex-sdk', 'runtime-acp', 'runtime-antigravity-cli', 'agent-workers', 'workers-fake', 'models-core', 'models'],
  },
  websites: {
    about: 'website Workers: the provider runtime, the display and the browser, accounts and login, the drivers and their fake sites, and turns',
    packages: ['provider-core', 'ui-ops', 'display-virtual', 'browser-patchright', 'accounts', 'login', 'providers', 'provider-chatgpt-web', 'provider-gemini-web', 'turns'],
  },
  surfaces: {
    about: 'what the operator and clients reach: the MCP server, the gateways, notifications, the web UI, the report, the CLI, and the bundle that composes everything',
    packages: ['gateway-core', 'gateway-turns', 'gateway-anthropic', 'gateway-responses', 'mcp-server', 'notify', 'lead-inbox', 'web-ui', 'report', 'cli', 'system-bundle'],
  },
  libs: {
    about: 'the libraries, the schemas, and the repository scripts with their repository-wide checks',
    packages: ['libs', 'schemas'],
    paths: ['scripts/'],
  },
}

/** Root files whose change affects every group: what composes, installs, builds, or runs the suite, and CI. */
const EVERYTHING = [/^package\.json$/, /^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/, /^tsconfig[^/]*\.json$/, /^vitest[^/]*\.ts$/, /^\.github\//, /^\.gitignore$/]

export interface Package { id: string; path: string; name?: string; src: boolean }

/** Every workspace package, by directory name, and the repository scripts as one more. */
export function packages(): Package[] {
  const out: Package[] = [{ id: 'schemas', path: 'schemas/', name: '@tsuuanmi/system-schemas', src: false }, { id: 'scripts', path: 'scripts/', src: false }]
  for (const [base, prefix] of [['packages', 'packages/'], ['packages/plugins', 'packages/plugins/']] as const) {
    for (const dir of readdirSync(join(root, base)).sort()) {
      const manifest = join(root, base, dir, 'package.json')
      if (dir === 'plugins' || !existsSync(manifest)) continue
      out.push({ id: dir, path: `${prefix}${dir}/`, name: (JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name, src: existsSync(join(root, base, dir, 'src')) })
    }
  }
  return out
}

/** The package a repository path is in, if any. */
const packageAt = (all: Package[], path: string): Package | undefined => all.filter((p) => path.startsWith(p.path)).sort((a, b) => b.path.length - a.path.length)[0]

/**
 * The node a path of a package is in: `<id>:src` for its code (`src/` and `package.json`; for the
 * schemas and the scripts, which have no `src/`, every file but a test), `<id>:test` for the rest.
 */
export function side(pkg: Package, path: string): string {
  const own = path.slice(pkg.path.length)
  const code = pkg.src ? own.startsWith('src/') || own === 'package.json' : !own.endsWith('.spec.ts')
  return `${pkg.id}:${code ? 'src' : 'test'}`
}

function files(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files(path, out)
    else if (/\.(ts|mts|mjs|js|cjs)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path)
  }
  return out
}

export interface Graph {
  /** What each node depends on, transitively through what those depend on. */
  imports: Map<string, Set<string>>
  /** The packages whose data files each node locates (`new URL` to a non-code file): a direct dependency only. */
  reads: Map<string, Set<string>>
}

export function graph(all: Package[] = packages()): Graph {
  const byName = new Map(all.filter((p) => p.name).map((p) => [p.name!, p.id]))
  const imports = new Map<string, Set<string>>()
  const reads = new Map<string, Set<string>>()
  const add = (map: Map<string, Set<string>>, from: string, to: string): void => {
    if (from !== to) map.set(from, new Set([...(map.get(from) ?? []), to]))
  }
  for (const pkg of all) {
    add(imports, `${pkg.id}:test`, `${pkg.id}:src`)
    const manifest = join(root, pkg.path, 'package.json')
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, Record<string, string> | undefined>
      for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
        for (const name of Object.keys(json[field] ?? {})) {
          if (byName.has(name)) add(imports, `${pkg.id}:${field === 'devDependencies' ? 'test' : 'src'}`, `${byName.get(name)!}:src`)
        }
      }
    }
    for (const file of files(join(root, pkg.path))) {
      const from = side(pkg, relative(root, file).split(sep).join('/'))
      for (const m of readFileSync(file, 'utf8').matchAll(/(\bfrom\s*|\bimport\(\s*|\brequire\(\s*|\bnew URL\(\s*)['"]([^'"]+)['"]/g)) {
        const spec = m[2]!
        const named = /^(@tsuuanmi\/[^/]+)/.exec(spec)?.[1]
        if (named) {
          if (byName.has(named)) add(imports, from, `${byName.get(named)!}:src`)
          continue
        }
        if (!spec.startsWith('.')) continue
        const path = relative(root, resolve(dirname(file), spec)).split(sep).join('/')
        const target = packageAt(all, path)
        if (!target) continue
        if (m[1]!.startsWith('new URL') && !/\.(ts|mts|mjs|js|cjs)$/.test(spec)) add(reads, from, target.id)
        else add(imports, from, side(target, path))
      }
    }
  }
  return { imports, reads }
}

/** The group a package's tests are in, if any (the scripts' are libs'). */
export function groupOf(id: string): string | undefined {
  for (const [name, group] of Object.entries(GROUPS)) {
    if (group.packages.includes(id) || (id === 'scripts' && group.paths?.includes('scripts/'))) return name
  }
  return undefined
}

/** The vitest filters that select a group's test files: its packages' directories and its paths. */
export function filters(name: string, all: Package[] = packages()): string[] {
  const group = GROUPS[name]!
  return [...group.packages.map((id) => all.find((p) => p.id === id)?.path ?? `(no package ${id})`), ...(group.paths ?? [])]
}

/**
 * The nodes a change to `touched` reaches: every node that depends on a touched one, transitively,
 * and the nodes that locate a touched package's data file, that far and no further.
 */
function reach(touched: ReadonlySet<string>, deps: Graph): Set<string> {
  const dependents = new Map<string, string[]>()
  for (const [from, set] of deps.imports) for (const to of set) dependents.set(to, [...(dependents.get(to) ?? []), from])
  const reached = new Set(touched)
  const queue = [...touched]
  while (queue.length) {
    for (const next of dependents.get(queue.shift()!) ?? []) {
      if (reached.has(next)) continue
      reached.add(next)
      queue.push(next)
    }
  }
  const changedPackages = new Set([...touched].map((node) => node.split(':')[0]!))
  for (const [from, set] of deps.reads) if ([...set].some((id) => changedPackages.has(id))) reached.add(from)
  return reached
}

/** Shared configuration, in any directory: a change to one widens the related tests to the whole suite (T299). */
const SHARED_CONFIGURATION = /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|vitest[^/]*\.ts)$/

/** The test files of the main suite (`vitest.config.ts` includes): the scripts' and each package's `tests/`. */
export function specFiles(): string[] {
  return [...files(join(root, 'scripts')), ...files(join(root, 'packages'))]
    .map((file) => relative(root, file).split(sep).join('/'))
    .filter((path) => path.endsWith('.spec.ts') && (path.startsWith('scripts/') || path.includes('/tests/')))
    .sort()
}

/**
 * The packages of the browser stack (T305): Chrome through patchright, its display, the page engine,
 * the login desktop, the two drivers with their fake sites, turns, and the web UI. A change in one of
 * them runs every browser spec; a change anywhere else runs only the browser specs it touches itself.
 */
export const BROWSER_STACK: readonly string[] = ['browser-patchright', 'display-virtual', 'ui-ops', 'login', 'provider-chatgpt-web', 'provider-gemini-web', 'turns', 'web-ui']

/**
 * The variable a run sets to leave its browser tests out (T305), read by
 * `browser-patchright/tests/support.ts`: every test gated on it (`canRunBrowser`, `headlessIt`,
 * `browserUnavailable`) is skipped, one test at a time, so the in-process tests that share a file with
 * browser tests still run.
 */
export const SKIP_BROWSER_TESTS_ENV = 'SYSTEM_SKIP_BROWSER_TESTS'

/** A browser test's mark: the gate of `browser-patchright/tests/support.ts` it is written with. */
const BROWSER_GATE = /\b(canRunBrowser|headlessIt|browserUnavailable)\b/

/**
 * Whether a spec's source is a browser spec as a whole: every test of the file is gated on a browser
 * (`describe.runIf(canRunBrowser…)`). Such a file a run that leaves its browser tests out does not
 * even collect; a file that also holds plain tests is collected, and only its gated tests skipped.
 */
export function isBrowserSpec(source: string): boolean {
  const top = source.match(/^(describe|it|test)\b[^\n]*/gm) ?? []
  return top.length > 0 && top.every((line) => /^describe\.runIf\(canRunBrowser\b/.test(line))
}

/** Every browser spec of the suite as a whole (a package's spec whose every test is gated on a browser), repository-relative. */
export function browserSpecs(): string[] {
  return specFiles().filter((path) => path.startsWith('packages/') && isBrowserSpec(readFileSync(join(root, path), 'utf8')))
}

/** Every package's spec that holds a browser test (one gated on a browser), whole or beside plain tests. */
export function specsWithBrowserTests(): string[] {
  return specFiles().filter((path) => path.startsWith('packages/') && BROWSER_GATE.test(readFileSync(join(root, path), 'utf8')))
}

/**
 * What a run does with its browser tests for a change (T305): `leaveOut` when the change touches no
 * package of the browser stack and is not `every` (a change that affects everything, or the daily
 * run); then only a spec it `touched` (its own file, or a helper in its tests directory changed) runs
 * its browser tests.
 */
export function browserPlan(changed: readonly string[], opts: { every?: boolean; all?: Package[] } = {}): { leaveOut: boolean; touched: (spec: string) => boolean } {
  const all = opts.all ?? packages()
  const helperDirs = changed.filter((path) => /\/tests\/[^/]+\.ts$/.test(path) && !path.endsWith('.spec.ts')).map((path) => path.slice(0, path.lastIndexOf('/') + 1))
  const touched = (spec: string): boolean => changed.includes(spec) || helperDirs.some((dir) => spec.startsWith(dir))
  const leaveOut = !opts.every && !changed.some((path) => BROWSER_STACK.includes(packageAt(all, path)?.id ?? ''))
  return { leaveOut, touched }
}

/** The whole-file browser specs a change does not touch, which a run does not collect (T305). */
export function skippedBrowserSpecs(changed: readonly string[], opts: { every?: boolean; all?: Package[]; specs?: readonly string[] } = {}): string[] {
  const plan = browserPlan(changed, opts)
  return plan.leaveOut ? (opts.specs ?? browserSpecs()).filter((spec) => !plan.touched(spec)) : []
}

/** The vitest arguments that leave `specs` out. */
const excluding = (specs: readonly string[]): string[] => specs.flatMap((spec) => ['--exclude', spec])

export interface Related { tests: string[]; everything?: string; changed: string[] }

/**
 * The test files related to the changed paths (T299): each changed test file; and, for any other
 * changed file, the tests of its package and of every package that depends on it, through the graph
 * (`affected` names the groups of the same reach). The scripts' tests, which check the whole
 * repository, run for any change but a test file's. Shared configuration (`package.json` anywhere,
 * the lockfile, `tsconfig*.json`, `vitest*.ts`, CI) and a path no rule places select the whole
 * suite: `everything` names it, and `tests` is then every test file.
 */
export function related(changed: readonly string[], all: Package[] = packages(), deps: Graph = graph(all), suite: readonly string[] = specFiles(), browser: readonly string[] = browserSpecs()): Related {
  const everything = (why: string): Related => ({ tests: [...suite], everything: why, changed: [] })
  const touched = new Set<string>()
  const direct = new Set<string>()
  let repository = false
  for (const path of changed) {
    if (SHARED_CONFIGURATION.test(path) || EVERYTHING.some((re) => re.test(path))) return everything(path)
    const pkg = packageAt(all, path)
    if (!pkg) {
      if (path.startsWith('docs/') || /^[^/]+\.md$/.test(path) || path.startsWith('.changeset/')) repository = true
      else return everything(path)
    } else if (suite.includes(path)) direct.add(path)
    else touched.add(side(pkg, path))
  }
  const reached = reach(touched, deps)
  if (touched.size || repository) reached.add('scripts:test')
  // A browser spec the change does not touch is left out (T305).
  const left = new Set(skippedBrowserSpecs(changed, { all, specs: browser }))
  const tests = suite.filter((path) => !left.has(path) && (direct.has(path) || reached.has(side(packageAt(all, path)!, path))))
  return { tests, changed: [...touched].sort() }
}

/** The environment a check's command reads its scope from: `acceptance` or `landing` (set by agent-workers, T299). */
export const CHECK_SCOPE_ENV = 'SYSTEM_CHECK_SCOPE'
/** The environment an acceptance check reads the commit its run's worktree was cut at from (set by agent-workers, T299). */
export const CHECK_BASE_ENV = 'SYSTEM_CHECK_BASE'

/**
 * What a check's `test:affected` runs, by its environment (T299): none set, the affected groups as by
 * hand (`{}`); `landing`, the whole suite (`full` says why); `acceptance`, the tests related to the
 * files changed since the run's own starting commit (`base`), never since a branch the run did not
 * start on; `daily` (T305b), the whole suite with every browser test. An acceptance with no starting commit, or a scope it does not know, runs the whole suite
 * (INV-2).
 */
export function checkScope(env: Readonly<Record<string, string | undefined>>): { full?: string; base?: string; browserBase?: string } {
  const scope = env[CHECK_SCOPE_ENV]
  if (scope === undefined || scope === '') return {}
  if (scope === 'landing') {
    // The whole suite, but the browser specs the run's change does not touch (T305): read from the commit its worktree was cut at, if told.
    const base = env[CHECK_BASE_ENV]
    return { full: `${CHECK_SCOPE_ENV}=landing (the landing's tree)`, ...(base && /^[0-9a-f]{7,64}$/.test(base) ? { browserBase: base } : {}) }
  }
  // The daily run of a tip (T305b): the whole suite, every browser test with it; there is no change to read.
  if (scope === 'daily') return { full: `${CHECK_SCOPE_ENV}=daily (the daily run of a ref's tip)` }
  if (scope !== 'acceptance') return { full: `${CHECK_SCOPE_ENV}=${scope} is no scope this script knows` }
  const base = env[CHECK_BASE_ENV]
  if (!base || !/^[0-9a-f]{7,64}$/.test(base)) return { full: `${CHECK_SCOPE_ENV}=acceptance with no commit the run's worktree was cut at (${CHECK_BASE_ENV})` }
  return { base }
}

export interface Affected { groups: string[]; everything?: string; changed: string[] }

/** The groups the changed paths affect; `everything` names the path that affects every group, `changed` the nodes changed. */
export function affected(changed: readonly string[], all: Package[] = packages(), deps: Graph = graph(all)): Affected {
  const names = Object.keys(GROUPS)
  const touched = new Set<string>()
  // Documentation and changesets are read by the repository checks alone (the scripts' tests).
  let repository = false
  for (const path of changed) {
    if (EVERYTHING.some((re) => re.test(path))) return { groups: names, everything: path, changed: [] }
    const pkg = packageAt(all, path)
    if (pkg) touched.add(side(pkg, path))
    else if (path.startsWith('docs/') || /^[^/]+\.md$/.test(path) || path.startsWith('.changeset/')) repository = true
    else return { groups: names, everything: path, changed: [] }
  }
  const reached = reach(touched, deps)
  // The scripts' tests check the whole repository (architecture rules, manifests, docs, records):
  // any change runs their group.
  if (touched.size || repository) reached.add('scripts:test')
  const ids = new Set([...reached].map((node) => node.split(':')[0]!))
  // A package no group names would have its tests skipped: run everything instead.
  const orphan = [...ids].find((id) => !groupOf(id))
  if (orphan) return { groups: names, everything: `${all.find((p) => p.id === orphan)?.path ?? orphan} (in no test group)`, changed: [...touched].sort() }
  return { groups: names.filter((name) => [...ids].some((id) => groupOf(id) === name)), changed: [...touched].sort() }
}

/**
 * The paths changed since the merge base of `base` and HEAD: committed, staged, unstaged, and
 * untracked, but a command sandbox's empty placeholders (`.bashrc`, `.gitconfig`, `.claude/…`: an
 * agent's tool sandbox mounts them in the worktree, T265), which are no change of the repository.
 */
export function changedSince(base: string, dir: string = root): string[] {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  const mergeBase = git('merge-base', base, 'HEAD').trim()
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter((path) => path && !sandboxPlaceholder(dir, path))
  return [...new Set([...git('diff', '--name-only', mergeBase).split('\n'), ...untracked].filter(Boolean))].sort()
}

function defaultBase(): string {
  for (const ref of ['origin/main', 'main']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' })
      return ref
    } catch {
      // try the next
    }
  }
  throw new Error('no base to compare with: neither origin/main nor main exists; pass --base <ref>')
}

/** Run vitest on these filters (none: the whole suite), with the extra arguments; returns its exit status. */
function vitest(filterList: string[], extra: string[], env: Record<string, string> = {}): number {
  // vitest exports no path to its CLI: run the root devDependency's, as `pnpm test` does.
  return spawnSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...filterList, ...extra], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1
}

/**
 * Run these filters (none: the whole suite) for a change (T305). When the change leaves the browser
 * tests out, two runs: everything but the browser specs the change touches, with
 * {@link SKIP_BROWSER_TESTS_ENV} set, so every test that would start a browser is skipped (whole
 * browser specs not even collected); then the touched browser specs, as they are.
 */
function runFor(filterList: string[], changed: readonly string[], every: boolean, extra: string[], all: Package[]): number {
  const plan = browserPlan(changed, { every, all })
  if (!plan.leaveOut) return vitest(filterList, extra)
  const inScope = (spec: string): boolean => !filterList.length || filterList.some((f) => spec.startsWith(f))
  const keep = specsWithBrowserTests().filter((spec) => plan.touched(spec) && inScope(spec))
  const skipped = browserSpecs().filter((spec) => !plan.touched(spec))
  console.log(`browser tests left out: the change does not touch the browser stack${keep.length ? `; ${keep.length} browser spec(s) it touches run as they are` : ''}`)
  const first = vitest(filterList, [...excluding([...skipped, ...keep]), '--passWithNoTests', ...extra], { [SKIP_BROWSER_TESTS_ENV]: '1' })
  const second = keep.length ? vitest(keep, extra) : 0
  return first || second
}

/**
 * The command, its own arguments, and vitest's (after `--`). A runner may drop the `--` (a package
 * runner's `run <script> -- …`): for `group`, the group names then end at the first argument that is
 * an option or a path (none is a group's name), and the rest are vitest's; for `related`, the files
 * end at the first option (its own `--dry-run` aside).
 */
export function splitArgs(argv: readonly string[]): { command: string | undefined; rest: string[]; extra: string[] } {
  const split = argv.indexOf('--')
  if (split >= 0) return { command: argv[0], rest: argv.slice(1, split), extra: argv.slice(split + 1) }
  const [command, ...rest] = argv
  if (command === 'related') {
    // The files end at the first option but its own `--dry-run`; the rest are vitest's.
    const first = rest.findIndex((arg) => arg.startsWith('-') && arg !== '--dry-run')
    return first < 0 ? { command, rest, extra: [] } : { command, rest: rest.slice(0, first), extra: rest.slice(first) }
  }
  if (command !== 'group') return { command, rest, extra: [] }
  const end =rest.findIndex((arg) => arg.startsWith('-') || /[/.]/.test(arg))
  return end < 0 ? { command, rest, extra: [] } : { command, rest: rest.slice(0, end), extra: rest.slice(end) }
}

/** Run the tests related to `changed` (T299): all of the suite when shared configuration changed; nothing when none relates. */
function runRelated(changed: string[], dryRun: boolean, extra: string[], base?: string): number {
  const result = related(changed)
  console.log(`${base ? `changed since ${base}` : 'files given'}: ${changed.length} file(s)${result.changed.length ? `, in ${result.changed.join(', ')}` : ''}`)
  if (result.everything) console.log(`${result.everything} is shared configuration or has no rule: the full suite runs`)
  console.log(result.tests.length ? `related tests: ${result.tests.length} file(s) of ${specFiles().length}` : 'no test is related')
  if (dryRun && !result.everything) console.log(result.tests.join('\n'))
  if (dryRun || !result.tests.length) return 0
  return runFor(result.everything ? [] : result.tests, changed, !!result.everything, extra, packages())
}

function main(argv: string[]): number {
  const { command, rest, extra } = splitArgs(argv)
  const all = packages()
  if (command === 'group') {
    if (!rest.length) {
      for (const [name, group] of Object.entries(GROUPS)) console.log(`${name}: ${group.about}\n  ${filters(name, all).join(' ')}`)
      return 0
    }
    const unknown = rest.filter((name) => !GROUPS[name])
    if (unknown.length) {
      console.error(`unknown test group ${unknown.join(', ')}; the groups are ${Object.keys(GROUPS).join(', ')}`)
      return 2
    }
    return vitest(rest.flatMap((name) => filters(name, all)), extra)
  }
  if (command === 'related') {
    const given = rest.filter((arg) => arg !== '--dry-run')
    const option = given.find((arg) => arg.startsWith('-'))
    if (!given.length || option) {
      console.error(option ? `unknown option ${option}` : 'no file given')
      console.error('usage: test-groups.ts related <file>… [--dry-run] [--] [<vitest args>]')
      return 2
    }
    return runRelated(given.map((file) => relative(root, resolve(root, file)).split(sep).join('/')), rest.includes('--dry-run'), extra)
  }
  if (command === 'affected') {
    // An acceptance or landing check (agent-workers, T299) sets its scope: the landing's tree runs the
    // whole suite, once; the acceptance runs the tests related to the files the result itself changed.
    const scope = checkScope(process.env)
    if (scope.full) {
      console.log(`${scope.full}: the full suite runs${scope.browserBase ? '' : ', every browser test with it'}`)
      if (rest.includes('--dry-run')) return 0
      if (!scope.browserBase) return vitest([], extra)
      const changed = changedSince(scope.browserBase)
      return runFor([], changed, !!related(changed).everything, extra, all)
    }
    if (scope.base) return runRelated(changedSince(scope.base), rest.includes('--dry-run'), extra, scope.base)
    const at = rest.indexOf('--base')
    const base = at >= 0 ? rest[at + 1] : defaultBase()
    if (!base) {
      console.error('--base needs a ref')
      return 2
    }
    const changed = changedSince(base)
    const result = affected(changed, all)
    const names = Object.keys(GROUPS)
    console.log(`changed since ${base}: ${changed.length} file(s)${result.changed.length ? `, in ${result.changed.join(', ')}` : ''}`)
    if (result.everything) console.log(`${result.everything} affects every group: the full suite runs`)
    console.log(result.groups.length ? `affected groups: ${result.groups.join(', ')} (of ${names.length})` : 'no test group is affected')
    if (!result.groups.length) return 0
    if (rest.includes('--dry-run')) return 0
    return runFor(result.groups.length === names.length ? [] : result.groups.flatMap((name) => filters(name, all)), changed, rest.includes('--all-browser') || !!result.everything, extra, all)
  }
  console.error('usage: test-groups.ts group [<name>...] [-- <vitest args>] | affected [--base <ref>] [--all-browser] [--dry-run] [-- <vitest args>] | related <file>… [--dry-run] [--] [<vitest args>]')
  return 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)))
