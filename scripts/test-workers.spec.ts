// The test-worker budget of a run (T348): the one count vitest's pool takes from the environment.
import { availableParallelism } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testWorkers } from './test-workers.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('testWorkers: the pool size the environment allows (T348)', () => {
  const cores = 256

  it('is the default (the host\'s cores less one, at most 32) when no budget is given', () => {
    expect(testWorkers({}, cores)).toBe(32)
    expect(testWorkers({}, 4)).toBe(3)
    expect(testWorkers({}, 1)).toBe(1)
  })

  it('takes a step\'s budget (SYSTEM_TEST_MAX_WORKERS) and a check\'s (SYSTEM_CHECK_MAX_WORKERS), the smaller of both', () => {
    expect(testWorkers({ SYSTEM_TEST_MAX_WORKERS: '6' }, cores)).toBe(6)
    expect(testWorkers({ SYSTEM_CHECK_MAX_WORKERS: '9' }, cores)).toBe(9)
    expect(testWorkers({ SYSTEM_TEST_MAX_WORKERS: '6', SYSTEM_CHECK_MAX_WORKERS: '9' }, cores)).toBe(6)
  })

  it('does not take a budget that is not a positive integer', () => {
    for (const bad of ['0', '-2', '2.5', 'many', '']) expect(testWorkers({ SYSTEM_TEST_MAX_WORKERS: bad }, cores)).toBe(32)
  })
})

describe('the vitest config\'s pool size', () => {
  it('is the budget the run\'s environment gives (SYSTEM_TEST_MAX_WORKERS)', async () => {
    vi.stubEnv('SYSTEM_CHECK_MAX_WORKERS', '')
    vi.stubEnv('SYSTEM_TEST_MAX_WORKERS', '3')
    const config = (await import('../vitest.config.ts')).default
    expect(config.test?.maxWorkers).toBe(3)
  })

  it('is the host\'s share when none is given', async () => {
    vi.stubEnv('SYSTEM_CHECK_MAX_WORKERS', '')
    vi.stubEnv('SYSTEM_TEST_MAX_WORKERS', '')
    const config = (await import('../vitest.config.ts')).default
    expect(config.test?.maxWorkers).toBe(Math.max(1, Math.min(32, availableParallelism() - 1)))
  })
})

describe('the vitest config\'s hook bound, which every browser and Xvfb setup hook runs under (T348)', () => {
  it('is 60 s times SYSTEM_TEST_TIME_FACTOR, so a scaled Xvfb or Chrome start-up in beforeAll is never cut short by it', async () => {
    vi.stubEnv('SYSTEM_TEST_TIME_FACTOR', '10')
    const config = (await import('../vitest.config.ts')).default
    expect(config.test?.hookTimeout).toBe(600_000)
  })

  it('is 60 s when no factor is given', async () => {
    vi.stubEnv('SYSTEM_TEST_TIME_FACTOR', '')
    const config = (await import('../vitest.config.ts')).default
    expect(config.test?.hookTimeout).toBe(60_000)
  })
})
