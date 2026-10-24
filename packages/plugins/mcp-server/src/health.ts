/**
 * The host's health (PROP-0003 M6b): what an operator needs to know is wrong now, read from the
 * services that are mounted, never guessed. Each check is `ok`, `degraded` (work may still run,
 * something needs the operator), or `down` (work cannot run); the report is the worst of them.
 */
import { statfsSync } from 'node:fs'
import { countUnknownUsage, MAX_UNKNOWN_ENTRIES, nodeVersionProblem, type UnknownUsageSources } from '@tsuuanmi/system-libs'

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
  /** Agent accounts in their enrollment slots (ADR-0051): any not `ready` takes no work, and is named. */
  agentAccounts?: () => Array<{ provider: string; slot: number; accountId?: string | undefined; status: string; reason?: string | undefined }>
  workers?: () => Promise<Array<{ worker: string; state: string }>>
  /**
   * How each Worker source answered its last read (`ctx.workers.sources()`), read after `workers`:
   * a source that was silent or failed is not counted there, and a route then saw none of its Workers.
   */
  workerSources?: () => Array<{ source: string; state: 'described' | 'silent' | 'failed'; at: string; detail?: string; describing?: true }>
  /**
   * The runs whose liveness needs the operator's look (`ctx.workers.liveness()`, PROP-0013): stalled,
   * being looked at, or ended without being known to be gone; and each source that could not tell.
   */
  liveness?: () => Promise<LivenessRead>
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
   * Usage the resource ledger could not count (docs/design/resources.md#usage-the-ledger-cannot-count),
   * counted by `countUnknownUsage` (`@tsuuanmi/system-libs`): the ledger's pools and windows, the
   * `usage.unknown` entries, and whether the ledger counted a record of a run in a pool.
   */
  unknownUsage?: UnknownUsageSources
  /**
   * The notifier's delivery outcomes (`notify.delivery` events, docs/design/notifications.md#health):
   * a page of them since a time, in `seq` order, after `afterSeq`, at most `limit`.
   */
  deliveries?: (query: { since: string; afterSeq: number; limit: number }) => Array<{ seq: number; data?: Record<string, unknown> | undefined }>
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

/** What `ctx.workers.liveness()` tells, as health and `status` read it. */
export interface LivenessRead {
  runs: Array<{ source: string; execution: string; worker: string; state: 'stalled' | 'looking' | 'unknown'; since: string; runId?: string | undefined; sessionId?: string | undefined }>
  counts: Record<'stalled' | 'looking' | 'unknown', number>
  unread: Array<{ source: string; detail: string }>
}

/** Runs one state's line of the `liveness` check names; the rest are counted. */
const LIVENESS_NAMED = 5

const RANK: Record<HealthState, number> = { ok: 0, degraded: 1, down: 2 }

/** `notify.delivery` entries the `notifications` check reads at most (INV-9): past it, it is degraded, never ok. */
export const MAX_DELIVERIES = 10_000
/** `notify.delivery` entries the `notifications` check asks for at once: the event log's most per query. */
const DELIVERIES_PAGE = 1000

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

  const agentAccounts = sources.agentAccounts
  if (agentAccounts) {
    checks.push(await guarded('agent-accounts', () => {
      const all = agentAccounts()
      const named = (a: (typeof all)[number]) => `${a.accountId ?? `slot ${a.slot} of ${a.provider}`} (${a.status}${a.reason ? `: ${a.reason}` : ''})`
      const waiting = all.filter((a) => a.status !== 'ready')
      return waiting.length
        ? { name: 'agent-accounts', state: 'degraded', detail: `take no work: ${waiting.map(named).join(', ')}; see system account list, and resolve each (docs/operations/runbooks.md#resolve-a-quarantined-agent-account)` }
        : ok('agent-accounts', `${all.length} enrolled, every one ready`)
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
      // A source whose first describe has not landed is still describing: its Workers are not known yet, so no count reads as all of them (T99 D8).
      const named = unheard.map((s) => (s.describing
        ? `source ${s.source} describing… (its first describe since it registered has not landed, at ${s.at})`
        : `source ${s.source} ${s.detail ?? s.state} (at ${s.at})`)).join('; ')
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
        const sofar = unheard.some((s) => s.describing) ? ' so far' : ''
        return { name: 'workers', state: 'degraded', detail: [...(waiting.length ? [`cannot take work: ${cannot} (system explain shows why)`] : [`${workers.length} available${sofar}`]), ...(unheard.length ? [unheardNote] : [])].join('; ') }
      }
      return ok('workers', `${workers.length} available`)
    }))
  }

  // A run that ended without being known to be gone holds its session and worktree until the operator
  // frees it (PROP-0013): degraded while one does, or while a source cannot tell (INV-2). A stalled run
  // and one still being looked at are named, and need nothing yet.
  const liveness = sources.liveness
  if (liveness) {
    checks.push(await guarded('liveness', async () => {
      const told = await liveness()
      const line = (state: 'stalled' | 'looking' | 'unknown', words: string): string | undefined => {
        if (!told.counts[state]) return undefined
        const named = told.runs.filter((r) => r.state === state).slice(0, LIVENESS_NAMED).map((r) => `${r.execution} (${r.worker})`)
        const more = told.counts[state] - named.length
        return `${told.counts[state]} ${words}: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
      }
      const held = line('unknown', 'ended without being known to be gone, their session and worktree held')
      const others = [line('looking', 'being looked at after their holder stopped'), line('stalled', 'stalled (nothing is sent to them; their deadline ends them)')].filter(Boolean)
      const unread = told.unread.map((u) => `source ${u.source} cannot tell (${u.detail})`)
      const runbook = '(docs/operations/runbooks.md#a-runs-liveness-is-unknown)'
      if (held || unread.length) {
        return { name: 'liveness', state: 'degraded', detail: `${[held, ...unread, ...others].filter(Boolean).join('; ')}. system explain <run> says why and what to do; free a run once its agent is gone: system free <run> --agent-gone ${runbook}` }
      }
      return ok('liveness', others.length ? others.join('; ') : 'no run is stalled, being looked at, or held for want of a verdict')
    }))
  }

  // Usage the ledger could not count still counts as 0 against a cap (D25): degraded while a pool
  // has such a run in its current window that the ledger has not counted a record of since.
  const unknownUsage = sources.unknownUsage
  if (unknownUsage) {
    checks.push(await guarded('usage', async () => {
      const count = await countUnknownUsage(unknownUsage, (sources.now ?? Date.now)())
      if (!count.pools.length) return ok('usage', 'no resource pool is configured')
      const open: string[] = []
      for (const { pool, seconds, runs, kinds } of count.pools) {
        if (runs) open.push(`${pool}: ${runs} run(s) in its current window (${seconds === undefined ? 'it has a window that never resets' : `the last ${span(seconds)}`}) whose usage the ledger could not count (${Object.entries(kinds).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, n]) => `${n} ${k}`).join(', ')})`)
      }
      if (count.unconfigured.length) open.push(`unconfigured pool: run(s) whose usage the ledger could not count name a pool it does not configure (${count.unconfigured.map((u) => `${u.pool} ${u.runs}`).join(', ')}), so no window counts them`)
      const { unreadable } = count
      if (unreadable) open.push(`${unreadable} usage.unknown entr${unreadable === 1 ? 'y is' : 'ies are'} not a valid usage-unknown@1.0 record, so no pool counts ${unreadable === 1 ? 'it' : 'them'}`)
      if (count.unread) open.push(`more than ${MAX_UNKNOWN_ENTRIES} usage.unknown entries in the pools' windows: only the first ${MAX_UNKNOWN_ENTRIES} were read, so later ones are not counted here`)
      return open.length
        ? { name: 'usage', state: 'degraded', detail: `${open.join('; ')}. A cap counts each as 0 until the ledger counts a record of it: see system events --type usage.unknown (docs/operations/runbooks.md#usage-the-ledger-could-not-count)` }
        : ok('usage', 'the ledger counted the usage of every run in each pool\'s current window')
    }))
  }

  // Notifications fail open, so a sink that stopped working is said here, never silently lost:
  // degraded while a sink's latest outcome recently is a failure, or a notice was dropped recently.
  const deliveries = sources.deliveries
  if (deliveries) {
    // Only once the notifier recorded something recently: with its row off there is nothing to say.
    const check = ((): HealthCheck | undefined => {
      const since = new Date((sources.now ?? Date.now)() - sources.driftWindowMs).toISOString()
      const entries: ReturnType<typeof deliveries> = []
      let unread = false
      for (let afterSeq = 0; ;) {
        const limit = Math.min(DELIVERIES_PAGE, MAX_DELIVERIES + 1 - entries.length)
        const page = deliveries({ since, afterSeq, limit })
        entries.push(...page)
        if (entries.length > MAX_DELIVERIES) {
          unread = true
          entries.length = MAX_DELIVERIES
          break
        }
        if (page.length < limit) break
        afterSeq = page.at(-1)!.seq
      }
      if (!entries.length) return undefined
      const latest = new Map<string, { outcome: string; reason: string; failed: number }>()
      let sent = 0
      let dropped = 0
      for (const { data } of entries) {
        const outcome = String(data?.outcome ?? '')
        if (outcome === 'dropped') dropped += 1
        if (outcome === 'sent') sent += 1
        const sink = typeof data?.sink === 'string' ? data.sink : undefined
        if (!sink || !['sent', 'failed', 'unavailable'].includes(outcome)) continue
        const before = latest.get(sink)
        latest.set(sink, { outcome, reason: String(data?.reason ?? '').slice(0, 200), failed: (before?.failed ?? 0) + (outcome === 'sent' ? 0 : 1) })
      }
      const problems = [
        ...[...latest].filter(([, s]) => s.outcome !== 'sent').sort(([a], [b]) => (a < b ? -1 : 1)).map(([sink, s]) => `${sink}: ${s.reason} (${s.failed} failed recently)`),
        ...(dropped ? [`${dropped} notice(s) dropped: the queue was full (maxQueue)`] : []),
        ...(unread ? [`more than ${MAX_DELIVERIES} notify.delivery entries recently: only the first ${MAX_DELIVERIES} were read`] : []),
      ]
      return problems.length
        ? { name: 'notifications', state: 'degraded', detail: `${problems.join('; ')}. Notices may not reach you: see system events --type notify.delivery (docs/operations/runbooks.md#get-notified)` }
        : ok('notifications', `${sent} notice(s) sent recently`)
    })
    try {
      const made = check()
      if (made) checks.push(made)
    } catch (error) {
      checks.push({ name: 'notifications', state: 'down', detail: `the check failed: ${(error as Error).message.slice(0, 160)}` })
    }
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
