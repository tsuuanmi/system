// Store migration gate (docs/engineering/testing.md#ci-gates): within one owner, every store
// migration has its own version, across all of the owner's `migrate` calls, and each list names
// them strictly increasing. Two parallel changes
// that each took the next version collide (agent-workers 18, added twice on 2026-10-26): the store
// records a version once, so on an install that ran the first, the second would never run.
//
// Read statically from the source with the TypeScript parser, not by running it: every
// `<x>.store.migrate(<owner>, <list>)` call (and any other `migrate` call with a string-literal
// owner or an array-literal list) under a package's `src/`,
// its owner a string literal or a constant holding one, its list an array literal or a constant
// holding one, each element an object literal with exactly one `version: <number literal>` and no
// spread or computed key (either could set the version at runtime), or a constant holding one; a
// constant in the same file or imported from a relative module. Anything else the check cannot
// read fails it (fail closed), so a list cannot hide from it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export interface MigrationList {
  owner: string
  /** `path:line` of the `migrate` call. */
  at: string
  versions: number[]
}

const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'coverage'])

/** Every `.ts` file under a `src/` directory below `dir`. */
export function sourceFiles(dir: string, inSrc = false): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path, inSrc || entry === 'src'))
    else if (inSrc && entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(path)
  }
  return out
}

const parsed = new Map<string, ts.SourceFile>()
function parse(file: string): ts.SourceFile {
  let source = parsed.get(file)
  if (!source) {
    source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    parsed.set(file, source)
  }
  return source
}

/** An expression without `as`, `satisfies`, parentheses, or `!`. */
function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    node = node.expression
  }
  return node
}

/** The relative module a specifier names, as a source file. */
function resolveModule(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(from), specifier)
  const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]
  return candidates.find((c) => c.endsWith('.ts') && existsSync(c))
}

/** The initializer of the constant `name` as `file` sees it: declared there, or imported from a relative module. */
function constant(file: string, name: string, seen = new Set<string>()): { file: string; init: ts.Expression } | undefined {
  const key = `${file}#${name}`
  if (seen.has(key)) return undefined
  seen.add(key)
  const source = parse(file)
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) return { file, init: unwrap(decl.initializer) }
      }
    }
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const element of bindings.elements) {
        if (element.name.text !== name) continue
        const target = resolveModule(file, statement.moduleSpecifier.text)
        if (target) return constant(target, (element.propertyName ?? element.name).text, seen)
      }
    }
  }
  return undefined
}

function lineOf(file: string, node: ts.Node): string {
  const source = parse(file)
  return `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
}

/** One element's version, or why it cannot be read. */
function versionOf(file: string, node: ts.Expression): number | string {
  node = unwrap(node)
  if (ts.isIdentifier(node)) {
    const found = constant(file, node.text)
    return found ? versionOf(found.file, found.init) : `${lineOf(file, node)}: cannot resolve ${node.text}`
  }
  if (!ts.isObjectLiteralExpression(node)) return `${lineOf(file, node)}: not an object literal`
  // The runtime version is the last one the literal assigns, a spread included, so the literal must
  // hold exactly one plain `version: <number>` and nothing that could assign it otherwise.
  const assignments: ts.ObjectLiteralElementLike[] = []
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) return `${lineOf(file, property)}: an object spread in a migration (it may set the version)`
    const name = property.name
    if (!name) continue
    if (ts.isComputedPropertyName(name)) return `${lineOf(file, property)}: a computed property name in a migration (it may set the version)`
    if ((ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) && name.text === 'version') assignments.push(property)
  }
  if (assignments.length > 1) return `${lineOf(file, assignments[1]!)}: version is assigned more than once`
  const property = assignments[0]
  if (!property) return `${lineOf(file, node)}: no version`
  if (!ts.isPropertyAssignment(property)) return `${lineOf(file, property)}: version is not a \`version: <number>\` property`
  const value = unwrap(property.initializer)
  if (ts.isNumericLiteral(value)) return Number(value.text)
  return `${lineOf(file, value)}: version is not a number literal`
}

/** A `migrate` call's owner: a string literal or a constant holding one, or why it cannot be read. */
function ownerOf(file: string, node: ts.Expression): string | { unreadable: string } {
  node = unwrap(node)
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isIdentifier(node)) {
    const found = constant(file, node.text)
    return found ? ownerOf(found.file, found.init) : { unreadable: `${lineOf(file, node)}: cannot resolve the owner ${node.text}` }
  }
  return { unreadable: `${lineOf(file, node)}: the owner is not a string literal or a constant holding one` }
}

