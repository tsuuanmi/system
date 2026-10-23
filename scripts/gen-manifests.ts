/**
 * Generates the `plugin-manifest.json` of every plugin package and every seam definition package
 * (`plugin-manifest@1.x`, docs/design/plugin-host.md#manifests), and checks the checked-in ones
 * against the code they describe (`--check`, part of `pnpm check`). Each fact has one source:
 * - name, version, description, license: the package's `package.json` (`UNLICENSED` while it
 *   declares none);
 * - provides, consumes (optional ones marked), defines: the code, as `gen-packages` reads it;
 * - versions: a provided seam is at the contract its provider pins in its conformance run
 *   (`runSuite(<suite>, { contract })` in the package's tests), a defined seam at its suite's
 *   `contract`, and a seam whose suite predates the conformance runner, or has none (DSH's), at 1.0;
 *   a consumed seam accepts `^` its provider's version in this workspace, else its definition's;
 * - class: the [seam catalog](../docs/architecture/plugin-model.md#seam-catalog): a package that
 *   provides or defines seams takes their Class; one that provides none is named in the family table.
 * What the code cannot tell (`renames`, `config`, `egress`, `cacheStable`) is kept from the manifest.
 * The check reports each disagreement by kind, as the host would read the file (INV-14).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalJson } from '../packages/libs/src/index.ts'
import { MANIFEST_FILE, type PluginManifest, readManifest } from '../packages/plugin-host-core/src/index.ts'
import { HOST_SERVICES, type Pkg, scan } from './gen-packages.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const MODEL = join(root, 'docs', 'architecture', 'plugin-model.md')

type Class = PluginManifest['class']
type Contract = { contract: string; file: string }

const COMPONENTS: Record<string, Extract<Class, { kind: 'core' }>['component']> = {
  'ledger of record': 'ledger-of-record', 'work state machine': 'work-state-machine', 'runner': 'runner', 'gate': 'gate',
  'resource ledger and metering': 'resource-ledger', 'plugin host': 'plugin-host',
}
const FAMILIES: Record<string, Extract<Class, { kind: 'family' }>['family']> = {
  'worker': 'worker', 'decision': 'decision', 'verification': 'verification', 'digest': 'digest', 'context': 'context',
  'workflow': 'workflow', 'knowledge': 'knowledge', 'surface': 'surface',
}

const tableRows = (text: string, header: RegExp): string[][] => {
  const start = text.split('\n').findIndex((line) => header.test(line))
  if (start < 0) throw new Error(`plugin-model.md: no table headed ${header}`)
  const rows: string[][] = []
  for (const line of text.split('\n').slice(start + 2)) {
    if (!line.startsWith('|')) break
    rows.push(line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim()))
  }
  return rows
}
const ticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)

/** Each seam's class, from the Class column of the seam catalog: `core: <component>…` or `plugin: <family>…`. */
export function seamClasses(model: string = readFileSync(MODEL, 'utf8')): Map<string, Class> {
  const classes = new Map<string, Class>()
  for (const [, seam = '', cell = ''] of tableRows(model, /^\| Layer \| Seam/)) {
    const key = ticked(seam)[0]
    const m = /^(core|plugin): ([A-Za-z ]+?)\s*(?:[,;(]|$)/.exec(cell)
    if (!key || !m) continue
    const name = m[2]!.toLowerCase()
    const known = m[1] === 'core' ? COMPONENTS[name] : FAMILIES[name]
    if (!known) throw new Error(`plugin-model.md: ctx.${key} has an unknown class "${cell}"`)
    classes.set(key, m[1] === 'core' ? { kind: 'core', component: known as Extract<Class, { kind: 'core' }>['component'] } : { kind: 'family', family: known as Extract<Class, { kind: 'family' }>['family'] })
  }
  return classes
}

/** The family each package the family table names belongs to, by directory name. */
export function familyNames(model: string = readFileSync(MODEL, 'utf8')): Map<string, string[]> {
  const named = new Map<string, string[]>()
  for (const [family = '', , providers = ''] of tableRows(model, /^\| Plugin family \|/)) {
    const key = FAMILIES[family.toLowerCase()]
    if (!key) throw new Error(`plugin-model.md: unknown plugin family "${family}"`)
    for (const token of ticked(providers)) named.set(token, [...(named.get(token) ?? []), key])
  }
  return named
}

function sources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (entry === 'node_modules' || entry === 'lib') continue
    if (statSync(path).isDirectory()) sources(path, out)
    else if (entry.endsWith('.ts')) out.push(path)
  }
  return out
}

