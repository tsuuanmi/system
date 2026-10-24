/**
 * Plugin host seam definition: `ctx.pluginHost` (docs/design/plugin-host.md), the guarantee seam of
 * the plugin host core component (ADR-0036): every plugin of the composition with the manifest its
 * package declares (`plugin-manifest@1.x`), and each plugin's lifecycle state, every change recorded
 * as a `lifecycle` decision before the state is (INV-13). Base records the state the operator's
 * configuration gives a plugin and automates nothing: a plugin a row mounts is `default`, one whose
 * rows are all off is `candidate`, one no row names any more is `retired`. `shadow` and `canary`
 * need a split of work between plugins that nothing in Base makes, so no Base host records them.
 * Contract 1.1 adds the manifest check: each plugin a row mounts is checked against its manifest and
 * its providers' manifests at start, and what the check finds is recorded as a `gate` decision and
 * listed (ADR-0048). The vocabulary, the reading of a declared manifest, the check, and the
 * reconciliations every provider applies live here; `schemas/plugin-manifest.v1.json` and
 * `schemas/decision.v1.json` are canonical.
 * @module @tsuuanmi/system-plugin-host-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import { canonicalJson, contentId, SchemaRegistry } from '@tsuuanmi/system-libs'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginHost: PluginHost
  }
}

/** The contract version this definition and its conformance suite describe; 1.1 adds the manifest check (`PluginRecord.findings`, `checked`). */
export const PLUGIN_HOST_CONTRACT = '1.1' as const

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
  /** 1.1: what this start's manifest check found, for a plugin a row mounts; absent when it found nothing. */
  findings?: ManifestFinding[]
  /** 1.1: with `findings`, the `gate` decision that recorded them, and when. */
  checked?: { since: string; decision: ArtifactRef }
}

/**
 * 1.1: what the manifest check finds wrong with a plugin a row mounts: it runs with no valid
 * manifest (none in its package that the configuration allows, or one the host refused), or a seam
 * it consumes is provided at a version its range does not accept. `provider` is the plugin whose
 * manifest declares that version; absent, no plugin of the composition declares the seam, and it is
 * taken at {@link UNDECLARED_SEAM_VERSION}.
 */
