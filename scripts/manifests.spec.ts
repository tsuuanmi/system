/**
 * The manifest check (`pnpm check:manifests`): every manifest the workspace ships is valid and agrees
 * with its code, and each kind of disagreement is caught, on fixtures made from a real manifest.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { readManifest } from '../packages/plugin-host-core/src/index.ts'
import { bundleAllowance, check, checkAll, type CodeFacts, codeFacts, configKeys, type Derived, derive, familyNames, render, satisfies, seamClasses } from './gen-manifests.ts'
import { type Pkg, providerProblems, scan } from './gen-packages.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
let facts: CodeFacts
let derived: Derived[]
beforeAll(async () => {
  facts = await codeFacts()
  derived = derive(facts)
}, 120_000)
const of = (dir: string): Derived => derived.find((d) => d.dir === dir)!
/** The package's manifest as generated, changed by `edit`, as the text a package would ship. */
const shipped = (dir: string, edit: (m: Record<string, any>) => void): string => {
  const manifest = JSON.parse(render(of(dir).manifest)) as Record<string, any>
  edit(manifest)
  return JSON.stringify(manifest)
}

describe('the manifests the workspace ships (REQ-HOST-7)', () => {
  it('has one for every plugin and every seam definition, each valid as the host reads it, and all agreeing with the code', () => {
    expect(derived.map((d) => d.path).filter((p) => p.startsWith('packages/plugins/')).length).toBe(39)
    expect(derived.filter((d) => d.manifest.defines).map((d) => d.dir).sort()).toEqual([
      'agent-runtime-core', 'approvals-core', 'board-core', 'digest-core', 'evaluations-core', 'experiments-core', 'gateway-core', 'models-core', 'plugin-host-core', 'provider-core',
      'resources-core', 'workers-core',
    ])
    for (const d of derived) expect(readManifest(readFileSync(join(root, d.path, 'plugin-manifest.json'), 'utf8'), d.manifest.name).state, d.dir).toBe('valid')
    expect(checkAll(derived)).toEqual([])
  })

  it('derives each version from the conformance contract, each class from the seam catalog, and each consumer\'s range from its provider', () => {
    expect(of('workflow').manifest).toMatchObject({ class: { kind: 'core', component: 'work-state-machine' }, provides: [{ seam: 'workflow', version: '1.8.0' }] })
    expect(of('web-ui').manifest.consumes).toContainEqual({ seam: 'workflow', range: '^1.8.0' })
    expect(of('board-core').manifest).toMatchObject({ schema: 'plugin-manifest@1.1', class: { kind: 'core', component: 'work-state-machine' }, provides: [], defines: [{ seam: 'board', version: '1.3.0' }] })
    expect(of('experiments-core').manifest).toMatchObject({ class: { kind: 'core', component: 'work-state-machine' }, defines: [{ seam: 'experiments', version: '1.0.0' }] })
    expect(of('evaluations-core').manifest).toMatchObject({ class: { kind: 'core', component: 'gate' }, defines: [{ seam: 'evaluations', version: '1.0.0' }] })
    expect(of('runtime-claude-agent-sdk').manifest.class).toEqual({ kind: 'family', family: 'worker' })
    expect(of('report').manifest).toMatchObject({ class: { kind: 'family', family: 'surface' }, provides: [], consumes: expect.arrayContaining([{ seam: 'board', range: '^1.3.0', optional: true }]) })
    expect(of('plugin-host').manifest).toMatchObject({ class: { kind: 'core', component: 'plugin-host' }, consumes: expect.arrayContaining([{ seam: 'loader', range: '^1.0.0' }, { seam: 'profileContext', range: '^1.0.0', optional: true }]) })
    expect(seamClasses().get('mcp')).toEqual({ kind: 'family', family: 'surface' })
    expect(familyNames().get('profile-scientific-research')).toEqual(['workflow'])
  })

  it('derives each plugin\'s configuration keys from its Config, and holds no secret in any (INV-8)', () => {
    expect(of('plugin-host').manifest.config).toEqual([{ key: 'allowWithoutManifest', sensitive: false }])
    expect(of('store').manifest.config?.map((c) => c.key)).toEqual(['path', 'busyTimeoutMs', 'synchronous'])
    expect(of('report').manifest.config).toBeUndefined()
    expect(derived.filter((d) => d.manifest.config).length).toBe(35)
    // The notifier's webhook URL is a credential reference's value, never configuration.
    expect(of('notify').manifest.config?.find((c) => c.key === 'webhook')).toEqual({ key: 'webhook', sensitive: false })
    expect(of('notify').manifest).toMatchObject({ class: { kind: 'family', family: 'surface' }, provides: [] })
    // Secrets live in the credential vault; a plugin's configuration holds paths and references only.
    expect(derived.flatMap((d) => (d.manifest.config ?? []).filter((c) => c.sensitive).map((c) => `${d.dir}.${c.key}`))).toEqual([])
  })

  it('derives egress from each Worker source\'s egress check and the default policy, and keeps the one its drivers and runtimes declare (INV-12)', () => {
    expect([of('turns').egressClasses, of('agent-workers').egressClasses, of('models').egressClasses]).toEqual([['website'], ['agent'], ['model', 'model-local']])
    expect(derived.filter((d) => d.manifest.egress).map((d) => [d.dir, d.manifest.egress, d.egressClasses.length ? 'derived' : 'declared'])).toEqual([
      ['agent-workers', 'operator-shared', 'derived'], ['models', 'operator-shared', 'derived'],
      ['provider-chatgpt-web', 'operator-shared', 'declared'], ['provider-gemini-web', 'operator-shared', 'declared'],
      ['runtime-acp', 'operator-shared', 'declared'], ['runtime-antigravity-cli', 'operator-shared', 'declared'],
      ['runtime-claude-agent-sdk', 'operator-shared', 'declared'], ['runtime-codex-sdk', 'operator-shared', 'declared'],
      ['turns', 'operator-shared', 'derived'],
    ])
    expect(derived.filter((d) => d.manifest.cacheStable !== undefined)).toEqual([])
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
      .toEqual([expect.stringMatching(/provides ctx\.workflow at 1\.2\.0, but its conformance run pins contract 1\.8 \(packages\/plugins\/workflow\/tests\/conformance\.spec\.ts\), so it is at 1\.8\.0/)])
    expect(check(of('approvals-core'), shipped('approvals-core', (m) => { m.defines[0].version = '1.0.0' })))
      .toEqual([expect.stringMatching(/defines ctx\.approvals at 1\.0\.0, but its suite is at contract 1\.1/)])
    expect(check(of('web-ui'), shipped('web-ui', (m) => { m.consumes.find((c: { seam: string }) => c.seam === 'workflow').range = '^2.0.0' })))
      .toEqual([expect.stringMatching(/consumes ctx\.workflow in the range \^2\.0\.0, which its version in this workspace \(1\.8\.0, workflow\) does not satisfy/)])
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

  it('a configuration key its Config does not have, one it has that is not declared, or a sensitive flag other than its Config\'s', () => {
    expect(check(of('board'), shipped('board', (m) => { m.config.push({ key: 'extra', sensitive: false }) }))).toEqual([expect.stringMatching(/config declares the key extra, which its Config does not have/)])
    expect(check(of('board'), shipped('board', (m) => { m.config = m.config.filter((c: { key: string }) => c.key !== 'sweepSeconds') }))).toEqual([expect.stringMatching(/its Config has the key sweepSeconds, which config does not declare/)])
    expect(check(of('board'), shipped('board', (m) => { m.config[0].sensitive = true }))).toEqual([expect.stringMatching(/config key fundingMaxPercent is sensitive, but its Config does not mark it a secret/)])
    const secretive = { ...of('board'), manifest: { ...of('board').manifest, config: of('board').manifest.config!.map((c, i) => ({ ...c, sensitive: i === 0 })) } }
    expect(check(secretive, render(of('board').manifest))).toEqual([expect.stringMatching(/config key fundingMaxPercent is not sensitive, but its Config marks it a secret \(\.role\('secret'\)\)/)])
  })

  it('an egress other than a Worker source\'s check gives, one declared off the Worker family or past what any Worker class may receive, and cacheStable off the context family (INV-12)', () => {
    expect(check(of('turns'), shipped('turns', (m) => { delete m.egress }))).toEqual([expect.stringMatching(/egress none, but its code checks egress for the Worker class website, whose default policy lets operator-shared leave the machine at most/)])
    expect(check(of('board'), shipped('board', (m) => { m.egress = 'public' }))).toEqual([expect.stringMatching(/egress public is declared, but only a Worker-family plugin carries content to a remote provider/)])
    expect(check(of('runtime-acp'), shipped('runtime-acp', (m) => { m.egress = 'local-private' }))).toEqual([expect.stringMatching(/egress local-private is declared, but no Worker class's default policy lets it leave the machine \(INV-12\): at most operator-shared/)])
    expect(check(of('board'), shipped('board', (m) => { m.cacheStable = true }))).toEqual([expect.stringMatching(/cacheStable is declared, but only a context-family plugin/)])
  })

  it('a bundle whose plugin-host row allows other packages without a manifest than its DSH rows, or none', () => {
    const bundle = readFileSync(join(root, 'packages', 'system-bundle', 'cordis.patch.yml'), 'utf8')
    expect(bundleAllowance(bundle)).toEqual(['@deepseek-ai/cordis-plugin-timer', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai'])
    const problems = (text: string): string[] => checkAll(derived, undefined, text).filter((p) => p.includes('cordis.patch.yml'))
    expect(problems(bundle.replace("          - '@deepseek-ai/dsh-llm'\n", ''))).toEqual([expect.stringMatching(/leaves out the DSH row package @deepseek-ai\/dsh-llm, which ships no manifest/)])
    expect(problems(bundle.replace("          - '@deepseek-ai/dsh-llm'\n", "          - '@deepseek-ai/dsh-llm'\n          - '@tsuuanmi/system-board'\n")))
      .toEqual([expect.stringMatching(/names @tsuuanmi\/system-board, which is not a DSH row of the bundle/)])
    expect(problems(bundle.replace(/ {6}config:\n(?: {8}#.*\n)+ {8}allowWithoutManifest:\n(?: {10}- '.*'\n)+/, ''))).toEqual([expect.stringMatching(/the plugin-host row allows no package without a manifest/)])
  })
})

describe('the generator', () => {
  it('names a seam missing from the catalog, and a plugin with no seam the family table does not name, instead of guessing a class', () => {
    const model = readFileSync(join(root, 'docs', 'architecture', 'plugin-model.md'), 'utf8')
    expect(() => derive(facts, undefined, model.replace(/^\| Orchestration \| `board` .*$/m, ''))).toThrow(/packages\/plugins\/board: ctx\.board is not in the seam catalog/)
    expect(() => derive(facts, undefined, model.replace(', `profile-scientific-research`', ''))).toThrow(/profile-scientific-research: provides no seam, so the family table .* must name it once/)
  })

  it('lets a capability seam have an alternative provider, at the contract of the one whose row is on, its row off; never a guarantee seam, never two rows on (INV-1, QA-9, ADR-0036)', () => {
    expect(of('digest-extractive').manifest).toMatchObject({ class: { kind: 'family', family: 'digest' }, provides: [{ seam: 'digests', version: '1.2.0' }] })
    expect(of('digest').manifest.provides).toEqual(of('digest-extractive').manifest.provides)
    expect(of('workflow').manifest.consumes).toContainEqual({ seam: 'digests', range: '^1.2.0', optional: true })
    const model = readFileSync(join(root, 'docs', 'architecture', 'plugin-model.md'), 'utf8')
    expect(() => derive(facts, undefined, model.replace('| Orchestration | `digests` | plugin: digest |', '| Orchestration | `digests` | core: gate |')))
      .toThrow(/ctx\.digests is provided by digest, digest-extractive, but it is not a capability seam in the seam catalog: a guarantee seam has one provider/)
    const pkgs = scan()
    expect(providerProblems(pkgs)).toEqual([])
    const bothOn = pkgs.map((p) => (p.dir === 'digest-extractive' ? { ...p, off: undefined } : p)) as Pkg[]
    expect(providerProblems(bothOn)).toEqual([expect.stringMatching(/ctx\.digests is provided by digest, digest-extractive: exactly one of their bundle rows must be on by default, and the others off \(2 are on\)/)])
    const noneOn = pkgs.map((p) => (p.dir === 'digest' ? { ...p, off: true } : p)) as Pkg[]
    expect(providerProblems(noneOn)).toEqual([expect.stringMatching(/\(0 are on\)/)])
  })

  it('matches a caret range as semver does for a major above zero (the plugin host\'s own rule)', () => {
    expect([satisfies('1.3.0', '^1.0.0'), satisfies('1.3.0', '^1.3.1'), satisfies('2.0.0', '^1.0.0'), satisfies('1.0.0', '1.0.0')]).toEqual([true, false, false, undefined])
  })

  it('takes a Config\'s top-level keys, each sensitive when it or a schema within it is marked a secret', () => {
    const string = (role?: string) => ({ type: 'string', ...(role ? { meta: { role } } : {}) })
    expect(configKeys({
      type: 'object',
      dict: { token: string('secret'), routes: { type: 'array', inner: { type: 'object', dict: { key: string('secret') } } }, either: { type: 'union', list: [string(), string('secret')] }, path: string('link') },
    })).toEqual([{ key: 'token', sensitive: true }, { key: 'routes', sensitive: true }, { key: 'either', sensitive: true }, { key: 'path', sensitive: false }])
  })
})
