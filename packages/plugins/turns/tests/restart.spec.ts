import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { account, ask, turnsStack } from './stack.ts'

const { boot } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: across a restart', () => {
  it('recovers a submitted persistent turn after a restart from its conversation, without resending (REQ-PRV-2, QA-1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { thinkMs: 4000, answer: 'answered while we were down' } })
    const turn = await ask(first.ctx, { prompt: 'survive a crash', persist: true })
    const until = (check: () => boolean): Promise<void> => vi.waitFor(() => {
      if (!check()) throw new Error('timed out')
    }, { timeout: 30_000, interval: 100 })
    await until(() => first.ctx.turns.get(turn.turnId)?.binding !== undefined)
    await first.stop()
    // The provider keeps working while the host is down.
    await until(() => [...first.fake.conversations.values()].some((c) => c.turns.some((t) => t.role === 'assistant')))
    const second = await boot({ dir, shared: first.fake })
    const recovered = await second.ctx.turns.wait(turn.turnId, 60_000)
    expect(recovered).toMatchObject({ status: 'completed', answer: 'answered while we were down' })
    expect(first.fake.sent).toHaveLength(1)
    const outcome = second.ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' }).map((a) => (a.body as { outcome: { option: string } }).outcome.option)
    expect(outcome).toEqual(['RECOVER'])
  }, 120_000)

  it('recovers a Deep research turn after a restart from its run, without resending (live 2026-10-12)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { researchMs: 9000, report: 'Report written while we were down.' } })
    const turn = await ask(first.ctx, { research: true, prompt: 'survive a crash' })
    const deadline = Date.now() + 30_000
    while (first.ctx.turns.get(turn.turnId)?.binding === undefined) {
      if (Date.now() > deadline) throw new Error('never bound')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await first.stop()
    const second = await boot({ dir, shared: first.fake })
    const recovered = await second.ctx.turns.wait(turn.turnId, 60_000)
    expect(recovered).toMatchObject({ status: 'completed', answer: 'Research findings\nReport written while we were down.' })
    expect(first.fake.sent).toHaveLength(1)
    const outcomes = second.ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' }).map((a) => (a.body as { outcome: { option: string } }).outcome.option)
    expect(outcomes).not.toContain('RESUBMIT')
    expect(outcomes.at(-1)).toBe('RECOVER')
  }, 150_000)

  it('runs a recovered turn in only one of two processes sharing the same home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { thinkMs: 2000, answer: 'once' } })
    const turn = await ask(first.ctx, { prompt: 'only once' })
    const second = await boot({ dir, shared: first.fake })
    // However long the turn takes, both processes see it complete, and it was sent once.
    expect((await first.ctx.turns.wait(turn.turnId, 60_000)).status).toBe('completed')
    await expect.poll(() => second.ctx.turns.get(turn.turnId)?.status, { timeout: 30_000 }).toBe('completed')
    expect(first.fake.sent.map((s) => s.prompt)).toEqual(['only once'])
  }, 90_000)

  it('never serves a routed turn by another mode after its tier was unmapped across a restart (INV-2, QA-3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, capacity: 1, fake: { thinkMs: 60_000 } })
    await ask(first.ctx, { prompt: 'hold the slot' })
    const queued = await ask(first.ctx, { prompt: 'needs frontier', tier: 'frontier' })
    const deadline = Date.now() + 30_000
    while (first.ctx.turns.get(queued.turnId)?.worker === undefined) {
      if (Date.now() > deadline) throw new Error('never routed')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await first.stop()
    const second = await boot({ dir, shared: first.fake, accounts: [account('chatgpt-main', { economy: 'instant', standard: 'medium' })] })
    const refused = await second.ctx.turns.wait(queued.turnId, 30_000)
    expect(refused).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error' } })
    expect(first.fake.sent.map((s) => s.prompt)).not.toContain('needs frontier')
  }, 120_000)

  it('resumes a queued turn after a restart, and never resends one that was already submitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { thinkMs: 60_000 }, capacity: 1 })
    const submitted = await ask(first.ctx, { prompt: 'long one' })
    await vi.waitFor(() => {
      if (!first.fake.sent.length) throw new Error('never sent')
    }, { timeout: 30_000, interval: 100 })
    // Capacity 1: this turn waits behind the first one when the host goes down.
    const queuedTurn = await ask(first.ctx, { prompt: 'queued before the crash' })
    expect(first.ctx.turns.get(queuedTurn.turnId)).toMatchObject({ status: 'queued' })
    await first.stop()

    const second = await boot({ dir, fake: { answer: 'resumed' } })
    const turns = second.ctx.turns.list()
    const interrupted = turns.find((t) => t.turnId === submitted.turnId)!
    expect(interrupted).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed' } })
    // The restart decision is recorded (INV-13): a temporary conversation cannot be observed.
    const reconciliations = second.ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' })
    expect(reconciliations.map((a) => (a.body as { outcome: { option: string } }).outcome.option)).toEqual(['AMBIGUOUS'])
    expect(turns.map((t) => t.turnId).sort()).toEqual([submitted.turnId, queuedTurn.turnId].sort())
    expect((await second.ctx.turns.wait(queuedTurn.turnId, 60_000)).answer).toBe('resumed')
    expect(second.fake.sent.map((s) => s.prompt)).toEqual(['queued before the crash'])
  }, 150_000)
})
