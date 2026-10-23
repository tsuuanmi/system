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
 *   provides or defines seams takes their Class; one that provides none is named in the family table;
 * - config: the plugin's `Config` schema, run: each top-level key, sensitive when it or a schema
 *   within it is marked a secret (`.role('secret')`);
 * - egress, for a plugin whose code checks egress (`ctx.egress.check({ workerClass })`): the
 *   strictest classification the egress plugin's default policy (`WORKER_CLASSES`) lets leave the
 *   machine for those Worker classes.
 * What the code cannot tell (`renames`, the `egress` of a plugin that carries a Worker's content but
 * checks none, `cacheStable`) is kept from the manifest, and checked where it can be: a hand-declared
 * egress only on a Worker-family plugin and only at a classification some Worker class's default
 * policy lets leave; `cacheStable` only on a context-family plugin. The check also holds the bundle's
 * plugin-host allowance (`allowWithoutManifest`) to exactly its DSH rows. It reports each
 * disagreement by kind, as the host would read the file (INV-14).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalJson } from '../packages/libs/src/index.ts'
import { MANIFEST_FILE, type PluginManifest, readManifest, satisfies } from '../packages/plugin-host-core/src/index.ts'
import { HOST_SERVICES, type Pkg, scan } from './gen-packages.ts'

export { satisfies }

const root = fileURLToPath(new URL('..', import.meta.url))
const MODEL = join(root, 'docs', 'architecture', 'plugin-model.md')
const BUNDLE_PATCH = join(root, 'packages', 'system-bundle', 'cordis.patch.yml')

type Class = PluginManifest['class']
type Contract = { contract: string; file: string }
type Classification = NonNullable<PluginManifest['egress']>
type ConfigKey = NonNullable<PluginManifest['config']>[number]

/** The classifications from the least to the most restricted: public content may leave freely, local-private never by default (INV-12). */
const STRICTNESS: readonly Classification[] = ['public', 'operator-shared', 'local-private']

/** What the generator reads by running the code: each plugin's configuration keys, and the egress plugin's default policy. */
export interface CodeFacts {
  /** Each plugin's configuration keys, by directory, from its `Config` schema; a plugin with no `Config` has none. */
  configs: Map<string, ConfigKey[]>
  /** The classifications each Worker class may receive by default (`WORKER_CLASSES` of the egress plugin). */
  workerClasses: Readonly<Record<string, readonly Classification[]>>
}

/** The part of a Schemastery schema the generator reads. */
export interface SchemaNode { type?: string; dict?: Record<string, SchemaNode>; inner?: SchemaNode; list?: SchemaNode[]; meta?: { role?: string } }

/** Whether a schema, or any schema within it, is marked a secret (`.role('secret')`). */
function secret(node: SchemaNode | undefined, depth = 0): boolean {
  if (!node || depth > 16) return false
  if (node.meta?.role === 'secret') return true
  return [...Object.values(node.dict ?? {}), ...(node.inner ? [node.inner] : []), ...(node.list ?? [])].some((child) => secret(child, depth + 1))
}

/** The keys of an object `Config` schema, in its order, each sensitive when it or a schema within it is marked a secret. */
export const configKeys = (schema: SchemaNode): ConfigKey[] => Object.entries(schema.dict ?? {}).map(([key, node]) => ({ key, sensitive: secret(node) }))

/**
 * Read from the code what only running it tells: each plugin's `Config` (its entry module, the
 * default export's `Config` or a `Config` export), and the egress plugin's default policy. The
 * workspace resolves from source, by the root tsconfig's paths, so nothing needs building first.
 */
export async function codeFacts(pkgs: readonly Pkg[] = scan()): Promise<CodeFacts> {
  const configs = new Map<string, ConfigKey[]>()
  for (const p of pkgs.filter((x) => x.path && x.plugin)) {
    const entry = join(root, p.path, 'src', 'index.ts')
    if (!existsSync(entry)) continue
    const mod = await import(pathToFileURL(entry).href) as { default?: { Config?: SchemaNode }; Config?: SchemaNode }
    const schema = mod.default?.Config ?? mod.Config
    if (!schema) continue
    if (schema.type !== 'object' || !schema.dict) throw new Error(`gen-manifests: ${p.path}: its Config is not an object schema, so its keys cannot be told`)
    configs.set(p.dir, configKeys(schema))
  }
  const egress = await import(pathToFileURL(join(root, 'packages', 'plugins', 'egress', 'src', 'index.ts')).href) as { WORKER_CLASSES: Record<string, Classification[]> }
  return { configs, workerClasses: egress.WORKER_CLASSES }
}

