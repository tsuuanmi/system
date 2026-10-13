import { describe, expect, it } from 'vitest'
import { registerSecretPath, secretPaths } from '../src/index.ts'

describe('registered secret paths (ADR-0024)', () => {
  it('lists a path while any owner holds it, resolved, and drops it when the last lets go', () => {
    const first = registerSecretPath('/keys/../keys/vault.key')
    const second = registerSecretPath('/keys/vault.key')
    expect(secretPaths()).toContain('/keys/vault.key')
    first()
    first()
    expect(secretPaths()).toContain('/keys/vault.key')
    second()
    expect(secretPaths()).not.toContain('/keys/vault.key')
  })
})
