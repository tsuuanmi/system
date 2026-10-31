// A writing run's test-worker budget (T348): named to its commands in the confinement's environment,
// where vitest's config reads it.
import { describe, expect, it } from 'vitest'
import { TEST_WORKERS_VARIABLE, type Confinement, confinedCommand, withTestWorkers } from '../src/index.ts'

const base: Confinement = { bwrap: '/usr/bin/bwrap', hide: [], writable: ['/work'], readOnly: [] }

describe('withTestWorkers: the budget of a run\'s own test runs (T348)', () => {
  it('is SYSTEM_TEST_MAX_WORKERS, which vitest\'s config reads', () => {
    expect(TEST_WORKERS_VARIABLE).toBe('SYSTEM_TEST_MAX_WORKERS')
  })

  it('names the count to the commands inside the confinement, beside the variables it has', () => {
    const confinement = withTestWorkers({ ...base, env: { KEPT: 'yes' } }, 6)
    expect(confinement.env).toEqual({ KEPT: 'yes', SYSTEM_TEST_MAX_WORKERS: '6' })
    const { args } = confinedCommand('true', [], confinement)
    const at = args.indexOf('SYSTEM_TEST_MAX_WORKERS')
    expect(args.slice(at - 1, at + 2)).toEqual(['--setenv', 'SYSTEM_TEST_MAX_WORKERS', '6'])
  })

  it('leaves a confinement alone when the run has no budget', () => {
    expect(withTestWorkers(base, undefined)).toBe(base)
  })

  it('refuses a budget that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => withTestWorkers(base, bad)).toThrow(/positive integer/)
  })
})
