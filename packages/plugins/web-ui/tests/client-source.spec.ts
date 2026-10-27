import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { builtClient } from './client-build.ts'

// The page's script is typed modules (T304b): `client/app.ts` is a classic entry that imports `boot.js`, and every module is a page or
// a concern under 600 lines with no `any`. Read-only: the compiled files are in a temporary directory (`builtClient`).
const CLIENT = fileURLToPath(new URL('../client/', import.meta.url))
const MAX_LINES = 600
const sources = readdirSync(CLIENT).filter((name) => name.endsWith('.ts')).sort()
const parsed = (name: string) => ts.createSourceFile(name, readFileSync(join(CLIENT, name), 'utf8'), ts.ScriptTarget.ES2023, true)

describe('web UI client: typed modules', () => {
  it('is split by page and concern: an entry, the router, the API client, and each page', () => {
    for (const name of ['app.ts', 'boot.ts', 'state.ts', 'router.ts', 'dom.ts', 'home.ts', 'board.ts', 'runpage.ts', 'queue.ts', 'reviews.ts', 'workers.ts', 'policy.ts', 'help.ts']) expect(sources, name).toContain(name)
  })

  it(`has no module over ${MAX_LINES} lines`, () => {
    for (const name of sources) expect(readFileSync(join(CLIENT, name), 'utf8').split('\n').length, name).toBeLessThanOrEqual(MAX_LINES)
  })

  it('has no `any`: not a type, a parameter, a catch variable, or a lookup table', () => {
    const found: string[] = []
    for (const name of sources) {
      const file = parsed(name)
      const visit = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.AnyKeyword) found.push(`${name}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    expect(found).toEqual([])
  })

  it('shares the API types with the server: one declaration file, imported by both', () => {
    expect(readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')).toMatch(/import type \{[^}]*\} from '\.\/api\.js'/)
    expect(sources.filter((name) => /from '\.\.\/src\/api\.js'/.test(readFileSync(join(CLIENT, name), 'utf8'))).length).toBeGreaterThan(5)
    expect(existsSync(fileURLToPath(new URL('../src/api.d.ts', import.meta.url)))).toBe(true)
  })

  it('builds app.js as a classic script that loads boot.js, and every module it imports is built beside it', () => {
    const out = builtClient()
    const entry = readFileSync(join(out, 'app.js'), 'utf8')
    expect(entry).toContain("import('./boot.js')")
    expect(entry).not.toMatch(/^(import|export) /m)
    for (const name of readdirSync(out).filter((file) => file.endsWith('.js'))) {
      for (const [, target] of readFileSync(join(out, name), 'utf8').matchAll(/(?:from|import\()\s*'\.\/([A-Za-z0-9-]+\.js)'/g)) expect(existsSync(join(out, target as string)), `${name} imports ${target}`).toBe(true)
    }
  })
})
