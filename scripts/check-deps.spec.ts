import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { BASELINE, GRAPH, compare, importsOf, measure, parseTable, render, scanEdges, packages, tableProblems, violations } from './check-deps.ts'

const TABLE = [
  '### Package classes',
  '',
  '| Class | Family | Packages |',
  '|---|---|---|',
  '| kernel | — | `libs`, `seams-core` |',
  '| guarantee | — | `ledger` |',
  '| capability | runtimes | `run-a`, `run-b` |',
  '| capability | — | `cap-a`, `cap-b` |',
  '| surface | — | `view` |',
  '',
  '## Next',
  '',
  '| surface | — | `ignored` |',
].join('\n')

/** A workspace of packages: `files` are `src/` files by package dir; each package is named `@t/<dir>`. */
function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-deps-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const kernel = ['libs', 'seams-core']
  for (const dir of ['libs', 'seams-core', 'ledger', 'run-a', 'run-b', 'cap-a', 'cap-b', 'view']) {
    const base = join(root, 'packages', kernel.includes(dir) ? '' : 'plugins', dir)
    mkdirSync(join(base, 'src'), { recursive: true })
    writeFileSync(join(base, 'package.json'), JSON.stringify({ name: `@t/${dir}` }))
    writeFileSync(join(base, 'src', 'index.ts'), files[dir] ?? 'export {}\n')
  }
  return root
}

const check = (files: Record<string, string>, baseline: string[] = []) => {
  const root = workspace(files)
  const table = parseTable(TABLE)
  const pkgs = packages(root)
  const found = violations(scanEdges(root, pkgs), table)
  return { problems: tableProblems(table, pkgs), found, ...compare(found, baseline) }
}

describe('dependency check', () => {
  it('reads a table of classes and families, and only the section of its heading', () => {
    const table = parseTable(TABLE)
    expect(table.classOf.get('seams-core')).toBe('kernel')
    expect(table.classOf.get('view')).toBe('surface')
    expect(table.classOf.has('ignored')).toBe(false)
    expect(table.familyOf.get('run-a')).toBe('runtimes')
    expect(table.familyOf.has('cap-a')).toBe(false)
    expect(() => parseTable('| kernel | — | `a` |\n')).toThrow('Package classes')
  })

  it('tells a type import from a value import', () => {
    const text = [
      "import type { A } from 'a'",
      "import { type B, type C } from 'b'",
      "import { D, type E } from 'c'",
      "import F from 'd'",
      "import 'e'",
      "export type { G } from 'f'",
      "export * from 'g'",
      "type H = import('h').H",
      "const i = await import('i')",
    ].join('\n')
    expect(importsOf(text)).toEqual([
      { spec: 'a', type: true },
      { spec: 'b', type: true },
      { spec: 'c', type: false },
      { spec: 'd', type: false },
      { spec: 'e', type: false },
      { spec: 'f', type: true },
      { spec: 'g', type: false },
      { spec: 'h', type: true },
      { spec: 'i', type: false },
    ])
  })

  it('fails a capability plugin importing another capability plugin, type or value, naming the import and the rule', () => {
    for (const [text, kind] of [["import { x } from '@t/cap-b'\nexport const y = x\n", 'value'], ["import type { X } from '@t/cap-b'\nexport type Y = X\n", 'type']] as const) {
      const { added, problems } = check({ 'cap-a': text })
      expect(problems).toEqual([])
      expect(added).toHaveLength(1)
      expect(added[0]).toMatchObject({ key: 'cap-a -> cap-b [plugin-to-plugin]', edge: { kind } })
      expect(added[0]!.message).toContain(`packages/plugins/cap-a/src/index.ts imports cap-b (${kind})`)
      expect(added[0]!.message).toContain('outside the family')
    }
  })

  it('fails a surface and a guarantee provider importing a plugin, and any package importing a guarantee provider', () => {
    const keys = check({ view: "import type { X } from '@t/cap-a'\n", ledger: "import { x } from '@t/cap-b'\n", 'seams-core': "import { l } from '@t/ledger'\n", 'cap-a': "import { l } from '@t/ledger'\n" })
      .added.map((v) => v.key)
    expect(keys).toEqual(['cap-a -> ledger [guarantee-provider]', 'ledger -> cap-b [plugin-to-plugin]', 'seams-core -> ledger [guarantee-provider]', 'view -> cap-a [plugin-to-plugin]'])
  })

  it('passes a plugin importing only definitions and libraries, and one family building on its own seams', () => {
    const { added, gone, problems } = check({
      'cap-a': "import { Seam } from '@t/seams-core'\nimport { hash } from '@t/libs/hash'\nexport const x = [Seam, hash]\n",
      view: "import type { Seam } from '@t/seams-core'\nexport type V = Seam\n",
      'run-a': "import { run } from '@t/run-b'\nexport const x = run\n",
      'cap-b': "import { notAPackage } from 'node:fs'\nexport const y = notAPackage\n",
    })
    expect({ added, gone, problems }).toEqual({ added: [], gone: [], problems: [] })
  })

  it('passes a violation in the baseline until it is fixed, then its baseline line is stale and fails', () => {
    const baseline = ['cap-a -> cap-b [plugin-to-plugin]']
    const held = check({ 'cap-a': "import { x } from '@t/cap-b'\n" }, baseline)
    expect(held.found).toHaveLength(1)
    expect(held.added).toEqual([])
    expect(held.gone).toEqual([])
    const fixed = check({ 'cap-a': "import type { Seam } from '@t/seams-core'\n" }, baseline)
    expect(fixed.added).toEqual([])
    expect(fixed.gone).toEqual(baseline)
  })

  it('fails a package the table lacks and a table row for a package that is not there', () => {
    const root = workspace({})
    const table = parseTable(TABLE.replace('`view`', '`gone`'))
    expect(tableProblems(table, packages(root)).sort()).toEqual([
      'package view is not in the Package classes table of docs/architecture/plugin-model.md',
      'the Package classes table names gone, which is not a package',
    ])
  })

  it('holds the workspace to its baseline, and the graph to the code', () => {
    const { table, pkgs, edges, found } = measure()
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as string[]
    expect(compare(found, baseline)).toEqual({ added: [], gone: [] })
    expect(baseline).toEqual([...baseline].sort())
    expect(readFileSync(GRAPH, 'utf8')).toBe(render(table, pkgs, edges))
  })
})
