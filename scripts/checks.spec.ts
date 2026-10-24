import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { slugify } from './check-docs.ts'
import { loadSchemas, schemaId } from './check-schemas.ts'
import { scanText } from './check-secrets.ts'
import { rows } from './gen-reference.ts'
import { scenarioTitle, testTitle } from './gen-traceability.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const schemas = join(root, 'schemas')
const example = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(schemas, 'examples', name), 'utf8')) as Record<string, unknown>

describe('documentation checks', () => {
  it('slugifies headings like GitHub', () => {
    expect(slugify('INV-4 Restart is reconciliation, not replay')).toBe('inv-4-restart-is-reconciliation-not-replay')
    expect(slugify('Delivery order: slice 1 first')).toBe('delivery-order-slice-1-first')
  })
})

describe('schema checks', () => {
  it('rejects a decision with two selected candidates', () => {
    const decision = example('decision.route.json') as { candidates: { selected: boolean }[] }
    decision.candidates.forEach((c) => (c.selected = true))
    expect(loadSchemas(schemas).getSchema(schemaId('decision'))?.(decision)).toBe(false)
  })

  it('rejects a model decision without model answers', () => {
    const decision = example('decision.route.json') as { decider: { type: string } }
    decision.decider.type = 'model'
    expect(loadSchemas(schemas).getSchema(schemaId('decision'))?.(decision)).toBe(false)
  })

  it('keeps @1.1 fields out of @1.0 records: a descriptor\'s family, an evidence claim\'s reviews', () => {
    const descriptor = example('capability-descriptor.family.json')
    const valid = (name: string, value: unknown) => loadSchemas(schemas).getSchema(schemaId(name))?.(value)
    expect(valid('capability-descriptor', descriptor)).toBe(true)
    expect(valid('capability-descriptor', { ...descriptor, schema: 'capability-descriptor@1.0' })).toBe(false)
    const { family: _family, ...without } = descriptor
    expect(valid('capability-descriptor', { ...without, schema: 'capability-descriptor@1.0' })).toBe(true)
    const table = example('evidence-table.two-reviews.json')
    expect(valid('evidence-table', table)).toBe(true)
    expect(valid('evidence-table', { ...table, schema: 'evidence-table@1.0' })).toBe(false)
    // A review's quote checks are decision@1.2; a team vote is never @1.0.
    const review = example('decision.review-blocking.json')
    expect(valid('decision', review)).toBe(true)
    expect(valid('decision', { ...review, schema: 'decision@1.1' })).toBe(false)
    expect(valid('decision', { ...review, schema: 'decision@1.0' })).toBe(false)
    expect(valid('decision', { ...example('decision.team-vote.json'), schema: 'decision@1.0' })).toBe(false)
  })

  it('rejects an envelope carrying both an inline body and a blob', () => {
    const envelope = example('artifact-envelope.decision.json') as Record<string, unknown>
    envelope['blob'] = { ref: envelope['id'], bytes: 1, mediaType: 'application/json' }
    expect(loadSchemas(schemas).getSchema(schemaId('artifact-envelope'))?.(envelope)).toBe(false)
  })

  it('requires a credential reference for credential login', () => {
    const account = example('account.ready.json') as { login: Record<string, unknown> }
    delete account.login['credentialRef']
    expect(loadSchemas(schemas).getSchema(schemaId('account'))?.(account)).toBe(false)
  })

  it('never lets a model heal an irreversible UI action (ADR-0021)', () => {
    const map = example('ui-map.chatgpt-web.json') as { actions: Record<string, Record<string, unknown>> }
    const validate = loadSchemas(schemas).getSchema(schemaId('ui-map'))!
    map.actions['composer.send']!['heal'] = 'model'
    expect(validate(map)).toBe(false)
    map.actions['composer.send']!['sideEffect'] = 'reversible'
    expect(validate(map)).toBe(true)
  })

  it('rejects a UI map element without candidates', () => {
    const map = example('ui-map.chatgpt-web.json') as { elements: Record<string, Record<string, unknown>> }
    map.elements['composer.send']!['candidates'] = []
    expect(loadSchemas(schemas).getSchema(schemaId('ui-map'))?.(map)).toBe(false)
  })
})

// `pnpm check:secrets` scans the repository itself; these tests pin what the scan reports.
describe('secrets audit', () => {
  it('reports the file, line, and rule of a credential, never its value', async () => {
    // A realistic key, made at test time (scanners ignore documented example keys).
    const key = String(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }))
    const findings = await scanText('notes.txt', `first line\n${key}`)
    expect(findings).toEqual([{ file: 'notes.txt', line: 2, rule: expect.stringContaining('privatekey') }])
    expect(JSON.stringify(findings)).not.toContain(key.split('\n')[1])
  })

  it('applies the egress built-in patterns too: an AWS access key id on its own', async () => {
    const id = `AKIA${Array.from(randomBytes(16), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b % 32]).join('')}`
    expect(await scanText('config.ini', `[default]\nkey = ${id}\n`)).toContainEqual({ file: 'config.ini', line: 2, rule: 'aws-access-key-id' })
  })
})

describe('CI workflows', () => {
  it('pin every third-party Action by commit SHA', () => {
    const dir = join(root, '.github', 'workflows')
    const unpinned = readdirSync(dir).flatMap((file) =>
      [...readFileSync(join(dir, file), 'utf8').matchAll(/uses:\s*([^\s#]+)/g)]
        .map((m) => m[1]!)
        .filter((ref) => !ref.startsWith('./') && !/@[0-9a-f]{40}$/.test(ref))
        .map((ref) => `${file}: ${ref}`))
    expect(unpinned).toEqual([])
  })
})

describe('configuration reference', () => {
  it('escapes a description\'s backslashes and pipes, so a backslash before a pipe cannot break the cell', () => {
    const schema = { type: 'object', dict: { mode: { type: 'string', meta: { default: 'a|b', description: 'a\\|b or c\\' } } } }
    expect(rows(schema)).toEqual(['| `mode` | string | `"a\\|b"` | a\\\\\\|b or c\\\\ |'])
  })
})

describe('traceability', () => {
  it('reads test titles and conformance scenario titles, which the suites hold as data', () => {
    expect(testTitle(`  it('refuses a stale lease (INV-15)', async () => {`)).toBe('refuses a stale lease (INV-15)')
    expect(scenarioTitle(`    scenario('expiry-rejects', 'rejects at expiry (INV-2)', async (ctx) => {`)).toBe('rejects at expiry (INV-2)')
    expect(scenarioTitle(`  { id: 'meta.gap', since: '1.0', title: 'a known gap (INV-9)', run }`)).toBe('a known gap (INV-9)')
    expect(scenarioTitle(`const scenario = (id: string, title: string, run: Run) => ({`)).toBeUndefined()
  })
})
