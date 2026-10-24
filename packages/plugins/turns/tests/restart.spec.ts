import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { account, ask, turnsStack } from './stack.ts'

const { boot } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: across a restart, within its bounds, and as the runtime stops', () => {
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

  it('bounds the turns it accepts (INV-9): beyond the limit it refuses with a back-off failure', async () => {
    const { ctx } = await boot({ fake: { thinkMs: 3000 }, turns: { maxPendingTurns: 1 } })
    const first = await ask(ctx, { prompt: 'one' })
    await expect(ask(ctx, { prompt: 'two' })).rejects.toMatchObject({ kind: 'overloaded', disposition: 'BACKOFF' })
    await ctx.turns.wait(first.turnId, 30_000)
    await ask(ctx, { prompt: 'three' })
  }, 90_000)

  it('keeps a session\'s turns in order across a restart: a later turn waits while an earlier one cannot be reconciled yet (INV-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { thinkMs: 4000, answer: (prompt: string) => `answer to ${prompt}` } })
    const t1 = await ask(first.ctx, { prompt: 'one', persist: true })
    const settled = (check: () => boolean): Promise<void> => vi.waitFor(() => {
      if (!check()) throw new Error('timed out')
    }, { timeout: 30_000, interval: 100 })
    await settled(() => first.ctx.turns.get(t1.turnId)?.binding !== undefined)
    const t2 = await ask(first.ctx, { prompt: 'two', sessionId: t1.sessionId! })
    expect(first.ctx.turns.get(t2.turnId)?.status).toBe('queued')
    await first.stop()
    // A crash: the dead process's lease on the first turn stays live for a while after the restart.
    const deadUntil = Date.now() + 3000
    const db = new DatabaseSync(join(dir, 'system.db'))
    db.prepare("UPDATE leases SET owner = 'dead:1:x', token = 'dead', expires_at = ? WHERE resource = ?").run(deadUntil, `turn:${t1.turnId}`)
    db.close()
    const second = await boot({ dir, shared: first.fake })
    // The restarted runtime took both turns up while that lease still held the first one.
    expect(Date.now()).toBeLessThan(deadUntil)
    const one = await second.ctx.turns.wait(t1.turnId, 90_000)
    const two = await second.ctx.turns.wait(t2.turnId, 90_000)
    expect([one.answer, two.answer]).toEqual(['answer to one', 'answer to two'])
    expect(first.fake.sent.map((s) => s.prompt)).toEqual(['one', 'two'])
  }, 180_000)

  it('lets the operator cancel, and the runtime stop, while a restarted turn waits for its answer to finish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { researchMs: 120_000, report: 'late report' } })
    const turn = await ask(first.ctx, { research: true, prompt: 'long research' })
    const settled = (check: () => boolean, ms = 60_000): Promise<void> => vi.waitFor(() => {
      if (!check()) throw new Error('timed out')
    }, { timeout: ms, interval: 100 })
    await settled(() => first.ctx.turns.get(turn.turnId)?.binding !== undefined)
    await first.stop()
    const second = await boot({ dir, shared: first.fake })
    const waits = () => second.ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' })
      .filter((a) => (a.body as { outcome: { option: string } }).outcome.option === 'WAIT')
    await settled(() => waits().length > 0)
    await new Promise((resolve) => setTimeout(resolve, 25_000))
    // Waiting is one decision, not one per look (INV-9).
    expect(waits()).toHaveLength(1)
    expect(second.ctx.turns.cancel(turn.turnId)).toBe(true)
    await settled(() => second.ctx.turns.get(turn.turnId)?.status === 'failed', 3000)
    expect(second.ctx.turns.get(turn.turnId)).toMatchObject({ status: 'failed', error: { kind: 'aborted' } })
    const started = Date.now()
    await second.stop()
    expect(Date.now() - started).toBeLessThan(5000)
  }, 240_000)

  it('ends a restarted turn cancelled while it looks at its conversation as aborted: the look the cancel cut short is no evidence, never AMBIGUOUS (INV-4, REQ-WRK-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { thinkMs: 60_000, answer: 'never taken' } })
    const turn = await ask(first.ctx, { prompt: 'cancelled mid-look', persist: true })
    await vi.waitFor(() => {
      if (first.ctx.turns.get(turn.turnId)?.binding === undefined) throw new Error('not bound yet')
    }, { timeout: 30_000, interval: 100 })
    await first.stop()
    // A crash: the dead process's lease holds the turn until the restarted runtime is set up below.
    const deadUntil = Date.now() + 5000
    const db = new DatabaseSync(join(dir, 'system.db'))
    db.prepare("UPDATE leases SET owner = 'dead:1:x', token = 'dead', expires_at = ? WHERE resource = ?").run(deadUntil, `turn:${turn.turnId}`)
    db.close()
    const second = await boot({ dir, shared: first.fake })
    // The look is open when the operator cancels; the abort closes its page, which then reads as
    // not observed (the driver's answer when no user turn rendered).
    const driver = second.ctx.providers.get('chatgpt-web') as unknown as { snapshot: (...args: unknown[]) => Promise<unknown> }
    let looking!: () => void
    const looked = new Promise<void>((resolve) => { looking = resolve })
    let cut!: () => void
    const cancelled = new Promise<void>((resolve) => { cut = resolve })
    driver.snapshot = async () => {
      looking()
      await cancelled
      return { text: '', running: false, observable: false }
    }
    expect(Date.now()).toBeLessThan(deadUntil)
    await looked
    expect(second.ctx.turns.cancel(turn.turnId)).toBe(true)
    cut()
    expect(await second.ctx.turns.wait(turn.turnId, 30_000)).toMatchObject({ status: 'failed', error: { kind: 'aborted' } })
    // No reconciliation was decided on that look, and the prompt was never resent.
    expect(second.ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' })).toEqual([])
    expect(first.fake.sent).toHaveLength(1)
  }, 120_000)

  it('keeps a completed turn completed when a later step fails (closing its browser turn), never rewriting it as failed', async () => {
    const { ctx } = await boot({ fake: { answer: 'Done' } })
    const browser = ctx.browser as unknown as { openTurn: (...args: unknown[]) => Promise<{ close: () => Promise<void> }> }
    const open = browser.openTurn.bind(browser)
    browser.openTurn = async (...args) => {
      const turn = await open(...args)
      const close = turn.close.bind(turn)
      turn.close = async () => {
        await close()
        throw new Error('the browser turn did not close cleanly')
      }
      return turn
    }
    const started = await ask(ctx, { prompt: 'finish then fail' })
    await ctx.turns.wait(started.turnId, 60_000)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(ctx.turns.get(started.turnId)).toMatchObject({ status: 'completed', answer: 'Done' })
  }, 90_000)

  it('never leaves a failure it cannot record unhandled: with its lease taken, the turn is looked at again, not overwritten (INV-4)', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    onTestFinished(() => void process.off('unhandledRejection', onUnhandled))
    const { ctx } = await boot({ fake: { thinkMs: 30_000, answer: 'late' } })
    const turn = await ask(ctx, { prompt: 'slow' })
    for (let t = Date.now(); ctx.turns.get(turn.turnId)?.status !== 'running' && Date.now() - t < 30_000;) await new Promise((resolve) => setTimeout(resolve, 100))
    // Another process took the turn (its lease moved on): this process may no longer write it.
    ctx.leases.invalidate(`turn:${turn.turnId}`)
    expect(ctx.turns.cancel(turn.turnId)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(unhandled).toEqual([])
    expect(ctx.turns.get(turn.turnId)?.status).toBe('running')
  }, 90_000)

  it('forgets finished turns (their prompts and receipts) after the retention period (INV-9)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir })
    const done = await first.ctx.turns.wait((await ask(first.ctx, { prompt: 'old prompt' })).turnId, 30_000)
    first.ctx.store.transaction((db) => void db.prepare("UPDATE turns SET updated_at = '2026-01-01T00:00:00.000Z' WHERE turn_id = ?").run(done.turnId))
    await first.stop()
    const second = await boot({ dir, turns: { retainDays: 30 } })
    expect(second.ctx.turns.get(done.turnId)).toBeUndefined()
    expect(second.ctx.turnReceipts.read({ account: 'chatgpt-main', sessionId: done.turnId, requestId: done.turnId })).toBeUndefined()
    expect(second.ctx.artifacts.get(done.answerArtifact!)).toBeDefined()
  }, 90_000)

  it('settles pending waits promptly when the runtime stops', async () => {
    const { ctx, stop } = await boot({ fake: { thinkMs: 30_000 } })
    const started = await ask(ctx, { prompt: 'slow' })
    const waiting = ctx.turns.wait(started.turnId, 55_000)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const t0 = Date.now()
    await stop()
    await waiting
    expect(Date.now() - t0).toBeLessThan(15_000)
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
