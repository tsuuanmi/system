// What the operator reads before a review verdict (T122): where an accepted result stands, the run's change, each reviewer's
// verdict, the run's report, and each required check as the run recorded it (ADR-0063, T160).
import type { Assessment, Carry, Finding, Landing, ReviewCard, ReviewCheck, RunReview } from '../src/api.js'
import { chip, el, fold, qty, shortId, type Child } from './dom.js'
import { whatIs } from './glossary.js'
import { decideLink, runLink } from './router.js'
import { api, asApiError, refresh } from './state.js'
import type { ApiError } from './state.js'

const via = (base: string | undefined) => base || 'its base'
// Where an accepted result stands on its way into the repository (ADR-0060), in words, each pending step linked to where it is decided.
const landingText = (l: Landing): HTMLElement => l.state === 'asked' && l.requestId ? el('div', {}, 'Accepted — waiting to merge into ' + via(l.base) + ': ', decideLink(l.requestId, 'approve'))
  : l.state === 'merged' ? el('div', {}, 'Accepted and merged into ' + via(l.base) + (l.commit ? ' as ' : ''), l.commit ? shortId(l.commit, 'Copy commit') : null, el('span', { class: 'muted' }, ' · not pushed'))
  : l.state === 'refused' ? el('div', {}, 'Accepted — not merged: ' + (l.reason || 'refused'))
  : l.state === 'rejected' ? el('div', {}, 'Accepted — the merge was not approved; ' + (l.branch || 'its branch') + ' keeps the commit')
  : l.state === 'committed' ? el('div', {}, 'Accepted and committed on ' + (l.branch || 'its run\'s branch') + (l.head ? ' as ' : ''), l.head ? shortId(l.head, 'Copy commit') : null, '; its merge request comes next')
  : l.state === 'merging' ? el('div', {}, 'Accepted — merging into ' + via(l.base) + ' now')
  // ADR-0068: the base moved since the result's work started, so it is made again on top of it and checked again first.
  : l.state === 'rebase' ? el('div', {}, 'Accepted — ' + via(l.base) + ' moved on: rebasing onto it before the merge is asked')
  : l.state === 'resolving' ? el('div', {}, 'Accepted — its rebase onto ' + via(l.base) + ' conflicts; its Worker is resolving it')
  : l.state === 'recheck' ? el('div', {}, 'Accepted; its required checks run in full on the tree to merge into ' + via(l.base) + ' before the merge is asked')
  : l.state === 'returning' || l.state === 'returned' ? el('div', {}, 'Accepted, but it cannot land on ' + via(l.base) + ' as it is now: sent back as another attempt' + (l.reason ? ' — ' + l.reason : ''))
  // PROP-0016 I3: one result lands at a time on each base, so the base never moves under it.
  : l.state === 'queued' || l.state === 'stacked' ? el('div', {}, 'Accepted — waiting its turn to land on ' + via(l.base) + (l.state === 'stacked' ? ', stacked with the results next to it' : ', behind the result landing now') + ': one result lands at a time')
  : el('div', {}, 'Accepted — being committed on ' + (l.branch || 'its run\'s branch') + ' to be merged')
/** Who decided each step (ADR-0076): the operator, a project's lead (lead:<project>), or System. */
export const landingLine = (l: Landing): HTMLElement => {
  const line = landingText(l)
  const by = [l.acceptedBy ? 'accepted by ' + l.acceptedBy.label : '', l.approvedBy ? 'merge approved by ' + l.approvedBy.label : ''].filter(Boolean)
  if (by.length) line.append(el('span', { class: 'muted decider' }, ' · ' + by.join(' · ')))
  return line
}
/** Where a task's run started its work (ADR-0061), in words: from the change its previous attempt left, or over from the code. */
export const carryLine = (c: Carry): HTMLElement => {
  const from = c.from ? 'attempt ' + c.from.attempt : 'the previous attempt'
  const link: Child[] = c.from ? [' (', runLink(c.from.runId, 'its run'), ')'] : []
  // The outcome in a line; the worktree and commit mechanics folded (T171).
  return c.state === 'carried' ? el('li', {}, 'Continued from ' + from, link, whatIs('carry'),
    fold('Details', 'That change was already in its worktree' + (c.commit ? ', saved as ' : ''), c.commit ? shortId(c.commit, 'Copy commit') : null, '; its writing step built on it instead of starting over.'))
    : c.state === 'due' ? el('li', {}, 'Continues from ' + from, link, ' · before its first step', whatIs('carry'))
    : el('li', {}, 'Started over' + (c.reason ? ' — ' + c.reason.replace(/\.$/, '') : ''), link, whatIs('carry'),
      fold('Details', c.from ? 'The work ' + from + ' left was not reused: it started from the code.' : 'It started from the code.'))
}

