// The results held for the operator, decided together (T336): what each row says and the one-by-one decision. No page here, so a test runs it without a browser.
import type { ReviewCard } from '../src/api.js'

export type Verdict = 'accept' | 'reject'
/** What one row came to: its decision recorded, refused with the server's reason, or held back until it has what it needs. */
export type RowResult = { state: 'recorded'; decision: string; task: string } | { state: 'refused'; reason: string } | { state: 'needs-note'; checks: string[] }
/** The one decision a row sends: its verdict and the same note for each, a check not run with its why. Throws what the server refused. */
export type Send = (row: ReviewCard, verdict: Verdict, note: string, checksNotRun: Record<string, string>) => Promise<{ decision: string; task: string }>
/** The checks a row's accept needs a why for, and the why given for each. */
export interface NotRun { needed: string[]; given: Record<string, string> }

/** A held result with an expiry, the one that lapses first at the top. */
export const heldOrder = (list: ReviewCard[]): ReviewCard[] => list.filter((r) => r.heldFor === 'operator' && r.expiresAt).sort((a, b) => (a.expiresAt as string).localeCompare(b.expiresAt as string) || a.taskId.localeCompare(b.taskId))

/** Why the board holds it: its hold decision's words (heavy, with its risk reason), else the checks it holds pending, else the checks that passed with tests not run (the auto-accept rule). */
export const whyHeld = (r: ReviewCard): string => {
  if (r.holdReason) return r.holdReason
  const states = r.checks?.value ?? []
  const failed = r.pendingChecks.filter((c) => states.some((s) => s.check === c && s.state === 'failed')), notRun = r.pendingChecks.filter((c) => !failed.includes(c))
  const unrun = states.filter((c) => c.state === 'passed' && c.notRun).map((c) => c.check)
  const parts = [failed.length ? 'checks failed: ' + failed.join(', ') : '', notRun.length ? 'checks not run: ' + notRun.join(', ') : '', unrun.length ? 'checks passed, browser tests not run: ' + unrun.join(', ') + ' (not accepted automatically)' : ''].filter(Boolean)
  return parts.length ? parts.join('; ') : 'held for you; the board recorded no reason'
}

const DIGEST_LINES = 3
/** The first lines of a run's report: what it says first, not its whole text. */
export const digestLines = (text: string | undefined): string[] => (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, DIGEST_LINES).map((l) => l.length > 200 ? l.slice(0, 200) + '…' : l)

/**
 * Decide each row on its own, one after another, with the same note. An accept of a row with a check not run and no why for it is not sent:
 * it comes back `needs-note`, naming the checks. A row the server refuses comes back with its reason, and the others go on.
 */
export async function decideTogether(rows: ReviewCard[], verdict: Verdict, note: string, notRun: (r: ReviewCard) => NotRun, send: Send, reason: (error: unknown) => string): Promise<Map<string, RowResult>> {
  const results = new Map<string, RowResult>()
  for (const row of rows) {
    const { needed, given } = notRun(row), missing = verdict === 'accept' ? needed.filter((c) => !given[c]) : []
    if (missing.length) { results.set(row.taskId, { state: 'needs-note', checks: missing }); continue }
    try {
      const sent = await send(row, verdict, note, verdict === 'accept' ? given : {})
      results.set(row.taskId, { state: 'recorded', ...sent })
    } catch (error) {
      results.set(row.taskId, { state: 'refused', reason: reason(error) })
    }
  }
  return results
}
