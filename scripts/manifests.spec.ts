/**
 * The manifest check (`pnpm check:manifests`): every manifest the workspace ships is valid and agrees
 * with its code, and each kind of disagreement is caught, on fixtures made from a real manifest.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { readManifest } from '../packages/plugin-host-core/src/index.ts'
import { check, checkAll, type Derived, derive, familyNames, render, satisfies, seamClasses } from './gen-manifests.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
let derived: Derived[]
beforeAll(() => {
  derived = derive()
})
const of = (dir: string): Derived => derived.find((d) => d.dir === dir)!
/** The package's manifest as generated, changed by `edit`, as the text a package would ship. */
const shipped = (dir: string, edit: (m: Record<string, any>) => void): string => {
  const manifest = JSON.parse(render(of(dir).manifest)) as Record<string, any>
  edit(manifest)
  return JSON.stringify(manifest)
}

describe('the manifests the workspace ships (REQ-HOST-7)', () => {
  it('has one for every plugin and every seam definition, each valid as the host reads it, and all agreeing with the code', () => {
    expect(derived.map((d) => d.path).filter((p) => p.startsWith('packages/plugins/')).length).toBe(37)
    expect(derived.filter((d) => d.manifest.defines).map((d) => d.dir).sort()).toEqual([
      'agent-runtime-core', 'approvals-core', 'board-core', 'digest-core', 'gateway-core', 'models-core', 'plugin-host-core', 'provider-core', 'resources-core', 'workers-core',
    ])
    for (const d of derived) expect(readManifest(readFileSync(join(root, d.path, 'plugin-manifest.json'), 'utf8'), d.manifest.name).state, d.dir).toBe('valid')
    expect(checkAll(derived)).toEqual([])
  })

  it('derives each version from the conformance contract, each class from the seam catalog, and each consumer\'s range from its provider', () => {
    expect(of('workflow').manifest).toMatchObject({ class: { kind: 'core', component: 'work-state-machine' }, provides: [{ seam: 'workflow', version: '1.3.0' }] })
    expect(of('web-ui').manifest.consumes).toContainEqual({ seam: 'workflow', range: '^1.3.0' })
    expect(of('board-core').manifest).toMatchObject({ schema: 'plugin-manifest@1.1', class: { kind: 'core', component: 'work-state-machine' }, provides: [], defines: [{ seam: 'board', version: '1.2.0' }] })
    expect(of('runtime-claude-agent-sdk').manifest.class).toEqual({ kind: 'family', family: 'worker' })
    expect(of('report').manifest).toMatchObject({ class: { kind: 'family', family: 'surface' }, provides: [], consumes: expect.arrayContaining([{ seam: 'board', range: '^1.2.0', optional: true }]) })
    expect(of('plugin-host').manifest).toMatchObject({ class: { kind: 'core', component: 'plugin-host' }, consumes: expect.arrayContaining([{ seam: 'loader', range: '^1.0.0' }, { seam: 'profileContext', range: '^1.0.0', optional: true }]) })
    expect(seamClasses().get('mcp')).toEqual({ kind: 'family', family: 'surface' })
    expect(familyNames().get('profile-scientific-research')).toEqual(['workflow'])
  })
})

