// What parallel changes collide on (docs/engineering/testing.md#ci-gates): a numbered document's
// number, a store migration's version, and a schema's contract changed in place. Each check fails
// on a fixture of the collision, and passes on the real tree.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { duplicateNumbers } from './check-docs.ts'
import { checkMigrations, migrationLists } from './check-migrations.ts'
import { contractProblems, nextSnapshot, readSnapshot, renderSnapshot, type Snapshot } from './check-schemas.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = (): string => mkdtempSync(join(tmpdir(), 'collisions-'))
const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('numbered documents', () => {
  it('refuses two ADRs or two proposals with one number, naming the later file', () => {
    const dir = scratch()
    for (const file of ['0065-a-cap-fails-closed.md', '0065-every-route-orders-workers.md', '0066-other.md']) put(join(dir, 'docs/decisions/adr', file), '# x\n')
    for (const file of ['0014-dispatch.md', '0014-right-worker.md', 'README.md']) put(join(dir, 'docs/proposals', file), '# x\n')
    expect(duplicateNumbers(dir)).toEqual([
      { kind: 'duplicate-number', file: 'docs/decisions/adr/0065-every-route-orders-workers.md', detail: expect.stringContaining('0065 is also docs/decisions/adr/0065-a-cap-fails-closed.md') },
      { kind: 'duplicate-number', file: 'docs/proposals/0014-right-worker.md', detail: expect.stringContaining('0014 is also docs/proposals/0014-dispatch.md') },
    ])
  })

  it('finds none in the real tree', () => {
    expect(duplicateNumbers(root)).toEqual([])
  })
})

