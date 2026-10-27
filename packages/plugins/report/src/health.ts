/**
 * The health table of a project (PROP-0019 section 2.10), computed: a pure function from what was
 * read to one row per source, each `ok`, `degraded`, or `unknown` with its reason. A source that
 * could not be read is `unknown`, never `ok` (INV-2). It joins what is read in several places today:
 * dispatch, the Workers, the quota pools, the notification and lead sinks, the live update, the
 * landing queue, the worktrees held, and each enforce switch's mode (T322).
 */
import type { Read } from './digest.ts'

export type HealthState = 'ok' | 'degraded' | 'unknown'
export interface HealthRow { id: string; name: string; state: HealthState; reason: string }
export interface Health { projectId: string; asOf: string; state: HealthState; rows: HealthRow[] }

/** Dispatch as `dispatchStatus()` tells it, as much as the table reads. */
export interface DispatchRead {
  enabled: boolean
  paused?: { reason?: string }
  /** The projects the operator paused dispatch in. */
  pausedProjects: string[]
  bounds: Array<{ name: string; used: number; max: number }>
}
export interface WorkerRead { worker: string; state: string; unavailableReason?: string; cooldownUntil?: string }
export interface PoolRead { pool: string; available: boolean; until?: string; usedPercentage?: number }
/** The last outcome of one sink in the window read (`notify.delivery`, `lead-inbox.delivery`). */
export interface SinkRead { sink: string; at: string; outcome: string; reason?: string }
export interface LiveUpdateRead { at: string; outcome: string; reason?: string }
export interface LandingQueueRead { depth: number; oldestAt?: string }
export interface WorktreesRead { total: number; inUse: number; held: number; uncommitted: number }
export interface EnforceRead { mechanism: string; mode: string }

export interface HealthSources {
  projectId: string
  asOf: string
  dispatch: Read<DispatchRead>
  workers: Read<WorkerRead[]>
  pools: Read<PoolRead[]>
  notifySinks: Read<SinkRead[]>
  leadSinks: Read<SinkRead[]>
  liveUpdate: Read<LiveUpdateRead | undefined>
  landingQueue: Read<LandingQueueRead>
  worktrees: Read<WorktreesRead>
  enforcement: Read<EnforceRead[]>
}

/** A pool at or above this share of a window is degraded: its headroom is spent. */
const QUOTA_DEGRADED_PERCENT = 90
/** A landing waiting longer than this, in hours, is degraded: the queue is stuck or waits on someone. */
const LANDING_STALE_HOURS = 12
/** The window the sinks' deliveries are read over, in hours. */
export const SINK_WINDOW_HOURS = 24

const HOUR_MS = 3_600_000
const row = (id: string, name: string, state: HealthState, reason: string): HealthRow => ({ id, name, state, reason: reason.slice(0, 500) })
const unknown = (id: string, name: string, why: string): HealthRow => row(id, name, 'unknown', `not read: ${why}`)
const named = (items: string[], max = 5): string => (items.length > max ? `${items.slice(0, max).join('; ')}; and ${items.length - max} more` : items.join('; '))

