// Schema gate (ADR-0014): every schema compiles under Ajv draft 2020-12 strict mode,
// every example validates against the schema named by its file prefix, and no schema changes
// a contract in place: against the committed contract snapshot (scripts/schema-snapshot.json),
// a change that requires a property, stops requiring one, removes one, or narrows or relaxes an
// existing subschema needs a new version note (docs/engineering/testing.md#ci-gates).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020

/** Schema files are named `<name>.v<major>.json`; package.json and examples are not schemas. */
export const schemaFiles = (dir: string): string[] => readdirSync(dir).filter((f) => /\.v\d+\.json$/.test(f))

export const schemaId = (name: string): string => `urn:tsuuanmi:system:schema:${name}:v1`

export function loadSchemas(dir: string): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true })
  addFormats(ajv)
  for (const file of schemaFiles(dir)) {
    ajv.addSchema(JSON.parse(readFileSync(join(dir, file), 'utf8')))
  }
  return ajv
}

export function checkSchemas(dir: string): string[] {
  const problems: string[] = []
  const ajv = loadSchemas(dir)
  for (const file of schemaFiles(dir)) {
    const { $id } = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { $id: string }
    try {
      if (!ajv.getSchema($id)) problems.push(`${file}: not registered`)
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`)
    }
  }
  const examples = join(dir, 'examples')
  for (const file of readdirSync(examples).filter((f) => f.endsWith('.json'))) {
    const name = file.split('.')[0] ?? ''
    const validate = ajv.getSchema(schemaId(name))
    if (!validate) {
      problems.push(`examples/${file}: no schema named ${name}`)
      continue
    }
    if (!validate(JSON.parse(readFileSync(join(examples, file), 'utf8')))) {
      problems.push(`examples/${file}: ${ajv.errorsText(validate.errors)}`)
    }
  }
  return problems
}

// --- Contract changes in place ----------------------------------------------------------------
//
// Why a committed snapshot, not a diff against the merge base with main: work lands on `dev` and
// `main` follows it at a release, so the merge base is a different tree on each branch, and a
// fresh clone or a shallow CI checkout may not hold it. The snapshot is in the tree, so the check
// answers the same everywhere. Two parallel changes that both version a schema both rewrite its
// entry, so they meet as a merge conflict in the snapshot instead of landing silently.

/** One subschema's contract: a digest of its own constraints, its required list, its property names. */
export interface ShapeNode {
  h: string
  r?: string[]
  p?: string[]
}

/** A schema's contract: its newest version note, and each subschema by JSON pointer. */
export interface Shape {
  version: string
  nodes: Record<string, ShapeNode>
}

export type Snapshot = Record<string, Shape>

export const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), 'schema-snapshot.json')

/** Words that never change what validates. */
const ANNOTATIONS = new Set(['description', 'title', 'examples', '$comment', 'default', 'deprecated', 'readOnly', 'writeOnly'])
/** Keywords holding named subschemas; each is its own node. */
const MAP_KIDS = new Set(['properties', '$defs', 'dependentSchemas'])
/** Keywords holding a list of subschemas; the list's length is part of the parent's constraints. */
const LIST_KIDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
/** Keywords holding one subschema (a boolean one is a constraint of the parent). */
const ONE_KID = new Set(['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'])

const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(value)

const segment = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1')

/** Every subschema's contract, by JSON pointer. */
export function shapeNodes(schema: unknown, pointer = '', out: Record<string, ShapeNode> = {}): Record<string, ShapeNode> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    out[pointer] = { h: canonical(schema) }
    return out
  }
  const node = schema as Record<string, unknown>
  const own: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (ANNOTATIONS.has(key) || key === 'required') continue
    if (MAP_KIDS.has(key) && value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) shapeNodes(child, `${pointer}/${key}/${segment(name)}`, out)
    } else if (LIST_KIDS.has(key) && Array.isArray(value)) {
      own[key] = value.length
      value.forEach((child, i) => shapeNodes(child, `${pointer}/${key}/${i}`, out))
    } else if (ONE_KID.has(key) && value && typeof value === 'object') {
      shapeNodes(value, `${pointer}/${key}`, out)
    } else if (key === 'patternProperties' && value && typeof value === 'object') {
      own[key] = Object.keys(value).sort()
      for (const [name, child] of Object.entries(value)) shapeNodes(child, `${pointer}/${key}/${segment(name)}`, out)
    } else {
      own[key] = value
    }
  }
  const entry: ShapeNode = { h: createHash('sha256').update(canonical(own)).digest('hex').slice(0, 16) }
  if (Array.isArray(node['required'])) entry.r = [...(node['required'] as string[])].sort()
  if (node['properties'] && typeof node['properties'] === 'object') entry.p = Object.keys(node['properties']).sort()
  out[pointer] = entry
  return out
}

type Version = [number, number]
const parseVersion = (v: string): Version => v.split('.').map(Number) as Version
const newer = (a: string, b: string): boolean => {
  const [am, an] = parseVersion(a)
  const [bm, bn] = parseVersion(b)
  return am !== bm ? am > bm : an > bn
}

/**
 * A schema's newest version within its file's major: the highest `<major>.<minor>` among the
 * version notes of its descriptions (`1.9 adds …`, `1.4: …`, `(1.1)`, `<name>@1.9 …`: every bare
 * `<major>.<minor>` or own `<name>@<major>.<minor>` tag in a description; `other@1.3` names another
 * schema and is not one). Only descriptions count: a tag elsewhere (`properties.schema.const`
 * advanced to `<name>@1.1`) is not a note, so it cannot stand in for one. `<major>.0` when it has none.
 */
export function schemaVersion(name: string, major: number, schema: unknown): string {
  let best = `${major}.0`
  const consider = (minor: string): void => { if (newer(`${major}.${minor}`, best)) best = `${major}.${minor}` }
  // Every regular-expression character of the name escaped, backslash included, not only '-'.
  const own = new RegExp(`(?<![\\w-])${name.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')}@${major}\\.(\\d+)(?![\\d.])`, 'g')
  const note = new RegExp(`(?<![@\\w.])${major}\\.(\\d+)(?![\\d.]*\\w)`, 'g')
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (key !== 'description') return
      for (const m of value.matchAll(own)) consider(m[1]!)
      for (const m of value.matchAll(note)) consider(m[1]!)
    } else if (Array.isArray(value)) value.forEach((v) => visit(v))
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k)
  }
  visit(schema)
  return best
}

