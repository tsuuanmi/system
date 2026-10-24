import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  currentProcess, hostOf, type LeaseProbe, LIVENESS_RULE, livenessOf, type LivenessSignals, type ProcessIdentity, processIdentity, processIdentityOf, type ProcessProbe, probeProcess,
} from '../src/index.ts'

const AT = 1_800_000_000_000
const BOUNDS = { stallSeconds: 300, deadAfterSeconds: 120 }
const LIVE: LeaseProbe = { state: 'live' }
const LAPSED: LeaseProbe = { state: 'lapsed', why: 'expired' }
const LEASE_UNKNOWN: LeaseProbe = { state: 'unknown', why: 'database is locked' }
const PRESENT: ProcessProbe = { state: 'present' }
const GONE: ProcessProbe = { state: 'gone', why: 'no process 42 exists' }
const NOT_READ: ProcessProbe = { state: 'unknown', why: 'process 42 cannot be read (EACCES)' }
const NEVER: ProcessProbe = { state: 'unknown', why: 'never reported' }
const ELSEWHERE: ProcessProbe = { state: 'unknown', why: 'it ran on another host (b)' }

const signals = (overrides: Partial<LivenessSignals> & { quietSeconds?: number | undefined } = {}): LivenessSignals => {
  const { quietSeconds = 10, ...rest } = overrides
  return {
    at: AT, holder: { lease: LIVE, process: PRESENT }, runtime: PRESENT,
    lastActivityAt: 'quietSeconds' in overrides && overrides.quietSeconds === undefined ? undefined : AT - quietSeconds * 1000, ...rest,
  }
}

/** The liveness table of PROP-0013, row by row: only `dead` is death. */
describe('livenessOf (PROP-0013, ADR-0054)', () => {
  it('alive: the holder\'s lease live, the agent process present, activity within stallSeconds', () => {
    expect(livenessOf(signals({ quietSeconds: 299 }), BOUNDS)).toMatchObject({ verdict: 'alive', rule: LIVENESS_RULE })
  })

  it('stalled: the agent process present with no activity for stallSeconds or more, whatever the holder', () => {
    expect(livenessOf(signals({ quietSeconds: 300 }), BOUNDS).verdict).toBe('stalled')
    expect(livenessOf(signals({ quietSeconds: 3000, holder: { lease: LAPSED, process: GONE } }), BOUNDS).verdict).toBe('stalled')
    expect(livenessOf(signals({ quietSeconds: 3000, holder: { lease: LEASE_UNKNOWN, process: NOT_READ } }), BOUNDS).verdict).toBe('stalled')
  })

  it('dead: the holder positively gone (lease lapsed, process gone), the agent process gone, and no activity within deadAfterSeconds', () => {
    const dead = livenessOf(signals({ holder: { lease: LAPSED, process: GONE }, runtime: GONE, quietSeconds: 120 }), BOUNDS)
    expect(dead).toEqual({
      verdict: 'dead', rule: LIVENESS_RULE,
      reasons: ['the holder\'s lease: lapsed (expired)', 'the holder\'s process: gone (no process 42 exists)', 'the agent process: gone (no process 42 exists)', 'activity: the latest 120 s ago'],
    })
  })

  it('unknown, never dead, while activity is within deadAfterSeconds, and says when to look again', () => {
    const recent = livenessOf(signals({ holder: { lease: LAPSED, process: GONE }, runtime: GONE, quietSeconds: 119 }), BOUNDS)
    expect(recent).toMatchObject({ verdict: 'unknown', recheckAt: AT + 1000 })
  })

  it('unknown on every failed probe or signal never reported: a failed probe is never death', () => {
    const gone = { holder: { lease: LAPSED, process: GONE }, runtime: GONE, quietSeconds: 10_000 } as const
    const cases: Array<[string, Partial<LivenessSignals> & { quietSeconds?: number | undefined }]> = [
      ['the lease cannot be read (a store error)', { ...gone, holder: { lease: LEASE_UNKNOWN, process: GONE } }],
      ['the lease is still live', { ...gone, holder: { lease: LIVE, process: GONE } }],
      ['the holder\'s process cannot be read', { ...gone, holder: { lease: LAPSED, process: NOT_READ } }],
      ['the holder ran on another host', { ...gone, holder: { lease: LAPSED, process: ELSEWHERE } }],
      ['the holder\'s process is still there', { ...gone, holder: { lease: LAPSED, process: PRESENT } }],
      ['the agent process was never reported', { ...gone, runtime: NEVER }],
      ['the agent process cannot be read', { ...gone, runtime: NOT_READ }],
      ['no activity was ever recorded', { ...gone, quietSeconds: undefined }],
      ['the agent process present, active, the lease lapsed', { holder: { lease: LAPSED, process: GONE }, runtime: PRESENT, quietSeconds: 5 }],
      ['the agent process present, active, the lease unknown', { holder: { lease: LEASE_UNKNOWN, process: PRESENT }, runtime: PRESENT, quietSeconds: 5 }],
      ['the agent process unknown, the lease live', { runtime: NOT_READ, quietSeconds: 5 }],
    ]
    for (const [why, overrides] of cases) {
      const verdict = livenessOf(signals(overrides), BOUNDS)
      expect(verdict.verdict, why).toBe('unknown')
      expect(verdict.recheckAt, why).toBeUndefined()
    }
  })

  it('counts activity stamped after the verdict\'s time as just now, and refuses bounds that are not positive whole seconds', () => {
    expect(livenessOf(signals({ lastActivityAt: AT + 60_000 }), BOUNDS).verdict).toBe('alive')
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => livenessOf(signals(), { ...BOUNDS, stallSeconds: bad })).toThrow(RangeError)
      expect(() => livenessOf(signals(), { ...BOUNDS, deadAfterSeconds: bad })).toThrow(RangeError)
    }
  })
})