/** Every suite defined through the conformance runner: its variable, seam, and contract. */
export function suites(pkgs: readonly Pkg[]): Map<string, { seam: string } & Contract> {
  const out = new Map<string, { seam: string } & Contract>()
  for (const p of pkgs.filter((x) => x.path)) {
    for (const file of sources(join(root, p.path, 'conformance'))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/export const (\w+) = defineSuite<\w+>\(\{\s*seam: '(\w+)'/g)) {
        const contract = /\bcontract: '(\d+\.\d+)'/.exec(text.slice(m.index))?.[1]
        if (!contract) throw new Error(`${file}: suite ${m[1]} names no contract`)
        out.set(m[1]!, { seam: m[2]!, contract, file: file.slice(root.length) })
      }
    }
  }
  return out
}

/** The contract each package pins in its own conformance runs, by seam (`runSuite(<suite>, { contract })` in its tests). */
export function pins(pkgs: readonly Pkg[], defined: ReadonlyMap<string, { seam: string } & Contract>): Map<string, Map<string, Contract[]>> {
  const constants = new Map<string, string>()
  for (const p of pkgs.filter((x) => x.path)) {
    for (const file of sources(join(root, p.path, 'src'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/export const (\w+_CONTRACT) = '(\d+\.\d+)'/g)) constants.set(m[1]!, m[2]!)
    }
  }
  const out = new Map<string, Map<string, Contract[]>>()
  for (const p of pkgs.filter((x) => x.path)) {
    const bySeam = new Map<string, Contract[]>()
    for (const file of sources(join(root, p.path, 'tests'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/runSuite\(\s*(\w+)\s*,\s*\{[^}]*?\bcontract:\s*(?:'(\d+\.\d+)'|(\w+))/g)) {
        const suite = defined.get(m[1]!)
        if (!suite) continue
        const contract = m[2] ?? constants.get(m[3]!)
        if (!contract) throw new Error(`${file}: runSuite(${m[1]}) pins ${m[3]}, which no package exports`)
        bySeam.set(suite.seam, [...(bySeam.get(suite.seam) ?? []), { contract, file: file.slice(root.length) }])
      }
    }
    out.set(p.dir, bySeam)
  }
  return out
}

const semver = (contract: string): string => `${contract}.0`

/** A package that has a manifest, with everything its manifest is derived from. */
export interface Derived {
  dir: string
  path: string
  manifest: PluginManifest
  /** Where its class comes from, to say so when a manifest disagrees. */
  classSource: string
  /** The version each seam it consumes is at in this workspace, and who sets it. */
  consumed: Map<string, { version: string; by: string }>
  /** For each seam it provides or defines: the contract it must declare, and where that is pinned. */
  contracts: Map<string, { version: string; from: string }>
  /** The `files` its package.json ships. */
  files: string[]
}

/** Derive the manifest of every plugin package and seam definition package from the code, the catalog, and package.json. */
export function derive(pkgs: Pkg[] = scan(), model: string = readFileSync(MODEL, 'utf8')): Derived[] {
  const problems: string[] = []
  const classes = seamClasses(model)
  const families = familyNames(model)
  const defined = suites(pkgs)
  const suiteOf = new Map([...defined.values()].map((s) => [s.seam, s]))
  const pinned = pins(pkgs, defined)

  // The version of every seam in this workspace: its provider's, else its definition's.
  const definitionVersion = (seam: string): string => semver(suiteOf.get(seam)?.contract ?? '1.0')
  const providedVersion = new Map<string, { version: string; by: string; from: string }>()
  for (const p of pkgs) {
    for (const seam of p.provides) {
      const suite = suiteOf.get(seam)
      if (!suite || p.dsh) {
        providedVersion.set(seam, { version: '1.0.0', by: p.dir, from: p.dsh ? 'a DSH row has no versioned conformance suite: contract 1.0' : 'it has no versioned conformance suite: contract 1.0' })
        continue
      }
      const runs = pinned.get(p.dir)?.get(seam) ?? []
      const contracts = [...new Set(runs.map((r) => r.contract))]
      if (!contracts.length) problems.push(`${p.path}: provides ctx.${seam}, but runs no conformance suite of it (runSuite(…) in its tests)`)
      else if (contracts.length > 1) problems.push(`${p.path}: pins ctx.${seam} at several contracts (${contracts.join(', ')})`)
      else providedVersion.set(seam, { version: semver(contracts[0]!), by: p.dir, from: `its conformance run pins contract ${contracts[0]} (${runs[0]!.file})` })
    }
  }
  const versionOf = (seam: string): { version: string; by: string } => {
    const provided = providedVersion.get(seam)
    if (provided) return { version: provided.version, by: provided.by }
    const definer = pkgs.find((p) => p.defines.includes(seam))
    if (definer) return { version: definitionVersion(seam), by: definer.dir }
    return { version: '1.0.0', by: seam in HOST_SERVICES ? 'the dsh launcher' : 'no package' }
  }

  const out: Derived[] = []
  for (const p of pkgs.filter((x) => x.path && (x.plugin || x.defines.length))) {
    const json = JSON.parse(readFileSync(join(root, p.path, 'package.json'), 'utf8')) as { name: string; version: string; description?: string; license?: string; files?: string[] }
    const seams = [...p.provides, ...p.defines]
    let cls: Class | undefined
    let classSource = ''
    if (seams.length) {
      const found = [...new Set(seams.map((s) => {
        const c = classes.get(s)
        if (!c) problems.push(`${p.path}: ctx.${s} is not in the seam catalog (docs/architecture/plugin-model.md#seam-catalog)`)
        return c ? JSON.stringify(c) : undefined
      }).filter((c): c is string => c !== undefined))]
      if (found.length > 1) problems.push(`${p.path}: its seams ${seams.join(', ')} are of several classes in the seam catalog`)
      if (found.length === 1) cls = JSON.parse(found[0]!) as Class
      classSource = `the seam catalog's class of ctx.${seams.join(', ctx.')}`
    } else {
      const named = families.get(p.dir) ?? []
      if (named.length !== 1) problems.push(`${p.path}: provides no seam, so the family table of docs/architecture/plugin-model.md must name it once (it names it ${named.length} times)`)
      else cls = { kind: 'family', family: named[0] as Extract<Class, { kind: 'family' }>['family'] }
      classSource = 'the family table of the plugin model'
    }
    if (!cls) continue
    const contracts = new Map<string, { version: string; from: string }>()
    for (const seam of p.provides) {
      const v = providedVersion.get(seam)
      if (v) contracts.set(seam, { version: v.version, from: v.from })
    }
    for (const seam of p.defines) contracts.set(seam, { version: definitionVersion(seam), from: suiteOf.has(seam) ? `its suite is at contract ${suiteOf.get(seam)!.contract} (${suiteOf.get(seam)!.file})` : 'no versioned conformance suite: contract 1.0' })
    const consumed = new Map([...p.required, ...p.optional].map((seam) => [seam, versionOf(seam)]))
    const existing = existsSync(join(root, p.path, MANIFEST_FILE)) ? (() => {
      try {
        return JSON.parse(readFileSync(join(root, p.path, MANIFEST_FILE), 'utf8')) as Partial<PluginManifest>
      } catch {
        return {}
      }
    })() : {}
    const kept = Object.fromEntries((['renames', 'config', 'egress', 'cacheStable'] as const).filter((k) => existing[k] !== undefined).map((k) => [k, existing[k]]))
    const manifest: PluginManifest = {
      schema: p.defines.length ? 'plugin-manifest@1.1' : 'plugin-manifest@1.0',
      name: json.name,
      ...(kept.renames ? { renames: kept.renames as string[] } : {}),
      version: json.version,
      ...(json.description ? { description: json.description } : {}),
      class: cls,
      provides: [...p.provides].sort().filter((s) => contracts.has(s)).map((seam) => ({ seam, version: contracts.get(seam)!.version })),
      consumes: [
        ...p.required.map((seam) => ({ seam, range: `^${consumed.get(seam)!.version}` })),
        ...p.optional.map((seam) => ({ seam, range: `^${consumed.get(seam)!.version}`, optional: true })),
      ],
      ...(p.defines.length ? { defines: [...p.defines].sort().map((seam) => ({ seam, version: contracts.get(seam)!.version })) } : {}),
      ...(kept.config ? { config: kept.config as NonNullable<PluginManifest['config']> } : {}),
      license: json.license ?? 'UNLICENSED',
      ...(kept.egress ? { egress: kept.egress as NonNullable<PluginManifest['egress']> } : {}),
      ...(kept.cacheStable !== undefined ? { cacheStable: kept.cacheStable as boolean } : {}),
    }
    out.push({ dir: p.dir, path: p.path, manifest, classSource, consumed, contracts, files: json.files ?? [] })
  }
  if (problems.length) throw new Error(`gen-manifests:\n  ${problems.join('\n  ')}`)
  return out
}

export const render = (manifest: PluginManifest): string => `${JSON.stringify(manifest, null, 2)}\n`

const classText = (c: Class): string => (c.kind === 'core' ? `core: ${c.component}` : `family: ${c.family}`)

/** Whether `version` satisfies a caret range `^M.m.p`; undefined when `range` is not one. */
export function satisfies(version: string, range: string): boolean | undefined {
  const r = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!r || !v) return undefined
  const [rm, rn, rp] = r.slice(1).map(Number) as [number, number, number]
  const [vm, vn, vp] = v.slice(1).map(Number) as [number, number, number]
  return vm === rm && (vn > rn || (vn === rn && vp >= rp))
}

