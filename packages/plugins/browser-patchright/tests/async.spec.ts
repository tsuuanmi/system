import { describe, expect, it } from 'vitest'
import { abortable } from '../src/async.ts'

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
