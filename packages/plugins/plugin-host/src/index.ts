/**
 * `ctx.pluginHost`: the plugin host's record of the composition (docs/design/plugin-host.md). When
 * it starts, it reads every row of the composition from the DSH loader, mounted or not, the manifest
 * each row's package declares, and the lifecycle states recorded before; it records each change as a
 * `lifecycle` decision and then the plugin's new state, in one store transaction (INV-13), and lists
 * the plugins from then on. It is the one adapter between the DSH loader and a `system` seam
 * (ADR-0018). It records and automates nothing: it never mounts, stops, or gates a plugin.
 * @module @tsuuanmi/system-plugin-host
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import {
  type ArtifactRef, type CompositionRow, findPlugin, MANIFEST_FILE, MANIFEST_MAX_BYTES, type ManifestRead, PluginHost, type PluginRecord, pluginRecords, pluginsOf,
  readManifest, reconcile, type RecordedLifecycle,
} from '@tsuuanmi/system-plugin-host-core'
import type {} from '@tsuuanmi/system-store'

/** What the host reads of the DSH loader (`ctx.loader`, `@deepseek-ai/cordis-plugin-loader`): its entries, and the profile it resolves them from. */
export interface LoaderView {
  ctx: { baseUrl?: string | undefined }
  entries(): Iterable<{ options: { id: string; name: string; group?: unknown }; disabled: boolean; subtree?: unknown }>
}

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

interface LifecycleRow { name: string; state: RecordedLifecycle['state']; since: string; decision: string; version: string; rows: string }

export class StorePluginHost extends PluginHost {
  static inject = ['store', 'artifacts', 'loader']

  private readonly records: PluginRecord[]

  constructor(ctx: Context) {
    super(ctx)
    ctx.store.migrate('plugin-host', [{
      version: 1,
      sql: `CREATE TABLE plugin_lifecycle (
        name TEXT PRIMARY KEY, state TEXT NOT NULL, since TEXT NOT NULL, decision TEXT NOT NULL,
        version TEXT NOT NULL, rows TEXT NOT NULL
      );`,
    }])
    const loader = (ctx as unknown as { loader: LoaderView }).loader
    const rows = compositionOf(loader)
    const bases = packageBases(loader, ctx.get('profileContext' as never) as ProfileView | undefined)
    const manifests = new Map(pluginsOf(rows).map((plugin) => [plugin.name, packageManifest(plugin.name, bases)]))
    // Every decision before the state it sets, and both or neither (INV-13): a decision that cannot
    // be recorded leaves every record as it was, and the host does not start.
    ctx.store.transaction((db) => {
      const { changes, moves } = reconcile(rows, manifests, this.recorded())
      const since = new Date().toISOString()
      for (const { from, to } of moves) db.prepare('UPDATE plugin_lifecycle SET name = ? WHERE name = ?').run(to, from)
      for (const change of changes) {
        const decision = ctx.artifacts.recordDecision(change.decision, { producer: { type: 'system', ref: 'plugin-host' } })
        if (change.previous && change.previous.name !== change.name) db.prepare('DELETE FROM plugin_lifecycle WHERE name = ?').run(change.previous.name)
        db.prepare(`INSERT INTO plugin_lifecycle (name, state, since, decision, version, rows) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (name) DO UPDATE SET state = excluded.state, since = excluded.since, decision = excluded.decision, version = excluded.version, rows = excluded.rows`)
          .run(change.name, change.state, since, decision.id, change.version, JSON.stringify(change.rows))
        ctx.logger.info('plugin %s: %s → %s (decision %s)', change.name, change.previous?.state ?? 'unrecorded', change.state, decision.id)
      }
    })
    this.records = pluginRecords(rows, manifests, this.recorded())
    for (const plugin of this.records.filter((p) => p.manifestState === 'refused')) ctx.logger.warn('plugin %s: manifest refused: %s', plugin.name, plugin.reason)
  }

  list(): PluginRecord[] {
    return this.records
  }

  get(name: string): PluginRecord | undefined {
    return findPlugin(this.records, name)
  }

  /** The lifecycle of every plugin as last recorded. */
  private recorded(): Map<string, RecordedLifecycle> {
    const rows = this.ctx.store.db.prepare('SELECT name, state, since, decision, version, rows FROM plugin_lifecycle').all() as unknown as LifecycleRow[]
    return new Map(rows.map((r) => [r.name, { name: r.name, state: r.state, since: r.since, decision: r.decision as ArtifactRef, version: r.version, rows: JSON.parse(r.rows) as string[] }]))
  }
}

export default StorePluginHost