/**
 * Every way the manifest a package ships (`text`; undefined: none) disagrees with what its code,
 * its package.json, and the seam catalog say, each named by what disagrees.
 */
export function check(d: Derived, text: string | undefined): string[] {
  const file = `${d.path}/${MANIFEST_FILE}`
  if (text === undefined) return [`${d.path}: ships no ${MANIFEST_FILE}: run \`pnpm gen:manifests\``]
  const problems: string[] = []
  const say = (message: string): void => void problems.push(`${file}: ${message}`)
  if (!d.files.includes(MANIFEST_FILE)) say(`package.json "files" does not ship it, so an installed package has no manifest`)
  const read = readManifest(text, d.manifest.name)
  if (read.state !== 'valid') return [...problems, `${file}: the host refuses it: ${read.reason}`]
  const m = read.manifest
  const e = d.manifest
  for (const key of ['name', 'version', 'description', 'license'] as const) {
    if (m[key] !== e[key]) say(`${key} ${JSON.stringify(m[key])} disagrees with package.json (${JSON.stringify(e[key])})`)
  }
  if (classText(m.class) !== classText(e.class)) say(`class ${classText(m.class)} disagrees with ${d.classSource} (${classText(e.class)})`)

  const declared = (list: Array<{ seam: string }> | undefined): Set<string> => new Set((list ?? []).map((s) => s.seam))
  for (const [field, verb] of [['provides', 'provides'], ['defines', 'defines']] as const) {
    const want = new Map((e[field] ?? []).map((s) => [s.seam, s.version]))
    for (const s of m[field] ?? []) {
      if (!want.has(s.seam)) say(`${field} ctx.${s.seam}, which the code does not ${verb === 'provides' ? 'provide' : 'define'}`)
      else if (want.get(s.seam) !== s.version) say(`${field} ctx.${s.seam} at ${s.version}, but ${d.contracts.get(s.seam)!.from}, so it is at ${want.get(s.seam)}`)
    }
    const have = declared(m[field])
    for (const seam of want.keys()) if (!have.has(seam)) say(`the code ${verb === 'provides' ? 'provides' : 'defines'} ctx.${seam}, which it does not declare in ${field}`)
  }
  const wantConsumed = new Map(e.consumes.map((c) => [c.seam, c]))
  for (const c of m.consumes) {
    const want = wantConsumed.get(c.seam)
    if (!want) {
      say(`consumes ctx.${c.seam}, which the code does not inject`)
      continue
    }
    if (!!c.optional !== !!want.optional) say(`consumes ctx.${c.seam} as ${c.optional ? 'optional' : 'required'}, but the code takes it as ${want.optional ? 'optional (ctx.get, ctx.inject)' : 'required (its inject list)'}`)
    const at = d.consumed.get(c.seam)!
    const ok = satisfies(at.version, c.range)
    if (ok === undefined) say(`consumes ctx.${c.seam} in the range ${c.range}, which is not a caret range (^major.minor.patch)`)
    else if (!ok) say(`consumes ctx.${c.seam} in the range ${c.range}, which its version in this workspace (${at.version}, ${at.by}) does not satisfy`)
  }
  const have = declared(m.consumes)
  for (const seam of wantConsumed.keys()) if (!have.has(seam)) say(`the code consumes ctx.${seam} (${wantConsumed.get(seam)!.optional ? 'optional' : 'required'}), which it does not declare`)
  if (!problems.length && canonicalJson(m) !== canonicalJson(e)) say('differs from the generated manifest: run `pnpm gen:manifests`')
  return problems
}

