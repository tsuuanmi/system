// Dependency rules of "everything is a plugin" (docs/architecture/plugin-model.md#package-classes).
//
// The class of every package (kernel, guarantee provider, capability, surface, profile) and the
// family a group of plugins registers into come from one table in plugin-model.md; this check reads
// it. It reads every package's imports from its `src/` (type and value apart: `import type`, an
// all-`type` specifier list, `export type … from`, and `import('x').T` are type; the rest value) and
// refuses:
//
//  - `guarantee-provider`: any import of a guarantee provider's package by another package. A seam's
//    definition belongs in a `*-core` package; a consumer imports that, never the provider.
//  - `plugin-to-plugin`: a plugin (guarantee provider, capability, surface or profile) importing another
//    plugin's package, unless both are in one family of the table. Plugins depend on the core.
//
// `scripts/dependency-baseline.json` lists today's violations, one `from -> to [rule]` per package pair.
// A violation the baseline lacks fails the check, naming the import and the rule; a baseline line that
// is no longer a violation is stale and fails too, so the baseline only shrinks (`--shrink` drops the
// stale lines; there is no way to add one). `--gen` writes docs/architecture/dependency-graph.md, which
// the check also holds up to date.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const CLASSES = ['kernel', 'guarantee', 'capability', 'surface', 'profile'] as const
export type PackageClass = (typeof CLASSES)[number]
export type Rule = 'guarantee-provider' | 'plugin-to-plugin'

const RULE_TEXT: Record<Rule, string> = {
  'guarantee-provider': "imports a guarantee provider's package: depend on its seam definition in a *-core package",
  'plugin-to-plugin': 'imports another plugin outside the family the table allows: cooperate through the core (a seam, an artifact, an event)',
}

export interface Table {
  classOf: Map<string, PackageClass>
  familyOf: Map<string, string>
}

