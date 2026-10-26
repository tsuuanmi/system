// The host-wide queue of acceptance checks and the reading of a test run that failed only on timeouts (T292).
import { describe, expect, it } from 'vitest'
import { CheckQueue, checkWorkers } from '../src/check-queue.ts'
import { timedOutTests, TimeoutReader } from '../src/failures.ts'

describe('the host\'s check queue (T292)', () => {
  it('holds at most its limit, and grants the places in the order asked', async () => {
    const queue = new CheckQueue()
    const order: number[] = []
    const first = await queue.acquire(2)
    const second = await queue.acquire(2)
    const waits: number[] = []
    const third = queue.acquire(2, undefined, (ahead) => waits.push(ahead)).then((place) => { order.push(3); return place })
    const fourth = queue.acquire(2, undefined, (ahead) => waits.push(ahead)).then((place) => { order.push(4); return place })
    expect(queue.running).toBe(2)
    expect(queue.queued).toBe(2)
    expect(waits).toEqual([0, 1])
    first.release()
    const granted = await third
    expect(order).toEqual([3])
    second.release()
    await fourth
    expect(order).toEqual([3, 4])
    granted.release()
  })

  it('runs a check that asks to be alone with nothing else, and holds back those asked after it', async () => {
    const queue = new CheckQueue()
    const running = await queue.acquire(2)
    const order: string[] = []
    const alone = queue.acquire(2, undefined, undefined, true).then((place) => { order.push('alone'); return place })
    const later = queue.acquire(2).then((place) => { order.push('later'); return place })
    await Promise.resolve()
    expect(order).toEqual([])
    running.release()
    const place = await alone
    expect(queue.running).toBe(2)
    expect(order).toEqual(['alone'])
    place.release()
    await later
    expect(order).toEqual(['alone', 'later'])
  })

  it('drops a waiter whose signal aborts, and lets those after it on', async () => {
    const queue = new CheckQueue()
    const held = await queue.acquire(1)
    const controller = new AbortController()
    const aborted = queue.acquire(1, controller.signal)
    const next = queue.acquire(1)
    controller.abort(new Error('stopped'))
    await expect(aborted).rejects.toThrow('stopped')
    held.release()
    await expect(next).resolves.toBeDefined()
  })

  it('shares the host\'s cores less one among the checks that run at once, at least 1 and at most 32 each; a configured count wins', () => {
    expect(checkWorkers(2, undefined, 9)).toBe(4)
    expect(checkWorkers(3, undefined, 2)).toBe(1)
    expect(checkWorkers(1, undefined, 256)).toBe(32)
    expect(checkWorkers(2, 3, 64)).toBe(3)
  })
})

