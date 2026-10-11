// Schema gate (ADR-0014): every schema compiles under Ajv draft 2020-12 strict mode,
// and every example validates against the schema named by its file prefix.
import { readdirSync, readFileSync } from 'node:fs'
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas')
  const problems = checkSchemas(dir)
  for (const p of problems) console.error(p)
  console.log(`schemas: ${problems.length} problem(s)`)
  process.exit(problems.length ? 1 : 0)
}
