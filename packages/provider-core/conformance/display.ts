/** Conformance suite for `ctx.display` (plugin rule 7): every provider, including fakes, passes it. */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type {} from '../src/display.ts'
import { scaled } from './time.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

/**
 * `timeout` bounds each scenario, boot and dispose included: 15 s by default, as the other real-Xvfb
 * tests allow, scaled by `SYSTEM_TEST_TIME_FACTOR` on a loaded host (T348). It must exceed the
 * provider's own startup bound (display-virtual's `startupTimeoutMs`), so that on a loaded host a slow
 * X server fails by the provider's own timeout, if at all, never by the test's.
 */
export function displayConformance(name: string, boot: Boot, timeout = scaled(15_000)): void {
  describe(`ctx.display conformance: ${name}`, () => {
    it('prepares an invisible headed display: never visible, never headless', async () => {
      const { ctx, dispose } = await boot()
      try {
        const display = await ctx.display.prepare('invisible')
        expect(display.kind).not.toBe('visible')
        expect(display.env.DISPLAY).toBeTruthy()
        expect(display.windowArgs.length).toBeGreaterThan(0)
        expect(display.lost.aborted).toBe(false)
        expect(display.generation).toBeGreaterThan(0)
      } finally {
        await dispose()
      }
    }, timeout)

    it('shares one display between callers until it is lost', async () => {
      const { ctx, dispose } = await boot()
      try {
        const [a, b] = await Promise.all([ctx.display.prepare('invisible'), ctx.display.prepare('invisible')])
        expect(a.generation).toBe(b.generation)
        expect(a.env.DISPLAY).toBe(b.env.DISPLAY)
      } finally {
        await dispose()
      }
    }, timeout)

    it('signals loss to its holders when the provider is disposed', async () => {
      const { ctx, dispose } = await boot()
      const display = await ctx.display.prepare('invisible')
      await dispose()
      expect(display.lost.aborted).toBe(true)
    }, timeout)
  })
}
