import { setTimeout as sleep } from 'node:timers/promises'
import type { AgentRuntimeProvider, RuntimeEvidence } from '@tsuuanmi/system-agent-runtime-core'
import { afterEach, describe, expect, it } from 'vitest'
import { Probes } from '../src/probes.ts'

const READY: RuntimeEvidence = { available: true, detail: 'gated 1.0', sandboxes: ['read-only'], resume: true, executes: false, readsConfined: true, gatesToolCalls: true }

/** A runtime whose probes answer at once, or wait until the test settles them (a slow probe). */
class GatedRuntime implements AgentRuntimeProvider {
  readonly kind = 'gated'
  probes = 0
  hold = false
  answer: RuntimeEvidence | Error = READY
  readonly held: Array<(answer: RuntimeEvidence | Error) => void> = []

  probe(): Promise<RuntimeEvidence> {
    this.probes++
    const settle = (answer: RuntimeEvidence | Error): Promise<RuntimeEvidence> => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer))
    if (!this.hold) return settle(this.answer)
    return new Promise((resolve) => this.held.push((answer) => resolve(settle(answer))))
  }

  /** Settle every held probe with `answer`. */
  release(answer: RuntimeEvidence | Error = READY): void {
    for (const settle of this.held.splice(0)) settle(answer)
  }

  async run(): Promise<never> {
    throw new Error('the probe tests run nothing')
  }
}

const open: Array<{ probes: Probes; runtime: GatedRuntime; stopped: AbortController }> = []
afterEach(async () => {
  for (const { probes, runtime, stopped } of open.splice(0)) {
    stopped.abort()
    probes.close()
    runtime.release()
  }
})

function setup(ttlMs: number) {
  const runtime = new GatedRuntime()
  const stopped = new AbortController()
  const tracked: Array<Promise<unknown>> = []
  const warned: string[] = []
  let registered = true
  const probes = new Probes({
    ttlMs, provider: (kind) => (registered && kind === 'gated' ? runtime : undefined), stopped: stopped.signal,
    track: (probe) => tracked.push(probe), warn: (message) => warned.push(message),
  })
  open.push({ probes, runtime, stopped })
  return { probes, runtime, stopped, tracked, warned, unregister: () => { registered = false } }
}

/** What `read` answers within 2 s, or `waited`: a held probe settles only when the test says so. */
const atOnce = <T>(read: Promise<T>): Promise<T | 'waited'> => Promise.race([read, sleep(2000).then(() => 'waited' as const)])