export function buildHealth(s: HealthSources): Health {
  const asOf = Date.parse(s.asOf)
  const rows: HealthRow[] = []

  if (!('value' in s.dispatch)) rows.push(unknown('dispatch', 'Dispatch', s.dispatch.unknown))
  else {
    const d = s.dispatch.value
    const full = d.bounds.filter((b) => b.max > 0 && b.used >= b.max).map((b) => `${b.name} ${b.used}/${b.max}`)
    if (!d.enabled) rows.push(row('dispatch', 'Dispatch', 'degraded', 'dispatch is off: nothing is started by itself'))
    else if (d.paused) rows.push(row('dispatch', 'Dispatch', 'degraded', `paused${d.paused.reason ? `: ${d.paused.reason}` : ''}`))
    else if (d.pausedProjects.includes(s.projectId)) rows.push(row('dispatch', 'Dispatch', 'degraded', `paused for project ${s.projectId}`))
    else if (full.length) rows.push(row('dispatch', 'Dispatch', 'degraded', `running, at a bound: ${named(full)}`))
    else rows.push(row('dispatch', 'Dispatch', 'ok', `running; ${d.bounds.length ? d.bounds.map((b) => `${b.name} ${b.used}/${b.max}`).join(', ') : 'no bound read'}`))
  }

  if (!('value' in s.workers)) rows.push(unknown('workers', 'Workers', s.workers.unknown))
  else if (!s.workers.value.length) rows.push(row('workers', 'Workers', 'degraded', 'no Worker is registered: nothing can take work'))
  else {
    const resting = s.workers.value.filter((w) => w.cooldownUntil !== undefined && Date.parse(w.cooldownUntil) > asOf).map((w) => `${w.worker} in cooldown until ${w.cooldownUntil}`)
    const unavailable = s.workers.value.filter((w) => w.state === 'unavailable' || w.state === 'reauth-required' || w.state === 'quota-exhausted').map((w) => `${w.worker} ${w.state}${w.unavailableReason ? ` (${w.unavailableReason})` : ''}`)
    const problems = [...unavailable, ...resting]
    rows.push(problems.length ? row('workers', 'Workers', 'degraded', `${s.workers.value.length - unavailable.length} of ${s.workers.value.length} available: ${named(problems)}`) : row('workers', 'Workers', 'ok', `${s.workers.value.length} available`))
  }

  if (!('value' in s.pools)) rows.push(unknown('quota', 'Quota headroom', s.pools.unknown))
  else if (!s.pools.value.length) rows.push(row('quota', 'Quota headroom', 'unknown', 'no pool is configured: the headroom is not measured'))
  else {
    const spent = s.pools.value.filter((p) => !p.available || (p.usedPercentage !== undefined && p.usedPercentage >= QUOTA_DEGRADED_PERCENT))
      .map((p) => `${p.pool} ${!p.available ? `limited${p.until ? ` until ${p.until}` : ''}` : `${p.usedPercentage}% used`}`)
    rows.push(spent.length ? row('quota', 'Quota headroom', 'degraded', named(spent)) : row('quota', 'Quota headroom', 'ok', `${s.pools.value.length} pool(s) with headroom`))
  }

  for (const [id, name, read] of [['notify-sinks', 'Notification sinks', s.notifySinks], ['lead-sinks', 'Lead sinks', s.leadSinks]] as const) {
    if (!('value' in read)) rows.push(unknown(id, name, read.unknown))
    else if (!read.value.length) rows.push(row(id, name, 'unknown', `no delivery recorded in the last ${SINK_WINDOW_HOURS} h: nothing says the sinks work`))
    else {
      const failing = read.value.filter((x) => x.outcome !== 'sent').map((x) => `${x.sink} ${x.outcome} at ${x.at}${x.reason ? ` (${x.reason})` : ''}`)
      rows.push(failing.length ? row(id, name, 'degraded', `last delivery did not go: ${named(failing)}`) : row(id, name, 'ok', `${read.value.length} sink(s), the last delivery of each sent`))
    }
  }

  if (!('value' in s.liveUpdate)) rows.push(unknown('live-update', 'Live update', s.liveUpdate.unknown))
  else {
    const u = s.liveUpdate.value
    rows.push(!u ? row('live-update', 'Live update', 'ok', 'idle: none recorded')
      : u.outcome === 'failed' ? row('live-update', 'Live update', 'degraded', `the last update failed at ${u.at}${u.reason ? ` (${u.reason})` : ''}`)
        : row('live-update', 'Live update', 'ok', `idle: the last update ${u.outcome} at ${u.at}`))
  }

  if (!('value' in s.landingQueue)) rows.push(unknown('landing-queue', 'Landing queue', s.landingQueue.unknown))
  else {
    const q = s.landingQueue.value
    const age = q.oldestAt === undefined ? 0 : Math.max(0, asOf - Date.parse(q.oldestAt)) / HOUR_MS
    rows.push(q.depth === 0 ? row('landing-queue', 'Landing queue', 'ok', 'empty')
      : age > LANDING_STALE_HOURS ? row('landing-queue', 'Landing queue', 'degraded', `${q.depth} waiting, the oldest since ${q.oldestAt} (over ${LANDING_STALE_HOURS} h)`)
        : row('landing-queue', 'Landing queue', 'ok', `${q.depth} waiting${q.oldestAt ? `, the oldest since ${q.oldestAt}` : ''}`))
  }

  if (!('value' in s.worktrees)) rows.push(unknown('worktrees', 'Worktrees held', s.worktrees.unknown))
  else {
    const w = s.worktrees.value
    const problems = [...(w.held ? [`${w.held} held (an agent run ended with its liveness unknown)`] : []), ...(w.uncommitted ? [`${w.uncommitted} with uncommitted changes`] : [])]
    rows.push(problems.length ? row('worktrees', 'Worktrees held', 'degraded', `${problems.join('; ')} of ${w.total}`) : row('worktrees', 'Worktrees held', 'ok', `${w.total} kept, ${w.inUse} in use, none held`))
  }

  if (!('value' in s.enforcement)) rows.push(unknown('enforce', 'Enforce switches', s.enforcement.unknown))
  else for (const m of s.enforcement.value) rows.push(m.mode === 'on' ? row(`enforce:${m.mechanism}`, `Enforce ${m.mechanism}`, 'ok', 'on') : row(`enforce:${m.mechanism}`, `Enforce ${m.mechanism}`, 'degraded', m.mode === 'warn' ? 'warn: records what it would refuse, refuses nothing' : `${m.mode}: it does not run`))

  const state: HealthState = rows.some((r) => r.state === 'degraded') ? 'degraded' : rows.some((r) => r.state === 'unknown') ? 'unknown' : 'ok'
  return { projectId: s.projectId, asOf: s.asOf, state, rows }
}

/** The table as text, one row per line: the state, the source, and why. */
export function renderHealth(h: Health): string {
  return `${[`# Health: project ${h.projectId}: ${h.state}`, '', `Read ${h.asOf}.`, '', ...h.rows.map((r) => `- ${r.state.padEnd(8)} ${r.name}: ${r.reason}`)].join('\n')}\n`
}