/**
 * A store migration call: any `<x>.store.migrate(…)` or `store.migrate(…)`, whatever its owner, or
 * another `<x>.migrate(owner, list)` whose owner is a string literal or whose list an array literal
 * (`migrator.migrate({ … }, check)`, a different `migrate`, is neither).
 */
function isMigrateCall(node: ts.Node): node is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'migrate') return false
  const receiver = unwrap(node.expression.expression)
  if ((ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'store') || (ts.isIdentifier(receiver) && receiver.text === 'store')) return true
  const [first, second] = node.arguments
  return node.arguments.length === 2 && ((!!first && ts.isStringLiteralLike(unwrap(first))) || (!!second && ts.isArrayLiteralExpression(unwrap(second))))
}

/** The list a `migrate` call's second argument names, as array elements, or why it cannot be read. */
function listOf(file: string, node: ts.Expression): { file: string; elements: readonly ts.Expression[] } | string {
  node = unwrap(node)
  if (ts.isIdentifier(node)) {
    const found = constant(file, node.text)
    return found ? listOf(found.file, found.init) : `${lineOf(file, node)}: cannot resolve ${node.text}`
  }
  if (!ts.isArrayLiteralExpression(node)) return `${lineOf(file, node)}: the migrations are not an array literal`
  return { file, elements: node.elements }
}

/**
 * Every migration list in `files` (by default every package source file under `root`), and what
 * could not be read; paths are relative to `root`.
 */
export function migrationLists(root: string, files = sourceFiles(join(root, 'packages'))): { lists: MigrationList[]; unreadable: string[] } {
  const lists: MigrationList[] = []
  const unreadable: string[] = []
  const prefix = `${resolve(root)}/`
  const rel = (text: string): string => text.split(prefix).join('')
  for (const file of files.map((f) => resolve(f))) {
    const visit = (node: ts.Node): void => {
      if (isMigrateCall(node)) {
        const [first, second] = node.arguments
        const at = rel(lineOf(file, node))
        const resolved = first && second ? ownerOf(file, first) : { unreadable: `${at}: a store migrate call takes (owner, migrations)` }
        if (typeof resolved !== 'string') {
          unreadable.push(`migrate call (${at}): ${rel(resolved.unreadable)}`)
          ts.forEachChild(node, visit)
          return
        }
        const owner = resolved
        const list = listOf(file, second!)
        if (typeof list === 'string') unreadable.push(`${owner} (${at}): ${rel(list)}`)
        else {
          const versions: number[] = []
          for (const element of list.elements) {
            if (ts.isSpreadElement(element)) {
              unreadable.push(`${owner} (${at}): ${rel(lineOf(list.file, element))}: a spread element`)
              continue
            }
            const version = versionOf(list.file, element)
            if (typeof version === 'string') unreadable.push(`${owner} (${at}): ${rel(version)}`)
            else versions.push(version)
          }
          lists.push({ owner, at, versions })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(parse(file))
  }
  return { lists, unreadable }
}

/** A list's duplicate versions and versions out of order. */
export function listProblems(list: MigrationList): string[] {
  const problems: string[] = []
  const seen = new Set<number>()
  list.versions.forEach((version, i) => {
    if (seen.has(version)) problems.push(`${list.owner} (${list.at}): version ${version} is declared twice: take the next free version`)
    else if (i > 0 && version <= list.versions[i - 1]!) problems.push(`${list.owner} (${list.at}): version ${version} follows ${list.versions[i - 1]}: versions must strictly increase in list order`)
    seen.add(version)
  })
  return problems
}

/**
 * One owner's versions declared again by a later `migrate` call: the store records a version per
 * owner, whichever call ran it, so the later call's migration would never run.
 */
export function ownerProblems(lists: readonly MigrationList[]): string[] {
  const problems: string[] = []
  const first = new Map<string, string>()
  for (const list of lists) {
    for (const version of new Set(list.versions)) {
      const key = `${list.owner}\u0000${version}`
      const earlier = first.get(key)
      if (earlier === undefined) first.set(key, list.at)
      else problems.push(`${list.owner} (${list.at}): version ${version} is also declared by the migrate call at ${earlier}: take the next free version`)
    }
  }
  return problems
}

export function checkMigrations(root: string, files?: string[]): string[] {
  const { lists, unreadable } = migrationLists(root, files)
  return [...unreadable.map((u) => `cannot read statically: ${u}`), ...lists.flatMap(listProblems), ...ownerProblems(lists)]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const { lists } = migrationLists(root)
  const problems = checkMigrations(root)
  for (const p of problems) console.error(p)
  console.log(`migrations: ${lists.length} list(s), ${problems.length} problem(s)`)
  process.exit(problems.length ? 1 : 0)
}