/**
 * The Worker classes a package's code checks egress for: the literals of each
 * `ctx.egress.check({ workerClass })` that name a class of the default policy.
 */
function egressClasses(p: Pkg, workerClasses: CodeFacts['workerClasses'], problems: string[]): string[] {
  const classes = new Set<string>()
  for (const file of sources(join(root, p.path, 'src'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\.egress\.check\(\s*\{([\s\S]*?)\}\s*\)/g)) {
      const at = /workerClass:\s*([^,\n]+)/.exec(m[1]!)
      const named = at ? [...at[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).filter((c) => Object.hasOwn(workerClasses, c)) : []
      if (!named.length) problems.push(`${file.slice(root.length)}: checks egress for a Worker class the generator cannot tell: name it as a literal of the egress plugin's WORKER_CLASSES`)
      for (const c of named) classes.add(c)
    }
  }
  return [...classes].sort()
}

/** The strictest classification the default policy lets leave the machine for any of `classes`. */
const strictest = (classes: readonly string[], workerClasses: CodeFacts['workerClasses']): Classification | undefined =>
  STRICTNESS.filter((c) => classes.some((wc) => workerClasses[wc]?.includes(c))).at(-1)

/**
 * The packages the bundle's plugin-host row allows without a manifest (`allowWithoutManifest`), as
 * its YAML lists them, one quoted name a line; undefined when the row names none.
 */
export function bundleAllowance(text: string = readFileSync(BUNDLE_PATCH, 'utf8')): string[] | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^\s*- id: plugin-host\s*$/.test(line))
  if (start < 0) return undefined
  const end = lines.findIndex((line, i) => i > start && /^\s*- id: /.test(line))
  const row = lines.slice(start, end < 0 ? undefined : end)
  const at = row.findIndex((line) => /^\s+allowWithoutManifest:\s*$/.test(line))
  if (at < 0) return undefined
  const names: string[] = []
  for (const line of row.slice(at + 1)) {
    const m = /^\s+- '([^']+)'/.exec(line)
    if (!m) break
    names.push(m[1]!)
  }
  return names
}

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
  /** The Worker classes its code checks egress for: its egress is derived from them when there are any, else declared by hand. */
  egressClasses: string[]
  /** The classifications some Worker class's default policy lets leave the machine: what a hand-declared egress may be. */
  permittedEgress: Classification[]
}

/** Derive the manifest of every plugin package and seam definition package from the code, the catalog, and package.json. */
export function derive(facts: CodeFacts, pkgs: Pkg[] = scan(), model: string = readFileSync(MODEL, 'utf8')): Derived[] {
  const problems: string[] = []
  const permittedEgress = STRICTNESS.filter((c) => Object.values(facts.workerClasses).some((classes) => classes.includes(c)))
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
    const kept = Object.fromEntries((['renames', 'egress', 'cacheStable'] as const).filter((k) => existing[k] !== undefined).map((k) => [k, existing[k]]))
    const config = facts.configs.get(p.dir)
    const checked = egressClasses(p, facts.workerClasses, problems)
    const egress = checked.length ? strictest(checked, facts.workerClasses) : kept.egress as Classification | undefined
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
      ...(config?.length ? { config } : {}),
      license: json.license ?? 'UNLICENSED',
      ...(egress ? { egress } : {}),
      ...(kept.cacheStable !== undefined ? { cacheStable: kept.cacheStable as boolean } : {}),
    }
    out.push({ dir: p.dir, path: p.path, manifest, classSource, consumed, contracts, files: json.files ?? [], egressClasses: checked, permittedEgress })
  }
  if (problems.length) throw new Error(`gen-manifests:\n  ${problems.join('\n  ')}`)
  return out
}

