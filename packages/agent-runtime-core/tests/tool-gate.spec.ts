import { describe, expect, it } from 'vitest'
import { askToolGate, type ToolGate } from '../src/index.ts'

const call = { tool: 'Read', input: { file_path: 'a.txt' }, callId: 'c-1' }

describe('askToolGate: a run\'s gate asked about one tool call, bounded (docs/design/approvals.md#a-workers-tool-calls)', () => {
  it('passes the verdicts the contract defines through, with the call as given', async () => {
    const asked: unknown[] = []
    for (const verdict of [{ decision: 'allow' }, { decision: 'deny', reason: 'no' }, { decision: 'defer', reason: 'waits', requestId: 'apr-1' }] as const) {
      const gate: ToolGate = async (c) => (asked.push(c), verdict)
      expect(await askToolGate(gate, call, new AbortController().signal, 1000)).toEqual(verdict)
    }
    expect(asked).toEqual([call, call, call])
  })

  it('denies when the gate throws, or answers a verdict the contract does not define (INV-2)', async () => {
    const gates: ToolGate[] = [
      async () => { throw new Error('store busy') },
      async () => ({ decision: 'maybe' }) as never,
      async () => ({ decision: 'deny' }) as never,
      async () => ({ decision: 'defer', reason: 'x', requestId: '' }) as never,
      async () => null as never,
    ]
    for (const gate of gates) expect(await askToolGate(gate, call, new AbortController().signal, 1000)).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/the tool gate/) })
  })

  it('denies a gate that does not answer within its bound, and aborts the gate\'s signal; the run\'s abort reaches the gate too', async () => {
    let seen: AbortSignal | undefined
    const slow: ToolGate = (_c, signal) => {
      seen = signal
      return new Promise(() => undefined)
    }
    expect(await askToolGate(slow, call, new AbortController().signal, 30)).toEqual({ decision: 'deny', reason: 'the tool gate did not answer within 0.03 s' })
    expect(seen?.aborted).toBe(true)
    const run = new AbortController()
    const pending = askToolGate(slow, call, run.signal, 100)
    run.abort()
    expect(seen?.aborted).toBe(true)
    // The gate itself decides what an abort means; a gate that never answers is still bounded.
    expect(await pending).toMatchObject({ decision: 'deny' })
  })
})
