import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { ask, turnsStack } from './stack.ts'

const { boot } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: a restarted turn that must wait, and its cancel', () => {
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
    // Each look at the conversation while the turn waits reads it on the site, then reconciles what it
    // read; after a WAIT the runtime waits 5 s before its next look.
    const receipts = second.ctx.turnReceipts as unknown as { reconcile: (...args: unknown[]) => unknown }
    const reconcile = receipts.reconcile.bind(receipts)
    let looks = 0
    receipts.reconcile = (...args) => {
      const decided = reconcile(...args)
      looks += 1
      return decided
    }
    const waits = () => second.ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' })
      .filter((a) => (a.body as { outcome: { option: string } }).outcome.option === 'WAIT')
    await settled(() => waits().length > 0)
    // Two more looks reconciled after the first WAIT: the cancel below lands while the turn waits
    // between looks, as the operator's would (a cancel during a look is the next test).
    const seen = looks
    await settled(() => looks >= seen + 2)
    // Waiting is one decision, not one per look (INV-9).
    expect(waits()).toHaveLength(1)
    // Decisions are content-addressed, so the same WAIT recorded again is the same artifact: the
    // receipt's own list says whether a look recorded one more.
    expect(second.ctx.turnReceipts.read({ account: 'chatgpt-main', sessionId: turn.sessionId!, requestId: turn.turnId })?.reconciliations).toEqual([waits()[0]!.id])
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
})
