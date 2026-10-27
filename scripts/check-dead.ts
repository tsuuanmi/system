// Dead-code gate (PROP-0018 T1): an export nothing refers to, and a plugin `Config` key nothing reads.
//
// Both are read from the TypeScript program the repository already type-checks (tsconfig.json), so
// a reference is resolved by the compiler, through imports, re-exports and aliases, not by name.
//
//  - A dead export: a name exported by a package's `src/` file (not the package entry
//    `src/index.ts`, whose exports are the package's public surface, `export *` included) that no
//    other non-test source file refers to, and that a package entry does not re-export. `#unused`:
//    nothing refers to it at all (delete it); `#local`: only its own file does (unexport it);
//    `#tests`: a test does (a seam: unexport it with its test, or keep it).
//  - An unused config key: a property of an `interface Config` in a package's `src/` that no
//    non-test source reads (`x.key`, `x['key']`, or `{ key } = x`). A test that sets a key is not a
//    consumer; a key read only by the file's own test is as unused as one never read.
//
// `scripts/dead-code-baseline.json` lists today's findings. The check fails on a finding the
// baseline lacks (new dead code) and on a baseline entry that no longer is a finding (delete it:
// the baseline only shrinks). `--shrink` rewrites the baseline without the entries gone; `--seed` fills an empty one.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const IN_SRC = /(^|\/)packages\/(?:[^/]+\/)?(?:[^/]+\/)?src\//
const isTest = (rel: string): boolean => /(^|\/)(tests|conformance|fixtures)\//.test(rel) || rel.endsWith('.spec.ts')
const isEntry = (rel: string): boolean => /(^|\/)src\/index\.ts$/.test(rel)

export interface Findings {
  deadExports: string[]
  unusedConfigKeys: string[]
}

function createProgram(root: string, configFile: string): ts.Program {
  const read = ts.readConfigFile(join(root, configFile), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root)
  return ts.createProgram(parsed.fileNames, parsed.options)
}

