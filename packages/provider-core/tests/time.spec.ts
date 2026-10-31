// The browser-stack and real-Xvfb tests' waits scale with the host's load (T348).
import type { Context } from '@deepseek-ai/cordis'
import type { RunnerTask } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { displayConformance } from '../conformance/display.ts'
import { scaled, timeFactor } from '../conformance/time.ts'

afterEach(() => vi.unstubAllEnvs())

/** Every test of `task`, at any depth. */
const testsOf = (task: RunnerTask): RunnerTask[] => ('tasks' in task ? task.tasks.flatMap(testsOf) : [task])

// The display conformance suite as a real-Xvfb spec registers it, under a factor of 3, and never run:
// its scenarios' registered bounds are what a loaded host gets.
describe.skip('display conformance, registered under SYSTEM_TEST_TIME_FACTOR=3', () => {
  const before = process.env.SYSTEM_TEST_TIME_FACTOR
  process.env.SYSTEM_TEST_TIME_FACTOR = '3'
  try {
    displayConformance('factor probe', async () => ({ ctx: undefined as unknown as Context, dispose: async () => undefined }))
  } finally {
    if (before === undefined) delete process.env.SYSTEM_TEST_TIME_FACTOR
    else process.env.SYSTEM_TEST_TIME_FACTOR = before
  }
})

describe('a spec\'s bound scales with the factor (T348)', () => {
  it('registers each display conformance scenario with 15 s times the factor', ({ task }) => {
    const probes = testsOf(task.file).filter((t) => t.suite?.name === 'ctx.display conformance: factor probe')
    expect(probes.length).toBeGreaterThan(0)
    for (const probe of probes) expect((probe as RunnerTask & { timeout: number }).timeout).toBe(45_000)
  })
})

describe('a wait for the browser stack scales with SYSTEM_TEST_TIME_FACTOR (T348)', () => {
  it('multiplies a wait by the factor, 1 when it is not given', () => {
    expect(timeFactor({})).toBe(1)
    expect(timeFactor({ SYSTEM_TEST_TIME_FACTOR: '3' })).toBe(3)
    expect(timeFactor({ SYSTEM_TEST_TIME_FACTOR: '2.5' })).toBe(2.5)
    expect(scaled(60_000, 3)).toBe(180_000)
    expect(scaled(60_000, 1)).toBe(60_000)
  })

  it('never shortens a wait, and ignores a value that is not a number from 1 to 20', () => {
    for (const bad of ['0', '0.5', '-3', 'fast', '', '21', 'Infinity']) expect(timeFactor({ SYSTEM_TEST_TIME_FACTOR: bad })).toBe(1)
  })

  it('reads the process environment by default', () => {
    vi.stubEnv('SYSTEM_TEST_TIME_FACTOR', '4')
    expect(scaled(15_000)).toBe(60_000)
  })
})
