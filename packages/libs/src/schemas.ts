import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020
const TAG = /^([a-z][a-z0-9-]*)@(\d+)\.(\d+)$/
const DEF = /^[A-Za-z][A-Za-z0-9-]*$/

/** Thrown when a record does not satisfy its schema; carries the Ajv errors. */
export class SchemaError extends Error {
  constructor(
    readonly tag: string,
    readonly errors: readonly ErrorObject[],
    message: string,
  ) {
    super(`${tag}: ${message}`)
    this.name = 'SchemaError'
  }
}

/**
 * The schemas of each directory, loaded into one Ajv per process on first use, with the validators
 * compiled from it. The schemas are fixed files, so every registry over a directory shares them: a
 * registry of its own per plugin instance or call built a new Ajv over every schema file (about
 * 40 ms) and compiled each schema it then used again (tens of ms each), CPU that every boot paid
 * and that grew with the host's load.
 */
const loaded = new Map<string, { ajv: Ajv2020; validators: Map<string, ValidateFunction> }>()

/** Validates records against the canonical schemas in `@tsuuanmi/system-schemas` (ADR-0014). */
export class SchemaRegistry {
  readonly #ajv: Ajv2020
  readonly #cache: Map<string, ValidateFunction>

  constructor(dir: string = defaultSchemaDir()) {
    let schemas = loaded.get(dir)
    if (!schemas) {
      const ajv = new Ajv2020({ strict: true, allErrors: true })
      addFormats(ajv)
      for (const file of readdirSync(dir).filter((f) => /\.v\d+\.json$/.test(f))) {
        ajv.addSchema(JSON.parse(readFileSync(join(dir, file), 'utf8')) as object)
      }
      schemas = { ajv, validators: new Map() }
      loaded.set(dir, schemas)
    }
    this.#ajv = schemas.ajv
    this.#cache = schemas.validators
  }

  /** Validate `value` against the schema named by `tag` (`<name>@<major>.<minor>`); throws {@link SchemaError}. */
  assert(tag: string, value: unknown): void {
    const validate = this.#validator(tag)
    if (!validate(value)) {
      throw new SchemaError(tag, validate.errors ?? [], this.#ajv.errorsText(validate.errors))
    }
  }

  /** Whether a schema tag names a schema this registry holds (its major version). */
  knows(tag: string): boolean {
    try {
      this.#validator(tag)
      return true
    } catch {
      return false
    }
  }

  /** The JSON Schema a tag names, to give a Worker that must produce it (REQ-ART-5). */
  schemaOf(tag: string): object {
    return this.#validator(tag).schema as object
  }

  /** Validate a record by the `schema` tag it carries. */
  assertRecord(value: { schema?: unknown }): void {
    if (typeof value.schema !== 'string') throw new SchemaError('unknown', [], 'record has no schema tag')
    this.assert(value.schema, value)
  }

  /**
   * Validate `value` against one definition of the schema `tag` names, its `#/$defs/<def>`: an MCP
   * tool's input or output, for example `assertDef('mcp-board@1.0', 'board-claim-input', args)`.
   * Throws {@link SchemaError}, also for a definition the schema does not have.
   */
  assertDef(tag: string, def: string, value: unknown): void {
    const validate = this.#validator(tag, def)
    if (!validate(value)) {
      throw new SchemaError(`${tag}#/$defs/${def}`, validate.errors ?? [], this.#ajv.errorsText(validate.errors))
    }
  }

  #validator(tag: string, def?: string): ValidateFunction {
    const key = def === undefined ? tag : `${tag}#${def}`
    const cached = this.#cache.get(key)
    if (cached) return cached
    const match = TAG.exec(tag)
    if (!match) throw new SchemaError(tag, [], 'malformed schema tag')
    if (def !== undefined && !DEF.test(def)) throw new SchemaError(tag, [], `malformed definition name ${def.slice(0, 80)}`)
    const id = `urn:tsuuanmi:system:schema:${match[1]}:v${match[2]}`
    const whole = this.#ajv.getSchema(id)
    if (!whole) throw new SchemaError(tag, [], 'unknown schema or unsupported major version')
    const validate = def === undefined ? whole : this.#ajv.getSchema(`${id}#/$defs/${def}`)
    if (!validate) throw new SchemaError(tag, [], `no definition ${def} in this schema`)
    this.#cache.set(key, validate)
    return validate
  }
}

function defaultSchemaDir(): string {
  const require = createRequire(import.meta.url)
  return dirname(require.resolve('@tsuuanmi/system-schemas/package.json'))
}

/** The JSON a text parses to, or undefined when it is none. */
const parsed = (raw: string): { value: unknown } | undefined => {
  try {
    return { value: JSON.parse(raw) as unknown }
  } catch {
    return undefined
  }
}

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/**
 * The bodies of a text's fenced code blocks, in order. Fences pair line by line, as Markdown
 * pairs them: a block closes only on a fence line of its own character, at least as long as the
 * one that opened it, so one block's closing fence is never read as the next one's opening.
 */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = []
  let open: { close: RegExp; lines: string[] } | undefined
  for (const line of text.split('\n')) {
    if (!open) {
      const fence = /^ {0,3}(`{3,}|~{3,})[^`]*$/.exec(line)?.[1]
      if (fence) open = { close: new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`), lines: [] }
    } else if (open.close.test(line)) {
      blocks.push(open.lines.join('\n'))
      open = undefined
    } else {
      open.lines.push(line)
    }
  }
  return blocks
}

/**
 * The JSON object an answer ends with. Its last fenced block that holds JSON decides: an object
 * there is the answer's, anything else (a list, a string) is no object, and an earlier block never
 * stands in for it. Blocks that hold no JSON (quoted code) are passed over. With no such block,
 * the object ending at the answer's last closing brace, from the first opening brace it parses
 * from (prose or code quoted before it may hold braces of its own). Untrusted model text.
 */
export function extractJson(text: string): Record<string, unknown> | undefined {
  for (const block of fencedBlocks(text).reverse()) {
    const json = parsed(block)
    if (json) return objectOf(json.value)
  }
  const end = text.lastIndexOf('}') + 1
  for (let start = text.indexOf('{'); start >= 0 && start < end; start = text.indexOf('{', start + 1)) {
    const value = objectOf(parsed(text.slice(start, end))?.value)
    if (value) return value
  }
  return undefined
}

