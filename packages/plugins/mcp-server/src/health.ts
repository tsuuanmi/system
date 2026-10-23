/**
 * The host's health (PROP-0003 M6b): what an operator needs to know is wrong now, read from the
 * services that are mounted, never guessed. Each check is `ok`, `degraded` (work may still run,
 * something needs the operator), or `down` (work cannot run); the report is the worst of them.
 */
import { statfsSync } from 'node:fs'
import { nodeVersionProblem, usageUnknownOf } from '@tsuuanmi/system-libs'

export type HealthState = 'ok' | 'degraded' | 'down'

export interface HealthCheck {
  name: string
  state: HealthState
  /** What is wrong and what to do; only operator-scope callers see it. */
  detail: string
}

export interface HealthReport {
  state: HealthState
  checks: HealthCheck[]
}

/** What the report reads; each source is absent when its service is not mounted. */
export interface HealthSources {
  dshHome: string
  /** The store's integrity check result (`PRAGMA quick_check(1)`), as last run. */
  storeCheck?: () => string
  /** Where the vault keeps its key, when the vault reports it. */
  keyCustody?: () => { keyApart: boolean }
  accounts?: () => Promise<Array<{ id: string; status: string }>>
  /** Groups of accounts signed in as one person (REQ-ACC-7): their Workers take no work. */
  duplicateAccounts?: () => Promise<string[][]>
  workers?: () => Promise<Array<{ worker: string; state: string }>>
  /**
   * How each Worker source answered its last read (`ctx.workers.sources()`), read after `workers`:
   * a source that was silent or failed is not counted there, and a route then saw none of its Workers.
   */
  workerSources?: () => Array<{ source: string; state: 'described' | 'silent' | 'failed'; at: string; detail?: string }>
  /** Events of `type` committed since `sinceIso`. */
  events?: (type: string, sinceIso: string) => Array<{ data?: Record<string, unknown> | undefined }>
  /** Plugins of the composition that failed to activate or wait for a service no one supplies. */
  plugins?: () => Array<{ name: string; state: 'failed' | 'pending'; detail: string }>
  /**
   * The plugins of the composition as the plugin host read them (REQ-HOST-7): whether a row mounts
   * each, its manifest's state and why it is not valid, and what the manifest check found in it.
   */
  manifests?: () => Array<{ name: string; mounted: boolean; state: 'valid' | 'absent' | 'refused'; reason?: string; findings: string[] }>
  /** Configured workflow templates refused at load, with why. */
  templates?: () => Array<{ name: string; reason: string }>
  /**
   * Usage the resource ledger could not count (docs/design/resources.md#usage-the-ledger-cannot-count):
   * its configured pools with their windows' lengths, a page of the `usage.unknown` entries since a
   * time (in `seq` order, after `afterSeq`, at most `limit`), and whether the ledger counted a record
   * of a run in a pool.
   */
  unknownUsage?: {
    pools: () => Promise<Array<{ pool: string; windows: Array<{ seconds?: number }> }>>
    entries: (query: { since: string; afterSeq: number; limit: number }) => Array<{ seq: number; at: string; data?: Record<string, unknown> | undefined }>
    counted: (runId: string, pool: string) => Promise<boolean>
  }
  /** Website conversations whose deletion failed every attempt (the conversation ledger). */
  undeleted?: () => Array<{ account: string; binding: string; reason?: string }>
  /** Login profiles the browser holds, reserves for a login, or cannot free (ADR-0030). */
  profiles?: () => Array<{ account: string; open: boolean; pages: number; kept?: number; reserved: boolean; blocked?: string }>
  /** The most login-profile browsers open at once; 0 or absent is no cap (PROP-0007). */
  browserCap?: number
  nodeVersion?: string
  minFreeBytes: number
  driftWindowMs: number
  now?: () => number
}

const RANK: Record<HealthState, number> = { ok: 0, degraded: 1, down: 2 }

/** `usage.unknown` entries the `usage` check reads at most (INV-9): past it, it is degraded, never ok. */
export const MAX_UNKNOWN_ENTRIES = 10_000
/** `usage.unknown` entries the `usage` check asks for at once: the event log's most per query. */
const UNKNOWN_PAGE = 1000

