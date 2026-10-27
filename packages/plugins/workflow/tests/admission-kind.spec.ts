import { AdmissionFailure, type Rejection } from '@tsuuanmi/system-workers-core'
import { describe, expect, it } from 'vitest'
import { admissionKind } from '../src/recovery.ts'

const failure = (rejections: Rejection[], retryAt?: string): AdmissionFailure => new AdmissionFailure(rejections, 'sha256:00', 'no Worker can take this work', undefined, retryAt)
const writer: Rejection = { worker: 'w:w', state: 'ready', failed: [{ check: 'capability', reason: 'does not prove review' }] }

describe('admissionKind: only "no configured Worker proves it at any tier" is a config error (T282)', () => {
  it('is never a config error for a Worker that proves the work and is at its limit, out of quota, or whose tier its model\'s limit closed', () => {
    expect(admissionKind(failure([writer, { worker: 'w:r', state: 'quota-exhausted', failed: [{ check: 'state', reason: 'state quota-exhausted' }] }]))).toBe('quota_exhausted')
    expect(admissionKind(failure([writer, { worker: 'w:r', state: 'ready', failed: [{ check: 'cooldown', reason: 'tier frontier limit until 2099-01-05T09:00:00.000Z (its model\'s limit)' }] }]))).toBe('quota_exhausted')
  })

  it('is never a config error while routing says the work is worth routing again: a source has not described its Workers yet since the host started', () => {
    const soon = '2026-10-27T10:00:30.000Z'
    // Only Workers that do not prove it were described: the source that holds the one that does is still describing.
    expect(admissionKind(failure([writer], soon))).toBe('overloaded')
    expect(admissionKind(failure([], soon))).toBe('overloaded')
    // Without it, as before.
    expect(admissionKind(failure([writer]))).toBe('config_error')
    expect(admissionKind(failure([]))).toBe('reauth_required')
  })
})
