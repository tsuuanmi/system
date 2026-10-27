/**
 * The removability matrix's own checks, cheap enough for every change: every bundle row is classified in
 * docs/architecture/plugin-model.md#required-and-optional-rows exactly once, and the harness boots the
 * bundle as shipped, with the digest row off (the example row of the matrix), and with the profile row off
 * (the template is then absent). The whole matrix is `pnpm test:removability`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Booted, bootBundle, bundleRows, classes, smoke, StepFailure } from './matrix.ts'

vi.setConfig({ testTimeout: 180_000 })

const booted: Booted[] = []
afterEach(async () => {
  while (booted.length) await booted.pop()!.dispose()
})

describe('removability matrix harness', () => {
  it('classifies every row of the bundle as required or optional, once', () => {
    const { required, optional } = classes()
    const ids = bundleRows().map((r) => r.id)
    expect([...required, ...optional].sort()).toEqual([...ids].sort())
  })

  it('smokes the bundle as shipped, with the digest row off, and with the profile row off, and names the row and the step of a failure', async () => {
    const on = ['profile-software-development']
    const base = await bootBundle(undefined, on)
    booted.push(base)
    const { tools } = await smoke(base, undefined)
    const system = await bootBundle('digest', on)
    booted.push(system)
    const without = await smoke(system, 'digest', tools)
    expect(without.tools).not.toContain('digests_request')
    // The profile row off: algorithm-development is absent, and the run fails with that reason.
    const profile = await bootBundle('profile-software-development', on)
    booted.push(profile)
    await smoke(profile, 'profile-software-development', tools)
    // A booted bundle with a row that failed to start is reported by the row and the step.
    system.failed.set('digest', 'boom')
    await expect(smoke(system, 'digest', tools)).rejects.toThrow(new StepFailure('digest', 'start', 'rows that failed to start: digest (boom)').message)
  })
})