describe('store migrations', () => {
  it('refuses a version declared twice, through an imported constant, and versions out of list order', () => {
    const dir = scratch()
    put(join(dir, 'packages/plugins/demo/src/gate.ts'), "export const DENIAL_MIGRATION = { version: 18, sql: 'ALTER TABLE t ADD COLUMN d TEXT;' }\n")
    put(join(dir, 'packages/plugins/demo/src/index.ts'), [
      "import { DENIAL_MIGRATION } from './gate.ts'",
      "const MIGRATIONS = [{ version: 1, sql: 'CREATE TABLE t (id TEXT);' }, DENIAL_MIGRATION, { version: 18, sql: 'ALTER TABLE t ADD COLUMN k TEXT;' }]",
      'export function start(ctx: any): void {',
      "  ctx.store.migrate('demo', MIGRATIONS)",
      "  ctx.store.migrate('other', [{ version: 2, sql: '' }, { version: 1, sql: '' }])",
      '}',
    ].join('\n'))
    // Outside a package's src/ (tests, conformance) a list may be out of order on purpose.
    put(join(dir, 'packages/plugins/demo/tests/demo.spec.ts'), "store.migrate('t', [{ version: 2, sql: '' }, { version: 1, sql: '' }])\n")
    expect(checkMigrations(dir)).toEqual([
      expect.stringMatching(/^demo \(packages\/plugins\/demo\/src\/index\.ts:4\): version 18 is declared twice/),
      expect.stringMatching(/^other \(packages\/plugins\/demo\/src\/index\.ts:5\): version 1 follows 2: versions must strictly increase/),
    ])
  })

  it('refuses one owner\'s version declared by two migrate calls, each list in order on its own', () => {
    const dir = scratch()
    put(join(dir, 'packages/plugins/demo/src/index.ts'), [
      'export function start(ctx: any): void {',
      "  ctx.store.migrate('demo', [{ version: 1, sql: 'CREATE TABLE a (id TEXT);' }])",
      "  ctx.store.migrate('demo', [{ version: 1, sql: 'CREATE TABLE b (id TEXT);' }])",
      "  ctx.store.migrate('elsewhere', [{ version: 1, sql: '' }])",
      '}',
    ].join('\n'))
    expect(checkMigrations(dir)).toEqual([
      expect.stringMatching(/^demo \(packages\/plugins\/demo\/src\/index\.ts:3\): version 1 is also declared by the migrate call at packages\/plugins\/demo\/src\/index\.ts:2/),
    ])
  })

  it('fails closed on a list it cannot read statically', () => {
    const dir = scratch()
    put(join(dir, 'packages/demo/src/index.ts'), "ctx.store.migrate('demo', build())\nctx.store.migrate('spread', [...MORE])\n")
    expect(checkMigrations(dir)).toEqual([
      expect.stringMatching(/^cannot read statically: demo .*the migrations are not an array literal/),
      expect.stringMatching(/^cannot read statically: spread .*a spread element/),
    ])
  })

  it('resolves a constant owner, and fails closed on an owner it cannot resolve', () => {
    const dir = scratch()
    put(join(dir, 'packages/plugins/demo/src/index.ts'), [
      "const OWNER = 'demo'",
      'export function start(ctx: any, name: string): void {',
      "  ctx.store.migrate(OWNER, [{ version: 1, sql: '' }, { version: 1, sql: '' }])",
      "  ctx.store.migrate(name, [{ version: 1, sql: '' }])",
      "  ctx.store.migrate(`x-${name}`, [{ version: 1, sql: '' }])",
      '}',
    ].join('\n'))
    expect(checkMigrations(dir)).toEqual([
      expect.stringMatching(/^cannot read statically: migrate call \(packages\/plugins\/demo\/src\/index\.ts:4\): .*cannot resolve the owner name/),
      expect.stringMatching(/^cannot read statically: migrate call \(packages\/plugins\/demo\/src\/index\.ts:5\): .*the owner is not a string literal/),
      expect.stringMatching(/^demo \(packages\/plugins\/demo\/src\/index\.ts:3\): version 1 is declared twice/),
    ])
  })

  it('fails closed on an object spread, a computed key, or a version assigned twice in a migration', () => {
    const dir = scratch()
    put(join(dir, 'packages/plugins/demo/src/index.ts'), [
      'export function start(ctx: any): void {',
      "  ctx.store.migrate('spread', [{ version: 1, ...{ version: 2 }, sql: '' }, { version: 2, sql: '' }])",
      "  ctx.store.migrate('computed', [{ version: 1, ['version']: 2, sql: '' }])",
      "  ctx.store.migrate('twice', [{ version: 1, 'version': 2, sql: '' }])",
      '}',
    ].join('\n'))
    expect(checkMigrations(dir)).toEqual([
      expect.stringMatching(/^cannot read statically: spread .*an object spread in a migration/),
      expect.stringMatching(/^cannot read statically: computed .*a computed property name in a migration/),
      expect.stringMatching(/^cannot read statically: twice .*version is assigned more than once/),
    ])
  })

  it('reads every plugin\'s list in the real tree, imported constants included, and finds no collision', () => {
    const { lists } = migrationLists(root)
    const versions = (owner: string) => lists.find((l) => l.owner === owner)?.versions
    expect(versions('agent-workers')).toEqual(Array.from({ length: 19 }, (_, i) => i + 1))
    expect(versions('workflow')?.slice(0, 3)).toEqual([1, 2, 3])
    expect(versions('turns')).toContain(7)
    expect(checkMigrations(root)).toEqual([])
  })
})

