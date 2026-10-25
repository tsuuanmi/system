/**
 * The report rendered for the operator: one screen of Markdown, read in layers (PROP-0008's
 * investor report): progress, results, attention, resources, the baseline, digests, and the dispatch
 * advisor's calibration once there is any. Deterministic,
 * from the report alone; numbers are written without a locale.
 */
import { drawFigureText } from '@tsuuanmi/system-libs'
import type { Report } from './report.ts'

/** A whole number with thousands separated by commas, whatever the host's locale. */
export const whole = (n: number): string => {
  const [int, frac] = String(n).split('.')
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac === undefined ? grouped : `${grouped}.${frac}`
}

/** Seconds as the largest two units: `45s`, `12m 5s`, `3h 2m`, `2d 4h`. */
export const duration = (seconds: number): string => {
  const s = Math.round(seconds)
  const units: Array<[string, number]> = [['d', 86_400], ['h', 3600], ['m', 60], ['s', 1]]
  const parts: string[] = []
  let rest = s
  for (const [unit, size] of units) {
    const n = Math.floor(rest / size)
    if (n || (unit === 's' && !parts.length)) parts.push(`${n}${unit}`)
    rest -= n * size
    if (parts.length === 2) break
  }
  return parts.join(' ')
}

const usd = (n: number): string => `$${n.toFixed(n >= 100 ? 2 : 4)}`
const plural = (n: number, one: string, many = `${one}s`): string => `${whole(n)} ${n === 1 ? one : many}`
const stateLine = (counts: Record<string, number>): string => {
  const shown = Object.entries(counts).filter(([, n]) => n > 0).map(([state, n]) => `${whole(n)} ${state}`)
  return shown.length ? shown.join(', ') : 'none'
}