describe('probeProcess', () => {
  const boot = '0b1e2c3d-1111-2222-3333-444455556666'
  const recorded: ProcessIdentity = { host: hostOf(), boot, pid: 42, startTicks: 777 }
  const stat = (start: number, state = 'S'): string => `42 (claude (code) x) ${state} 1 42 42 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 ${start} 1000 10 18446744073709551615`
  const files = (entries: Record<string, string | NodeJS.ErrnoException>) => (path: string): string => {
    const entry = entries[path]
    if (entry === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    if (typeof entry !== 'string') throw entry
    return entry
  }
  const BOOT = '/proc/sys/kernel/random/boot_id'

  it('finds a recorded process present only when its pid has the same start time on the same boot', () => {
    expect(probeProcess(recorded, files({ [BOOT]: `${boot}\n`, '/proc/42/stat': stat(777) }))).toEqual({ state: 'present' })
  })

  it('finds it gone only on positive evidence: no such pid, a reused pid, an exited one, or another boot', () => {
    expect(probeProcess(recorded, files({ [BOOT]: boot }))).toMatchObject({ state: 'gone', why: 'no process 42 exists' })
    expect(probeProcess(recorded, files({ [BOOT]: boot, '/proc/42/stat': stat(778) }))).toMatchObject({ state: 'gone', why: expect.stringContaining('another time') })
    expect(probeProcess(recorded, files({ [BOOT]: boot, '/proc/42/stat': stat(777, 'Z') }))).toMatchObject({ state: 'gone', why: 'process 42 has exited' })
    expect(probeProcess(recorded, files({ [BOOT]: '99999999-1111-2222-3333-444455556666', '/proc/42/stat': stat(777) }))).toMatchObject({ state: 'gone', why: expect.stringContaining('restarted') })
  })

  it('cannot tell, and says so, for a process never reported, one on another host, or anything it cannot read', () => {
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    expect(probeProcess(undefined)).toEqual({ state: 'unknown', why: 'never reported' })
    expect(probeProcess({ ...recorded, host: `${hostOf()}-other` }, files({ [BOOT]: boot }))).toMatchObject({ state: 'unknown', why: expect.stringContaining('another host') })
    expect(probeProcess(recorded, files({}))).toMatchObject({ state: 'unknown', why: expect.stringContaining('boot id') })
    expect(probeProcess(recorded, files({ [BOOT]: boot, '/proc/42/stat': denied }))).toMatchObject({ state: 'unknown', why: 'process 42 cannot be read (EACCES)' })
    expect(probeProcess(recorded, files({ [BOOT]: boot, '/proc/42/stat': 'garbage' }))).toMatchObject({ state: 'unknown' })
  })

  it.runIf(process.platform === 'linux')('reads a real process on this host: present while it runs, gone once it exits', async () => {
    expect(currentProcess()).toMatchObject({ pid: process.pid, host: hostOf() })
    expect(probeProcess(currentProcess())).toEqual({ state: 'present' })
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    await new Promise((resolve) => child.once('spawn', resolve))
    const identity = processIdentity(child.pid!)
    expect(identity).toBeDefined()
    expect(probeProcess(identity)).toEqual({ state: 'present' })
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))
    expect(probeProcess(identity)).toMatchObject({ state: 'gone' })
    expect(processIdentityOf(JSON.parse(JSON.stringify(identity)))).toEqual(identity)
    expect(processIdentityOf({ ...identity, pid: 0 })).toBeUndefined()
    expect(processIdentityOf('x')).toBeUndefined()
  })
})
