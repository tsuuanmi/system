import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020
const TAG = /^([a-z][a-z0-9-]*)@(\d+)\.(\d+)$/

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

/** Validates records against the canonical schemas in `@tsuuanmi/system-schemas` (ADR-0014). */
export class SchemaRegistry {
  readonly #ajv = new Ajv2020({ strict: true, allErrors: true })
  readonly #cache = new Map<string, ValidateFunction>()

  constructor(dir: string = defaultSchemaDir()) {
    addFormats(this.#ajv)
    for (const file of readdirSync(dir).filter((f) => /\.v\d+\.json$/.test(f))) {
      this.#ajv.addSchema(JSON.parse(readFileSync(join(dir, file), 'utf8')) as object)
    }
  }

  /** Validate `value` against the schema named by `tag` (`<name>@<major>.<minor>`); throws {@link SchemaError}. */
  assert(tag: string, value: unknown): void {
    const validate = this.#validator(tag)
    if (!validate(value)) {
      throw new SchemaError(tag, validate.errors ?? [], this.#ajv.errorsText(validate.errors))
    }
  }

  /** Validate a record by the `schema` tag it carries. */
  assertRecord(value: { schema?: unknown }): void {
    if (typeof value.schema !== 'string') throw new SchemaError('unknown', [], 'record has no schema tag')
    this.assert(value.schema, value)
  }

  #validator(tag: string): ValidateFunction {
    const cached = this.#cache.get(tag)
    if (cached) return cached
    const match = TAG.exec(tag)
    if (!match) throw new SchemaError(tag, [], 'malformed schema tag')
    const validate = this.#ajv.getSchema(`urn:tsuuanmi:system:schema:${match[1]}:v${match[2]}`)
    if (!validate) throw new SchemaError(tag, [], 'unknown schema or unsupported major version')
    this.#cache.set(tag, validate)
    return validate
  }
}

function defaultSchemaDir(): string {
  const require = createRequire(import.meta.url)
  return dirname(require.resolve('@tsuuanmi/system-schemas/package.json'))
}