export function renderReport(report: Report): string {
  const scope = report.projectId === undefined ? 'every project' : `project ${report.projectId}${report.projects[0] ? ` (${report.projects[0].title})` : ''}`
  const lines: string[] = [
    `# Report: ${scope}`,
    '',
    `${report.period.since} to ${report.period.until}; board and queue as of ${report.asOf}.`,
    '',
    '## Progress',
    '',
  ]
  for (const p of report.projects) {
    const milestones = p.milestones.length ? `; milestones: ${p.milestones.map((m) => `${m.id} ${m.state}`).join(', ')}` : ''
    lines.push(`- ${p.projectId} (${p.state}, charter v${p.charterVersion}): tasks ${stateLine(p.tasks)}${milestones}`)
  }
  if (!report.projects.length) lines.push('- no project')
  if (report.projectsOmitted) lines.push(`- and ${plural(report.projectsOmitted, 'more project')}`)
  const t = report.tasks
  lines.push(`- In the period: ${plural(t.created, 'task')} proposed, ${whole(t.done)} done (${whole(t.doneByOperator)} accepted by you), ${whole(t.cancelled)} cancelled.`)

  const a = report.attempts
  lines.push('', '## Results', '',
    `- Accepted results: ${whole(t.done)}.`,
    `- Attempts reported: ${whole(a.reported)} (${whole(a.accepted)} accepted by their own checks, ${whole(a.rejected)} rejected by them, ${whole(a.heldForOperator)} held for you, ${whole(a.reconciled)} failed or stopped, ${whole(a.other)} other).`,
    `- Reviews of the results: ${whole(a.review.passed)} passed, ${whole(a.review.failed)} still asking for changes, ${whole(a.review.none)} with no review bound.`,
    `- Remediation: ${plural(report.remediation.cycles, 'cycle')}; fixes approved ${whole(report.remediation.fixesOpened)}, closed ${whole(report.remediation.fixesClosed)}.`)

  const q = report.approvals
  const at = report.attention
  lines.push('', '## Attention', '',
    `- Asked of you: ${whole(at.interruptions)} (${plural(q.asked, 'approval request')}, ${plural(a.heldForOperator, 'review')} held for you), in ${plural(at.batches, 'batch', 'batches')}.`,
    `- Requests: ${whole(q.approved)} approved, ${whole(q.rejected)} rejected, ${whole(q.expired)} expired, ${whole(q.withdrawn)} withdrawn; ${whole(q.openNow)} open now.`)
  if (q.byClass.length) lines.push(`- By class: ${q.byClass.map((c) => `${c.actionClass} ${whole(c.asked)}`).join(', ')}.`)
  if (q.wait) lines.push(`- Your verdicts took: median ${duration(q.wait.medianSeconds)}, 90th percentile ${duration(q.wait.p90Seconds)}, longest ${duration(q.wait.maxSeconds)} (${plural(q.wait.answered, 'verdict')}).`)
  const busiest = [...at.days].sort((x, y) => y.interruptions - x.interruptions || (x.date < y.date ? -1 : 1))[0]
  if (busiest) lines.push(`- Busiest day: ${busiest.date}, ${plural(busiest.interruptions, 'interruption')} and ${plural(busiest.batches, 'batch', 'batches')}.`)
  if (at.threshold) {
    const allowed = [at.threshold.maxInterruptionsPerDay !== undefined ? plural(at.threshold.maxInterruptionsPerDay, 'interruption') : '', at.threshold.maxBatchesPerDay !== undefined ? plural(at.threshold.maxBatchesPerDay, 'batch', 'batches') : ''].filter(Boolean).join(' and ')
    lines.push(`- Charter allows ${allowed} a day: ${at.daysOver ? `over it on ${plural(at.daysOver, 'day')} (${at.days.filter((d) => d.over).map((d) => d.date).join(', ')})` : 'never over it'}.`)
  }
  if (at.reviewsHeld) {
    // When each expires unseen, as of the report: unanswered, its task waits for input, which nothing revives.
    const asOf = Date.parse(report.asOf)
    const held = at.reviewsHeld.map((r) => {
      const left = Math.round((Date.parse(r.expiresAt) - asOf) / 1000)
      return `${r.taskId} "${r.title}" (${left > 0 ? `expires in ${duration(left)}` : 'expired'}, at ${r.expiresAt}${r.pendingChecks.length ? `; ${r.pendingChecks.join(', ')} not run` : ''})`
    })
    lines.push(`- Reviews held for you now: ${held.join(', ')}${at.reviewsHeldOmitted ? ` and ${whole(at.reviewsHeldOmitted)} more` : ''}. Accept or Reject each on /ui before it expires: unanswered, its task waits for input, which nothing revives.`)
  }
  if (at.liveness) {
    const l = at.liveness
    lines.push(`- Agent runs: ${whole(l.stalled)} stalled, ${whole(l.unknown)} ended without being known to be gone (their session and worktree held until you free them), ${whole(l.freed)} freed by you.`)
    const held = l.held.map((h) => `${h.agentRun} on ${h.worker}${h.runId ? ` (run ${h.runId})` : ''}`)
    if (held.length) lines.push(`- Still held: ${held.join(', ')}${l.heldOmitted ? ` and ${whole(l.heldOmitted)} more` : ''}; system explain <run> says why, and system free <run> --agent-gone frees one once its agent is gone.`)
  }

  const u = report.usage
  lines.push('', '## Resources', '')
  if (!u.pools.length) lines.push('- No usage recorded.')
  for (const p of [...u.pools, ...(u.pools.length > 1 ? [{ ...u.total, pool: 'all pools' }] : [])]) {
    // What a cap counts as 0: the runs the ledger could not count, and the records without a figure.
    const uncounted = [
      p.unknownRuns ? `${plural(p.unknownRuns, 'run')} whose usage is unknown` : '', p.withoutTokens ? `${plural(p.withoutTokens, 'record')} without token counts` : '',
      p.withoutCost ? `${plural(p.withoutCost, 'record')} without a cost` : '', p.withoutTurns ? `${plural(p.withoutTurns, 'record')} without turns` : '',
    ].filter(Boolean)
    lines.push(`- ${p.pool}: ${whole(p.inputTokens)} tokens in (${whole(p.cacheReadInputTokens)} cache reads, ${whole(p.cacheCreationInputTokens)} cache writes), ${whole(p.outputTokens)} out; ${plural(p.turns, 'turn')}; ${usd(p.costUsd)}; ${plural(p.records, 'record')}${uncounted.length ? `; not counted: ${uncounted.join(', ')}` : ''}.`)
  }
  if (u.byOutcome.failed || u.byOutcome.aborted) lines.push(`- Runs that did not complete: ${whole(u.byOutcome.failed)} failed, ${whole(u.byOutcome.aborted)} aborted.`)
  if (u.unknown) {
    const k = u.unknown
    const kinds = [k.notReported ? `${whole(k.notReported)} not reported` : '', k.interrupted ? `${whole(k.interrupted)} interrupted` : '', k.refused ? `${whole(k.refused)} refused by the ledger` : '', k.failed ? `${whole(k.failed)} failed to record` : ''].filter(Boolean)
    lines.push(`- Usage the ledger could not count: ${plural(k.runs, 'run')} (${kinds.join(', ')}), ${whole(k.reconciled)} of them counted since; a cap counts the others as 0.`)
  }
  if (u.draws) {
    // Quota drawn per run (PROP-0015 E2): clean draws only in a figure; what was left out, said.
    lines.push(`- Quota drawn per run, in percentage points of each window (${plural(u.draws.records, 'run')}): ${u.draws.byKind.map((f) => drawFigureText(f)).join('; ')}.`)
    const steps = u.draws.byStep.filter((f) => f.step !== undefined)
    if (steps.length) lines.push(`- By template step: ${steps.map((f) => drawFigureText(f)).join('; ')}${u.draws.omitted ? `; and ${plural(u.draws.omitted, 'more figure')}` : ''}.`)
  }

  const b = report.baseline
  lines.push('', '## Baseline', '')
  if (b.perAcceptedResult) {
    const per = b.perAcceptedResult
    lines.push(`- Per accepted result: ${whole(per.tokens)} tokens, ${usd(per.costUsd)}, ${whole(per.turns)} turns, ${whole(per.attempts)} attempts, ${whole(per.interruptions)} interruptions.`,
      `- Accepted results per interruption: ${b.interruptions ? whole(Math.round((b.acceptedResults / b.interruptions) * 100) / 100) : 'none asked'}.`)
  } else {
    lines.push('- No accepted result in the period: nothing to divide by.')
  }

  const d = report.digests
  lines.push('', '## Digests', '', `- ${whole(d.attached)} attached, ${whole(d.bypassed)} bypassed${d.claimsKept !== undefined ? `; claims kept ${whole(d.claimsKept)}, dropped ${whole(d.claimsDropped!)}; ${plural(d.escalated!, 'escalation')}` : ''}.`)

  if (report.advice) {
    // The advisor in shadow (PROP-0015 J1): it changed no choice; this says how well calibrated it was.
    const v = report.advice
    lines.push('', '## Dispatch advice (shadow)', '',
      `- Choices advised: ${whole(v.advised)}; no advice: ${whole(v.unavailable)}. Outcomes recorded: ${whole(v.outcomes)}, ${whole(v.scored)} of them advised (the shadow period runs for ${whole(v.shadowAttempts)}).`)
    for (const q of v.questions) lines.push(`- ${q.question}: Brier ${q.brier} over ${plural(q.scored, 'attempt')} (always answering the rate ${q.rate}: ${q.baseline}; lower is better).`)
    if (!v.questions.length) lines.push('- No advised attempt has an outcome yet: nothing to score.')
  }

  if (report.notes.length) lines.push('', '## Not counted', '', ...report.notes.map((n) => `- ${n}`))
  return `${lines.join('\n')}\n`
}