/** Seconds as one unit, the largest that divides them: `7d`, `5h`, `90m`, `45s`. */
const span = (seconds: number): string => {
  for (const [unit, size] of [['d', 86_400], ['h', 3600], ['m', 60]] as const) if (seconds % size === 0) return `${seconds / size}${unit}`
  return `${seconds}s`
}

const ok = (name: string, detail: string): HealthCheck => ({ name, state: 'ok', detail })

/** A check that throws is reported as down with why, never as a failed report. */
async function guarded(name: string, run: () => HealthCheck | Promise<HealthCheck>): Promise<HealthCheck> {
  try {
    return await run()
  } catch (error) {
    return { name, state: 'down', detail: `the check failed: ${(error as Error).message.slice(0, 160)}` }
  }
}

/** Workers that can take work now; any other state (reauth-required, quota-exhausted, unavailable) cannot. */
const AVAILABLE = new Set(['ready', 'busy'])

export async function healthReport(sources: HealthSources): Promise<HealthReport> {
  const checks: HealthCheck[] = []
  // A plugin that is not running takes its tools and its dependents with it: work cannot run as composed.
  if (sources.plugins) {
    checks.push(await guarded('plugins', () => {
      const broken = sources.plugins!()
      return broken.length
        ? { name: 'plugins', state: 'down', detail: `${broken.map((p) => `${p.name} ${p.state}: ${p.detail}`).join('; ')}. See the daemon's log, fix the configuration, and restart (docs/operations/runbooks.md)` }
        : ok('plugins', 'every plugin of the composition is active')
    }))
  }
  // A finding of the manifest check fails closed: the host cannot keep that plugin from running, so it
  // cannot vouch for what runs (ADR-0048). A refused manifest of a row that is off leaves only its
  // lifecycle unrecorded.
  if (sources.manifests) {
    checks.push(await guarded('manifests', () => {
      const plugins = sources.manifests!()
      const found = plugins.filter((p) => p.findings.length)
      if (found.length) {
        return { name: 'manifests', state: 'down', detail: `${found.map((p) => `${p.name}: ${p.findings.join('; ')}`).join('; ')}. The plugin host cannot keep a row from running: turn the row off, or fix or allow its package, and restart (docs/operations/runbooks.md#the-manifest-check-found-a-plugin)` }
      }
      const refused = plugins.filter((p) => p.state === 'refused')
      if (refused.length) {
        return { name: 'manifests', state: 'degraded', detail: `${refused.map((p) => `${p.name}: ${p.reason ?? ''}`).join('; ')}: its row is off, and its lifecycle is not recorded until its package ships a valid manifest (docs/operations/runbooks.md#the-manifest-check-found-a-plugin)` }
      }
      const allowed = plugins.filter((p) => p.mounted && p.state === 'absent').map((p) => p.name)
      const off = plugins.filter((p) => !p.mounted && p.state === 'absent').map((p) => p.name)
      return ok('manifests', [
        'every plugin a row mounts passes the manifest check',
        ...(allowed.length ? [`${allowed.length} of them run with no manifest, as the plugin host's configuration allows: ${allowed.join(', ')}`] : []),
        ...(off.length ? [`${off.length} row(s) that are off have none: ${off.join(', ')}`] : []),
      ].join('; '))
    }))
  }
  if (sources.templates) {
    checks.push(await guarded('templates', () => {
      const refused = sources.templates!()
      return refused.length
        ? { name: 'templates', state: 'degraded', detail: `${refused.length} configured template(s) refused, every other one works: ${refused.map((t) => `${t.name} (${t.reason})`).join('; ')}` }
        : ok('templates', 'every configured template passed its check')
    }))
  }
  const runtime = nodeVersionProblem(sources.nodeVersion ?? process.versions.node)
  checks.push(runtime ? { name: 'runtime', state: 'down', detail: runtime } : ok('runtime', `Node ${sources.nodeVersion ?? process.versions.node}`))

  const storeCheck = sources.storeCheck
  checks.push(!storeCheck
    ? { name: 'store', state: 'down', detail: 'the store is not mounted' }
    : await guarded('store', () => {
      const result = storeCheck()
      return result === 'ok' ? ok('store', 'integrity check passed') : { name: 'store', state: 'down', detail: `integrity check: ${result.slice(0, 200)}` }
    }))

  try {
    const fs = statfsSync(sources.dshHome)
    const free = fs.bavail * fs.bsize
    const gib = (n: number) => `${(n / 2 ** 30).toFixed(1)} GiB`
    checks.push(free < sources.minFreeBytes
      ? { name: 'disk', state: 'degraded', detail: `${gib(free)} free under ${sources.dshHome}, below ${gib(sources.minFreeBytes)}: free space, or prune old runs and backups` }
      : ok('disk', `${gib(free)} free`))
  } catch (error) {
    checks.push({ name: 'disk', state: 'degraded', detail: `free space unknown: ${(error as Error).message.slice(0, 120)}` })
  }

  // Advice, not an alarm: the default keeps the key beside the vault, and a timer must not page
  // every default install (docs/operations/runbooks.md#key-custody).
  const custody = sources.keyCustody
  if (custody) {
    checks.push(await guarded('vault-key', () => (custody().keyApart
      ? ok('vault-key', 'kept apart from the vault')
      : ok('vault-key', 'beside the vault (the default); on a shared or managed host keep it apart (docs/operations/runbooks.md#key-custody)'))))
  }

  const accounts = sources.accounts
  if (accounts) {
    checks.push(await guarded('accounts', async () => {
      const waiting = (await accounts()).filter((a) => a.status === 'reauth-required' || a.status === 'challenge')
      const duplicates = (await sources.duplicateAccounts?.()) ?? []
      const problems = [
        ...(waiting.length ? [`${waiting.map((a) => `${a.id} (${a.status})`).join(', ')}: sign in again (system account login <id>)`] : []),
        ...duplicates.map((ids) => `${ids.join(' and ')} are signed in as the same person, so none of them takes work: sign all but one in as another person, or remove them from the catalog (docs/operations/runbooks.md#two-accounts-sign-in-as-one-person)`),
      ]
      return problems.length
        ? { name: 'accounts', state: 'degraded', detail: problems.join('; ') }
        : ok('accounts', 'every account is signed in or not in use')
    }))
  }

  const listWorkers = sources.workers
  if (listWorkers) {
    checks.push(await guarded('workers', async () => {
      // The read fails when a source's describe throws; the sources' last reads still name it.
      const listed = await listWorkers().then((workers) => ({ workers }), (error: unknown) => ({ error }))
      // A source that was silent or failed in its last read is counted nowhere, so a route then saw
      // none of its Workers: never ok while one is (INV-2).
      const unheard = (sources.workerSources?.() ?? []).filter((s) => s.state !== 'described')
      const named = unheard.map((s) => `source ${s.source} ${s.detail ?? s.state} (at ${s.at})`).join('; ')
      const runbook = '(docs/operations/runbooks.md#a-worker-source-does-not-answer)'
      if ('error' in listed) {
        if (!unheard.length) throw listed.error
        return { name: 'workers', state: 'down', detail: `the Workers cannot be read, so no route is taken: ${named} ${runbook}` }
      }
      const unheardNote = unheard.length ? `${named}: routing sees none of ${unheard.length === 1 ? 'its' : 'their'} Workers until it answers ${runbook}` : ''
      const { workers } = listed
      const waiting = workers.filter((w) => !AVAILABLE.has(w.state))
      const cannot = waiting.map((w) => `${w.worker} (${w.state})`).join(', ')
      if (waiting.length === workers.length && (workers.length || unheard.length)) {
        return { name: 'workers', state: 'down', detail: `no Worker can take work: ${[cannot, unheardNote].filter(Boolean).join('; ')}` }
      }
      if (waiting.length || unheard.length) {
        return { name: 'workers', state: 'degraded', detail: [...(waiting.length ? [`cannot take work: ${cannot} (system explain shows why)`] : [`${workers.length} available`]), ...(unheard.length ? [unheardNote] : [])].join('; ') }
      }
      return ok('workers', `${workers.length} available`)
    }))
  }

  // Usage the ledger could not count still counts as 0 against a cap (D25): degraded while a pool
  // has such a run in its current window that the ledger has not counted a record of since.
  const unknownUsage = sources.unknownUsage
  if (unknownUsage) {
    checks.push(await guarded('usage', async () => {
      const now = (sources.now ?? Date.now)()
      // A pool's current window is its longest, back from now; one of no length (a credit balance) never resets.
      const windows = new Map((await unknownUsage.pools()).map((p) => {
        const bounded = p.windows.length > 0 && p.windows.every((w) => w.seconds !== undefined)
        return [p.pool, bounded ? Math.max(...p.windows.map((w) => w.seconds!)) : undefined] as const
      }))
      if (!windows.size) return ok('usage', 'no resource pool is configured')
      const starts = [...windows.values()].map((seconds) => (seconds === undefined ? 0 : now - seconds * 1000))
      // Every entry back to the earliest window's start, a page at a time in `seq` order, at most
      // MAX_UNKNOWN_ENTRIES (INV-9): one entry more says the rest went unread.
      const since = new Date(Math.min(...starts)).toISOString()
      const entries: ReturnType<typeof unknownUsage.entries> = []
      let unread = false
      for (let afterSeq = 0; ;) {
        const limit = Math.min(UNKNOWN_PAGE, MAX_UNKNOWN_ENTRIES + 1 - entries.length)
        const page = unknownUsage.entries({ since, afterSeq, limit })
        entries.push(...page)
        if (entries.length > MAX_UNKNOWN_ENTRIES) {
          unread = true
          entries.length = MAX_UNKNOWN_ENTRIES
          break
        }
        if (page.length < limit) break
        afterSeq = page.at(-1)!.seq
      }
      // Each run once per pool, by its first fact. An entry that is not a valid record, or that names
      // a pool the ledger does not configure, has no window to count it in, so it is said, never
      // skipped silently (INV-14).
      const runs = new Map<string, Map<string, string>>()
      const unconfigured = new Map<string, Set<string>>()
      let unreadable = 0
      for (const entry of entries) {
        const fact = usageUnknownOf(entry.data)
        if (!fact) unreadable += 1
        if (fact && !windows.has(fact.pool)) (unconfigured.get(fact.pool) ?? unconfigured.set(fact.pool, new Set()).get(fact.pool)!).add(fact.runId)
        if (!fact || !windows.has(fact.pool)) continue
        const seconds = windows.get(fact.pool)
        if (seconds !== undefined && Date.parse(entry.at) < now - seconds * 1000) continue
        const ofPool = runs.get(fact.pool) ?? runs.set(fact.pool, new Map()).get(fact.pool)!
        if (!ofPool.has(fact.runId)) ofPool.set(fact.runId, fact.kind)
      }
      const open: string[] = []
      for (const pool of [...runs.keys()].sort()) {
        const kinds = new Map<string, number>()
        for (const [runId, kind] of runs.get(pool)!) if (!(await unknownUsage.counted(runId, pool))) kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
        const count = [...kinds.values()].reduce((n, k) => n + k, 0)
        const seconds = windows.get(pool)
        if (count) open.push(`${pool}: ${count} run(s) in its current window (${seconds === undefined ? 'it has a window that never resets' : `the last ${span(seconds)}`}) whose usage the ledger could not count (${[...kinds].sort().map(([k, n]) => `${n} ${k}`).join(', ')})`)
      }
      const gone: string[] = []
      for (const pool of [...unconfigured.keys()].sort()) {
        let count = 0
        for (const runId of unconfigured.get(pool)!) if (!(await unknownUsage.counted(runId, pool))) count += 1
        if (count) gone.push(`${pool} ${count}`)
      }
      if (gone.length) open.push(`unconfigured pool: run(s) whose usage the ledger could not count name a pool it does not configure (${gone.join(', ')}), so no window counts them`)
      if (unreadable) open.push(`${unreadable} usage.unknown entr${unreadable === 1 ? 'y is' : 'ies are'} not a valid usage-unknown@1.0 record, so no pool counts ${unreadable === 1 ? 'it' : 'them'}`)
      if (unread) open.push(`more than ${MAX_UNKNOWN_ENTRIES} usage.unknown entries in the pools' windows: only the first ${MAX_UNKNOWN_ENTRIES} were read, so later ones are not counted here`)
      return open.length
        ? { name: 'usage', state: 'degraded', detail: `${open.join('; ')}. A cap counts each as 0 until the ledger counts a record of it: see system events --type usage.unknown (docs/operations/runbooks.md#usage-the-ledger-could-not-count)` }
        : ok('usage', 'the ledger counted the usage of every run in each pool\'s current window')
    }))
  }

  const undeleted = sources.undeleted
  if (undeleted) {
    checks.push(await guarded('conversations', () => {
      const failed = undeleted()
      const accounts = [...new Set(failed.map((c) => c.account))].sort()
      return failed.length
        ? { name: 'conversations', state: 'degraded', detail: `${failed.length} website conversation(s) of ${accounts.join(', ')} could not be deleted: see system conversations --state failed, and the playbook (docs/operations/playbooks.md)` }
        : ok('conversations', 'every released website conversation was deleted or is due')
    }))
  }

  const profiles = sources.profiles
  if (profiles) {
    checks.push(await guarded('login-profiles', () => {
      const states = profiles()
      const blocked = states.filter((p) => p.blocked)
      if (blocked.length) return { name: 'login-profiles', state: 'degraded', detail: blocked.map((p) => `${p.account}: ${p.blocked}`).join('; ') }
      const reserved = states.filter((p) => p.reserved).map((p) => p.account)
      const open = states.filter((p) => p.open).map((p) => (p.kept ? `${p.account} (${p.kept} kept tab(s))` : p.account))
      return ok('login-profiles', [
        reserved.length ? `held by a remote login: ${reserved.join(', ')} (their operations fail as overloaded and are retried until it ends)` : '',
        open.length ? `open for work${sources.browserCap ? ` (${open.length} of at most ${sources.browserCap})` : ''}: ${open.join(', ')}` : '',
      ].filter(Boolean).join('; ') || 'no login profile is open for work')
    }))
  }

  const events = sources.events
  if (events) {
    checks.push(await guarded('ui-drift', () => {
      const since = new Date((sources.now ?? Date.now)() - sources.driftWindowMs).toISOString()
      // One stale element of one map is one change, however many turns resolve it on a fallback.
      const drifted = new Map<string, string>()
      for (const { data } of events('ui.drift', since)) drifted.set(`${data?.provider}\0${data?.element}\0${data?.mapHash}`, `${data?.provider} ${data?.element}`)
      // A failed turn whose drift was reported with its element is that one change, not another.
      const reported = [...drifted.values()].map((named) => named.replace(' ', ': '))
      const failed = new Set(events('workflow.node.failed', since).filter((e) => e.data?.kind === 'ui_drift').map((e) => String(e.data?.message ?? ''))
        .filter((message) => !reported.some((prefix) => message.startsWith(`${prefix} `))))
      const count = drifted.size + failed.size
      const named = [...new Set(drifted.values())].sort()
      return count
        ? { name: 'ui-drift', state: 'degraded', detail: `${count} provider UI change(s) seen recently${named.length ? ` (${named.join(', ')})` : ''}: update the UI map (docs/operations/playbooks.md)` }
        : ok('ui-drift', 'no provider UI change seen recently')
    }))
  }

  // A notice, not an alarm: what retention removed recently (the first sweep after an upgrade may remove many runs).
  if (events) {
    checks.push(await guarded('retention', () => {
      const since = new Date((sources.now ?? Date.now)() - sources.driftWindowMs).toISOString()
      const swept = events('workflow.retention.swept', since)
      const runs = swept.reduce((n, e) => n + Number(e.data?.runs ?? 0), 0)
      const conversations = swept.reduce((n, e) => n + Number(e.data?.conversations ?? 0), 0)
      return ok('retention', swept.length
        ? `retention expired ${runs} run(s) and released ${conversations} website conversation(s) for deletion recently (system events --type workflow.retention.swept)`
        : 'retention expired no run recently')
    }))
  }

  const state = checks.reduce<HealthState>((worst, check) => (RANK[check.state] > RANK[worst] ? check.state : worst), 'ok')
  return { state, checks }
}
