/**
 * Plugin host seam definition: `ctx.pluginHost` (docs/design/plugin-host.md), the guarantee seam of
 * the plugin host core component (ADR-0036): every plugin of the composition with the manifest its
 * package declares (`plugin-manifest@1.x`), and each plugin's lifecycle state, every change recorded
 * as a `lifecycle` decision before the state is (INV-13). Base records the state the operator's
 * configuration gives a plugin and automates nothing: a plugin a row mounts is `default`, one whose
 * rows are all off is `candidate`, one no row names any more is `retired`. `shadow` and `canary`
 * need a split of work between plugins that nothing in Base makes, so no Base host records them.
 * The vocabulary, the reading of a declared manifest, and the reconciliation every provider applies
 * live here; `schemas/plugin-manifest.v1.json` and `schemas/decision.v1.json` are canonical.
 * @module @tsuuanmi/system-plugin-host-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import { contentId, SchemaRegistry } from '@tsuuanmi/system-libs'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginHost: PluginHost
  }
}

/** The contract version this definition and its conformance suite describe. */
export const PLUGIN_HOST_CONTRACT = '1.0' as const

/** The file a plugin package declares its manifest in, at the package's root. */
export const MANIFEST_FILE = 'plugin-manifest.json'

/** The largest manifest file a host reads (INV-9); a larger one is refused. */
export const MANIFEST_MAX_BYTES = 64 * 1024

/** A content id (`sha256:<hex>`). */
export type ArtifactRef = `sha256:${string}`

export type LifecycleState = 'candidate' | 'shadow' | 'canary' | 'default' | 'retired'
export const LIFECYCLE_STATES: readonly LifecycleState[] = ['candidate', 'shadow', 'canary', 'default', 'retired']

/** A plugin's lifecycle as the host recorded it: `_meta.lifecycle` of `plugin-manifest@1.x`. */
export interface Lifecycle {
  state: LifecycleState
  /** For `canary` only: the share of eligible jobs it serves. */
  share?: number
  /** When the decision that set it was recorded. */
  since: string
  /** The `lifecycle` decision that set it. */
  decision: ArtifactRef
}

export type CoreComponent = 'ledger-of-record' | 'work-state-machine' | 'runner' | 'gate' | 'resource-ledger' | 'plugin-host'
export type PluginFamily = 'worker' | 'decision' | 'verification' | 'digest' | 'context' | 'workflow' | 'knowledge' | 'surface'
export interface SeamVersion { seam: string; version: string }

/** `plugin-manifest@1.x`: what a plugin package declares, and the host's `_meta`. */
export interface PluginManifest {
  schema: 'plugin-manifest@1.0' | 'plugin-manifest@1.1'
  name: string
  renames?: string[]
  version: string
  description?: string
  class: { kind: 'core'; component: CoreComponent } | { kind: 'family'; family: PluginFamily }
  provides: SeamVersion[]
  consumes: Array<{ seam: string; range: string; optional?: boolean }>
  /** `@1.1`: the seams a definition package owns. */
  defines?: SeamVersion[]
  config?: Array<{ key: string; sensitive: boolean; description?: string }>
  license: string
  egress?: 'public' | 'operator-shared' | 'local-private'
  cacheStable?: boolean
  /** The host's, never declared. */
  _meta?: { lifecycle: Lifecycle }
}

/** One row of the composition: its id, the package it loads, and whether the composition mounts it. */
export interface CompositionRow { id: string; name: string; mounted: boolean }

/** What reading a row's package found: its manifest, none, or one the host refuses, with why. */
export type ManifestRead =
  | { state: 'valid'; manifest: PluginManifest; digest: ArtifactRef }
  | { state: 'absent' | 'refused'; reason: string }

/** A plugin's lifecycle as last recorded, with the version and rows its decision saw. */
export interface RecordedLifecycle extends Lifecycle {
  name: string
  version: string
  rows: string[]
}

