/**
 * `ctx.pluginHost`: the plugin host's record of the composition (docs/design/plugin-host.md). When
 * it starts, it reads every row of the composition from the DSH loader, mounted or not, the manifest
 * each row's package declares, and the lifecycle states and manifest checks recorded before; it
 * records each change as a decision (a `lifecycle` decision, or the manifest check's `gate`
 * decision) and then the plugin's new record, in one store transaction (INV-13), and lists the
 * plugins from then on. It is the one adapter between the DSH loader and a `system` seam
 * (ADR-0018). Its check never stops a plugin; what it finds makes health down (ADR-0048). Contract
 * 1.2 (ADR-0078): on the operator's word only, it turns an optional row off or on in the running host
 * (`turn`), recording the change and keeping it in the profile's patch, and it holds each mechanism's
 * live enforce override (`setEnforce`).
 * @module @tsuuanmi/system-plugin-host
 */
import { chmodSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Context, type Exporter, Logger, type Message } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-ledger-core'
import { type EnforceMode, MECHANISMS, mechanismOf, writeFileDurable } from '@tsuuanmi/system-libs'
import {
  type ArtifactRef, type CompositionRow, enforceDecision, type EnforceState, findPlugin, MANIFEST_FILE, MANIFEST_MAX_BYTES, type ManifestFinding, type ManifestRead, PluginHost, type PluginRecord,
  pluginRecords, pluginsOf, readManifest, reconcile, reconcileChecks, type RecordedCheck, type RecordedLifecycle, rowRequirement, type RowState, servesSwitches, SwitchError, type Turned, turnDecision,
} from '@tsuuanmi/system-plugin-host-core'
import { editPatch } from './patch.ts'

/** One entry of the DSH loader as the host reads and (1.2) turns it: `update` and `fiber` are the loader's `Entry`'s. */
export interface LoaderEntry {
  options: { id: string; name: string; group?: unknown; config?: unknown }
  disabled: boolean
  subtree?: unknown
  /** The running plugin's fiber: `await` settles once its load or unload in flight is done, its disposers run (Cordis). */
  fiber?: { dispose(): Promise<void>; await?(): Promise<unknown> } | undefined
  /** Merge options and start or stop the entry; the loader writes nothing back for it (an entry already disabled is not persisted on unload). */
  update?(options: { disabled: boolean }): Promise<void>
}

/** What the host reads of the DSH loader (`ctx.loader`, `@deepseek-ai/cordis-plugin-loader`): its entries, and the profile it resolves them from. */
export interface LoaderView {
  ctx: { baseUrl?: string | undefined }
  entries(): Iterable<LoaderEntry>
}

/** The operator's patch in the profile's directory (DSH's profile patch). */
export const PATCH_FILE = 'cordis.patch.yml'

/** What the host reads of the dsh launcher's `ctx.profileContext`: the profile and the bundles composed into it. */
export interface ProfileView { dir?: string; startedBundles?: readonly string[] }

const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/**
 * The rows of the composition, in the loader's order: every plugin entry, mounted or not. A group
 * or an include is a carrier of rows, not a plugin, so it is not a row here; its rows are.
 */
export function compositionOf(loader: LoaderView): CompositionRow[] {
  const rows: CompositionRow[] = []
  for (const entry of loader.entries()) {
    if (entry.options.group || entry.subtree) continue
    rows.push({ id: entry.options.id, name: entry.options.name, mounted: !entry.disabled })
  }
  return rows
}

/**
 * The directory of the package `name` as Node finds a bare name from each base in turn: the nearest
 * `node_modules/<name>` going up whose `package.json` names it. Undefined for a name that is not a
 * package name (a path, a `cordis:` builtin) or that no base reaches.
 */