// A review's evidence, read once per run and result (runs/<id>/review). A read that failed is kept too, so the 5-second refresh
// never reads it again: the operator asks for it again (readAgain), or the result changes.
export type Evidence = RunReview | { error: ApiError; runId: string }
const evidenceCache = new Map<string, { key: string; value: Evidence }>()
export const reviewOf = async (runId: string, key: string): Promise<Evidence> => {
  const kept = evidenceCache.get(runId)
  if (kept && kept.key === key) return kept.value
  let value: Evidence
  try { value = await api<RunReview>('runs/' + encodeURIComponent(runId) + '/review') } catch (error) { value = { error: asApiError(error), runId } }
  if (evidenceCache.size > 50) evidenceCache.clear()
  evidenceCache.set(runId, { key, value })
  return value
}
const readAgain = (runId: string) => {
  const button = el('button', {}, 'Read it again')
  button.addEventListener('click', async () => { button.disabled = true; evidenceCache.delete(runId); await refresh() })
  return button
}
const SHOWN_LINES = 200
// One file's diff as text, each line marked by what it is; a long one shows its first lines and a "show all".
const diffLines = (text: string) => {
  const lines = text.split('\n')
  const line = (l: string) => el('span', l.startsWith('+') && !l.startsWith('+++') ? { class: 'add' } : l.startsWith('-') && !l.startsWith('---') ? { class: 'del' } : l.startsWith('@@') ? { class: 'hunk' } : {}, l + '\n')
  const pre = el('pre', { class: 'diff file' }, lines.slice(0, SHOWN_LINES).map(line))
  if (lines.length <= SHOWN_LINES) return pre
  const all = el('button', {}, 'Show all ' + lines.length + ' lines')
  all.addEventListener('click', () => { pre.replaceChildren(...lines.map(line)); all.remove() })
  return el('div', {}, pre, all)
}
const STATUS_WORD: Record<string, string> = { added: 'added', modified: 'changed', deleted: 'deleted', renamed: 'renamed' }
const unknownLine = (text: string, runId: string) => el('p', { class: 'unknown' }, text, readAgain(runId))
const workChangeView = (change: RunReview['change'], runId: string) => {
  if (!('value' in change)) return unknownLine('What changed is unknown (' + change.unknown + '). Do not accept what you could not see. ', runId)
  const { changes, unread } = change.value
  return el('div', { class: 'change' },
    unread.map((u) => el('p', { class: 'state failed', role: 'alert' }, 'The change in source ' + u.source + ' could not be read: ' + u.detail + '. Do not accept what you could not see. ', readAgain(runId))),
    !changes.length && !unread.length ? el('p', { class: 'muted' }, 'No worktree of this run holds a change: it wrote no file in one.') : null,
    changes.map((c) => {
      const count = (k: 'added' | 'removed') => c.files.reduce((n, f) => n + (f[k] || 0), 0)
      const total = c.files.length + c.more
      return el('div', { role: 'group', 'aria-label': 'Change on ' + c.branch },
        el('p', { class: 'stat' }, el('strong', {}, total + (total === 1 ? ' file' : ' files') + ' changed'), ' ', el('span', { class: 'add' }, '+' + count('added')), ' ', el('span', { class: 'del' }, '−' + count('removed')),
          el('span', { class: 'muted' }, ' · on ', shortId(c.branch, 'Copy branch'), ', against ' + c.base.branch + ' at ', shortId(c.base.sha, 'Copy commit'), c.fromBranch ? ' (its worktree was removed: what its branch holds)' : '')),
        el('ul', { class: 'files' }, c.files.map((f) => el('li', {}, el('details', {},
          el('summary', {}, shortId(f.path, 'Copy path'), ' ' + (STATUS_WORD[f.status] ?? f.status) + ' ', f.from ? ['from ', shortId(f.from, 'Copy path'), ' '] : null, f.binary || f.note ? el('span', { class: 'muted' }, f.binary ? 'binary' : f.note)
            : f.added === undefined ? el('span', { class: 'muted' }, 'not read') : [el('span', { class: 'add' }, '+' + f.added), ' ', el('span', { class: 'del' }, '−' + (f.removed || 0))]),
          f.diff !== undefined ? diffLines(f.diff) : el('p', { class: 'muted' }, f.binary ? 'A binary file: its content is not shown.' : f.note ? 'Not shown: ' + f.note + '.' : ['Not shown: the change is past what a page shows; read it in ', shortId(c.workspace, 'Copy path'), '.']),
          f.truncated ? el('p', { class: 'muted' }, 'Cut: read the whole file in ', shortId(c.workspace, 'Copy path'), '.') : null)))),
        c.more ? el('p', { class: 'muted' }, c.more + ' more file(s) are not listed: read them in ', shortId(c.workspace, 'Copy path'), '.') : null)
    }))
}
// A finding's severity rank (ADR-0075): important first, then pre-existing, then nits; an assessment@1.0's severities read alike.
const SEVERITY_RANK: Record<string, number> = { important: 0, blocking: 0, 'pre-existing': 1, nit: 2, warning: 2, info: 2 }
const findingBlocks = (f: Finding) => !f.repeated && (f.severity === 'blocking' || (f.severity === 'important' && f.verification?.vote === 'confirm'))
const bySeverity = (fs: Finding[]) => fs.map((f, i) => ({ f, i })).sort((a, b) => (Number(!!a.f.repeated) - Number(!!b.f.repeated)) || ((SEVERITY_RANK[a.f.severity] ?? 3) - (SEVERITY_RANK[b.f.severity] ?? 3))
  || (Number(!findingBlocks(a.f)) - Number(!findingBlocks(b.f))) || a.i - b.i).map((p) => p.f)