const schemaName = (file: string): string => file.replace(/\.v\d+\.json$/, '')
const schemaMajor = (file: string): number => Number(/\.v(\d+)\.json$/.exec(file)?.[1] ?? 1)

export function shapeOf(file: string, schema: unknown): Shape {
  return { version: schemaVersion(schemaName(file), schemaMajor(file), schema), nodes: shapeNodes(schema) }
}

/** The changes from `before` to `after` that need a new version, in words. */
export function contractChanges(before: Shape, after: Shape): string[] {
  const changes: string[] = []
  const gone = Object.keys(before.nodes).filter((p) => !after.nodes[p])
  for (const [pointer, old] of Object.entries(before.nodes)) {
    const at = pointer || '/'
    const now = after.nodes[pointer]
    if (!now) {
      // Reported once, at the topmost subschema removed; a removed property by its parent's names.
      const underGone = gone.some((g) => g !== pointer && pointer.startsWith(`${g}/`))
      if (!underGone && !/\/properties\/[^/]+$/.test(pointer)) changes.push(`removes ${at}`)
      continue
    }
    for (const name of now.r ?? []) if (!(old.r ?? []).includes(name)) changes.push(`requires ${name} at ${at}`)
    for (const name of old.r ?? []) if (!(now.r ?? []).includes(name)) changes.push(`stops requiring ${name} at ${at}`)
    for (const name of old.p ?? []) if (!(now.p ?? []).includes(name)) changes.push(`removes property ${name} at ${at}`)
    if (now.h !== old.h) changes.push(`narrows or relaxes ${at}`)
  }
  // A subschema that is new: a constraint added to an existing one (`not`, `items`, `if`, a
  // `dependentSchemas` entry, …) narrows or relaxes it, though the parent's own digest leaves its
  // object-valued keywords out (a new `anyOf` entry also changes the parent's list length, so may be
  // named twice). A new property (optional unless required, reported above) or a new
  // `$defs` entry, and anything under either, is no change in place. Reported once, at the topmost.
  const added = Object.keys(after.nodes).filter((p) => !before.nodes[p])
  for (const pointer of added) {
    if (added.some((a) => a !== pointer && pointer.startsWith(`${a}/`))) continue
    if (/\/(properties|\$defs)\/[^/]+$/.test(pointer)) continue
    changes.push(`adds constraint subschema ${pointer}`)
  }
  return changes
}

