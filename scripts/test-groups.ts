/**
 * The main test suite by functional group (docs/engineering/testing.md#test-groups), and the
 * groups a change affects, read from the package graph. A change runs its groups and `pnpm check`;
 * a big update (a contract, seam, or schema change, a batch integration, a release) runs the full
 * gate: `pnpm check`, `pnpm test`, `pnpm test:e2e`, `pnpm test:crash`.
 *
 * - `tsx scripts/test-groups.ts group [<name>...] [-- <vitest args>]`: run those groups' tests; with
 *   no name, list the groups.
 * - `tsx scripts/test-groups.ts affected [--base <ref>] [--dry-run] [-- <vitest args>]`: run the
 *   groups the files changed since `<ref>` (default `origin/main`, else `main`) affect, committed or
 *   not, and nothing more.
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
 * file, CI, or any path no rule places affects every group (fail closed); a spike affects none
 * (spikes are not part of the suite).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

export interface Group { about: string; packages: readonly string[]; paths?: readonly string[] }

/** The groups, by package directory name (as in `scripts/gen-packages.ts`); every package is in one. */
export const GROUPS: Readonly<Record<string, Group>> = {
  kernel: {
    about: 'the ledger of record and the gates beneath every other group: the store, artifacts, the event log, leases, the credentials vault, turn receipts, egress, and the plugin host',
    packages: ['store', 'artifacts', 'event-log', 'leases', 'credentials-vault', 'turn-receipts', 'egress', 'plugin-host-core', 'plugin-host'],
  },
  workflow: {
    about: 'the workflow engine, the board, approvals, resources, digests, worker sessions, the feedback-loop seams, and the profiles that contribute templates',
    packages: ['workflow', 'board-core', 'board', 'approvals-core', 'approvals', 'resources-core', 'resources', 'digest-core', 'digest', 'digest-extractive', 'worker-sessions', 'experiments-core', 'evaluations-core', 'profile-software-development', 'profile-scientific-research'],
  },
  workers: {
    about: 'routing and the Worker sources behind it: agent runtimes and agent Workers, and model Workers',
    packages: ['workers-core', 'workers', 'agent-runtime-core', 'agent-runtimes', 'runtime-claude-agent-sdk', 'runtime-codex-sdk', 'runtime-acp', 'runtime-antigravity-cli', 'agent-workers', 'models-core', 'models'],
  },
  websites: {
    about: 'website Workers: the provider runtime, the display and the browser, accounts and login, the drivers and their fake sites, and turns',
    packages: ['provider-core', 'ui-ops', 'display-virtual', 'browser-patchright', 'accounts', 'login', 'providers', 'provider-chatgpt-web', 'provider-gemini-web', 'turns'],
  },
  surfaces: {
    about: 'what the operator and clients reach: the MCP server, the gateways, the web UI, the report, the CLI, and the bundle that composes everything',
    packages: ['gateway-core', 'gateway-turns', 'gateway-anthropic', 'gateway-responses', 'mcp-server', 'web-ui', 'report', 'cli', 'system-bundle'],
  },
  libs: {
    about: 'the libraries, the schemas, and the repository scripts with their repository-wide checks',
    packages: ['libs', 'statistics', 'schemas'],
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

export interface Affected { groups: string[]; everything?: string; changed: string[] }

/** The groups the changed paths affect; `everything` names the path that affects every group, `changed` the nodes changed. */
export function affected(changed: readonly string[], all: Package[] = packages(), deps: Graph = graph(all)): Affected {
  const names = Object.keys(GROUPS)
  const touched = new Set<string>()
  // Documentation and changesets are read by the repository checks alone (the scripts' tests).
  let repository = false
  for (const path of changed) {
    if (path.startsWith('spikes/')) continue
    if (EVERYTHING.some((re) => re.test(path))) return { groups: names, everything: path, changed: [] }
    const pkg = packageAt(all, path)
    if (pkg) touched.add(side(pkg, path))
    else if (path.startsWith('docs/') || /^[^/]+\.md$/.test(path) || path.startsWith('.changeset/')) repository = true
    else return { groups: names, everything: path, changed: [] }
  }
  // Every node that depends on a changed one, transitively.
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
  // A changed package's data files reach what locates them, and no further.
  const changedPackages = new Set([...touched].map((node) => node.split(':')[0]!))
  for (const [from, set] of deps.reads) if ([...set].some((id) => changedPackages.has(id))) reached.add(from)
  // The scripts' tests check the whole repository (architecture rules, manifests, docs, records):
  // any change runs their group.
  if (touched.size || repository) reached.add('scripts:test')
  const ids = new Set([...reached].map((node) => node.split(':')[0]!))
  // A package no group names would have its tests skipped: run everything instead.
  const orphan = [...ids].find((id) => !groupOf(id))
  if (orphan) return { groups: names, everything: `${all.find((p) => p.id === orphan)?.path ?? orphan} (in no test group)`, changed: [...touched].sort() }
  return { groups: names.filter((name) => [...ids].some((id) => groupOf(id) === name)), changed: [...touched].sort() }
}

/** The paths changed since the merge base of `base` and HEAD: committed, staged, unstaged, and untracked. */
export function changedSince(base: string): string[] {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const mergeBase = git('merge-base', base, 'HEAD').trim()
  return [...new Set([...git('diff', '--name-only', mergeBase).split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean))].sort()
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
function vitest(filterList: string[], extra: string[]): number {
  // vitest exports no path to its CLI: run the root devDependency's, as `pnpm test` does.
  return spawnSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...filterList, ...extra], { cwd: root, stdio: 'inherit' }).status ?? 1
}

function main(argv: string[]): number {
  const split = argv.indexOf('--')
  const [command, ...rest] = split >= 0 ? argv.slice(0, split) : argv
  const extra = split >= 0 ? argv.slice(split + 1) : []
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
  if (command === 'affected') {
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
    if (rest.includes('--dry-run') || !result.groups.length) return 0
    return vitest(result.groups.length === names.length ? [] : result.groups.flatMap((name) => filters(name, all)), extra)
  }
  console.error('usage: test-groups.ts group [<name>...] [-- <vitest args>] | affected [--base <ref>] [--dry-run] [-- <vitest args>]')
  return 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)))