/** A plugin as the host lists it. */
export interface PluginRecord {
  /** Its package name. */
  name: string
  /** Its rows in the composition, in order; none once retired. */
  rows: string[]
  /** Whether a row of the composition mounts it. */
  mounted: boolean
  manifestState: ManifestRead['state']
  /** Why its manifest is absent or refused. */
  reason?: string
  /** The manifest it declares, `_meta.lifecycle` filled from the host's record: a valid `plugin-manifest@1.x`. */
  manifest?: PluginManifest
  /** Its lifecycle as last recorded, whatever its manifest is now. */
  lifecycle?: Lifecycle
}

export abstract class PluginHost extends Service {
  constructor(ctx: Context) {
    super(ctx, 'pluginHost')
  }

  /** Every plugin of the composition, in the order of its first row, then each retired one, by name. */
  abstract list(): PluginRecord[]

  /** One plugin, by its name or a name it was renamed from; undefined when the host knows none. */
  abstract get(name: string): PluginRecord | undefined
}

const schemas = new SchemaRegistry()
const refused = (reason: string): ManifestRead => ({ state: 'refused', reason })

/**
 * Read a package's declared manifest, `text` being its `plugin-manifest.json` (undefined: the
 * package ships none). A manifest is refused, never repaired (INV-14): one that is not a JSON
 * object, that declares the host's `_meta`, that is not a valid `plugin-manifest@1.x` (an unknown
 * major included), or that names another package than the row loads. Its digest is the sha256 of
 * its canonical JSON.
 */
