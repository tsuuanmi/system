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
    const { probes, runtime, warned } = setup(2000)
    expect(await probes.described('gated')).toEqual(READY)
    runtime.hold = true
    await expect.poll(() => runtime.probes, { timeout: 5000, interval: 20 }).toBe(2)
    // Past the bound (2000 ms from when the first probe started), with the re-probe (started at
    // half of it) still running within its own.
    await sleep(1300)
    const expired = await atOnce(probes.described('gated'))
    expect(expired).toMatchObject({ available: false, readsConfined: false, gatesToolCalls: false, sandboxes: [] })
    expect((expired as RuntimeEvidence).detail).toMatch(/^the last probe of gated started \d+ s ago, past probeTtlMs \(2000 ms\), and the next has not finished$/)
    expect(probes.current('gated')).toBeUndefined()
    expect(warned).toEqual(['agent Workers: the last probe of gated is older than probeTtlMs (2000 ms) and the next has not finished; its Workers take no work until it does'])
    // No second probe joins the one in flight.
    expect(runtime.probes).toBe(2)
    // A run's own check waits for the probe instead, no longer than the probe's own bound: one
    // that takes as long as its result could stand is refused as timed out.
    const proven = probes.proven('gated')
    expect(await Promise.race([proven, sleep(100).then(() => 'waiting')])).toBe('waiting')
    runtime.hold = false
    expect(await proven).toMatchObject({ available: false, detail: 'probe timed out: the probe of gated did not finish within probeTtlMs (2000 ms)' })
    // Slower than half its bound, it is said once and probed again at once; once that probe
    // finishes, the runtime is back.
    expect(warned).toContain('agent Workers: a probe of gated took longer than half of probeTtlMs (2000 ms), so it is probed again at once; its Workers take no work while a result is past probeTtlMs: raise probeTtlMs, or see why the runtime is slow')
    await expect.poll(async () => (await atOnce(probes.described('gated'))), { timeout: 5000, interval: 20 }).toEqual(READY)
    expect(runtime.probes).toBe(3)
  }, 20_000)

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

  it('probes each named home on its own, reads its accounts again before a result stands, and forgets a home no Worker runs in', async () => {
    const probed: Array<string | undefined> = []
    const runtime: AgentRuntimeProvider = {
      kind: 'homes',
      probe: async (options) => {
        probed.push(options?.home)
        return { ...READY, homes: true, detail: options?.home ? `in ${options.home}` : 'its own home' }
      },
      run: async () => { throw new Error('the probe tests run nothing') },
    }
    const stopped = new AbortController()
    const reread: Array<[string, string | undefined, string | undefined]> = []
    let inUse = true
    const probes = new Probes({
      ttlMs: 600, provider: (kind) => (kind === 'homes' ? runtime : undefined), stopped: stopped.signal, track: () => undefined, warn: () => undefined,
      // What the read sees as standing when the accounts are read again: nothing of this probe yet.
      after: async (kind, home) => { reread.push([kind, home, probes.current(kind, home)?.detail]) },
      inUse: () => inUse,
    })
    try {
      expect(await probes.described('homes')).toMatchObject({ detail: 'its own home' })
      expect(await probes.described('homes', '/accounts/2')).toMatchObject({ detail: 'in /accounts/2' })
      // probeIn: the provider's own probe first (it must report homes), then the one in the home.
      expect(probed).toEqual([undefined, undefined, '/accounts/2'])
      expect(reread).toEqual([['homes', undefined, undefined], ['homes', '/accounts/2', undefined]])
      expect(probes.current('homes', '/accounts/2')).toMatchObject({ detail: 'in /accounts/2' })
      expect(probes.current('homes', '/accounts/3')).toBeUndefined()
      // Both are refreshed in the background, the home's accounts read again each time.
      await expect.poll(() => reread.filter(([, home]) => home === '/accounts/2').length, { timeout: 5000, interval: 20 }).toBeGreaterThanOrEqual(2)
      expect(reread.filter(([, home]) => home === undefined).length).toBeGreaterThanOrEqual(2)
      // No Worker runs in the home any more: its background probe stops, and what it proved is forgotten.
      inUse = false
      await expect.poll(() => probes.current('homes', '/accounts/2'), { timeout: 5000, interval: 20 }).toBeUndefined()
      const homeProbes = probed.filter((home) => home === '/accounts/2').length
      await sleep(700)
      expect(probed.filter((home) => home === '/accounts/2').length).toBe(homeProbes)
      // The runtime's own home is refreshed still; a later read of the home probes it first.
      expect(probes.current('homes')).toMatchObject({ detail: 'its own home' })
      expect(await probes.described('homes', '/accounts/2')).toMatchObject({ detail: 'in /accounts/2' })
      expect(probed.filter((home) => home === '/accounts/2').length).toBe(homeProbes + 1)
    } finally {
      stopped.abort()
      probes.close()
    }
  })

  it('bounds every probe by probeTtlMs: one that never settles is refused as timed out, and the next one starts', async () => {
    const { probes, runtime, tracked } = setup(600)
    runtime.hold = true
    // A first probe is waited for, but no longer than its bound.
    const first = await atOnce(probes.described('gated'))
    expect(first).toMatchObject({ available: false, readsConfined: false, gatesToolCalls: false, detail: 'probe timed out: the probe of gated did not finish within probeTtlMs (600 ms)' })
    // What a stop waits for settles within the bound too.
    expect(await atOnce(Promise.allSettled(tracked))).not.toBe('waited')
    // Its probe no longer counts as running: the next one starts, and its answer brings the runtime back.
    runtime.hold = false
    await expect.poll(async () => (await atOnce(probes.described('gated'))), { timeout: 5000, interval: 20 }).toEqual(READY)
    expect(runtime.probes).toBe(2)
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