describe('schema contracts', () => {
  const base = () => ({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:tsuuanmi:system:schema:thing:v1',
    description: 'A thing; its count follows other@1.5.',
    type: 'object',
    required: ['schema', 'a'],
    properties: {
      schema: { const: 'thing@1.0' },
      a: { description: 'An a.', type: 'string', maxLength: 10 },
      b: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  })
  type Thing = ReturnType<typeof base> & Record<string, unknown>
  const fixture = (): { dir: string; snapshot: Snapshot; write: (edit: (s: Thing) => void) => void } => {
    const dir = scratch()
    const write = (edit: (s: Thing) => void): void => {
      const schema = base() as Thing
      edit(schema)
      writeFileSync(join(dir, 'thing.v1.json'), JSON.stringify(schema))
    }
    write(() => {})
    return { dir, snapshot: nextSnapshot(dir, {}), write }
  }

  it('refuses a property required, no longer required, removed, or narrowed in place', () => {
    const cases: [(s: Thing) => void, RegExp][] = [
      [(s) => s.required.push('b'), /requires b at \/ in place, at 1\.0/],
      [(s) => { s.required = ['schema'] }, /stops requiring a at \/ in place/],
      [(s) => { delete (s.properties as Partial<Thing['properties']>).b }, /removes property b at \/ in place/],
      [(s) => { s.properties.a.maxLength = 5 }, /narrows or relaxes \/properties\/a in place/],
      [(s) => { s.properties.b.minimum = -1 }, /narrows or relaxes \/properties\/b in place/],
      // A constraint subschema added to an existing property: its digest leaves `not` out.
      [(s) => { (s.properties.b as Record<string, unknown>)['not'] = { const: 0 } }, /adds constraint subschema \/properties\/b\/not in place/],
    ]
    for (const [edit, problem] of cases) {
      const { dir, snapshot, write } = fixture()
      write(edit)
      expect(contractProblems(dir, snapshot)).toEqual([expect.stringMatching(problem)])
      // Regenerating keeps the old entry: the check keeps failing until the change is versioned.
      expect(nextSnapshot(dir, snapshot)).toEqual(snapshot)
    }
  })

  it('takes the change with a new version note, once the snapshot is regenerated', () => {
    const { dir, snapshot, write } = fixture()
    write((s) => {
      s.required.push('b')
      s.description = `${s.description} 1.1 requires b.`
    })
    expect(contractProblems(dir, snapshot)).toEqual(['scripts/schema-snapshot.json is out of date: run `pnpm gen:reference`'])
    const next = nextSnapshot(dir, snapshot)
    expect(next['thing.v1.json']?.version).toBe('1.1')
    expect(contractProblems(dir, next)).toEqual([])
  })

  it('takes a description edit as no change, and an optional property as no change in place', () => {
    const { dir, snapshot, write } = fixture()
    write((s) => { s.properties.a.description = 'An a, said otherwise.' })
    expect(contractProblems(dir, snapshot)).toEqual([])
    write((s) => { (s.properties as Record<string, unknown>)['c'] = { type: 'string', maxLength: 3 } })
    expect(contractProblems(dir, snapshot)).toEqual(['scripts/schema-snapshot.json is out of date: run `pnpm gen:reference`'])
  })

  it('does not take an advanced schema tag for the description\'s version note', () => {
    const { dir, snapshot, write } = fixture()
    write((s) => {
      s.properties.a.maxLength = 5
      s.properties.schema.const = 'thing@1.1'
    })
    expect(contractProblems(dir, snapshot)).toEqual([
      expect.stringMatching(/narrows or relaxes \/properties\/schema in place, at 1\.0/),
      expect.stringMatching(/narrows or relaxes \/properties\/a in place, at 1\.0/),
    ])
    // Regenerating keeps the old entry until a description carries the note.
    expect(nextSnapshot(dir, snapshot)).toEqual(snapshot)
  })

  it('does not take another schema\'s version for a note of its own', () => {
    const { dir, snapshot, write } = fixture()
    write((s) => {
      s.required.push('b')
      s.description = 'A thing; its count follows other@1.6.'
    })
    expect(contractProblems(dir, snapshot)).toEqual([expect.stringMatching(/requires b at \/ in place/)])
  })

  it('refuses mcp-roster\'s load made optional in place against the committed snapshot (the 1.7 field T185 relaxed)', () => {
    const dir = scratch()
    cpSync(join(root, 'schemas'), dir, { recursive: true })
    const path = join(dir, 'mcp-roster.v1.json')
    const roster = JSON.parse(readFileSync(path, 'utf8')) as { $defs: { load: { required: string[] } } }
    roster.$defs.load.required = roster.$defs.load.required.filter((name) => name !== 'pending')
    writeFileSync(path, JSON.stringify(roster, null, 2))
    expect(contractProblems(dir, readSnapshot())).toEqual([expect.stringMatching(/^mcp-roster\.v1\.json: stops requiring pending at \/\$defs\/load in place/)])
  })

  it('finds every real schema in the committed snapshot, current and unchanged in place', () => {
    const snapshot = readSnapshot()
    expect(contractProblems(join(root, 'schemas'), snapshot)).toEqual([])
    expect(readFileSync(join(root, 'scripts', 'schema-snapshot.json'), 'utf8')).toBe(renderSnapshot(snapshot))
  })
})
