import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { ask, turnsStack } from './stack.ts'

const { boot } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: within its bounds, and as the runtime stops', () => {
  it('bounds the turns it accepts (INV-9): beyond the limit it refuses with a back-off failure', async () => {
    const { ctx } = await boot({ fake: { thinkMs: 3000 }, turns: { maxPendingTurns: 1 } })
    const first = await ask(ctx, { prompt: 'one' })
    await expect(ask(ctx, { prompt: 'two' })).rejects.toMatchObject({ kind: 'overloaded', disposition: 'BACKOFF' })
    await ctx.turns.wait(first.turnId, 30_000)
    await ask(ctx, { prompt: 'three' })
  }, 90_000)

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

  it('settles pending waits promptly when the runtime stops, even when the browser drops the close of the page the stop aborted (INV-9, CI 2026-10-24)', async () => {
    const { ctx, stop } = await boot({ fake: { thinkMs: 30_000 } })
    // A close that lands as the page's first navigation commits: Chrome acknowledges it and the
    // tab stays open, so the page's close never completes.
    const browser = ctx.browser as unknown as { openTurn: (...args: unknown[]) => Promise<{ page: { close: () => Promise<void> } }> }
    const open = browser.openTurn.bind(browser)
    let opened!: () => void
    const pageOpen = new Promise<void>((resolve) => { opened = resolve })
    browser.openTurn = async (...args) => {
      const turn = await open(...args)
      turn.page.close = () => new Promise<void>(() => undefined)
      opened()
      return turn
    }
    const started = await ask(ctx, { prompt: 'slow' })
    const waiting = ctx.turns.wait(started.turnId, 55_000)
    await pageOpen
    const t0 = Date.now()
    await stop()
    await waiting
    expect(Date.now() - t0).toBeLessThan(15_000)
  }, 90_000)
})
