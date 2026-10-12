import { describe, expect, it } from 'vitest'
import { ProviderError, dispositionOf } from '../src/index.ts'

describe('failure taxonomy (docs/design/workflow-engine.md#recovery)', () => {
  it('maps each failure kind to one retry disposition (REQ-WF-6)', () => {
    expect(dispositionOf('network')).toBe('BACKOFF')
    expect(dispositionOf('timeout')).toBe('BACKOFF')
    expect(dispositionOf('provider_stalled')).toBe('RECREATE_SESSION')
    expect(dispositionOf('session_broken')).toBe('RECREATE_SESSION')
    expect(dispositionOf('reauth_required')).toBe('USER_ACTION')
    expect(dispositionOf('challenge')).toBe('USER_ACTION')
    expect(dispositionOf('quota_exhausted')).toBe('USER_ACTION')
    expect(dispositionOf('reconciliation_failed')).toBe('USER_ACTION')
    expect(dispositionOf('ui_drift')).toBe('CONFIG_FIX') // ADR-0021: fix the UI map, not the code
    expect(dispositionOf('config_error')).toBe('CODE_FIX')
    expect(dispositionOf('aborted')).toBe('NONE')
    expect(dispositionOf('invalid_input')).toBe('NONE')
  })

  it('carries kind and disposition on the error', () => {
    const error = new ProviderError('challenge', 'Cloudflare challenge during turn')
    expect(error).toMatchObject({ name: 'ProviderError', kind: 'challenge', disposition: 'USER_ACTION' })
  })
})

describe('toProviderError: classifying failures the runtime did not type', () => {
  it('keeps typed failures, treats programming and contract errors as internal (no retry), and the rest as a broken session', async () => {
    const { toProviderError } = await import('../src/index.ts')
    const typed = new ProviderError('challenge', 'cf')
    expect(toProviderError(typed)).toBe(typed)
    for (const error of [new TypeError('x'), new RangeError('y'), Object.assign(new Error('schema'), { name: 'SchemaError' }), Object.assign(new Error('rev'), { name: 'RevisionConflict' })]) {
      expect(toProviderError(error)).toMatchObject({ kind: 'internal', disposition: 'CODE_FIX' })
    }
    expect(toProviderError(new Error('Target page, context or browser has been closed'))).toMatchObject({ kind: 'session_broken', disposition: 'RECREATE_SESSION' })
    expect(toProviderError('a string')).toMatchObject({ kind: 'session_broken' })
  })
})
