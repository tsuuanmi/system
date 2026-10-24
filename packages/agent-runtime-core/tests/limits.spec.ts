// An account's usage report (ADR-0059): the fake passes the seam's suite, and a Worker source reads a
// report through readLimits, bounded and fail-closed on anything the seam does not define (INV-2).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { agentRuntimeLimitsConformance, FakeAgentRuntime } from '../conformance/agent-runtimes.ts'
import { type AgentRuntimeProvider, type LimitReport, LIMITS_READ_MS, limitProblem, readLimits } from '../src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'system-limits-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
/** A fake on `version` whose own home is signed in, its report scripted as `windows`. */
function fake(version: string, windows: Parameters<typeof FakeAgentRuntime.report>[1]): FakeAgentRuntime {
  const home = join(root, `home-${++n}`)
  mkdirSync(home, { mode: 0o700 })
  FakeAgentRuntime.signIn(home, 'alice@example.test')
  FakeAgentRuntime.report(home, windows)
  return new FakeAgentRuntime('fake-runtime', version, home)
}
const WINDOWS = [{ window: 'five_hour', status: 'allowed' as const, usedPercentage: 42, resetsAt: '2026-10-24T14:20:00.000Z' }, { window: 'seven_day', status: 'rejected' as const, usedPercentage: 100 }]

agentRuntimeLimitsConformance('FakeAgentRuntime', {
  readable: () => fake('1.0.0', WINDOWS), garbled: () => fake('1.0.0', 'garbled'), unchecked: () => fake('2.0.0', WINDOWS), uncheckedVersion: '2.0.0',
})

/** A provider whose `limits` answers `answer` (a function of the signal, or a value). */
const provider = (answer: ((signal: AbortSignal) => Promise<unknown>) | undefined): AgentRuntimeProvider => ({
  kind: 'scripted', probe: async () => ({ available: true, detail: 'x', sandboxes: [], resume: false, executes: false, readsConfined: true, gatesToolCalls: true }), run: async () => ({ text: '' }),
  ...(answer ? { limits: (_options: unknown, signal: AbortSignal) => answer(signal) as Promise<LimitReport> } : {}),
})
const observation = { window: 'five_hour', status: 'allowed', usedPercentage: 12.5, resetsAt: '2026-10-24T14:20:00.000Z', observedAt: '2026-10-24T14:05:00.000Z' }

describe('readLimits (ADR-0059): bounded, and fail-closed', () => {
  it('gives the report a provider answered, its observations copied', async () => {
    const answered = { limits: [observation] }
    const read = await readLimits(provider(async () => answered), {}, new AbortController().signal)
    expect(read).toEqual(answered)
    expect((read as { limits: unknown[] }).limits[0]).not.toBe(answered.limits[0])
    expect(await readLimits(provider(async () => ({ unreadable: 'not verified for 9.9.9' })), {}, new AbortController().signal)).toEqual({ unreadable: 'not verified for 9.9.9' })
    expect(LIMITS_READ_MS).toBe(30_000)
  })

  it('passes the home it is asked for, and nothing it does not', async () => {
    const asked: unknown[] = []
    const p: AgentRuntimeProvider = { ...provider(undefined), limits: async (options) => (asked.push(options), { limits: [] }) }
    await readLimits(p, { home: '/srv/homes/2' }, new AbortController().signal)
    expect(asked).toEqual([{ home: '/srv/homes/2' }])
  })

  it('reads a provider without limits, one that throws, and one that answers what the seam does not define as unreadable, never a reading', async () => {
    const signal = new AbortController().signal
    expect(await readLimits(provider(undefined), {}, signal)).toEqual({ unreadable: 'scripted reads no usage report' })
    for (const answer of [
      async () => { throw new Error('boom') },
      async () => null,
      async () => ({ limits: 'none' }),
      async () => ({ limits: [], unreadable: 'both' }),
      async () => ({ limits: [{ ...observation, window: '' }] }),
      async () => ({ limits: [{ ...observation, status: 'ok' }] }),
      async () => ({ limits: [{ ...observation, usedPercentage: 140 }] }),
      async () => ({ limits: [{ ...observation, usedPercentage: -1 }] }),
      async () => ({ limits: [{ ...observation, resetsAt: 1_761_315_600 }] }),
      async () => ({ limits: [{ ...observation, observedAt: 'yesterday' }] }),
    ]) {
      const read = await readLimits(provider(answer), {}, signal)
      expect('unreadable' in read && read.unreadable.length > 0, JSON.stringify(read)).toBe(true)
      expect(read).not.toHaveProperty('limits')
    }
  })

  it('gives up on a report that does not answer in time, and aborts its signal', async () => {
    let aborted = false
    const slow = provider((signal) => new Promise(() => signal.addEventListener('abort', () => { aborted = true })))
    expect(await readLimits(slow, {}, new AbortController().signal, 20)).toEqual({ unreadable: 'the usage report did not answer within 0.02 s' })
    expect(aborted).toBe(true)
  })

  it('stops with its caller, even for a provider that ignores the signal, and never starts once stopped', async () => {
    const stop = new AbortController()
    let asked = 0
    const deaf = provider(() => (asked++, new Promise(() => undefined)))
    const read = readLimits(deaf, {}, stop.signal)
    stop.abort()
    expect(await read).toEqual({ unreadable: 'the read was stopped' })
    expect(await readLimits(deaf, {}, stop.signal)).toEqual({ unreadable: 'the read was stopped before it started' })
    expect(asked).toBe(1)
  })

  it('knows an observation as the seam defines it, and says what is wrong with any other', () => {
    expect(limitProblem(observation)).toBeUndefined()
    expect(limitProblem({ window: '*', status: 'rejected', observedAt: '2026-10-24T14:05:00Z' })).toBeUndefined()
    expect(limitProblem({ ...observation, resetsAt: '2026-10-24' })).toMatch(/resetsAt/)
    expect(limitProblem({ ...observation, window: 'w'.repeat(129) })).toMatch(/names no window/)
    expect(limitProblem([observation])).toMatch(/not an object/)
  })
})