export function packageDir(name: string, bases: readonly string[]): string | undefined {
  if (!PACKAGE_NAME.test(name)) return undefined
  for (const base of bases) {
    for (let dir = base; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name)
      try {
        if ((JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')) as { name?: unknown }).name === name) return realpathSync(candidate)
      } catch {
        // not here, or not a readable package: Node would look further up, and so does the host
      }
      if (dirname(dir) === dir) break
    }
  }
  return undefined
}

/**
 * Where the host looks for a row's package, as the launcher resolves rows: the profile itself, then
 * each bundle composed into it, whose dependencies are the plugins its rows load.
 */
export function packageBases(loader: LoaderView, profile: ProfileView | undefined): string[] {
  const root = loader.ctx.baseUrl ? fileURLToPath(loader.ctx.baseUrl) : profile?.dir
  if (!root) return []
  const bundles = (profile?.startedBundles ?? []).map((bundle) => packageDir(bundle, [root])).filter((dir): dir is string => dir !== undefined)
  return [root, ...bundles]
}

/** Read `file`, at most `max` bytes; undefined when it does not exist, an error past the bound. */
function readBounded(file: string, max: number): string | undefined {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    if (fstatSync(fd).size > max) throw new Error(`it is larger than ${max} bytes`)
    const buffer = Buffer.alloc(max + 1)
    const length = readSync(fd, buffer, 0, max + 1, 0)
    if (length > max) throw new Error(`it is larger than ${max} bytes`)
    return buffer.subarray(0, length).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The manifest the package of a row declares, as the host reads it. */
export function packageManifest(name: string, bases: readonly string[]): ManifestRead {
  const dir = packageDir(name, bases)
  if (!dir) return { state: 'absent', reason: `the package ${name} cannot be found from the profile` }
  let text: string | undefined
  try {
    text = readBounded(join(dir, MANIFEST_FILE), MANIFEST_MAX_BYTES)
  } catch (error) {
    return { state: 'refused', reason: `its ${MANIFEST_FILE} cannot be read: ${(error as Error).message.slice(0, 200)}` }
  }
  return readManifest(text, name)
}

/** The most severe levels the daemon's log takes: errors, info, and warnings (Cordis' 0, 1, 2), never debug. */
export const LOG_LEVEL = 2

/** One message as a line of the daemon's log: when, how severe, whose, and what; each line of a long one so marked. */
export function logLines(message: Message): string {
  const head = `${new Date(message.ts).toISOString()} ${message.type} ${message.name}:`
  return Logger.format({ colors: false, export: () => {} }, message).split('\n').map((line) => `${head} ${line}\n`).join('')
}

/**
 * The last message written to a log, by the logger service's exporters (one map per service, however
 * a context reaches it), so a host started again does not repeat what it wrote.
 */
const written = new WeakMap<object, number>()

/**
 * Write what the plugins log, from errors to warnings, to `write`, from now until `ctx` is disposed:
 * DSH gives the Cordis logger no sink but its memory, so without this a plugin's warning (a Worker
 * whose probe failed, a store callback that threw) reached no log (live, 2026-10-26). What the logger
 * kept before this started is written first. A write that fails is dropped: logging never stops the host.
 */
export function exportLog(ctx: Context, write: (text: string) => void): void {
  const service = ctx.logger as unknown as { buffer?: Message[]; exporters: object }
  const key = service.exporters
  const put = (message: Message): void => {
    if (message.level > LOG_LEVEL || message.sn <= (written.get(key) ?? 0)) return
    written.set(key, message.sn)
    try {
      write(logLines(message))
    } catch {
      // the log is gone (a closed stream): the host goes on without it
    }
  }
  for (const message of service.buffer ?? []) put(message)
  const exporter: Exporter = { colors: false, levels: { default: LOG_LEVEL }, export: put }
  ctx.logger.exporter(exporter)
}

interface LifecycleRow { name: string; state: RecordedLifecycle['state']; since: string; decision: string; version: string; rows: string }
interface CheckRow { name: string; findings: string; since: string; decision: string }

interface TurnRow { row: string; on_: number; reason: string | null; since: string; decision: string }
interface EnforceRow { mechanism: string; mode: EnforceMode; reason: string | null; since: string; decision: string }

export interface Config {
  /** Packages a row may load with no `plugin-manifest.json`: the DSH rows the bundle composes. */
  allowWithoutManifest?: string[]
  /** Packages with no manifest whose rows the operator may still turn off at runtime: the DSH model rows (1.2). */
  optionalWithoutManifest?: string[]
  /** How long a row's plugin has to finish or hand back its work and stop, or to start, when it is turned (1.2). */
  quiesceSeconds?: number
}

const within = <T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> => {
  let timer: NodeJS.Timeout | undefined
  const bound = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms) })
  return Promise.race([work, bound]).finally(() => clearTimeout(timer))
}

export class StorePluginHost extends PluginHost {
  static inject = ['store', 'artifacts', 'loader']

