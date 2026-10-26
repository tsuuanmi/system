import { describe, expect, it } from 'vitest'
import { abilityOf, availabilityChanges, recordedAbility, type RosterEntry, WORKER_AVAILABLE_EVENT, WORKER_UNAVAILABLE_EVENT } from '../src/index.ts'

// Worker availability over time (PROP-0016 I4): what a roster entry says of whether its Worker takes
// work, and the events that bring a record of it up to date.

const entry = (worker: string, availability: unknown, extra: Record<string, unknown> = {}): RosterEntry =>
  ({ worker, state: 'ready', account: { unknown: 'none' }, availability, ...extra }) as unknown as RosterEntry
const accountWith = (status: string) => ({ value: { id: 'a', group: 'g', mode: 'assigned', record: { value: { kind: 'agent', status } } } })

describe('Worker ability from the roster', () => {
  it('reads a usage limit, a lost login, a quarantine, and a stall as unable, each with its reason, and a busy Worker as able', () => {
    expect(abilityOf(entry('w', { state: 'resting', summary: 'resting at a limit' }))).toMatchObject({ able: false, reason: 'quota-exhausted' })
    expect(abilityOf(entry('w', { state: 'unavailable', summary: 'signed out' }, { account: accountWith('signed-out') }))).toMatchObject({ able: false, reason: 'login-lost' })
    expect(abilityOf(entry('w', { state: 'unavailable', summary: 'reauth' }, { state: 'reauth-required' }))).toMatchObject({ able: false, reason: 'login-lost' })
    expect(abilityOf(entry('w', { state: 'unavailable', summary: 'down' }, { account: accountWith('ready') }))).toMatchObject({ able: false, reason: 'unavailable' })
    expect(abilityOf(entry('w', { state: 'quarantined', summary: 'changed' }))).toMatchObject({ able: false, reason: 'quarantined' })
    expect(abilityOf(entry('w', { state: 'busy', summary: 'busy' }, { liveness: { value: [{ state: 'stalled', summary: 'run r stalled' }] } }))).toMatchObject({ able: false, reason: 'stalled' })
    expect(abilityOf(entry('w', { state: 'busy', summary: 'busy 1 of 2' }))).toEqual({ able: true })
  })
})

describe('the events that record a change', () => {
  it('records a Worker\'s first state, then only its changes, each with the Worker and the reason', () => {
    const ready = entry('a', { state: 'ready', summary: 'ready' })
    const limited = entry('a', { state: 'resting', summary: 'resting at a limit' })
    const first = availabilityChanges(new Map(), [ready, entry('b', { state: 'quarantined', summary: 'changed' })])
    expect(first.events).toEqual([{ type: WORKER_AVAILABLE_EVENT, data: { worker: 'a' } }, { type: WORKER_UNAVAILABLE_EVENT, data: { worker: 'b', reason: 'quarantined', detail: 'changed' } }])
    expect(availabilityChanges(first.next, [ready, entry('b', { state: 'quarantined', summary: 'changed' })]).events).toEqual([])
    const second = availabilityChanges(first.next, [limited])
    expect(second.events).toEqual([{ type: WORKER_UNAVAILABLE_EVENT, data: { worker: 'a', reason: 'quota-exhausted', detail: 'resting at a limit' } }])
    expect(availabilityChanges(second.next, [ready]).events).toEqual([{ type: WORKER_AVAILABLE_EVENT, data: { worker: 'a', was: 'quota-exhausted' } }])
  })

  it('rebuilds the last recorded state of each Worker from the log, a later event replacing an earlier one', () => {
    const last = recordedAbility([
      { type: WORKER_UNAVAILABLE_EVENT, data: { worker: 'a', reason: 'login-lost' } }, { type: WORKER_AVAILABLE_EVENT, data: { worker: 'a' } },
      { type: WORKER_UNAVAILABLE_EVENT, data: { worker: 'b', reason: 'stalled' } },
    ])
    expect(last.get('a')).toEqual({ able: true })
    expect(last.get('b')).toEqual({ able: false, reason: 'stalled' })
  })
})
