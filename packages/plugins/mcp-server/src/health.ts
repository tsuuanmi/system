/**
 * The host's health (PROP-0003 M6b): what an operator needs to know is wrong now, read from the
 * services that are mounted, never guessed. Each check is `ok`, `degraded` (work may still run,
 * something needs the operator), or `down` (work cannot run); the report is the worst of them.
 */
import { existsSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
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
  /** `PRAGMA quick_check(1)` on the store. */
  storeCheck?: () => string
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

export async function healthReport(sources: HealthSources): Promise<HealthReport> {
  const checks: HealthCheck[] = []
  const runtime = nodeVersionProblem(sources.nodeVersion ?? process.versions.node)
  checks.push(runtime ? { name: 'runtime', state: 'down', detail: runtime } : ok('runtime', `Node ${sources.nodeVersion ?? process.versions.node}`))

  if (!sources.storeCheck) checks.push({ name: 'store', state: 'down', detail: 'the store is not mounted' })
  else {
    let result: string
    try {
      result = sources.storeCheck()
    } catch (error) {
      result = (error as Error).message
    }
    checks.push(result === 'ok' ? ok('store', 'integrity check passed') : { name: 'store', state: 'down', detail: `integrity check: ${result.slice(0, 200)}` })
  }

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

  // The default key location sits beside the vault (docs/operations/runbooks.md#key-custody).
  checks.push(existsSync(join(sources.dshHome, 'system', 'vault.key'))
    ? { name: 'vault-key', state: 'degraded', detail: 'the vault key sits beside the vault; keep it elsewhere (docs/operations/runbooks.md#key-custody)' }
    : ok('vault-key', 'kept apart from the vault'))

  if (sources.accounts) {
    const waiting = (await sources.accounts()).filter((a) => a.status === 'reauth-required' || a.status === 'challenge')
    checks.push(waiting.length
      ? { name: 'accounts', state: 'degraded', detail: `${waiting.map((a) => `${a.id} (${a.status})`).join(', ')}: sign in again (system account login <id>)` }
      : ok('accounts', 'every account is signed in or not in use'))
  }

  if (sources.workers) {
    const workers = await sources.workers()
    const unavailable = workers.filter((w) => w.state === 'unavailable')
    checks.push(workers.length && unavailable.length === workers.length
      ? { name: 'workers', state: 'down', detail: 'no Worker is available' }
      : unavailable.length
        ? { name: 'workers', state: 'degraded', detail: `unavailable: ${unavailable.map((w) => w.worker).join(', ')} (system explain shows why)` }
        : ok('workers', `${workers.length} available`))
  }

  if (sources.events) {
    const since = new Date((sources.now ?? Date.now)() - sources.driftWindowMs).toISOString()
    const drift = sources.events('ui.drift', since).length
      + sources.events('workflow.node.failed', since).filter((e) => e.data?.kind === 'ui_drift').length
    checks.push(drift
      ? { name: 'ui-drift', state: 'degraded', detail: `${drift} provider UI change(s) seen recently: update the UI map (docs/operations/playbooks.md)` }
      : ok('ui-drift', 'no provider UI change seen recently'))
  }

  const state = checks.reduce<HealthState>((worst, check) => (RANK[check.state] > RANK[worst] ? check.state : worst), 'ok')
  return { state, checks }
}
