import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { issueLeadToken, leadTokens } from '@tsuuanmi/system-libs'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { activeProject } from '../../workflow/conformance/workflow.ts'
import { decideTogether, heldOrder, reopenFirst, whyHeld, type NotRun, type Reopen, type Send } from '../client/heldbatch.ts'
import type { ReviewCard } from '../src/api.ts'
import { boot, reviewed, type Booted } from './store-backed.ts'

// An expired review is one action away (T350): "Held for you" lists a result whose review expired, within its wait for input, and the
// operator reopens and accepts it in one pass: each step its own recorded decision. Over the store-backed board and the web UI's real API.
vi.setConfig({ testTimeout: 120_000 })
afterEach(() => vi.useRealTimers())

const DAY = 86_400_000
const none = (): NotRun => ({ needed: [], given: {} })
const reason = (error: unknown) => (error as Error).message

/** A result whose review lapsed unseen, with the run's worktree still on disk (a re-opening needs it). */
async function lapsed(booted: Booted, title: string) {
  const { ctx } = booted
  const { task, run } = await reviewed(ctx, title)
  const dir = mkdtempSync(join(tmpdir(), 'ui-expired-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  ctx.store.db.prepare('CREATE TABLE IF NOT EXISTS agent_worktrees (repository TEXT, workflow_run_id TEXT, path TEXT, branch TEXT, removed_at TEXT)').run()
  ctx.store.db.prepare('INSERT INTO agent_worktrees VALUES (?, ?, ?, ?, NULL)').run('/repo', run.runId, dir, `system/run/${run.runId}`)
  const at = new Date(Date.parse(task.waiting!.expiresAt) + 1000)
  await ctx.board.sweep(at)
  const expired = (await ctx.board.task(task.taskId))!
  expect(expired).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'review-expired' } })
  return { task: expired, at }
}

const expiredOf = async (call: Booted['call']): Promise<ReviewCard[]> => (await call('reviews')).value.expired as ReviewCard[]
const everyRow = async (call: Booted['call']) => { const v = (await call('reviews')).value; return heldOrder([...(v.reviews as ReviewCard[]), ...(v.expired as ReviewCard[])]) }

/** What the page sends: a decision, and a re-opening first for a row whose review expired (the same two calls as the client's). */
const sender = (call: Booted['call'], reopened: string[] = []): Send => reopenFirst(async (row, verdict, note, checksNotRun) => {
  const sent = await call(`reviews/${row.taskId}/decide`, { verdict, subject: row.subject, note, ...(Object.keys(checksNotRun).length ? { checksNotRun } : {}) })
  if (sent.status !== 200) throw new Error(String(sent.value.error))
  return { decision: sent.value.decision as string, task: (sent.value.task as { state: string }).state }
}, (async (row) => {
  const sent = await call(`reviews/${row.taskId}/reopen`, { subject: row.subject, reason: 'reopened from Held for you' })
  if (sent.status !== 200) throw new Error(String(sent.value.error))
  reopened.push(sent.value.decision as string)
  return { pendingChecks: (sent.value.task as { waiting: { pendingChecks: string[] } }).waiting.pendingChecks }
}) satisfies Reopen)