const VOTE_WORD: Record<string, string> = { confirm: 'confirmed', reject: 'rejected', none: 'unverified' }
const findingView = (f: Finding) => el('li', { class: findingBlocks(f) ? 'state failed' : '' }, el('span', { class: 'tag' }, f.severity),
  ' ' + f.title, f.file ? [' (', shortId(f.file, 'Copy path'), f.line ? ':' + f.line : '', ')'] : null, f.class ? ' [class: ' + f.class + ']' : null,
  f.verification ? [' ', el('span', { class: 'tag', title: 'the second reviewer\'s vote, by ' + f.verification.node }, VOTE_WORD[f.verification.vote] ?? f.verification.vote)] : null,
  f.repeated ? el('span', { class: 'muted' }, ' repeats ' + f.repeated + ', already answered: not counted') : null,
  f.demoted ? el('span', { class: 'muted' }, ' (read as a nit: no evidence given)') : null,
  f.evidence ? el('div', { class: 'muted' }, 'Evidence: ' + f.evidence) : null,
  f.verification?.reason ? el('div', { class: 'muted' }, 'Vote: ' + f.verification.reason) : null,
  f.detail ? el('div', { class: 'muted' }, f.detail) : null)
const verdictWord = (a: Assessment) => a.verdict === 'approve' ? 'Approved' : 'Changes requested'
// Each reviewer's verdict on the exact change, newest first, with its summary and its findings by severity and their votes; how many more there are.
const verdictsView = (assessments: RunReview['assessments']) => !('value' in assessments) ? el('p', { class: 'unknown' }, 'The reviewers\' verdicts are unknown (' + assessments.unknown + ').')
  : !assessments.value.length ? el('p', { class: 'muted' }, 'No reviewer gave a verdict on this change. When a review step of the run reads it, its verdict appears here.')
  : el('div', {}, el('ul', { class: 'verdicts' }, assessments.value.map((a) => el('li', {},
    el('strong', { class: a.verdict === 'approve' ? 'state completed' : 'state failed' }, verdictWord(a)), ' by the review at ' + (a.nodeId || 'a step') + (a.reviewer ? ' (' + a.reviewer + ')' : ''),
    a.summary ? el('div', { class: 'muted' }, a.summary) : null,
    a.findings.length ? el('ul', {}, bySeverity(a.findings).map(findingView)) : el('span', { class: 'muted' }, '; no finding')))),
    assessments.more ? el('p', { class: 'muted' }, 'The newest ' + assessments.value.length + ' verdicts are shown; ' + assessments.more + (assessments.moreAtLeast ? ' or more' : '') + ' older ' + (assessments.more === 1 && !assessments.moreAtLeast ? 'one is' : 'ones are') + ' not.') : null)
