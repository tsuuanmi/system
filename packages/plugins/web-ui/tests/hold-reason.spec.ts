import type { ArtifactRef } from '@tsuuanmi/system-board-core'
import { describe, expect, it } from 'vitest'
import { holdReasonOf } from '../src/index.ts'

const DECISION = `sha256:${'a'.repeat(64)}` as ArtifactRef
const held = { reason: 'operator-review' as const, pendingChecks: [], since: '2026-10-27T09:00:00.000Z', expiresAt: '2026-10-28T09:00:00.000Z' }
const read = (detail: unknown) => (ref: ArtifactRef) => ref === DECISION ? { outcome: { detail } } : undefined

describe('holdReasonOf: why a review is held for the operator (T330)', () => {
  it('reads the reason the board\'s hold decision recorded, so a heavy hold with no pending check is not shown as having none', () => {
    const why = 'the result is heavy-tier (risk decision sha256:b): a heavy change is never accepted automatically (autonomy decision sha256:c)'
    expect(holdReasonOf({ lastDecision: DECISION, waiting: held }, read({ reason: 'operator-review', holdReason: why, pendingChecks: [] }))).toBe(why)
  })

  it('names none for a review its reviewer holds, a hold recorded without one, or a decision it cannot read', () => {
    expect(holdReasonOf({ lastDecision: DECISION, waiting: { ...held, reason: 'landing' } }, read({ holdReason: 'x' }))).toBeUndefined()
    expect(holdReasonOf({ lastDecision: DECISION, waiting: held }, read({ reason: 'operator-review' }))).toBeUndefined()
    expect(holdReasonOf({ lastDecision: DECISION, waiting: held }, read({ holdReason: 7 }))).toBeUndefined()
    expect(holdReasonOf({ lastDecision: `sha256:${'d'.repeat(64)}` as ArtifactRef, waiting: held }, read({ holdReason: 'x' }))).toBeUndefined()
    expect(holdReasonOf({ waiting: held }, read({ holdReason: 'x' }))).toBeUndefined()
  })
})