/** The schema files of `dir`, by file name. */
function readSchemas(dir: string): Map<string, unknown> {
  return new Map(schemaFiles(dir).sort().map((file) => [file, JSON.parse(readFileSync(join(dir, file), 'utf8'))]))
}

/**
 * The snapshot `pnpm gen:reference` writes: each schema's current contract, unless it changed in
 * place (a change {@link contractChanges} names, with no newer version note), whose old entry is
 * kept so the check keeps failing until the change is versioned.
 */
export function nextSnapshot(dir: string, previous: Snapshot): Snapshot {
  const next: Snapshot = {}
  for (const [file, schema] of readSchemas(dir)) {
    const now = shapeOf(file, schema)
    const old = previous[file]
    next[file] = !old || !contractChanges(old, now).length || newer(now.version, old.version) ? now : old
  }
  return next
}

/** The snapshot as text: one subschema per line, so a change reads as a small diff. */
export function renderSnapshot(snapshot: Snapshot): string {
  const files = Object.keys(snapshot).sort().map((file) => {
    const shape = snapshot[file]!
    const nodes = Object.keys(shape.nodes).sort().map((p) => `      ${JSON.stringify(p)}: ${JSON.stringify(shape.nodes[p])}`)
    return `  ${JSON.stringify(file)}: {\n    "version": ${JSON.stringify(shape.version)},\n    "nodes": {\n${nodes.join(',\n')}\n    }\n  }`
  })
  return `{\n${files.join(',\n')}\n}\n`
}

export function readSnapshot(path = SNAPSHOT): Snapshot {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Snapshot : {}
}

export function writeSnapshot(dir: string, path = SNAPSHOT): void {
  writeFileSync(path, renderSnapshot(nextSnapshot(dir, readSnapshot(path))))
}

/** Each schema of `dir` changed in place against `snapshot`, and whether the snapshot is current. */
export function contractProblems(dir: string, snapshot: Snapshot): string[] {
  const problems: string[] = []
  const schemas = readSchemas(dir)
  for (const [file, schema] of schemas) {
    const old = snapshot[file]
    if (!old) {
      problems.push(`${file}: not in the contract snapshot: run \`pnpm gen:reference\``)
      continue
    }
    const now = shapeOf(file, schema)
    const changes = contractChanges(old, now)
    if (changes.length && !newer(now.version, old.version)) {
      for (const change of changes) {
        problems.push(`${file}: ${change} in place, at ${now.version}: a contract change needs a new version (its note in a description, ${schemaName(file)}@${old.version} → a newer one), then \`pnpm gen:reference\``)
      }
    }
  }
  if (!problems.length && renderSnapshot(nextSnapshot(dir, snapshot)) !== renderSnapshot(Object.fromEntries(Object.entries(snapshot).filter(([f]) => schemas.has(f))))) {
    problems.push('scripts/schema-snapshot.json is out of date: run `pnpm gen:reference`')
  }
  if (Object.keys(snapshot).some((f) => !schemas.has(f))) problems.push('scripts/schema-snapshot.json names a schema that is gone: run `pnpm gen:reference`')
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas')
  const problems = [...checkSchemas(dir), ...contractProblems(dir, readSnapshot())]
  for (const p of problems) console.error(p)
  console.log(`schemas: ${problems.length} problem(s)`)
  process.exit(problems.length ? 1 : 0)
}
