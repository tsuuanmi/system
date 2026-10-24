import { describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'patchright-core'
import { abortable, closePageWithin, closeWithin, newPage } from '../src/async.ts'

/** A promise and the function that settles it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

describe('abortable', () => {
  it('rejects at once on an abort while pending, and hands a late value to onLate exactly once', async () => {
    const work = deferred<string>()
    const controller = new AbortController()
    const late: string[] = []
    const waited = abortable(work.promise, controller.signal, (value) => late.push(value))
    controller.abort()
    await expect(waited).rejects.toThrow()
    work.resolve('page')
    await settled()
    expect(late).toEqual(['page'])
  })

  it('hands a late value to onLate once when the signal had already aborted', async () => {
    const work = deferred<string>()
    const controller = new AbortController()
    controller.abort()
    const late: string[] = []
    await expect(abortable(work.promise, controller.signal, (value) => late.push(value))).rejects.toThrow()
    work.resolve('page')
    await settled()
    expect(late).toEqual(['page'])
  })

  it('resolves with the value and calls no onLate without an abort; a late failure after an abort is swallowed', async () => {
    const late: string[] = []
    expect(await abortable(Promise.resolve('page'), new AbortController().signal, (value) => late.push(value))).toBe('page')
    const work = deferred<string>()
    const controller = new AbortController()
    const waited = abortable(work.promise, controller.signal, (value) => late.push(value))
    controller.abort()
    await expect(waited).rejects.toThrow()
    work.reject(new Error('closed'))
    await settled()
    expect(late).toEqual([])
  })
})

describe('closeWithin', () => {
  /** A context whose pages open when a test says, recording what happened in order. */
  function fakeContext() {
    const events: string[] = []
    const opens: Array<ReturnType<typeof deferred<Page>>> = []
    const context = {
      newPage: () => {
        const open = deferred<Page>()
        opens.push(open)
        events.push('newPage')
        return open.promise
      },
      close: async () => void events.push('close'),
    } as unknown as BrowserContext
    return { context, events, opens }
  }

  it('closes a context only once the page it is opening has attached, so the library never attaches to a closing session', async () => {
    const { context, events, opens } = fakeContext()
    const opening = newPage(context)
    const closed = closeWithin(context)
    await settled()
    expect(events).toEqual(['newPage'])
    opens[0]!.resolve({} as Page)
    await opening
    await closed
    expect(events).toEqual(['newPage', 'close'])
    // A page that failed to open holds nothing up either.
    const failing = newPage(context)
    opens[1]!.reject(new Error('target closed'))
    await expect(failing).rejects.toThrow('target closed')
    await closeWithin(context)
    expect(events).toEqual(['newPage', 'close', 'newPage', 'close'])
  })

  it('waits for a page that never opens only within its bound, then closes', async () => {
    const { context, events } = fakeContext()
    void newPage(context)
    const started = Date.now()
    await closeWithin(context, 5000, 50)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(events).toEqual(['newPage', 'close'])
  })
})

describe('closePageWithin', () => {
  it('warns when the browser does not confirm a page close within the bound, and says nothing when it does (T127 item 9, INV-9)', async () => {
    const warned: string[] = []
    const started = Date.now()
    // As Chrome does with a close that lands as the page's navigation commits: acknowledged, then dropped.
    expect(await closePageWithin({ close: () => new Promise<void>(() => undefined) } as unknown as Page, (m) => warned.push(m), 50)).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(warned).toEqual(['the browser did not confirm a page\'s close within 0.05 s; the page no longer counts as open, and its tab closes with its context'])
    expect(await closePageWithin({ close: async () => undefined } as unknown as Page, (m) => warned.push(m), 50)).toBe(true)
    // A close that fails is settled, not a bound hit: the page is gone or going.
    expect(await closePageWithin({ close: async () => { throw new Error('target closed') } } as unknown as Page, (m) => warned.push(m), 50)).toBe(true)
    expect(warned).toHaveLength(1)
  })
})