/** Findings of the program of `configFile` (relative to `root`), as `path#name` strings, sorted. */
export function findDead(root: string, configFile = 'tsconfig.json'): Findings {
  const program = createProgram(root, configFile)
  const checker = program.getTypeChecker()
  const files = program.getSourceFiles().filter((f) => !f.isDeclarationFile && !f.fileName.includes('/node_modules/'))
  const rel = (f: ts.SourceFile): string => relative(root, f.fileName)

  const resolve = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        return checker.getAliasedSymbol(symbol)
      } catch {
        return undefined
      }
    }
    return symbol
  }

  // Declaration → how many identifiers refer to it (any file); how many are in another non-test
  // source file (its consumers); how many are reads in non-test source (a Config key's readers).
  const refs = new Map<ts.Node, number>()
  const used = new Map<ts.Node, number>()
  const tested = new Map<ts.Node, number>()
  const reads = new Map<ts.Node, number>()
  const bump = (map: Map<ts.Node, number>, symbol: ts.Symbol | undefined): void => {
    for (const decl of symbol?.declarations ?? []) map.set(decl, (map.get(decl) ?? 0) + 1)
  }
  for (const file of files) {
    const reader = IN_SRC.test(rel(file)) && !isTest(rel(file))
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        const parent = node.parent
        const declares = !!checker.getSymbolAtLocation(node)?.declarations?.includes(parent as ts.Declaration)
        const localExport = ts.isExportSpecifier(parent) && !parent.parent.parent.moduleSpecifier
        if (!declares && !localExport) {
          const symbol =
            ts.isShorthandPropertyAssignment(parent) && parent.name === node
              ? checker.getShorthandAssignmentValueSymbol(parent)
              : resolve(checker.getSymbolAtLocation(node))
          bump(refs, symbol)
          if (symbol?.declarations?.every((d) => d.getSourceFile() !== file)) bump(reader ? used : tested, symbol)
          const read =
            (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isBindingElement(parent) && (parent.propertyName ?? parent.name) === node)
          if (reader && read) bump(reads, symbol)
        }
      } else if (reader && (ts.isSpreadElement(node) || ts.isSpreadAssignment(node) || ts.isCallExpression(node) || ts.isNewExpression(node))) {
        // A `Config` handed on whole (`guard(config)`, `{ ...config }`) is read by what takes it.
        const handed = ts.isCallExpression(node) || ts.isNewExpression(node) ? (node.arguments ?? []) : [node.expression]
        for (const arg of handed) {
          for (const decl of checker.getTypeAtLocation(arg).symbol?.declarations ?? []) {
            if (ts.isInterfaceDeclaration(decl) && decl.name.text === 'Config') for (const member of decl.members) reads.set(member, 1)
          }
        }
      }
      if (reader && ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        bump(reads, checker.getSymbolAtLocation(node.argumentExpression) ?? checker.getTypeAtLocation(node.expression).getProperty(node.argumentExpression.text))
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  // A package's public surface: what its entry exports, `export *` and re-exports included.
  const publicDecls = new Set<ts.Node>()
  for (const file of files.filter((f) => isEntry(rel(f)))) {
    const module = checker.getSymbolAtLocation(file)
    if (!module) continue
    for (const exported of checker.getExportsOfModule(module)) for (const d of resolve(exported)?.declarations ?? []) publicDecls.add(d)
  }

  const deadExports: string[] = []
  const unusedConfigKeys: string[] = []
  for (const file of files) {
    const path = rel(file)
    if (!IN_SRC.test(path) || isTest(path)) continue
    if (!isEntry(path)) {
      const module = checker.getSymbolAtLocation(file)
      for (const exported of module ? checker.getExportsOfModule(module) : []) {
        const symbol = resolve(exported)
        const decls = (symbol?.declarations ?? []).filter((d) => d.getSourceFile() === file)
        if (exported.name === 'default' || !decls.length || decls.some((d) => publicDecls.has(d))) continue
        if (decls.some((d) => used.get(d))) continue
        const kind = decls.some((d) => tested.get(d)) ? 'tests' : decls.some((d) => refs.get(d)) ? 'local' : 'unused'
        deadExports.push(`${path}#${exported.name}#${kind}`)
      }
    }
    for (const statement of file.statements) {
      if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== 'Config') continue
      for (const member of statement.members) {
        if (!ts.isPropertySignature(member) || !(ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))) continue
        if (!reads.get(member)) unusedConfigKeys.push(`${path}#Config.${member.name.text}`)
      }
    }
  }
  return { deadExports: deadExports.sort(), unusedConfigKeys: unusedConfigKeys.sort() }
}

const all = (f: Findings): string[] => [...f.deadExports, ...f.unusedConfigKeys]

/** What fails: findings the baseline lacks, and baseline entries that are no longer findings. */
export function compare(found: Findings, baseline: readonly string[]): { added: string[]; gone: string[] } {
  const now = new Set(all(found))
  const before = new Set(baseline)
  return { added: [...now].filter((x) => !before.has(x)), gone: [...before].filter((x) => !now.has(x)) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const baselinePath = join(root, 'scripts', 'dead-code-baseline.json')
  const found = findDead(root)
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as string[]
  if (process.argv.includes('--seed') && !baseline.length) {
    writeFileSync(baselinePath, `${JSON.stringify(all(found), null, 2)}\n`)
    console.log(`dead code: seeded the baseline with ${all(found).length} finding(s)`)
    process.exit(0)
  }
  const { added, gone } = compare(found, baseline)
  if (process.argv.includes('--shrink')) {
    writeFileSync(baselinePath, `${JSON.stringify(baseline.filter((x) => !gone.includes(x)), null, 2)}\n`)
    console.log(`dead code: dropped ${gone.length} entr(ies) from the baseline`)
    process.exit(added.length ? 1 : 0)
  }
  for (const x of added) console.error(`dead code: ${x} is new: delete it, or use it`)
  for (const x of gone) console.error(`dead code: ${x} is gone: run \`pnpm check:dead --shrink\` to drop it from scripts/dead-code-baseline.json`)
  console.log(`dead code: ${all(found).length} finding(s), ${baseline.length} in the baseline, ${added.length} new, ${gone.length} gone`)
  process.exit(added.length || gone.length ? 1 : 0)
}