/** The table of `### Package classes` in plugin-model.md: rows `| class | family or — | \`dir\`, … |`. */
export function parseTable(markdown: string): Table {
  const start = markdown.indexOf('### Package classes')
  if (start < 0) throw new Error('plugin-model.md has no "### Package classes" table')
  const rest = markdown.slice(start + 1)
  const end = rest.search(/\n#{1,3} /)
  const section = rest.slice(0, end < 0 ? rest.length : end)
  const table: Table = { classOf: new Map(), familyOf: new Map() }
  const problems: string[] = []
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    const cls = cells[1] as PackageClass
    if (!CLASSES.includes(cls)) continue
    const family = (cells[2] ?? '').replace(/`/g, '')
    for (const m of (cells[3] ?? '').matchAll(/`([\w-]+)`/g)) {
      const dir = m[1]!
      if (table.classOf.has(dir)) problems.push(`${dir} is in the table twice`)
      table.classOf.set(dir, cls)
      if (family && family !== '—') table.familyOf.set(dir, family)
    }
  }
  if (problems.length) throw new Error(`Package classes table:\n  ${problems.join('\n  ')}`)
  return table
}

export interface Pkg {
  dir: string
  name: string
  path: string
}

export interface Edge {
  from: string
  to: string
  /** `value` when any import of the package is a value import. */
  kind: 'type' | 'value'
  /** Source files (relative to the root) importing it, one with its import first. */
  files: string[]
}

export function packages(root: string): Pkg[] {
  const out: Pkg[] = []
  for (const [base, dirs] of [[join(root, 'packages'), (d: string) => d !== 'plugins'], [join(root, 'packages', 'plugins'), () => true]] as const) {
    if (!existsSync(base)) continue
    for (const dir of readdirSync(base).filter(dirs).sort()) {
      const file = join(base, dir, 'package.json')
      if (existsSync(file)) out.push({ dir, name: (JSON.parse(readFileSync(file, 'utf8')) as { name: string }).name, path: join(base, dir) })
    }
  }
  return out
}

function sources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(path)
  }
  return out
}

/** Every module specifier a file imports, with whether only types come through it. */
export function importsOf(text: string): Array<{ spec: string; type: boolean }> {
  const out: Array<{ spec: string; type: boolean }> = []
  const file = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
  const allTypes = (bindings: ts.NamedImportBindings | ts.NamedExportBindings | undefined): boolean =>
    !!bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly)
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      out.push({ spec: node.moduleSpecifier.text, type: !!clause && (clause.isTypeOnly || (!clause.name && allTypes(clause.namedBindings))) })
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push({ spec: node.moduleSpecifier.text, type: node.isTypeOnly || allTypes(node.exportClause) })
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      out.push({ spec: node.argument.literal.text, type: true })
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      out.push({ spec: node.arguments[0].text, type: false })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

/** The package-to-package edges of the workspace's `src/` code. */
export function scanEdges(root: string, pkgs: readonly Pkg[] = packages(root)): Edge[] {
  const edges = new Map<string, Edge>()
  for (const pkg of pkgs) {
    for (const file of sources(join(pkg.path, 'src'))) {
      for (const { spec, type } of importsOf(readFileSync(file, 'utf8'))) {
        const to = pkgs.find((p) => spec === p.name || spec.startsWith(`${p.name}/`))
        if (!to || to.dir === pkg.dir) continue
        const key = `${pkg.dir}\0${to.dir}`
        const edge = edges.get(key) ?? { from: pkg.dir, to: to.dir, kind: 'type', files: [] }
        const rel = relative(root, file)
        if (!type) {
          edge.kind = 'value'
          edge.files.unshift(rel)
        } else edge.files.push(rel)
        edges.set(key, edge)
      }
    }
  }
  return [...edges.values()].map((e) => ({ ...e, files: [...new Set(e.files)] })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
}

/** What the table lacks or names in excess, against the packages that exist. */
export function tableProblems(table: Table, pkgs: readonly Pkg[]): string[] {
  return [
    ...pkgs.filter((p) => !table.classOf.has(p.dir)).map((p) => `package ${p.dir} is not in the Package classes table of docs/architecture/plugin-model.md`),
    ...[...table.classOf.keys()].filter((d) => !pkgs.some((p) => p.dir === d)).map((d) => `the Package classes table names ${d}, which is not a package`),
  ]
}

export interface Violation {
  key: string
  rule: Rule
  edge: Edge
  message: string
}

export const keyOf = (from: string, to: string, rule: Rule): string => `${from} -> ${to} [${rule}]`

/** The rule an edge breaks, if any. */
export function ruleOf(edge: Edge, table: Table): Rule | undefined {
  const [from, to] = [table.classOf.get(edge.from), table.classOf.get(edge.to)]
  if (!from || !to) return undefined
  if (to === 'guarantee') return 'guarantee-provider'
  if (from === 'kernel' || to === 'kernel') return undefined
  const family = table.familyOf.get(edge.from)
  return family && family === table.familyOf.get(edge.to) ? undefined : 'plugin-to-plugin'
}

export function violations(edges: readonly Edge[], table: Table): Violation[] {
  const out: Violation[] = []
  for (const edge of edges) {
    const rule = ruleOf(edge, table)
    if (!rule) continue
    out.push({
      key: keyOf(edge.from, edge.to, rule),
      rule,
      edge,
      message: `${edge.files[0]} imports ${edge.to} (${edge.kind}${edge.files.length > 1 ? `, ${edge.files.length} files` : ''}): ${edge.from} ${RULE_TEXT[rule]}`,
    })
  }
  return out
}

/** What fails: violations the baseline lacks, and baseline lines that are no longer violations. */
export function compare(found: readonly Violation[], baseline: readonly string[]): { added: Violation[]; gone: string[] } {
  const now = new Set(found.map((v) => v.key))
  const before = new Set(baseline)
  return { added: found.filter((v) => !before.has(v.key)), gone: baseline.filter((k) => !now.has(k)) }
}

const ROWS: Array<[PackageClass, string]> = [
  ['kernel', 'libraries, the host, and the `*-core` seam definitions'],
  ['guarantee', 'guarantee providers: the required rows'],
  ['capability', 'capability plugins'],
  ['surface', 'surfaces'],
  ['profile', 'profiles'],
]

/** docs/architecture/dependency-graph.md, from the table, the imports, and the rules. */
export function render(table: Table, pkgs: readonly Pkg[], edges: readonly Edge[]): string {
  const cls = (dir: string): PackageClass => table.classOf.get(dir)!
  const broken = new Map(violations(edges, table).map((v) => [`${v.edge.from}\0${v.edge.to}`, v.rule]))
  const pairs = (from: PackageClass, to: PackageClass): Edge[] => edges.filter((e) => cls(e.from) === from && cls(e.to) === to)
  const cell = (list: Edge[]): string => (list.length ? `${list.filter((e) => e.kind === 'value').length} / ${list.filter((e) => e.kind === 'type').length}` : '·')
  const plugins = pkgs.filter((p) => cls(p.dir) !== 'kernel')
  const crossing = edges.filter((e) => cls(e.to) !== 'kernel')
  const bad = [...broken.keys()].map((k) => edges.find((e) => `${e.from}\0${e.to}` === k)!)
  const byRule = (rule: Rule): Edge[] => bad.filter((e) => broken.get(`${e.from}\0${e.to}`) === rule)
  const sources = new Set(bad.map((e) => e.from))
  const standing = (e: Edge): string => {
    const rule = broken.get(`${e.from}\0${e.to}`)
    if (rule) return `violation: ${rule}`
    return cls(e.from) === 'kernel' ? 'host or library' : `allowed: family ${table.familyOf.get(e.from)}`
  }
  return [
    '# Dependency graph',
    '',
    '> Generated by `pnpm gen:deps` (`scripts/check-deps.ts`) from the Package classes table of',
    '> [plugin-model](plugin-model.md#package-classes) and each package\'s `src/` imports; do not edit by hand.',
    '> `pnpm check:deps` fails when it is out of date, and on a dependency the rules refuse.',
    '',
    'Plugins are testable on their own and removable with System still working, so a plugin depends on the',
    'core, and plugins depend on each other as little as possible. The rules and the baseline of violations',
    'that may only shrink are in [plugin-model](plugin-model.md#package-classes). An edge is one package',
    'importing another, `value` when any of its imports is a value import, `type` when all are type-only.',
    '',
    '## Layers',
    '',
    '| Class | Packages | Members |',
    '|---|---|---|',
    ...ROWS.map(([c, what]) => {
      const members = pkgs.filter((p) => cls(p.dir) === c)
      return `| ${c}: ${what} | ${members.length} | ${members.map((p) => `\`${p.dir}\``).join(', ')} |`
    }),
    '',
    '## Edges by class',
    '',
    'Packages importing packages, importer by row, imported by column; each cell is value edges / type edges.',
    '',
    `| importer \\ imported | ${CLASSES.join(' | ')} |`,
    `|---|${CLASSES.map(() => '---').join('|')}|`,
    ...CLASSES.map((from) => `| ${from} | ${CLASSES.map((to) => cell(pairs(from, to))).join(' | ')} |`),
    '',
    '## Counts',
    '',
    `- ${pkgs.length} packages: ${ROWS.map(([c]) => `${pkgs.filter((p) => cls(p.dir) === c).length} ${c}`).join(', ')}.`,
    `- ${edges.length} package-to-package edges (${edges.filter((e) => e.kind === 'value').length} value, ${edges.filter((e) => e.kind === 'type').length} type); ${crossing.length} of them end in a plugin (${crossing.filter((e) => e.kind === 'value').length} value, ${crossing.filter((e) => e.kind === 'type').length} type).`,
    `- ${bad.length} violations (${bad.filter((e) => e.kind === 'value').length} value, ${bad.filter((e) => e.kind === 'type').length} type) in ${sources.size} of ${plugins.length} plugins: ${byRule('guarantee-provider').length} import a guarantee provider (\`guarantee-provider\`), ${byRule('plugin-to-plugin').length} import another plugin outside its family (\`plugin-to-plugin\`).`,
    '',
    '## Edges that end in a plugin',
    '',
    '| Importer | Class | Imported | Class | Kind | Standing |',
    '|---|---|---|---|---|---|',
    ...crossing.map((e) => `| \`${e.from}\` | ${cls(e.from)} | \`${e.to}\` | ${cls(e.to)} | ${e.kind} | ${standing(e)} |`),
    '',
  ].join('\n')
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DOC = join(root, 'docs', 'architecture', 'plugin-model.md')
export const GRAPH = join(root, 'docs', 'architecture', 'dependency-graph.md')
export const BASELINE = join(root, 'scripts', 'dependency-baseline.json')

/** The workspace's table, packages, edges, and violations. */
export function measure(at: string = root, doc: string = DOC): { table: Table; pkgs: Pkg[]; edges: Edge[]; found: Violation[] } {
  const table = parseTable(readFileSync(doc, 'utf8'))
  const pkgs = packages(at)
  const problems = tableProblems(table, pkgs)
  if (problems.length) throw new Error(`dependencies:\n  ${problems.join('\n  ')}`)
  const edges = scanEdges(at, pkgs)
  return { table, pkgs, edges, found: violations(edges, table) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { table, pkgs, edges, found } = measure()
  const graph = render(table, pkgs, edges)
  if (process.argv.includes('--gen')) {
    writeFileSync(GRAPH, graph)
    console.log(`wrote ${GRAPH}`)
    process.exit(0)
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as string[]
  const { added, gone } = compare(found, baseline)
  if (process.argv.includes('--shrink')) {
    writeFileSync(BASELINE, `${JSON.stringify(baseline.filter((k) => !gone.includes(k)), null, 2)}\n`)
    console.log(`dependencies: dropped ${gone.length} line(s) from the baseline`)
  }
  const stale = process.argv.includes('--shrink') ? [] : gone
  for (const v of added) console.error(`dependencies: new violation, ${v.message} [${v.rule}]`)
  for (const k of stale) console.error(`dependencies: baseline line "${k}" is no longer a violation: run \`pnpm check:deps --shrink\` to drop it from scripts/dependency-baseline.json`)
  const fresh = existsSync(GRAPH) && readFileSync(GRAPH, 'utf8') === graph
  if (!fresh) console.error('docs/architecture/dependency-graph.md is out of date: run `pnpm gen:deps`')
  console.log(`dependencies: ${found.length} violation(s), ${baseline.length} in the baseline, ${added.length} new, ${stale.length} stale`)
  process.exit(added.length || stale.length || !fresh ? 1 : 0)
}
