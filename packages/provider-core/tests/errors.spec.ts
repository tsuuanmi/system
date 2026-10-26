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
    expect(dispositionOf('worker_changed')).toBe('IMMEDIATE') // ADR-0073: routed again at once
  })

  it('carries kind and disposition on the error', () => {
    const error = new ProviderError('challenge', 'Cloudflare challenge during turn')
    expect(error).toMatchObject({ name: 'ProviderError', kind: 'challenge', disposition: 'USER_ACTION' })
    expect('siteError' in error).toBe(false)
  })

  it('marks a site\'s own error after the send only when its driver says so, as an optional field set only when true (ADR-0062, ADR-0036)', () => {
    expect(new ProviderError('overloaded', 'the site answered with its own error', { siteError: true })).toMatchObject({ kind: 'overloaded', disposition: 'BACKOFF', siteError: true })
    for (const options of [undefined, {}, { siteError: false }]) {
      const error = new ProviderError('overloaded', 'busy', options)
      expect(error.siteError).toBeUndefined()
      expect(Object.hasOwn(error, 'siteError')).toBe(false)
    }
    // A structural stand-in typed as a ProviderError need not name it.
    const fake: Pick<ProviderError, 'kind' | 'disposition' | 'feature' | 'siteError'> = { kind: 'network', disposition: 'BACKOFF', feature: undefined }
    expect(fake.siteError).toBeUndefined()
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