// The run's report in its own words: a line that says a criterion was not met or not measured is marked, the words stay the step's.
const reportView = (report: NonNullable<RunReview['report']>) => el('div', {},
  el('p', { class: 'muted' }, 'The run\'s last step, ' + report.nodeId + ', reported this, in its own words:'),
  el('pre', { class: 'report' }, report.text.split('\n').map((l) => el('span', /\b(not met|failed|not run)\b/i.test(l) ? { class: 'state failed' } : /\bnot measured\b/i.test(l) ? { class: 'soon' } : /\bmet\b/i.test(l) ? { class: 'state completed' } : {}, l + '\n'))),
  report.truncated ? el('p', { class: 'muted' }, 'Cut at 32,000 characters: the whole report is the run\'s answer.') : null)
/** On a run's page the report is its answer, already shown: `withReport` false leaves it out. */
export const evidenceView = (review: Evidence, withReport = true): HTMLElement => 'error' in review
  ? el('p', { class: 'state failed' }, 'What the run changed and what its steps said could not be read: ' + review.error.message + '. Do not accept what you could not see. ', readAgain(review.runId))
  : el('div', { class: 'evidence' },
    el('h4', {}, 'What changed'), workChangeView(review.change, review.runId),
    el('h4', {}, 'What the reviewers said'), verdictsView(review.assessments),
    review.report && withReport ? [el('h4', {}, 'What the checks measured'), reportView(review.report)] : null)

// Each check the policy requires of a review, with its state as the run recorded it: passed or failed (with its exit code) only on a
// record, not run and why, or pending; never "passed" without a record.
const CHECK_STATE: Record<string, [string, string]> = { passed: ['Passed', 'ok'], failed: ['Failed', 'bad'], 'not-run': ['Not run', 'warn'], pending: ['Pending', 'warn'] }
// A pass whose command reported tests it did not run (T247) is never a plain pass: it says so in warning color (T255).
const stateChip = (c: ReviewCheck) => { const [word, tone] = CHECK_STATE[c.state] ?? [c.state, 'idle']; return c.state === 'passed' && c.notRun ? chip('Passed, browser tests not run', 'warn') : chip(word, tone) }
const exitText = (c: ReviewCheck) => (c.exitCode !== undefined ? ' · exit code ' + c.exitCode : '')
const recorded = (r: ReviewCard) => r.checks?.value ?? []
/** The checks that passed without their browser tests: the board's auto-accept rule held the result for them (T255). */
export const unrunWarning = (r: ReviewCard): HTMLElement | null => {
  const unrun = recorded(r).filter((c) => c.state === 'passed' && c.notRun)
  if (!unrun.length) return null
  return el('p', { class: 'unrun-tests', role: 'note' },
    el('strong', {}, 'Checks passed, browser tests not run: ' + unrun.map((c) => c.check + ' (' + c.notRun + ' did not run)').join(', ') + '. '),
    'Their pass says nothing of those tests, so the result was not accepted automatically — run them where a browser is, or accept knowing they did not run.', whatIs('checks'))
}
// The warning is derived from the recorded states: a pending check the run recorded as failed is said to have failed, not to be not run (T160 review).
export const pendingWarning = (r: ReviewCard): HTMLElement | null => {
  if (!r.pendingChecks.length) return null
  const failed = r.pendingChecks.filter((c) => recorded(r).some((s) => s.check === c && s.state === 'failed'))
  const notRun = r.pendingChecks.filter((c) => !failed.includes(c))
  return el('p', { class: 'pending-checks', role: 'note' },
    failed.length ? el('strong', {}, 'Checks that failed: ' + failed.join(', ') + '. ') : null,
    notRun.length ? el('strong', {}, 'Checks not run: ' + notRun.join(', ') + '. ') : null,
    'Accepting counts them as passed — ' + (failed.length ? (notRun.length ? 'fix the failed ones and run the others first.' : 'fix them first.') : 'run them first.'),
    // A change in a run's worktree: the board refuses an acceptance past them (T293); only the operator accepts past a check not run, naming why below.
    ' For a change in a run\'s worktree the board refuses that: the system runs them on its tree, and to accept without one, say below why it did not run.', whatIs('checks'))
}
/** The checks the board holds pending that no run recorded as failed: the operator may accept past each, naming why (T293). */
export const notRunChecks = (r: ReviewCard): string[] => r.pendingChecks.filter((c) => ['tests', 'typecheck', 'lint'].includes(c) && !recorded(r).some((s) => s.check === c && s.state === 'failed'))
// A review card's first row (T186): the change in numbers, each required check as a chip, each reviewer's verdict as a chip.
export const changeSummary = (change: RunReview['change']): Child => {
  if (!('value' in change)) return chip('Change unknown', 'bad')
  const { changes, unread } = change.value
  if (!changes.length) return unread.length ? chip('Change unread', 'bad') : chip('No file changed', 'idle')
  const files = changes.reduce((n, c) => n + c.files.length + c.more, 0)
  const sum = (k: 'added' | 'removed') => changes.reduce((n, c) => n + c.files.reduce((m, f) => m + (f[k] || 0), 0), 0)
  return [el('span', { class: 'change-stat', 'aria-label': 'Change summary' }, qty(files, 'file') + ' ', el('span', { class: 'add' }, '+' + sum('added')), ' ', el('span', { class: 'del' }, '−' + sum('removed'))),
    unread.length ? chip('Partly unread', 'bad') : null]
}
/** A change that could not be read whole stays in sight: never accepted unseen. */
export const changeWarning = (change: RunReview['change'], runId?: string): HTMLElement | null => 'value' in change && !change.value.unread.length ? null
  : el('p', { class: 'state failed' }, 'What changed could not be read whole. Do not accept what you could not see. ', runId ? readAgain(runId) : null)