describe('the check catches each kind of disagreement', () => {
  it('a manifest that is missing, not shipped, or that the host would refuse', () => {
    expect(check(of('board'), undefined)).toEqual([expect.stringMatching(/board: ships no plugin-manifest\.json/)])
    expect(check({ ...of('board'), files: ['lib'] }, render(of('board').manifest))).toEqual([expect.stringMatching(/"files" does not ship it/)])
    expect(check(of('board'), shipped('board', (m) => { m._meta = { lifecycle: { state: 'default', since: '2026-10-23T00:00:00Z', decision: `sha256:${'1'.repeat(64)}` } } })))
      .toEqual([expect.stringMatching(/the host refuses it: it declares _meta/)])
    expect(check(of('board'), shipped('board', (m) => { m.name = '@tsuuanmi/system-other' }))).toEqual([expect.stringMatching(/refuses it: it names @tsuuanmi\/system-other/)])
  })

  it('a seam consumed but not declared, declared but not consumed, or optional in one and required in the other', () => {
    expect(check(of('board'), shipped('board', (m) => { m.consumes = m.consumes.filter((c: { seam: string }) => c.seam !== 'approvals') })))
      .toEqual([expect.stringMatching(/the code consumes ctx\.approvals \(required\), which it does not declare/)])
    expect(check(of('board'), shipped('board', (m) => { m.consumes.push({ seam: 'resources', range: '^1.0.0' }) })))
      .toEqual([expect.stringMatching(/consumes ctx\.resources, which the code does not inject/)])
    expect(check(of('board'), shipped('board', (m) => { delete m.consumes.find((c: { seam: string }) => c.seam === 'mcp').optional })))
      .toEqual([expect.stringMatching(/consumes ctx\.mcp as required, but the code takes it as optional/)])
  })

  it('a seam provided or defined that the code does not provide or define, or the other way round', () => {
    expect(check(of('board'), shipped('board', (m) => { m.provides = [] }))).toEqual([expect.stringMatching(/the code provides ctx\.board, which it does not declare in provides/)])
    expect(check(of('board'), shipped('board', (m) => { m.provides.push({ seam: 'approvals', version: '1.0.0' }) }))).toEqual([expect.stringMatching(/provides ctx\.approvals, which the code does not provide/)])
    expect(check(of('board-core'), shipped('board-core', (m) => { m.defines = [{ seam: 'approvals', version: '1.0.0' }] })))
      .toEqual([expect.stringMatching(/defines ctx\.approvals, which the code does not define/), expect.stringMatching(/the code defines ctx\.board, which it does not declare/)])
  })

  it('a version that disagrees with the conformance contract, of a provider, a definition, or a consumer\'s range', () => {
    expect(check(of('workflow'), shipped('workflow', (m) => { m.provides[0].version = '1.2.0' })))
      .toEqual([expect.stringMatching(/provides ctx\.workflow at 1\.2\.0, but its conformance run pins contract 1\.3 \(packages\/plugins\/workflow\/tests\/conformance\.spec\.ts\), so it is at 1\.3\.0/)])
    expect(check(of('approvals-core'), shipped('approvals-core', (m) => { m.defines[0].version = '1.0.0' })))
      .toEqual([expect.stringMatching(/defines ctx\.approvals at 1\.0\.0, but its suite is at contract 1\.1/)])
    expect(check(of('web-ui'), shipped('web-ui', (m) => { m.consumes.find((c: { seam: string }) => c.seam === 'workflow').range = '^2.0.0' })))
      .toEqual([expect.stringMatching(/consumes ctx\.workflow in the range \^2\.0\.0, which its version in this workspace \(1\.3\.0, workflow\) does not satisfy/)])
    expect(check(of('web-ui'), shipped('web-ui', (m) => { m.consumes.find((c: { seam: string }) => c.seam === 'workflow').range = '>=1' })))
      .toEqual([expect.stringMatching(/not a caret range/)])
  })

  it('a class that disagrees with the seam catalog, or with the family table for a plugin that provides no seam', () => {
    expect(check(of('board'), shipped('board', (m) => { m.class = { kind: 'family', family: 'workflow' } })))
      .toEqual([expect.stringMatching(/class family: workflow disagrees with the seam catalog's class of ctx\.board \(core: work-state-machine\)/)])
    expect(check(of('web-ui'), shipped('web-ui', (m) => { m.class = { kind: 'family', family: 'worker' } })))
      .toEqual([expect.stringMatching(/class family: worker disagrees with the family table of the plugin model \(family: surface\)/)])
  })

  it('a name, version, description, or license that disagrees with package.json, and anything else the generator would write otherwise', () => {
    expect(check(of('board'), shipped('board', (m) => { m.version = '9.9.9' }))).toEqual([expect.stringMatching(/version "9\.9\.9" disagrees with package\.json \("0\.0\.0"\)/)])
    expect(check(of('board'), shipped('board', (m) => { m.license = 'MIT' }))).toEqual([expect.stringMatching(/license "MIT" disagrees with package\.json \("UNLICENSED"\)/)])
    expect(check(of('board'), shipped('board', (m) => { m.consumes.reverse() }))).toEqual([expect.stringMatching(/differs from the generated manifest/)])
  })
})

describe('the generator', () => {
  it('names a seam missing from the catalog, and a plugin with no seam the family table does not name, instead of guessing a class', () => {
    const model = readFileSync(join(root, 'docs', 'architecture', 'plugin-model.md'), 'utf8')
    expect(() => derive(undefined, model.replace(/^\| Orchestration \| `board` .*$/m, ''))).toThrow(/packages\/plugins\/board: ctx\.board is not in the seam catalog/)
    expect(() => derive(undefined, model.replace(', `profile-scientific-research`', ''))).toThrow(/profile-scientific-research: provides no seam, so the family table .* must name it once/)
  })

  it('matches a caret range as semver does for a major above zero', () => {
    expect([satisfies('1.3.0', '^1.0.0'), satisfies('1.3.0', '^1.3.1'), satisfies('2.0.0', '^1.0.0'), satisfies('1.0.0', '1.0.0')]).toEqual([true, false, false, undefined])
  })
})