describe('a test run that failed only on timeouts (T292)', () => {
  const timeout = (name: string): string => ` FAIL  a.spec.ts > ${name}\nError: Test timed out in 5000ms.\n ❯ a.spec.ts:3:1\n`
  it('counts the failures when every one timed out and the summary counts them', () => {
    expect(timedOutTests(`${timeout('one')}\n⎯⎯⎯⎯⎯⎯⎯ [1/2] ⎯⎯⎯⎯⎯⎯⎯\n${timeout('two')}\n Tests  2 failed | 8 passed (10)\n`)).toBe(2)
  })
  it('is undefined when one failure is an assertion, a file failed, an error was unhandled, or nothing failed', () => {
    expect(timedOutTests(`${timeout('one')}\n FAIL  b.spec.ts > two\nAssertionError: expected 1 to be 2\n Tests  2 failed (10)\n`)).toBeUndefined()
    expect(timedOutTests(`${timeout('one')}\n FAIL  b.spec.ts [ b.spec.ts ]\nError: Cannot find module 'x'\n Tests  1 failed (10)\n`)).toBeUndefined()
    expect(timedOutTests(`${timeout('one')}\n⎯⎯ Unhandled Errors ⎯⎯\n Tests  1 failed (10)\n`)).toBeUndefined()
    expect(timedOutTests('lint: unused.js\n')).toBeUndefined()
  })
  it('is undefined when the summary counts more failures than it read, or prints none: a failure it did not read whole is never a timeout', () => {
    expect(timedOutTests(`${timeout('one')}\n Tests  2 failed | 8 passed (10)\n`)).toBeUndefined()
    expect(timedOutTests(`${timeout('one')}\n`)).toBeUndefined()
  })

  describe('in the format of vitest 4\'s report (printErrorsSummary)', () => {
    const red = (text: string): string => `\u001b[41m\u001b[1m${text}\u001b[22m\u001b[49m`
    const banner = (title: string): string => `\u001b[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\u001b[39m${red(` ${title} `)}\u001b[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\u001b[39m`
    const heading = (name: string): string => `${red(' FAIL ')} packages/x/tests/a.spec.ts > ${name}`
    const divider = (i: number, n: number): string => `\u001b[31m\u001b[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[${i}/${n}]⎯\u001b[22m\u001b[39m`
    const timeoutError = [
      '\u001b[31mError\u001b[39m: Test timed out in 5000ms.',
      'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
      ' ❯ packages/x/tests/a.spec.ts:12:3',
      '     10| ',
      "     11| describe('suite', () => {",
      "     12|   it.each([1, 2])('case %i', async () => { await expect(load()).rejects.toThrow('TypeError: no') })",
      '       |   ^',
      '',
    ].join('\n')
    const summary = (failed: number): string => [
      '',
      ' Test Files  1 failed | 9 passed (10)',
      `      Tests  ${failed ? `${failed} failed | ` : ''}90 passed (${90 + failed})`,
      '',
    ].join('\n')

    it('counts every test of a group whose one shared error is a timeout (identical errors are merged under their headings)', () => {
      const output = [banner('Failed Tests 3'), '', heading('case 1'), heading('case 2'), timeoutError, divider(1, 3), '', heading('other'), timeoutError, divider(2, 3), summary(3)].join('\n')
      expect(timedOutTests(output)).toBe(3)
    })

    it('counts a suite whose hook timed out, in the Failed Suites section, apart from the summary\'s failed tests', () => {
      const hook = timeoutError.replace('Test timed out', 'Hook timed out')
      expect(timedOutTests([banner('Failed Suites 1'), '', heading('suite'), hook, divider(1, 2), '', banner('Failed Tests 1'), '', heading('case 1'), timeoutError, divider(2, 2), summary(1)].join('\n'))).toBe(2)
      // The suite alone, its tests not run: the summary names no failed test.
      expect(timedOutTests([banner('Failed Suites 1'), '', heading('suite'), hook, divider(1, 1), summary(0)].join('\n'))).toBe(1)
    })

    it('never takes an assertion whose message or diff holds the timeout words for a timeout: only the error header itself counts', () => {
      const assertion = [
        "\u001b[31mAssertionError\u001b[39m: expected 'Test timed out in 5000ms' to be 'cancelled'",
        '',
        '\u001b[32m- Expected\u001b[39m',
        '\u001b[31m+ Received\u001b[39m',
        '',
        '\u001b[32m- cancelled\u001b[39m',
        '\u001b[31m+ Test timed out in 5000ms\u001b[39m',
        '',
        ' ❯ packages/x/tests/a.spec.ts:20:5',
        '',
      ].join('\n')
      expect(timedOutTests([banner('Failed Tests 1'), '', heading('case 1'), assertion, divider(1, 1), summary(1)].join('\n'))).toBeUndefined()
      // The words in a line that is no error header (a log line, a diff), with no header at all: no timeout either.
      const noHeader = ['  log: Hook timed out in 10000ms upstream', ' ❯ packages/x/tests/a.spec.ts:20:5', ''].join('\n')
      expect(timedOutTests([banner('Failed Tests 1'), '', heading('case 1'), noHeader, divider(1, 1), summary(1)].join('\n'))).toBeUndefined()
      // Next to a real timeout, the assertion still disqualifies the run.
      expect(timedOutTests([banner('Failed Tests 2'), '', heading('case 1'), timeoutError, divider(1, 2), '', heading('case 2'), assertion, divider(2, 2), summary(2)].join('\n'))).toBeUndefined()
    })

    it('never counts a group whose shared error is not a timeout, nor a heading the summary does not count', () => {
      const assertion = ['\u001b[31mAssertionError\u001b[39m: expected 1 to be 2', ' ❯ packages/x/tests/a.spec.ts:20:5', ''].join('\n')
      expect(timedOutTests([banner('Failed Tests 3'), '', heading('case 1'), heading('case 2'), assertion, divider(1, 2), '', heading('other'), timeoutError, divider(2, 2), summary(3)].join('\n'))).toBeUndefined()
      expect(timedOutTests([banner('Failed Tests 2'), '', heading('case 1'), heading('case 2'), timeoutError, divider(1, 1), summary(3)].join('\n'))).toBeUndefined()
      expect(timedOutTests([banner('Failed Tests 2'), '', heading('case 1'), heading('case 2'), timeoutError, divider(1, 1)].join('\n'))).toBeUndefined()
    })
  })

  it('reads the whole stream in pieces, so an assertion printed before 64 KiB of timeouts still disqualifies the run', () => {
    const assertion = ' FAIL  b.spec.ts > first\nAssertionError: expected 1 to be 2\n'
    const timeouts = Array.from({ length: 2000 }, (_, i) => timeout(`t${i}`)).join('')
    const output = `${assertion}${timeouts} Tests  2001 failed | 8 passed (2009)\n`
    expect(output.length).toBeGreaterThan(64 * 1024)
    const reader = new TimeoutReader()
    for (let at = 0; at < output.length; at += 997) reader.feed(output.slice(at, at + 997))
    expect(reader.result()).toBeUndefined()
    // The same stream without the assertion qualifies, read in the same pieces.
    const only = `${timeouts} Tests  2000 failed | 8 passed (2008)\n`
    const whole = new TimeoutReader()
    for (let at = 0; at < only.length; at += 997) whole.feed(only.slice(at, at + 997))
    expect(whole.result()).toBe(2000)
  })
})