describe('agent runtime probes: refreshed in the background, never waited for by a describe', () => {
  it('answers a describe from the latest result while a slow re-probe runs, started before the result expires', async () => {
    const { probes, runtime } = setup(1500)
    // The first probe of a runtime is waited for: there is nothing else to answer with.
    expect(await probes.described('gated')).toEqual(READY)
    expect(runtime.probes).toBe(1)
    runtime.hold = true
    // At half its bound, the next probe starts in the background, with nothing reading.
    await expect.poll(() => runtime.probes, { timeout: 5000, interval: 20 }).toBe(2)
    // It is slow; a describe still answers at once, from the result that still stands.
    expect(await atOnce(probes.described('gated'))).toEqual(READY)
    expect(await atOnce(probes.described('gated'))).toEqual(READY)
    expect(runtime.probes).toBe(2)
    runtime.release({ ...READY, detail: 'gated 1.1' })
    await expect.poll(async () => (await probes.described('gated')).detail).toBe('gated 1.1')
  })

  it('never answers from a result past its bound: a describe gets evidence that admits nothing, at once, until the re-probe finishes', async () => {
    const { probes, runtime, warned } = setup(800)
    expect(await probes.described('gated')).toEqual(READY)
    runtime.hold = true
    await expect.poll(() => runtime.probes, { timeout: 5000, interval: 20 }).toBe(2)
    // Past the bound (800 ms from when the first probe started), with the re-probe still running.
    await sleep(900)
    const expired = await atOnce(probes.described('gated'))
    expect(expired).toMatchObject({ available: false, readsConfined: false, gatesToolCalls: false, sandboxes: [] })
    expect((expired as RuntimeEvidence).detail).toMatch(/^the last probe of gated started \d+ s ago, past probeTtlMs \(800 ms\), and the next has not finished$/)
    expect(probes.current('gated')).toBeUndefined()
    expect(warned).toEqual(['agent Workers: the last probe of gated is older than probeTtlMs (800 ms) and the next has not finished; its Workers take no work until it does'])
    // No second probe joins the one in flight.
    expect(runtime.probes).toBe(2)
    // A run's own check waits for the probe instead.
    const proven = probes.proven('gated')
    expect(await Promise.race([proven, sleep(100).then(() => 'waiting')])).toBe('waiting')
    runtime.hold = false
    runtime.release()
    expect(await proven).toEqual(READY)
    // That result is already past its bound, counted from when its probe started: a describe
    // starts the next probe and answers at once; once it finishes, the runtime is back.
    expect(await atOnce(probes.described('gated'))).toMatchObject({ available: false })
    await expect.poll(async () => (await atOnce(probes.described('gated'))), { timeout: 5000, interval: 20 }).toEqual(READY)
    expect(runtime.probes).toBe(3)
    // A probe slower than half its bound is said once.
    expect(warned).toContain('agent Workers: a probe of gated took longer than half of probeTtlMs (800 ms), so it is probed again at once; its Workers take no work while a result is past probeTtlMs: raise probeTtlMs, or see why the runtime is slow')
  })

  it('admits nothing once a refresh fails, at once, though the older success would still stand', async () => {
    const { probes, runtime } = setup(1600)
    const first = Date.now()
    expect(await probes.described('gated')).toEqual(READY)
    runtime.answer = { ...READY, readsConfined: false, detail: 'gated 1.0; reads cannot be confined' }
    // The background refresh at half the bound proves less: it replaces the success at once.
    await expect.poll(async () => (await probes.described('gated')).readsConfined, { timeout: 5000, interval: 20 }).toBe(false)
    expect(Date.now() - first).toBeLessThan(1600)
    expect(probes.current('gated')).toMatchObject({ readsConfined: false })
    expect(await probes.proven('gated')).toMatchObject({ readsConfined: false })
    // A refresh that throws admits nothing either, with its message.
    runtime.answer = new Error('claude --version failed: spawn EACCES')
    await expect.poll(async () => (await probes.described('gated')).detail, { timeout: 5000, interval: 20 }).toBe('claude --version failed: spawn EACCES')
    expect(await probes.described('gated')).toMatchObject({ available: false, readsConfined: false, gatesToolCalls: false })
    // And a later probe that proves it again brings the runtime back.
    runtime.answer = READY
    await expect.poll(async () => (await probes.described('gated')).available, { timeout: 5000, interval: 20 }).toBe(true)
  }, 20_000)

  it('runs one probe at a time per runtime: concurrent reads share it', async () => {
    const { probes, runtime, tracked } = setup(60_000)
    runtime.hold = true
    const reads = [probes.described('gated'), probes.described('gated'), probes.proven('gated')]
    await sleep(20)
    expect(runtime.probes).toBe(1)
    expect(tracked).toHaveLength(1)
    runtime.release()
    expect(await Promise.all(reads)).toEqual([READY, READY, READY])
    // Within its bound, no read probes again.
    await probes.described('gated')
    await probes.proven('gated')
    expect(runtime.probes).toBe(1)
  })

  it('starts no probe once stopped, and none for a runtime that is not registered', async () => {
    const { probes, runtime, stopped, unregister } = setup(400)
    expect(await probes.described('gated')).toEqual(READY)
    stopped.abort()
    probes.close()
    await sleep(500)
    expect(runtime.probes).toBe(1)
    expect(await probes.described('other')).toMatchObject({ available: false, detail: 'no other runtime is registered' })
    unregister()
    expect(await probes.proven('gated')).toMatchObject({ available: false, detail: 'no gated runtime is registered' })
    expect(runtime.probes).toBe(1)
  })

  it('keeps no result with probeTtlMs 0: every read waits for a probe, and nothing probes in the background', async () => {
    const { probes, runtime } = setup(0)
    expect(await probes.described('gated')).toEqual(READY)
    expect(await probes.proven('gated')).toEqual(READY)
    expect(runtime.probes).toBe(2)
    await sleep(100)
    expect(runtime.probes).toBe(2)
  })
})
