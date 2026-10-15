/**
 * The host's health (PROP-0003 M6b): what an operator needs to know is wrong now, read from the
 * services that are mounted, never guessed. Each check is `ok`, `degraded` (work may still run,
 * something needs the operator), or `down` (work cannot run); the report is the worst of them.
 */
import { statfsSync } from 'node:fs'
import { nodeVersionProblem } from '@tsuuanmi/system-libs'

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
  workers?: () => Promise<Array<{ worker: string; state: string }>>
  /** Events of `type` committed since `sinceIso`. */
  events?: (type: string, sinceIso: string) => Array<{ data?: Record<string, unknown> | undefined }>
  nodeVersion?: string
  minFreeBytes: number
  driftWindowMs: number
  now?: () => number
}

const RANK: Record<HealthState, number> = { ok: 0, degraded: 1, down: 2 }

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
      return waiting.length
        ? { name: 'accounts', state: 'degraded', detail: `${waiting.map((a) => `${a.id} (${a.status})`).join(', ')}: sign in again (system account login <id>)` }
        : ok('accounts', 'every account is signed in or not in use')
    }))
  }

  const listWorkers = sources.workers
  if (listWorkers) {
    checks.push(await guarded('workers', async () => {
      const workers = await listWorkers()
      const waiting = workers.filter((w) => !AVAILABLE.has(w.state))
      return workers.length && waiting.length === workers.length
        ? { name: 'workers', state: 'down', detail: `no Worker can take work: ${waiting.map((w) => `${w.worker} (${w.state})`).join(', ')}` }
        : waiting.length
          ? { name: 'workers', state: 'degraded', detail: `cannot take work: ${waiting.map((w) => `${w.worker} (${w.state})`).join(', ')} (system explain shows why)` }
          : ok('workers', `${workers.length} available`)
    }))
  }

  const events = sources.events
  if (events) {
    checks.push(await guarded('ui-drift', () => {
      const since = new Date((sources.now ?? Date.now)() - sources.driftWindowMs).toISOString()
      // One stale element of one map is one change, however many turns resolve it on a fallback.
      const drifted = new Map<string, string>()
      for (const { data } of events('ui.drift', since)) drifted.set(`${data?.provider}\0${data?.element}\0${data?.mapHash}`, `${data?.provider} ${data?.element}`)
      const failed = new Set(events('workflow.node.failed', since).filter((e) => e.data?.kind === 'ui_drift').map((e) => String(e.data?.message ?? '')))
      const count = drifted.size + failed.size
      const named = [...new Set(drifted.values())].sort()
      return count
        ? { name: 'ui-drift', state: 'degraded', detail: `${count} provider UI change(s) seen recently${named.length ? ` (${named.join(', ')})` : ''}: update the UI map (docs/operations/playbooks.md)` }
        : ok('ui-drift', 'no provider UI change seen recently')
    }))
  }

  const state = checks.reduce<HealthState>((worst, check) => (RANK[check.state] > RANK[worst] ? check.state : worst), 'ok')
  return { state, checks }
}
