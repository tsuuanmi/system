/**
 * How long the browser-stack and real-Xvfb tests wait on a loaded host (T348): every package's
 * waits for Xvfb and Chrome read the one factor here (docs/engineering/testing.md, "A loaded host").
 */

/**
 * How many times longer than on an idle host a test waits for the browser stack: `SYSTEM_TEST_TIME_FACTOR`,
 * a number from 1 to 20, else 1. Never below 1: it only gives a loaded host more time to start Xvfb and Chrome.
 */
export function timeFactor(env: Record<string, string | undefined> = process.env): number {
  const given = Number(env.SYSTEM_TEST_TIME_FACTOR)
  return env.SYSTEM_TEST_TIME_FACTOR && Number.isFinite(given) && given >= 1 && given <= 20 ? given : 1
}

/**
 * A wait for the browser stack (a test's timeout, a start-up bound, a `vi.waitFor` timeout) scaled by {@link timeFactor}.
 * Never an assertion: a bound the test asserts on (`expect(elapsed).toBeLessThan(…)`) is the product's, and stays as it is.
 */
export const scaled = (ms: number, factor: number = timeFactor()): number => Math.round(ms * factor)