export const render = (manifest: PluginManifest): string => `${JSON.stringify(manifest, null, 2)}\n`

const classText = (c: Class): string => (c.kind === 'core' ? `core: ${c.component}` : `family: ${c.family}`)

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

  const wantConfig = new Map((e.config ?? []).map((c) => [c.key, c]))
  for (const c of m.config ?? []) {
    const want = wantConfig.get(c.key)
    if (!want) say(`config declares the key ${c.key}, which its Config does not have`)
    else if (want.sensitive !== c.sensitive) say(`config key ${c.key} is ${c.sensitive ? '' : 'not '}sensitive, but its Config ${want.sensitive ? 'marks it a secret (.role(\'secret\'))' : 'does not mark it a secret'}`)
  }
  const haveConfig = new Set((m.config ?? []).map((c) => c.key))
  for (const key of wantConfig.keys()) if (!haveConfig.has(key)) say(`its Config has the key ${key}, which config does not declare`)

  if (d.egressClasses.length) {
    if (m.egress !== e.egress) say(`egress ${m.egress ?? 'none'}, but its code checks egress for the Worker class ${d.egressClasses.join(', ')}, whose default policy lets ${e.egress} leave the machine at most`)
  } else if (m.egress !== undefined) {
    if (m.class.kind !== 'family' || m.class.family !== 'worker') say(`egress ${m.egress} is declared, but only a Worker-family plugin carries content to a remote provider`)
    else if (!d.permittedEgress.includes(m.egress)) say(`egress ${m.egress} is declared, but no Worker class's default policy lets it leave the machine (INV-12): at most ${d.permittedEgress.at(-1)}`)
  }
  if (m.cacheStable !== undefined && (m.class.kind !== 'family' || m.class.family !== 'context')) say('cacheStable is declared, but only a context-family plugin puts content in a Worker\'s prompt prefix')
  if (!problems.length && canonicalJson(m) !== canonicalJson(e)) say('differs from the generated manifest: run `pnpm gen:manifests`')
  return problems
}

/**
 * Every manifest problem in the workspace: each package's, a manifest in a package that should have
 * none, and a bundle whose plugin-host row allows other packages without a manifest than its DSH rows.
 */
export function checkAll(derived: Derived[], pkgs: readonly Pkg[] = scan(), bundle: string = readFileSync(BUNDLE_PATCH, 'utf8')): string[] {
  const problems = derived.flatMap((d) => check(d, existsSync(join(root, d.path, MANIFEST_FILE)) ? readFileSync(join(root, d.path, MANIFEST_FILE), 'utf8') : undefined))
  const owners = new Set(derived.map((d) => d.path))
  for (const base of ['packages', join('packages', 'plugins')]) {
    for (const dir of readdirSync(join(root, base))) {
      const path = join(base, dir)
      if (existsSync(join(root, path, MANIFEST_FILE)) && !owners.has(path)) problems.push(`${path}: has a ${MANIFEST_FILE} but is neither a plugin nor a seam definition`)
    }
  }
  const file = BUNDLE_PATCH.slice(root.length)
  const dsh = new Set(pkgs.filter((p) => p.dsh).map((p) => p.name))
  const allowed = bundleAllowance(bundle)
  if (!allowed) problems.push(`${file}: the plugin-host row allows no package without a manifest (allowWithoutManifest), so the manifest check finds each DSH row: ${[...dsh].join(', ')}`)
  else {
    for (const name of dsh) if (!allowed.includes(name)) problems.push(`${file}: the plugin-host row's allowWithoutManifest leaves out the DSH row package ${name}, which ships no manifest, so the manifest check finds it`)
    for (const name of allowed) if (!dsh.has(name)) problems.push(`${file}: the plugin-host row's allowWithoutManifest names ${name}, which is not a DSH row of the bundle: a package that is not DSH's ships its own manifest`)
  }
  return problems
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const pkgs = scan()
  const derived = derive(await codeFacts(pkgs), pkgs)
  if (process.argv.includes('--check')) {
    const problems = checkAll(derived, pkgs)
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