/** Every manifest problem in the workspace: each package's, and a manifest in a package that should have none. */
export function checkAll(derived: Derived[] = derive()): string[] {
  const problems = derived.flatMap((d) => check(d, existsSync(join(root, d.path, MANIFEST_FILE)) ? readFileSync(join(root, d.path, MANIFEST_FILE), 'utf8') : undefined))
  const owners = new Set(derived.map((d) => d.path))
  for (const base of ['packages', join('packages', 'plugins')]) {
    for (const dir of readdirSync(join(root, base))) {
      const path = join(base, dir)
      if (existsSync(join(root, path, MANIFEST_FILE)) && !owners.has(path)) problems.push(`${path}: has a ${MANIFEST_FILE} but is neither a plugin nor a seam definition`)
    }
  }
  return problems
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const derived = derive()
  if (process.argv.includes('--check')) {
    const problems = checkAll(derived)
    for (const p of problems) console.error(p)
    if (problems.length) {
      console.error(`manifests: ${problems.length} problem(s)`)
      process.exit(1)
    }
    console.log(`manifests: ${derived.length} up to date`)
  } else {
    for (const d of derived) writeFileSync(join(root, d.path, MANIFEST_FILE), render(d.manifest))
    console.log(`wrote ${derived.length} manifests`)
  }
}