  static Config: z<Config> = z.object({
    allowWithoutManifest: z.array(z.string().pattern(PACKAGE_NAME)).default([])
      .description('Packages a row may load with no plugin-manifest.json (the DSH rows the bundle composes); anything else that ships none is a finding of the manifest check'),
    optionalWithoutManifest: z.array(z.string().pattern(PACKAGE_NAME)).default([])
      .description('Packages with no plugin-manifest.json whose rows the operator may turn off at runtime (system plugin off); any other row with no manifest is required'),
    quiesceSeconds: z.natural().min(1).max(3600).default(60)
      .description('Seconds a turned row\'s plugin has to finish or hand back its in-flight work and stop, or to start; past it the row is put back as it was and nothing is recorded or written'),
  })

  private records: PluginRecord[]
  private readonly manifests: Map<string, ManifestRead>
  private readonly overrides = new Map<string, EnforceRow>()
  /** One turn at a time: a second waits for the first to settle. */
  private turning: Promise<unknown> = Promise.resolve()

  private readonly settings: Config

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.settings = config
    // The daemon's log: its stderr, which the unit appends to daemon.log (docs/operations/runbooks.md).
    exportLog(ctx, (text) => process.stderr.write(text))
    ctx.store.migrate('plugin-host', [{
      version: 1,
      sql: `CREATE TABLE plugin_lifecycle (
        name TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('candidate', 'shadow', 'canary', 'default', 'retired')),
        since TEXT NOT NULL, decision TEXT NOT NULL,
        version TEXT NOT NULL, rows TEXT NOT NULL
      );`,
    }, {
      // Contract 1.1: each plugin's manifest check as last recorded (none once cleared), and its decision.
      version: 2,
      sql: 'CREATE TABLE plugin_check (name TEXT PRIMARY KEY, findings TEXT NOT NULL, since TEXT NOT NULL, decision TEXT NOT NULL);',
    }, {
      // Contract 1.2 (ADR-0078): each row's last runtime turn, and each mechanism's live enforce override.
      version: 3,
      sql: `CREATE TABLE plugin_turn (row TEXT PRIMARY KEY, on_ INTEGER NOT NULL, reason TEXT, since TEXT NOT NULL, decision TEXT NOT NULL);
        CREATE TABLE plugin_enforce (mechanism TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('off', 'warn', 'on')), reason TEXT, since TEXT NOT NULL, decision TEXT NOT NULL);`,
    }])
    for (const row of ctx.store.db.prepare('SELECT mechanism, mode, reason, since, decision FROM plugin_enforce').all() as unknown as EnforceRow[]) this.overrides.set(row.mechanism, row)
    const loader = (ctx as unknown as { loader: LoaderView }).loader
    const rows = compositionOf(loader)
    const bases = packageBases(loader, ctx.get('profileContext' as never) as ProfileView | undefined)
    const manifests = new Map(pluginsOf(rows).map((plugin) => [plugin.name, packageManifest(plugin.name, bases)]))
    this.manifests = manifests
    const allowWithoutManifest = config.allowWithoutManifest ?? []
    let findings = new Map<string, ManifestFinding[]>()
    // Every decision before the record it sets, and all or none (INV-13): a decision that cannot be
    // recorded leaves every record as it was, and the host does not start.
    ctx.store.transaction((db) => {
      const { changes, moves } = reconcile(rows, manifests, this.recorded())
      const check = reconcileChecks(rows, manifests, allowWithoutManifest, this.checks())
      findings = check.findings
      const since = new Date().toISOString()
      const producer = { producer: { type: 'system', ref: 'plugin-host' } } as const
      for (const { from, to } of moves) db.prepare('UPDATE plugin_lifecycle SET name = ? WHERE name = ?').run(to, from)
      for (const change of changes) {
        const decision = ctx.artifacts.recordDecision(change.decision, producer)
        if (change.previous && change.previous.name !== change.name) db.prepare('DELETE FROM plugin_lifecycle WHERE name = ?').run(change.previous.name)
        db.prepare(`INSERT INTO plugin_lifecycle (name, state, since, decision, version, rows) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (name) DO UPDATE SET state = excluded.state, since = excluded.since, decision = excluded.decision, version = excluded.version, rows = excluded.rows`)
          .run(change.name, change.state, since, decision.id, change.version, JSON.stringify(change.rows))
        ctx.store.afterCommit(() => ctx.logger.info('plugin %s: %s → %s (decision %s)', change.name, change.previous?.state ?? 'unrecorded', change.state, decision.id))
      }
      for (const change of check.changes) {
        const decision = ctx.artifacts.recordDecision(change.decision, producer)
        db.prepare(`INSERT INTO plugin_check (name, findings, since, decision) VALUES (?, ?, ?, ?)
          ON CONFLICT (name) DO UPDATE SET findings = excluded.findings, since = excluded.since, decision = excluded.decision`)
          .run(change.name, JSON.stringify(change.findings), since, decision.id)
        ctx.store.afterCommit(() => ctx.logger.info('plugin %s: manifest check %s (decision %s)', change.name, change.findings.length ? 'failed' : 'passed again', decision.id))
      }
    })
    this.findings = findings
    this.records = pluginRecords(rows, manifests, this.recorded(), { findings, recorded: this.checks() })
    for (const plugin of this.records.filter((p) => p.manifestState === 'refused')) ctx.logger.warn('plugin %s: manifest refused: %s', plugin.name, plugin.reason)
    for (const plugin of this.records.filter((p) => p.findings?.length)) ctx.logger.warn('plugin %s: the manifest check found: %s', plugin.name, plugin.findings!.map((f) => f.reason).join('; '))
  }

  /** What the manifest check found at start, of the plugins a row then mounted: it runs at start only (ADR-0048). */
  private findings: Map<string, ManifestFinding[]> = new Map()

  list(): PluginRecord[] {
    return this.records
  }

  get(name: string): PluginRecord | undefined {
    return findPlugin(this.records, name)
  }

  private loader(): LoaderView {
    return (this.ctx as unknown as { loader: LoaderView }).loader
  }

  /** The loader's entry of row `id`, a plugin row (not a group or an include). */
  private entry(id: string): LoaderEntry | undefined {
    for (const entry of this.loader().entries()) if (!entry.options.group && !entry.subtree && entry.options.id === id) return entry
    return undefined
  }

  private state(entry: LoaderEntry, turns: ReadonlyMap<string, TurnRow>): RowState {
    const { id, name } = entry.options
    const on = !entry.disabled
    const turn = turns.get(id)
    return {
      id, name, on, ...rowRequirement(this.manifests.get(name), name, this.settings.optionalWithoutManifest ?? []),
      ...(turn && !!turn.on_ === on ? { turned: { on, ...(turn.reason ? { reason: turn.reason } : {}), since: turn.since, decision: turn.decision as ArtifactRef } } : {}),
    }
  }

  private turns(): Map<string, TurnRow> {
    const rows = this.ctx.store.db.prepare('SELECT row, on_, reason, since, decision FROM plugin_turn').all() as unknown as TurnRow[]
    return new Map(rows.map((r) => [r.row, r]))
  }

  rows(): RowState[] {
    const turns = this.turns()
    const out: RowState[] = []
    for (const entry of this.loader().entries()) if (!entry.options.group && !entry.subtree) out.push(this.state(entry, turns))
    return out
  }

  /** The operator's patch in the profile's directory; undefined when the host runs in no profile (a test, the matrix). */
  private patchFile(): string | undefined {
    const dir = (this.ctx.get('profileContext' as never) as ProfileView | undefined)?.dir
    return dir ? join(dir, PATCH_FILE) : undefined
  }

  turn(id: string, on: boolean, reason?: string): Promise<Turned> {
    const next = this.turning.then(() => this.turnNow(id, on, reason?.trim().slice(0, 500) || undefined))
    this.turning = next.catch(() => undefined)
    return next
  }

  private async turnNow(id: string, on: boolean, reason: string | undefined): Promise<Turned> {
    const entry = this.entry(id)
    if (!entry) throw new SwitchError('unknown', `no row ${id} in the composition (system plugin list names each row)`)
    const before = this.state(entry, this.turns())
    if (!on && before.required) throw new SwitchError('required', `row ${id} is required and is never turned off at runtime: ${before.why}`)
    // A switch never removes its own control surface (ADR-0078).
    const control = on ? undefined : servesSwitches(this.manifests.get(entry.options.name))
    if (control) throw new SwitchError('control', `row ${id} is never turned off at runtime: ${control}`)
    if (before.on === on) return { row: before, changed: false }
    if (!entry.update) throw new SwitchError('unsupported', 'the loader in this host cannot turn a row while it runs: set the row\'s disabled in the profile\'s patch and restart')
    // The patch is edited before anything moves: one the host cannot edit refuses the turn, and the row stays as it was.
    const file = this.patchFile()
    let patch: { text: string; mode: number } | undefined
    if (file) {
      const exists = existsSync(file)
      patch = { text: editPatch(exists ? readFileSync(file, 'utf8') : '', id, !on), mode: exists ? statSync(file).mode & 0o777 : 0o600 }
    }
    const name = entry.options.name
    const previous = this.recorded().get(name)
    // The decision first (INV-13): the turn is recorded before the loader is touched. If it then fails,
    // the row is put back and the failure is a decision of its own, chained to this one.
    const after = compositionOf(this.loader()).map((r) => (r.id === id ? { ...r, mounted: on } : r))
    const authorized = this.decide(after, entry, on, reason, previous)
    try {
      await this.quiesce(entry, id, on)
    } catch (error) {
      this.undone(entry, on, authorized, previous, (error as Error).message)
      throw error
    }
    try {
      this.ctx.store.transaction((db) => {
        const since = new Date().toISOString()
        if (authorized.state) {
          db.prepare(`INSERT INTO plugin_lifecycle (name, state, since, decision, version, rows) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (name) DO UPDATE SET state = excluded.state, since = excluded.since, decision = excluded.decision, version = excluded.version, rows = excluded.rows`)
            .run(name, authorized.state.state, since, authorized.id, authorized.state.version, JSON.stringify(authorized.state.rows))
        }
        db.prepare(`INSERT INTO plugin_turn (row, on_, reason, since, decision) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (row) DO UPDATE SET on_ = excluded.on_, reason = excluded.reason, since = excluded.since, decision = excluded.decision`)
          .run(id, on ? 1 : 0, reason ?? null, since, authorized.id)
        // Last, so a patch that cannot be written rolls the record back with it.
        if (file && patch) {
          writeFileDurable(file, patch.text, patch.mode)
          // The temp file is created under the umask: the patch keeps the mode the operator gave it.
          chmodSync(file, patch.mode)
        }
        this.ctx.store.afterCommit(() => this.ctx.logger.info('row %s turned %s%s (decision %s)%s', id, on ? 'on' : 'off', reason ? `: ${reason}` : '', authorized.id, file ? `, kept in ${file}` : ', in no profile patch: a restart does not keep it'))
      })
    } catch (error) {
      await this.quiesce(entry, id, !on).catch(() => undefined)
      const why = `row ${id} could not be recorded or kept in the profile's patch (${(error as Error).message.slice(0, 300)}): it is put back ${on ? 'off' : 'on'}`
      this.undone(entry, on, authorized, previous, why)
      throw new SwitchError('patch', why)
    }
    this.records = pluginRecords(compositionOf(this.loader()), this.manifests, this.recorded(), { findings: this.findings, recorded: this.checks() })
    return { row: this.state(entry, this.turns()), ...(file ? { patch: file } : {}), changed: true }
  }

  /**
   * Record the `lifecycle` decision of a turn of `entry`'s row over `rows` (the composition it leaves),
   * before anything moves (INV-13). A plugin with a valid manifest gets the state its rows give it
   * (`turnDecision`), returned with what its record takes once the turn is done; a row with no manifest
   * the host read (a DSH model row) gets a decision of its own with options `on` and `off`.
   */
  private decide(rows: CompositionRow[], entry: LoaderEntry, on: boolean, reason: string | undefined, previous: RecordedLifecycle | undefined, failed?: { authorized: ArtifactRef; why: string }): { id: ArtifactRef; state?: { state: RecordedLifecycle['state']; version: string; rows: string[] } } {
    const { id: row, name } = entry.options
    const read = this.manifests.get(name)
    const producer = { producer: { type: 'system', ref: 'plugin-host' } } as const
    const rationale = failed ? `The turn of row ${row} ${on ? 'on' : 'off'} (decision ${failed.authorized}) did not complete: ${failed.why}`.slice(0, 1000) : undefined
    const failure = failed && rationale ? { inputs: [failed.authorized], rationale } : {}
    if (read?.state === 'valid') {
      const body = { ...turnDecision(rows, name, row, on, reason, read.manifest.version, previous, read.digest), ...failure }
      const id = this.ctx.artifacts.recordDecision(body, producer).id as ArtifactRef
      return { id, state: { state: body.outcome.option, version: read.manifest.version, rows: body.outcome.detail.rows } }
    }
    const runs = rows.find((r) => r.id === row)?.mounted ?? on
    const said = failed ? `the turn ${on ? 'on' : 'off'} failed, and the row is put back` : `the operator turned it ${on ? 'on' : 'off'} (system plugin ${on ? 'on' : 'off'})${reason ? `: ${reason}` : ''}`
    const id = this.ctx.artifacts.recordDecision({
      schema: 'decision@1.5', decisionType: 'lifecycle', question: `Does row ${row} run?`, inputs: failed ? [failed.authorized] : [],
      candidates: [{ option: runs ? 'on' : 'off', selected: true, reasons: [said.slice(0, 300)] }, { option: runs ? 'off' : 'on', selected: false, reasons: [`not ${runs ? 'off' : 'on'}: ${said}`.slice(0, 300)] }],
      decider: { type: 'rule', id: 'plugin-host.composition', version: '1' }, outcome: { option: runs ? 'on' : 'off', detail: { row, plugin: name } }, deterministic: true,
      ...(rationale ? { rationale } : {}),
    }, producer).id as ArtifactRef
    return { id }
  }

  /**
   * A turn authorized by `authorized` that did not complete, its row put back: recorded as a decision
   * chained to it, over the composition as it is again, and the plugin's record names it (the state it
   * had). A decision that cannot be recorded is logged: the row is already put back.
   */
  private undone(entry: LoaderEntry, on: boolean, authorized: { id: ArtifactRef }, previous: RecordedLifecycle | undefined, why: string): void {
    try {
      const failed = this.decide(compositionOf(this.loader()), entry, on, undefined, previous, { authorized: authorized.id, why })
      if (failed.state) {
        this.ctx.store.db.prepare(`INSERT INTO plugin_lifecycle (name, state, since, decision, version, rows) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (name) DO UPDATE SET state = excluded.state, since = excluded.since, decision = excluded.decision, version = excluded.version, rows = excluded.rows`)
          .run(entry.options.name, failed.state.state, new Date().toISOString(), failed.id, failed.state.version, JSON.stringify(failed.state.rows))
        this.records = pluginRecords(compositionOf(this.loader()), this.manifests, this.recorded(), { findings: this.findings, recorded: this.checks() })
      }
      this.ctx.logger.warn('row %s: the turn %s did not complete (decision %s): %s', entry.options.id, on ? 'on' : 'off', failed.id, why)
    } catch (error) {
      this.ctx.logger.error('row %s: the turn %s did not complete (%s), and that could not be recorded: %s', entry.options.id, on ? 'on' : 'off', why, (error as Error).message)
    }
  }

  /**
   * Stop or start the row's plugin and wait, within the bound, until it is done: a disposal settles once
   * the plugin's disposers ran, each finishing or handing back its in-flight work as its seam says
   * (plugin rule 3); a start settles once the plugin applied. Past the bound, or a start that fails, the
   * row is put back as it was and the turn is refused; the caller records that it did not complete.
   */
  private async quiesce(entry: LoaderEntry, id: string, on: boolean): Promise<void> {
    const seconds = this.settings.quiesceSeconds ?? 60
    const fiber = entry.fiber
    const work = (async () => {
      await entry.update!({ disabled: !on })
      // The loader starts the fiber's disposal and does not wait for it; `await` waits for the unload in flight (Cordis).
      if (!on) await fiber?.await?.().catch(() => undefined)
      else await entry.fiber?.await?.()
    })()
    let outcome: unknown
    try {
      outcome = await within(work, seconds * 1000)
    } catch (error) {
      await entry.update!({ disabled: on }).catch(() => undefined)
      throw new SwitchError('failed', `row ${id} failed to ${on ? 'start' : 'stop'} (${(error as Error).message.slice(0, 300)}): it is put back ${on ? 'off' : 'on'}, and the profile's patch is not written`)
    }
    if (outcome === 'timeout') {
      work.catch(() => undefined)
      await entry.update!({ disabled: on }).catch(() => undefined)
      throw new SwitchError('quiescence', `row ${id} did not ${on ? 'start' : 'finish or hand back its work and stop'} within ${seconds} s (quiesceSeconds): it is put back ${on ? 'off' : 'on'}, and the profile's patch is not written`)
    }
  }

  enforced(mechanism: string): EnforceMode | undefined {
    return this.overrides.get(mechanism)?.mode
  }

  /** The owning row's configured mode (`enforce.<key>` of its configuration), when the mechanism takes it; else `on`. */
  private configured(mechanism: { row: string; key?: string; modes: readonly EnforceMode[] }): EnforceMode {
    const config = mechanism.key ? this.entry(mechanism.row)?.options.config : undefined
    const value = (config as { enforce?: Record<string, unknown> } | undefined)?.enforce?.[mechanism.key!]
    return typeof value === 'string' && (mechanism.modes as readonly string[]).includes(value) ? value as EnforceMode : 'on'
  }

  enforcement(): EnforceState[] {
    return MECHANISMS.map((m) => {
      const configured = this.configured(m)
      const set = this.overrides.get(m.id)
      const override = set && m.modes.includes(set.mode) ? set : undefined
      return {
        mechanism: m.id, row: m.row, modes: [...m.modes], mode: override?.mode ?? configured, configured, what: m.what,
        ...(override ? { override: { mode: override.mode, ...(override.reason ? { reason: override.reason } : {}), since: override.since, decision: override.decision as ArtifactRef } } : {}),
      }
    })
  }

  setEnforce(id: string, mode: EnforceMode | 'configured', reason?: string): EnforceState {
    const m = mechanismOf(id)
    if (!m) throw new SwitchError('unknown', `no mechanism ${id}: ${MECHANISMS.map((x) => x.id).join(', ')}`)
    if (mode !== 'configured' && !m.modes.includes(mode)) throw new SwitchError('unsupported', `${id} takes ${m.modes.join(' or ')}, never ${mode}: ${m.what}`)
    const said = reason?.trim().slice(0, 500) || undefined
    const now = () => this.enforcement().find((s) => s.mechanism === id)!
    const before = now()
    if (mode === 'configured' && !before.override) return before
    const cleared = mode === 'configured'
    const to = cleared ? before.configured : mode
    const body = enforceDecision(m, before.mode, to, cleared, said, before.override?.decision)
    this.ctx.store.transaction((db) => {
      const decision = this.ctx.artifacts.recordDecision(body, { producer: { type: 'system', ref: 'plugin-host' } }).id as ArtifactRef
      const since = new Date().toISOString()
      if (cleared) {
        db.prepare('DELETE FROM plugin_enforce WHERE mechanism = ?').run(id)
      } else {
        db.prepare(`INSERT INTO plugin_enforce (mechanism, mode, reason, since, decision) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (mechanism) DO UPDATE SET mode = excluded.mode, reason = excluded.reason, since = excluded.since, decision = excluded.decision`)
          .run(id, to, said ?? null, since, decision)
      }
      this.ctx.store.afterCommit(() => {
        if (cleared) this.overrides.delete(id)
        else this.overrides.set(id, { mechanism: id, mode: to, reason: said ?? null, since, decision })
        this.ctx.logger.info('mechanism %s: %s → %s%s (decision %s)', id, before.mode, to, said ? `: ${said}` : '', decision)
      })
    })
    return now()
  }

  /** The lifecycle of every plugin as last recorded. */
  private recorded(): Map<string, RecordedLifecycle> {
    const rows = this.ctx.store.db.prepare('SELECT name, state, since, decision, version, rows FROM plugin_lifecycle').all() as unknown as LifecycleRow[]
    return new Map(rows.map((r) => [r.name, { name: r.name, state: r.state, since: r.since, decision: r.decision as ArtifactRef, version: r.version, rows: JSON.parse(r.rows) as string[] }]))
  }

  /** The manifest check of every plugin as last recorded. */
  private checks(): Map<string, RecordedCheck> {
    const rows = this.ctx.store.db.prepare('SELECT name, findings, since, decision FROM plugin_check').all() as unknown as CheckRow[]
    return new Map(rows.map((r) => [r.name, { name: r.name, findings: JSON.parse(r.findings) as ManifestFinding[], since: r.since, decision: r.decision as ArtifactRef }]))
  }
}

export default StorePluginHost
