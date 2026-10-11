import { describe, expect, it } from 'vitest'
import { ProviderError, dispositionOf } from '../src/index.ts'

describe('failure taxonomy (docs/design/workflow-engine.md#recovery)', () => {
  it('maps each failure kind to one retry disposition', () => {
    expect(dispositionOf('network')).toBe('BACKOFF')
    expect(dispositionOf('timeout')).toBe('BACKOFF')
    expect(dispositionOf('provider_stalled')).toBe('RECREATE_SESSION')
    expect(dispositionOf('session_broken')).toBe('RECREATE_SESSION')
    expect(dispositionOf('reauth_required')).toBe('USER_ACTION')
    expect(dispositionOf('challenge')).toBe('USER_ACTION')
    expect(dispositionOf('quota_exhausted')).toBe('USER_ACTION')
    expect(dispositionOf('reconciliation_failed')).toBe('USER_ACTION')
    expect(dispositionOf('ui_drift')).toBe('CODE_FIX')
    expect(dispositionOf('config_error')).toBe('CODE_FIX')
    expect(dispositionOf('aborted')).toBe('NONE')
    expect(dispositionOf('invalid_input')).toBe('NONE')
  })

  it('carries kind and disposition on the error', () => {
    const error = new ProviderError('challenge', 'Cloudflare challenge during turn')
    expect(error).toMatchObject({ name: 'ProviderError', kind: 'challenge', disposition: 'USER_ACTION' })
  })
})
