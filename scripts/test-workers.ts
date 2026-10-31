import { availableParallelism } from 'node:os'

/** A positive integer the environment names, else undefined. */
function budget(value: string | undefined): number | undefined {
  const given = Number(value)
  return value !== undefined && value !== '' && Number.isInteger(given) && given >= 1 ? given : undefined
}

/**
 * The test files vitest runs at once (T348): at most 32 (on a 256-CPU host vitest's own default of one
 * per CPU but one starved tests of 1 to 2 s past their 5 s bound), the host's cores less one on a
 * smaller one; and no more than the budget the environment gives: a writing step's own test runs
 * (`SYSTEM_TEST_MAX_WORKERS`, agent-workers) or an acceptance check's (`SYSTEM_CHECK_MAX_WORKERS`),
 * the smaller of both when both are.
 */
export function testWorkers(env: Record<string, string | undefined> = process.env, cores = availableParallelism()): number {
  const given = [budget(env.SYSTEM_TEST_MAX_WORKERS), budget(env.SYSTEM_CHECK_MAX_WORKERS)].filter((n): n is number => n !== undefined)
  return given.length ? Math.min(...given) : Math.max(1, Math.min(32, cores - 1))
}