export function readManifest(text: string | undefined, packageName: string): ManifestRead {
  if (text === undefined) return { state: 'absent', reason: `${packageName} ships no ${MANIFEST_FILE}` }
  if (Buffer.byteLength(text) > MANIFEST_MAX_BYTES) return refused(`its ${MANIFEST_FILE} is larger than ${MANIFEST_MAX_BYTES} bytes`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return refused(`its ${MANIFEST_FILE} is not JSON: ${(error as Error).message.slice(0, 200)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refused(`its ${MANIFEST_FILE} is not a JSON object`)
  const record = value as Record<string, unknown>
  if ('_meta' in record) return refused('it declares _meta, which belongs to the host: a plugin never declares its lifecycle')
  if (typeof record.schema !== 'string' || !record.schema.startsWith('plugin-manifest@')) return refused(`it is not a plugin manifest (schema ${JSON.stringify(record.schema)?.slice(0, 80)})`)
  try {
    schemas.assertRecord(record)
  } catch (error) {
    return refused(`it is not a valid plugin manifest: ${(error as Error).message.slice(0, 300)}`)
  }
  const manifest = record as unknown as PluginManifest
  if (manifest.name !== packageName) return refused(`it names ${manifest.name}, but the row loads ${packageName}`)
  return { state: 'valid', manifest, digest: contentId(manifest) as ArtifactRef }
}

/** The body of a `lifecycle` decision (`decision@1.5`), as a provider records it through `ctx.artifacts.recordDecision`. */
export interface LifecycleDecision {
  schema: 'decision@1.5'
  decisionType: 'lifecycle'
  question: string
  inputs: ArtifactRef[]
  candidates: Array<{ option: LifecycleState; selected: boolean; reasons: string[] }>
  decider: { type: 'rule'; id: 'plugin-host.composition'; version: '1'; hash: ArtifactRef }
  outcome: { option: LifecycleState; detail: { plugin: string; version: string; rows: string[]; from: LifecycleState | null; renamedFrom?: string; manifestDigest?: ArtifactRef } }
  deterministic: true
  rationale: string
}

/** A lifecycle change to record: its decision first, then the plugin's new record. */
export interface LifecycleChange {
  name: string
  state: LifecycleState
  version: string
  rows: string[]
  /** The record it replaces, when the plugin had one; under a former name when it was renamed. */
  previous?: RecordedLifecycle
  decision: LifecycleDecision
}

/** What a boot changes: decisions to record, and records to carry to a new name with no change of state. */
export interface Reconciliation {
  changes: LifecycleChange[]
  moves: Array<{ from: string; to: string }>
}

/** The plugins of a composition, in the order of their first row, each with its rows and whether one mounts it. */
export function pluginsOf(rows: readonly CompositionRow[]): Array<{ name: string; rows: string[]; mounted: boolean }> {
  const plugins = new Map<string, { name: string; rows: string[]; mounted: boolean }>()
  for (const row of rows) {
    const plugin = plugins.get(row.name) ?? { name: row.name, rows: [], mounted: false }
    plugin.rows.push(row.id)
    plugin.mounted ||= row.mounted
    plugins.set(row.name, plugin)
  }
  return [...plugins.values()]
}

/**
 * The decider's hash: the sha256 of the composition as the rule read it (each row's id, package,
 * and whether it is mounted, in order), so a decision shows which composition gave it.
 */
export function compositionHash(rows: readonly CompositionRow[]): ArtifactRef {
  return contentId(rows.map(({ id, name, mounted }) => ({ id, name, mounted }))) as ArtifactRef
}

const list = (rows: readonly string[]): string => rows.join(', ')

/** Why each state was chosen or not, for one plugin (undefined: no row names it): every candidate gives a reason (INV-13). */
function reasons(plugin: { rows: string[]; mounted: boolean } | undefined): Record<LifecycleState, string> {
  if (!plugin) {
    return {
      default: 'not default: no row of the composition names it',
      candidate: 'not a candidate: no row of the composition names it',
      shadow: 'Base runs no plugin beside another with its results unused: shadow runs are not automated',
      canary: 'Base gives no plugin a share of the jobs: a canary split is not automated',
      retired: 'no row of the composition names it any more',
    }
  }
  const rows = list(plugin.rows)
  return {
    default: plugin.mounted ? `its row ${rows} is on in the composition: it serves every eligible job` : `not default: no row of the composition mounts it (${rows} off)`,
    candidate: plugin.mounted ? `not a candidate: its row ${rows} is on` : `its row ${rows} is off in the composition: installed with a valid manifest, and not run`,
    shadow: 'Base runs no plugin beside another with its results unused: shadow runs are not automated',
    canary: 'Base gives no plugin a share of the jobs: a canary split is not automated',
    retired: `not retired: the composition names it (${rows})`,
  }
}

function decision(name: string, state: LifecycleState, plugin: { rows: string[]; mounted: boolean } | undefined, version: string, hash: ArtifactRef, previous: RecordedLifecycle | undefined, digest: ArtifactRef | undefined): LifecycleDecision {
  const why = reasons(plugin)
  return {
    schema: 'decision@1.5',
    decisionType: 'lifecycle',
    question: `Which lifecycle state does plugin ${name} have?`,
    inputs: previous ? [previous.decision] : [],
    candidates: LIFECYCLE_STATES.map((option) => ({ option, selected: option === state, reasons: [why[option]] })),
    decider: { type: 'rule', id: 'plugin-host.composition', version: '1', hash },
    outcome: {
      option: state,
      detail: {
        plugin: name, version, rows: plugin?.rows ?? [], from: previous?.state ?? null,
        ...(previous && previous.name !== name ? { renamedFrom: previous.name } : {}),
        ...(digest ? { manifestDigest: digest } : {}),
      },
    },
    deterministic: true,
    rationale: 'The state follows from the operator\'s configuration (a row on, off, or gone); the host records it and automates nothing (PROP-0010).',
  }
}

/**
 * What a boot records, the same for every provider. A plugin of the composition with a valid
 * manifest has the state its rows give it (`default` when one is mounted, else `candidate`); a
 * recorded plugin no row names any more, and that no plugin of the composition was renamed from,
 * is `retired`. A plugin whose recorded state already is that state changes nothing, so a boot
 * records each state once and again only on a change. A plugin whose manifest is absent or refused
 * is left as it was recorded: nothing is derived from a manifest the host could not read. A plugin
 * with no record of its own takes the record of the first name in its manifest's `renames` that
 * has one, and keeps its state there, with no decision when the state is the same.
 */
export function reconcile(rows: readonly CompositionRow[], manifests: ReadonlyMap<string, ManifestRead>, recorded: ReadonlyMap<string, RecordedLifecycle>): Reconciliation {
  const hash = compositionHash(rows)
  const plugins = pluginsOf(rows)
  const changes: LifecycleChange[] = []
  const moves: Reconciliation['moves'] = []
  const claimed = new Set<string>()
  for (const plugin of plugins) {
    const read = manifests.get(plugin.name)
    if (read?.state !== 'valid') {
      claimed.add(plugin.name)
      continue
    }
    const own = recorded.get(plugin.name)
    const former = own ? undefined : (read.manifest.renames ?? []).find((old) => recorded.has(old) && !claimed.has(old) && !plugins.some((p) => p.name === old))
    const previous = own ?? (former ? recorded.get(former) : undefined)
    claimed.add(plugin.name)
    if (former) claimed.add(former)
    const state: LifecycleState = plugin.mounted ? 'default' : 'candidate'
    if (previous?.state === state) {
      if (former) moves.push({ from: former, to: plugin.name })
      continue
    }
    changes.push({ name: plugin.name, state, version: read.manifest.version, rows: plugin.rows, ...(previous ? { previous } : {}), decision: decision(plugin.name, state, plugin, read.manifest.version, hash, previous, read.digest) })
  }
  for (const [name, record] of [...recorded].sort(([a], [b]) => a.localeCompare(b))) {
    if (claimed.has(name) || record.state === 'retired') continue
    changes.push({ name, state: 'retired', version: record.version, rows: [], previous: record, decision: decision(name, 'retired', undefined, record.version, hash, record, undefined) })
  }
  return { changes, moves }
}

/**
 * The plugins as a host lists them after a boot: those of the composition in the order of their
 * first row, then the recorded ones no row names any more, by name. A valid manifest carries the
 * host's record in `_meta.lifecycle`.
 */
export function pluginRecords(rows: readonly CompositionRow[], manifests: ReadonlyMap<string, ManifestRead>, recorded: ReadonlyMap<string, RecordedLifecycle>): PluginRecord[] {
  const lifecycle = (record: RecordedLifecycle | undefined): Lifecycle | undefined => record && {
    state: record.state, ...(record.share !== undefined ? { share: record.share } : {}), since: record.since, decision: record.decision,
  }
  const listed = pluginsOf(rows).map((plugin): PluginRecord => {
    const read = manifests.get(plugin.name) ?? { state: 'absent', reason: `${plugin.name} was not read` }
    const own = lifecycle(recorded.get(plugin.name))
    return {
      ...plugin,
      manifestState: read.state,
      ...(read.state === 'valid' ? { manifest: { ...read.manifest, ...(own ? { _meta: { lifecycle: own } } : {}) } } : { reason: read.reason }),
      ...(own ? { lifecycle: own } : {}),
    }
  })
  const named = new Set(listed.map((p) => p.name))
  const gone = [...recorded.values()].filter((r) => !named.has(r.name)).sort((a, b) => a.name.localeCompare(b.name))
  return [...listed, ...gone.map((record): PluginRecord => ({
    name: record.name, rows: [], mounted: false, manifestState: 'absent', reason: 'no row of the composition names it', lifecycle: lifecycle(record)!,
  }))]
}

/** Find a plugin in a host's list by its name, or by a name its manifest says it was renamed from. */
export function findPlugin(records: readonly PluginRecord[], name: string): PluginRecord | undefined {
  return records.find((r) => r.name === name) ?? records.find((r) => r.manifest?.renames?.includes(name))
}