export const checkChips = (r: ReviewCard): Child => !r.checks ? null : [
  r.checks.value.length ? el('ul', { class: 'chips', 'aria-label': 'Required checks' }, r.checks.value.map((c) => el('li', {}, el('strong', {}, c.check + ': '), stateChip(c),
    c.state === 'passed' || c.state === 'failed' ? exitText(c) : ''))) : null,
  r.checks.requiredUnknown ? chip('Required checks unknown', 'warn') : null]
export const verdictChips = (assessments: RunReview['assessments']): Child => !('value' in assessments) ? chip('Verdicts unknown', 'idle')
  : !assessments.value.length ? chip('No reviewer verdict', 'idle')
  : el('ul', { class: 'chips', 'aria-label': 'Reviewers\' verdicts' }, assessments.value.map((a) => el('li', {},
    chip(verdictWord(a) + ' · ' + (a.reviewer || a.nodeId || 'a reviewer'), a.verdict === 'approve' ? 'ok' : 'bad'))),
    assessments.more ? el('li', { class: 'muted' }, '+' + assessments.more + (assessments.moreAtLeast ? ' or more' : '') + ' older') : null)
/** Each required check in full, under the card's Details: its state, and its exit code or why it has none. */
export const checksDetail = (r: ReviewCard): HTMLElement => {
  if (!r.checks) return el('p', { class: 'muted' }, r.pendingChecks.length ? 'Pending on the board: ' + r.pendingChecks.join(', ') + '; what the checks came to is not known here.' : 'No check is pending on the board; what the checks came to is not known here.')
  const list = r.checks.value
  return el('div', { class: 'checks' },
    list.length ? el('ul', { class: 'checks', 'aria-label': 'Each required check' }, list.map((c) => el('li', {}, el('strong', {}, c.check + ': '),
      stateChip(c), c.state === 'passed' || c.state === 'failed' ? exitText(c) + (c.notRun ? ' — ' + c.notRun + ' did not run' : '') : ' — ' + c.why)))
      : el('p', { class: 'muted' }, 'The policy requires no check of this kind of work.'),
    r.checks.requiredUnknown ? el('p', { class: 'unknown' }, 'Which checks the policy requires is unknown (' + r.checks.requiredUnknown + '): those listed are the ones the board holds pending.') : null)
}
