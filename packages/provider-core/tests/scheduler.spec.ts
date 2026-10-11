// Ported from tsuuanmi/internet test/provider-scheduler.test.ts, plus close/generation cases.
import { describe, expect, it, vi } from 'vitest'
import { ProviderScheduler } from '../src/index.ts'

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => (release = resolve))
  return { promise, release }
}

describe('ProviderScheduler', () => {
  it('runs different sessions up to capacity while preserving same-session order', async () => {
    const scheduler = new ProviderScheduler(2)
    const first = gate()
    const second = gate()
    const order: string[] = []
    const a1 = scheduler.runTurn('a', undefined, async () => {
      order.push('a1-start')
      await first.promise
      order.push('a1-end')
    })
    const a2 = scheduler.runTurn('a', undefined, async () => void order.push('a2-start'))
    const b1 = scheduler.runTurn('b', undefined, async () => {
      order.push('b1-start')
      await second.promise
      order.push('b1-end')
    })
    await vi.waitFor(() => expect(order).toEqual(['a1-start', 'b1-start']))
    first.release()
    await a1
    await vi.waitFor(() => expect(order).toContain('a2-start'))
    second.release()
    await Promise.all([a2, b1])
    expect(order.indexOf('a2-start')).toBeGreaterThan(order.indexOf('a1-end'))
  })

  it('treats a queued exclusive job as a FIFO fence', async () => {
    const scheduler = new ProviderScheduler(2)
    const first = gate()
    const order: string[] = []
    const turn = scheduler.runTurn('a', undefined, async () => {
      order.push('turn')
      await first.promise
    })
    const exclusive = scheduler.runExclusive(async () => void order.push('exclusive'))
    const later = scheduler.runTurn('b', undefined, async () => void order.push('later'))
    await vi.waitFor(() => expect(order).toEqual(['turn']))
    first.release()
    await Promise.all([turn, exclusive, later])
    expect(order).toEqual(['turn', 'exclusive', 'later'])
  })

  it('rejects queued aborted work and aborts active leases on invalidation', async () => {
    const scheduler = new ProviderScheduler(1)
    let leaseCurrent = true
    let aborted = false
    const active = scheduler.runTurn('a', undefined, async (lease) => {
      await new Promise<void>((resolve) => {
        lease.signal.addEventListener('abort', () => {
          aborted = true
          leaseCurrent = scheduler.isCurrent(lease)
          resolve()
        }, { once: true })
      })
    })
    const controller = new AbortController()
    const queued = scheduler.runTurn('b', controller.signal, async () => {})
    controller.abort(new Error('cancelled'))
    await expect(queued).rejects.toThrow('cancelled')
    scheduler.invalidate(new Error('reauth'))
    await active
    expect(aborted).toBe(true)
    expect(leaseCurrent).toBe(false)
    expect(scheduler.currentGeneration()).toBe(1)
  })

  it('rejects new work after close and validates its inputs', async () => {
    const scheduler = new ProviderScheduler(1)
    scheduler.close(new Error('closed'))
    await expect(scheduler.runTurn('a', undefined, async () => 1)).rejects.toThrow('closed')
    await expect(new ProviderScheduler(1).runTurn('  ', undefined, async () => 1)).rejects.toThrow(/session/)
    expect(() => new ProviderScheduler(0)).toThrow(/capacity/)
  })

  it('reports idleness once all work drains', async () => {
    const scheduler = new ProviderScheduler(1)
    const g = gate()
    void scheduler.runTurn('a', undefined, () => g.promise)
    expect(scheduler.isIdle).toBe(false)
    const idle = scheduler.waitForIdle()
    g.release()
    await idle
    expect(scheduler.isIdle).toBe(true)
  })
})