export type ManifestFinding =
  | { kind: 'no-manifest'; manifest: 'absent' | 'refused'; reason: string }
  | { kind: 'unsatisfied'; seam: string; range: string; provider?: string; version: string; reason: string }

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
 * The version a seam is taken at when no plugin of the composition declares it: a seam of DSH or a
 * service of the launcher has contract 1.0 (docs/design/plugin-host.md#manifests).
 */
export const UNDECLARED_SEAM_VERSION = '1.0.0'

/**
 * Whether `version` satisfies the caret range `range` (`^major.minor.patch`), as semver does for a
 * major above zero: a pre-release version (`1.2.3-rc.1`) satisfies none, since such a range names
 * no pre-release. Undefined when either is not of that form (a version is `major.minor.patch` with
 * an optional pre-release, nothing after it), or the range's major is 0 (whose caret semantics
 * differ). A generated manifest declares only such ranges, and a range the host cannot read is a
 * finding, never a pass (INV-2).
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const r = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(range)
  const v = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/.exec(version)
  if (!r || !v || Number(r[1]) === 0) return undefined
  if (v[4] !== undefined) return false
  const [rm, rn, rp] = r.slice(1, 4).map(Number) as [number, number, number]
  const [vm, vn, vp] = v.slice(1, 4).map(Number) as [number, number, number]
  return vm === rm && (vn > rn || (vn === rn && vp >= rp))
}

/**
 * 1.1: the manifest check of a composition, the same for every provider. Only a plugin a row mounts
 * runs, so only it is checked, and only it provides. It must declare a valid manifest, unless its
 * package was read as shipping none and `allowWithoutManifest` names it (the DSH rows the bundle
 * composes); one `manifests` gives no read for is never allowed. Each
 * seam it consumes must be provided at a version its range accepts, by every mounted plugin whose
 * manifest provides it; a required seam no manifest declares is taken at contract 1.0, and an
 * optional one is not checked (it may be absent, which an optional consumer works without).
 * Returns the findings of each plugin that has some, in the order of the composition.
 */
export function checkComposition(rows: readonly CompositionRow[], manifests: ReadonlyMap<string, ManifestRead>, allowWithoutManifest: readonly string[] = []): Map<string, ManifestFinding[]> {
  const allowed = new Set(allowWithoutManifest)
  const mounted = pluginsOf(rows).filter((plugin) => plugin.mounted)
  const providers = new Map<string, Array<{ name: string; version: string }>>()
  for (const plugin of mounted) {
    const read = manifests.get(plugin.name)
    if (read?.state !== 'valid') continue
    for (const { seam, version } of read.manifest.provides) providers.set(seam, [...(providers.get(seam) ?? []), { name: plugin.name, version }])
  }
  const out = new Map<string, ManifestFinding[]>()
  for (const plugin of mounted) {
    const read = manifests.get(plugin.name) ?? { state: 'absent', reason: `${plugin.name} was not read` }
    if (read.state !== 'valid') {
      // Only a package read as shipping none is allowed: one not read may ship any manifest (INV-2).
      if (read.state === 'absent' && manifests.has(plugin.name) && allowed.has(plugin.name)) continue
      out.set(plugin.name, [{ kind: 'no-manifest', manifest: read.state, reason: read.state === 'absent' ? `it runs with no manifest: ${read.reason}` : `it runs with a manifest the host refused: ${read.reason}` }])
      continue
    }
    const findings: ManifestFinding[] = []
    for (const { seam, range, optional } of read.manifest.consumes) {
      const by = (providers.get(seam) ?? []).filter((p) => p.name !== plugin.name)
      if (!by.length) {
        if (optional || satisfies(UNDECLARED_SEAM_VERSION, range) === true) continue
        findings.push({ kind: 'unsatisfied', seam, range, version: UNDECLARED_SEAM_VERSION, reason: `it requires ctx.${seam} in the range ${range}, but no plugin of the composition declares it, so it is taken at contract 1.0 (a seam of DSH or of the launcher)` })
        continue
      }
      for (const provider of by) {
        const ok = satisfies(provider.version, range)
        if (ok === true) continue
        findings.push({
          kind: 'unsatisfied', seam, range, provider: provider.name, version: provider.version,
          reason: ok === undefined
            ? `it consumes ctx.${seam} in the range ${range}, which is not a caret range (^major.minor.patch) the host can check against ${provider.name}'s ${provider.version}`
            : `it consumes ctx.${seam} in the range ${range}, which ${provider.name} does not satisfy: it provides ${provider.version}`,
        })
      }
    }
    if (findings.length) out.set(plugin.name, findings)
  }
  return out
}

/** 1.1: a plugin's manifest check as last recorded: what it found (none once cleared), and the `gate` decision that recorded it. */
export interface RecordedCheck {
  name: string
  findings: ManifestFinding[]
  since: string
  decision: ArtifactRef
}

/** 1.1: the body of a manifest check's `gate` decision (`decision@1.0`), as a provider records it through `ctx.artifacts.recordDecision`. */
export interface ManifestCheckDecision {
  schema: 'decision@1.0'
  decisionType: 'gate'
  question: string
  inputs: ArtifactRef[]
  candidates: Array<{ option: 'pass' | 'fail'; selected: boolean; reasons: string[] }>
  decider: { type: 'rule'; id: 'plugin-host.manifest-check'; version: '1'; hash: ArtifactRef }
  outcome: { option: 'pass' | 'fail'; detail: { plugin: string; rows: string[]; findings: ManifestFinding[]; from: 'pass' | 'fail' | null; version?: string; manifestDigest?: ArtifactRef } }
  deterministic: true
  rationale: string
}

/** 1.1: a manifest check to record: its decision first, then the plugin's new check record. */
export interface CheckChange {
  name: string
  findings: ManifestFinding[]
  /** The record it replaces, when the plugin had one. */
  previous?: RecordedCheck
  decision: ManifestCheckDecision
}

/**
 * The decider's hash of a manifest check: the sha256 of what the rule read, the composition (each
 * row's id, package, and whether it is mounted), each plugin's manifest (its digest, or why there is
 * none), and the packages allowed without one.
 */
export function checkHash(rows: readonly CompositionRow[], manifests: ReadonlyMap<string, ManifestRead>, allowWithoutManifest: readonly string[]): ArtifactRef {
  return contentId({
    rows: rows.map(({ id, name, mounted }) => ({ id, name, mounted })),
    manifests: pluginsOf(rows).map(({ name }) => {
      const read = manifests.get(name)
      return { name, manifest: read?.state === 'valid' ? read.digest : (read?.state ?? 'absent') }
    }),
    allowWithoutManifest: [...new Set(allowWithoutManifest)].sort(),
  }) as ArtifactRef
}

/**
 * What a plugin's findings are, reasons and order aside: a reworded reason, or the same findings in
 * another order (rows or a manifest's seams reordered), are the same findings, never recorded again.
 */
const findingKeys = (findings: readonly ManifestFinding[]): string => canonicalJson(findings.map((finding) => canonicalJson({ ...finding, reason: '' })).sort())

/** At most the 32 reasons a candidate holds (`decision@1.x`), the last one counting the rest. */
const bounded = (reasons: string[]): string[] => (reasons.length <= 32 ? reasons : [...reasons.slice(0, 31), `and ${reasons.length - 31} more finding(s), each in the outcome's detail`])

function checkDecision(name: string, plugin: { rows: string[]; mounted: boolean } | undefined, read: ManifestRead | undefined, findings: ManifestFinding[], previous: RecordedCheck | undefined, allowed: boolean, hash: ArtifactRef): ManifestCheckDecision {
  const failed = findings.length > 0
  const passed = !plugin?.mounted
    ? 'no row of the composition mounts it: nothing of it runs unchecked'
    : read?.state === 'valid'
      ? `its row ${list(plugin.rows)} runs a valid manifest, and every seam it consumes is provided at a version its range accepts`
      : allowed ? `its package ships no manifest, which the plugin host's configuration allows (allowWithoutManifest)` : 'nothing was found'
  return {
    schema: 'decision@1.0',
    decisionType: 'gate',
    question: `Does plugin ${name} run as its manifest declares, on seams its providers satisfy?`,
    inputs: previous ? [previous.decision] : [],
    candidates: [
      { option: 'pass', selected: !failed, reasons: [failed ? `not pass: the check found ${findings.length} finding(s), each a reason under fail` : passed] },
      { option: 'fail', selected: failed, reasons: failed ? bounded(findings.map((f) => f.reason)) : [`not fail: ${passed}`] },
    ],
    decider: { type: 'rule', id: 'plugin-host.manifest-check', version: '1', hash },
    outcome: {
      option: failed ? 'fail' : 'pass',
      detail: {
        plugin: name, rows: plugin?.rows ?? [], findings, from: previous ? (previous.findings.length ? 'fail' : 'pass') : null,
        ...(read?.state === 'valid' ? { version: read.manifest.version, manifestDigest: read.digest } : {}),
      },
    },
    deterministic: true,
    rationale: 'The plugin host checks each plugin a row mounts against its manifest and its providers\' manifests at start; a finding makes health down until it is cleared. Base cannot keep a row from running (ADR-0048).',
  }
}

/**
 * 1.1: what a start records of the manifest check, the same for every provider: the findings of
 * each plugin a row mounts ({@link checkComposition}), and a `gate` decision for each plugin whose
 * findings differ from its record, `fail` with what was found, or `pass` once a recorded finding is
 * cleared (fixed, allowed, or no row mounts the plugin any more). The same findings record nothing,
 * so a restart records each finding once (INV-4); each decision's input is the plugin's previous one.
 */
export function reconcileChecks(rows: readonly CompositionRow[], manifests: ReadonlyMap<string, ManifestRead>, allowWithoutManifest: readonly string[], recorded: ReadonlyMap<string, RecordedCheck>): { findings: Map<string, ManifestFinding[]>; changes: CheckChange[] } {
  const findings = checkComposition(rows, manifests, allowWithoutManifest)
  const hash = checkHash(rows, manifests, allowWithoutManifest)
  const plugins = new Map(pluginsOf(rows).map((plugin) => [plugin.name, plugin]))
  const allowed = new Set(allowWithoutManifest)
  const changes: CheckChange[] = []
  for (const name of [...plugins.keys(), ...[...recorded.keys()].filter((n) => !plugins.has(n)).sort()]) {
    const found = findings.get(name) ?? []
    const previous = recorded.get(name)
    if (findingKeys(found) === findingKeys(previous?.findings ?? [])) continue
    changes.push({ name, findings: found, ...(previous ? { previous } : {}), decision: checkDecision(name, plugins.get(name), manifests.get(name), found, previous, allowed.has(name), hash) })
  }
  return { findings, changes }
}

/**
 * The plugins as a host lists them after a boot: those of the composition in the order of their
 * first row, then the recorded ones no row names any more, by name. A valid manifest carries the
 * host's record in `_meta.lifecycle`; a plugin the manifest check found something in carries its
 * findings and the decision that recorded them.
 */
export function pluginRecords(
  rows: readonly CompositionRow[], manifests: ReadonlyMap<string, ManifestRead>, recorded: ReadonlyMap<string, RecordedLifecycle>,
  check: { findings: ReadonlyMap<string, ManifestFinding[]>; recorded: ReadonlyMap<string, RecordedCheck> } = { findings: new Map(), recorded: new Map() },
): PluginRecord[] {
  const lifecycle = (record: RecordedLifecycle | undefined): Lifecycle | undefined => record && {
    state: record.state, ...(record.share !== undefined ? { share: record.share } : {}), since: record.since, decision: record.decision,
  }
  const listed = pluginsOf(rows).map((plugin): PluginRecord => {
    const read = manifests.get(plugin.name) ?? { state: 'absent', reason: `${plugin.name} was not read` }
    const own = lifecycle(recorded.get(plugin.name))
    const findings = check.findings.get(plugin.name) ?? []
    const checked = check.recorded.get(plugin.name)
    return {
      ...plugin,
      manifestState: read.state,
      ...(read.state === 'valid' ? { manifest: { ...read.manifest, ...(own ? { _meta: { lifecycle: own } } : {}) } } : { reason: read.reason }),
      ...(own ? { lifecycle: own } : {}),
      ...(findings.length ? { findings, ...(checked ? { checked: { since: checked.since, decision: checked.decision } } : {}) } : {}),
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
