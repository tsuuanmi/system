import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { compare, findDead } from './check-dead.ts'

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-dead-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  files['tsconfig.json'] = JSON.stringify({ compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true }, include: ['packages/**/*.ts'] })
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe('dead-code check', () => {
  it('finds an export no other source file uses, `unused`, `local` (its own file) or `tests`, and spares a used or re-exported one', () => {
    const root = project({
      'packages/a/src/index.ts': "export { surface } from './mod.ts'\nexport * from './all.ts'\n",
      'packages/a/src/mod.ts': 'export const surface = 1\nexport const used = 2\nexport const dead = 3\nexport interface Dead { x: 1 }\nexport const tested = 4\n',
      'packages/a/src/all.ts': 'export const viaStar = 1\n',
      'packages/a/src/user.ts': "import { used } from './mod.ts'\nexport const user = used\n",
      'packages/a/tests/user.spec.ts': "import { user } from '../src/user.ts'\nimport { tested } from '../src/mod.ts'\nconsole.log(user, tested)\n",
    })
    expect(findDead(root).deadExports).toEqual([
      'packages/a/src/mod.ts#Dead#unused',
      'packages/a/src/mod.ts#dead#unused',
      'packages/a/src/mod.ts#tested#tests',
      'packages/a/src/user.ts#user#tests',
    ])
  })

  it('finds a Config key nothing reads; a Config handed on whole is read by what takes it', () => {
    const root = project({
      'packages/a/src/index.ts':
        'export interface Config { read?: number; bracket?: number; dropped?: number; set?: number }\n' +
        'export function apply(config: Config) { return config.read ?? config["bracket"] }\n',
      'packages/a/tests/a.spec.ts': "import { apply } from '../src/index.ts'\napply({ set: 1 })\n",
      'packages/b/src/index.ts': 'export interface Config { passed?: number }\nexport function apply(config: Config) { return take(config) }\nfunction take(_: object) { return 1 }\n',
    })
    expect(findDead(root).unusedConfigKeys).toEqual(['packages/a/src/index.ts#Config.dropped', 'packages/a/src/index.ts#Config.set'])
  })

  it('fails on a finding the baseline lacks and on a baseline entry no longer found', () => {
    expect(compare({ deadExports: ['a#x', 'a#y'], unusedConfigKeys: [] }, ['a#y', 'a#z'])).toEqual({ added: ['a#x'], gone: ['a#z'] })
  })
})