describe('web UI: an expired review in "Held for you" (T350)', () => {
  it('lists a result whose review expired with when it expired, after the ones still held, and counts it as no waiting review', async () => {
    const booted = await boot()
    const { ctx, call } = booted
    await activeProject(ctx)
    const { task, at } = await lapsed(booted, 'expired unseen')
    const still = (await reviewed(ctx, 'still held')).task
    const listed = (await call('reviews')).value
    expect((listed.reviews as ReviewCard[]).map((r) => r.taskId)).toEqual([still.taskId])
    const [card] = listed.expired as Array<ReviewCard & { expiredAt: string }>
    expect(card).toMatchObject({ taskId: task.taskId, heldFor: 'expired', expiredAt: at.toISOString(), expiresAt: task.waiting!.expiresAt, subject: task.result!.subject })
    expect(Date.parse(card!.expiresAt!) - Date.parse(card!.expiredAt)).toBe(7 * DAY)
    // Held rows first, then the expired one, marked as such.
    expect((await everyRow(call)).map((r) => r.taskId)).toEqual([still.taskId, task.taskId])
    expect(whyHeld(card!)).toMatch(/review expired/)
    // Home's count is the reviews held now: an expired one is not among them.
    expect((await call('waiting')).value.reviews).toMatchObject({ value: 1 })
  })

  it('reopens and accepts expired results together in one pass: a re-opening and an acceptance each recorded, the operator\'s, and they leave the list', async () => {
    const booted = await boot()
    const { ctx, call } = booted
    await activeProject(ctx)
    const a = (await lapsed(booted, 'one')).task, b = (await lapsed(booted, 'two')).task
    const rows = await everyRow(call)
    expect(rows.map((r) => r.taskId).sort()).toEqual([a.taskId, b.taskId].sort())
    // Their checks are pending on the re-opened hold: the operator gives why for them as for a held result.
    const given = { tests: 'no test command here', lint: 'no lint command here' }
    const reopened: string[] = []
    const results = await decideTogether(rows, 'accept', 'read both', () => ({ needed: [], given }), sender(call, reopened), reason)
    expect([...results.values()].map((r) => r.state)).toEqual(['recorded', 'recorded'])
    for (const task of [a, b]) {
      const done = (await ctx.board.task(task.taskId))!
      expect(done).toMatchObject({ state: 'done' })
      expect(ctx.artifacts.get(done.result!.acceptance!)!.body).toMatchObject({ decider: { type: 'operator' }, rationale: 'read both', outcome: { option: 'accept', detail: { taskId: task.taskId } } })
    }
    // The re-opening is its own board decision, by the operator, recorded before the acceptance.
    expect(reopened).toHaveLength(2)
    for (const id of reopened) expect(ctx.artifacts.get(id as never)!.body).toMatchObject({ decisionType: 'board', outcome: { option: 'operator-review', detail: { reopenedBy: 'operator' } } })
    expect(await everyRow(call)).toEqual([])
  })

  it('refuses a re-opening of a result that is not review-expired, on another subject than the page showed, or whose run\'s worktree is gone, and decides nothing', async () => {
    const booted = await boot()
    const { ctx, call } = booted
    await activeProject(ctx)
    const held = (await reviewed(ctx, 'still held')).task
    expect((await call(`reviews/${held.taskId}/reopen`, { subject: held.result!.subject, reason: 'x' })).status).toBe(409)
    const { task } = await lapsed(booted, 'expired')
    expect((await call(`reviews/${task.taskId}/reopen`, { subject: { ...task.result!.subject, ref: 'sha256:other' }, reason: 'x' })).status).toBe(409)
    expect((await call(`reviews/${task.taskId}/reopen`, { reason: 'x' })).status).toBe(400)
    ctx.store.db.prepare('UPDATE agent_worktrees SET removed_at = ?').run('2026-10-26T00:00:00.000Z')
    const gone = await call(`reviews/${task.taskId}/reopen`, { subject: task.result!.subject, reason: 'x' })
    expect(gone.status).toBe(409)
    expect(String(gone.value.error)).toMatch(/no worktree left/)
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'review-expired' } })
  })

  it('does not list a result past its wait for input: it is gone as it was', async () => {
    const booted = await boot()
    const { ctx, call } = booted
    await activeProject(ctx)
    const { task } = await lapsed(booted, 'too late')
    expect((await expiredOf(call)).map((r) => r.taskId)).toEqual([task.taskId])
    // Eight days on, with only the Date faked: the wait for input has ended (the sweep then cancels it).
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(task.waiting!.expiresAt) + 1000 })
    expect(await expiredOf(call)).toEqual([])
    expect(await everyRow(call)).toEqual([])
  })

  it('lets only the operator decide: a lead token is shown no expired result and cannot reopen one, nor accept a held one that is not on a dev branch', async () => {
    const booted = await boot({ approvals: { devBranches: { p1: ['dev'] } } })
    const { ctx, call, dir } = booted
    await activeProject(ctx)
    issueLeadToken(dir, 'p1')
    const lead = leadTokens(dir).get('p1')!
    const { task } = await lapsed(booted, 'expired')
    // A lead is not offered what it cannot do: no expired rows, and the reopen is the operator's (nothing moves).
    const seen = await call('reviews', undefined, lead)
    expect(seen.status).toBe(200)
    expect(seen.value.expired).toEqual([])
    const reopen = await call(`reviews/${task.taskId}/reopen`, { subject: task.result!.subject, reason: 'x' }, lead)
    expect(reopen.status).toBe(403)
    expect(String(reopen.value.error)).toMatch(/only the operator/)
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'review-expired' } })
    // Nor does a lead accept a held result (the run recorded no dev branch): nothing is decided.
    const held = (await reviewed(ctx, 'held heavy')).task
    const accept = await call(`reviews/${held.taskId}/decide`, { verdict: 'accept', subject: held.result!.subject }, lead)
    expect(accept.status).toBe(403)
    expect(await ctx.board.task(held.taskId)).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' } })
  })

  it('says why a row cannot be sent back before it is reopened, and holds the row back when its re-opening asks for a why the operator has not given', async () => {
    const booted = await boot()
    const { ctx, call } = booted
    await activeProject(ctx)
    const { task } = await lapsed(booted, 'needs why')
    const rows = await everyRow(call)
    const back = await decideTogether(rows, 'reject', 'no', none, sender(call), reason)
    expect(back.get(task.taskId)).toMatchObject({ state: 'refused' })
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'waiting-for-input' })
    // Accepted with no why for the checks the re-opened hold asks about: it is reopened, then named as still held, never accepted.
    const first = await decideTogether(rows, 'accept', 'ok', none, sender(call), reason)
    expect(first.get(task.taskId)).toMatchObject({ state: 'refused' })
    expect((first.get(task.taskId) as { reason: string }).reason).toMatch(/reopened.*tests, lint/)
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: ['tests', 'lint'] } })
  })
})
