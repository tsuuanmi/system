import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkDocs, slugify } from './check-docs.ts'
import { checkSchemas, loadSchemas, schemaId } from './check-schemas.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const schemas = join(root, 'schemas')
const example = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(schemas, 'examples', name), 'utf8')) as Record<string, unknown>

describe('documentation checks', () => {
  it('finds no structural or link problems in the repository', () => {
    expect(checkDocs(root)).toEqual([])
  })

  it('slugifies headings like GitHub', () => {
    expect(slugify('INV-4 Restart is reconciliation, not replay')).toBe('inv-4-restart-is-reconciliation-not-replay')
    expect(slugify('Delivery order: slice 1 first')).toBe('delivery-order-slice-1-first')
  })
})

describe('schema checks', () => {
  it('compiles every schema in strict mode and validates every example', () => {
    expect(checkSchemas(schemas)).toEqual([])
  })

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
