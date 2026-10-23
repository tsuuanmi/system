// Asking a run's tool gate as a gating provider must (docs/design/approvals.md#a-workers-tool-calls):
// bounded, and fail-closed on anything the contract does not define (INV-2).
import { describe, expect, it } from 'vitest'
import { type ToolGate, askToolGate, isToolVerdict } from '../src/index.ts'

const call = { tool: 'Read', input: { file_path: 'a' }, callId: 'c1' }

describe('askToolGate', () => {
  it('passes the call and returns a verdict the contract defines', async () => {
    const seen: unknown[] = []
    const gate: ToolGate = async (c) => (seen.push(c), { decision: 'defer', reason: 'asks', requestId: 'apr-1' })
    expect(await askToolGate(gate, call, new AbortController().signal)).toEqual({ decision: 'defer', reason: 'asks', requestId: 'apr-1' })
    expect(seen).toEqual([call])
    expect(await askToolGate(async () => ({ decision: 'allow' }), call, new AbortController().signal)).toEqual({ decision: 'allow' })
  })

  it('denies when the gate throws, gives an undefined verdict, or a defer without a request', async () => {
    for (const gate of [
      async () => { throw new Error('boom') },
      async () => ({ decision: 'maybe' }),
      async () => ({ decision: 'defer', reason: 'x', requestId: '' }),
      async () => ({ decision: 'deny' }),
      async () => null,
    ] as unknown as ToolGate[]) {
      expect(await askToolGate(gate, call, new AbortController().signal)).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/the tool gate/) })
    }
  })

  it('denies a gate that does not answer in time, and aborts its signal', async () => {
    let aborted = false
    const gate: ToolGate = (_c, signal) => new Promise(() => signal.addEventListener('abort', () => { aborted = true }))
    expect(await askToolGate(gate, call, new AbortController().signal, 20)).toEqual({ decision: 'deny', reason: 'the tool gate did not answer within 0.02 s' })
    expect(aborted).toBe(true)
  })

  it('aborts the gate\'s signal when the run is aborted', async () => {
    const run = new AbortController()
    let aborted = false
    const gate: ToolGate = (_c, signal) => new Promise((resolve) => signal.addEventListener('abort', () => {
      aborted = true
      resolve({ decision: 'deny', reason: 'stopped' })
    }))
    const verdict = askToolGate(gate, call, run.signal)
    run.abort()
    expect(await verdict).toEqual({ decision: 'deny', reason: 'stopped' })
    expect(aborted).toBe(true)
  })

  it('knows the verdicts the contract defines, and nothing else', () => {
    expect([{ decision: 'allow' }, { decision: 'deny', reason: '' }, { decision: 'defer', reason: 'r', requestId: 'a' }].every(isToolVerdict)).toBe(true)
    expect([{ decision: 'deny' }, { decision: 'defer', reason: 'r' }, { decision: 'ok' }, 'allow', null].some(isToolVerdict)).toBe(false)
  })
})
