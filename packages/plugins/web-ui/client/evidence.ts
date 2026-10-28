// What the operator reads before a review verdict (T122): where an accepted result stands, the run's change, each reviewer's verdict, the run's report, each required check (ADR-0063).
import type { Assessment, Carry, Finding, Landing, ReviewCard, ReviewCheck, RunReview } from '../src/api.js'
import { chip, el, fold, qty, shortId, type Child } from './dom.js'
import { whatIs } from './glossary.js'
import { decideLink, runLink } from './router.js'
import { api, asApiError, refresh, type ApiError } from './state.js'

const via = (base: string | undefined) => base || 'its base'
const landingText = (l: Landing): HTMLElement => l.state === 'asked' && l.requestId ? el('div', {}, 'Accepted — waiting to merge into ' + via(l.base) + ': ', decideLink(l.requestId, 'approve'))
  : l.state === 'merged' ? el('div', {}, 'Accepted and merged into ' + via(l.base) + (l.commit ? ' as ' : ''), l.commit ? shortId(l.commit, 'Copy commit') : null, el('span', { class: 'muted' }, ' · not pushed'))
  : l.state === 'refused' ? el('div', {}, 'Accepted — not merged: ' + (l.reason || 'refused'))
  : l.state === 'rejected' ? el('div', {}, 'Accepted — the merge was not approved; ' + (l.branch || 'its branch') + ' keeps the commit')
  : l.state === 'committed' ? el('div', {}, 'Accepted and committed on ' + (l.branch || 'its run\'s branch') + (l.head ? ' as ' : ''), l.head ? shortId(l.head, 'Copy commit') : null, '; its merge request comes next')
  : l.state === 'merging' ? el('div', {}, 'Accepted — merging into ' + via(l.base) + ' now')
  : l.state === 'rebase' ? el('div', {}, 'Accepted — ' + via(l.base) + ' moved on: rebasing onto it before the merge is asked')
  : l.state === 'resolving' ? el('div', {}, 'Accepted — its rebase onto ' + via(l.base) + ' conflicts; its Worker is resolving it')
  : l.state === 'recheck' ? el('div', {}, 'Accepted; its required checks run in full on the tree to merge into ' + via(l.base) + ' before the merge is asked')
  : l.state === 'returning' || l.state === 'returned' ? el('div', {}, 'Accepted, but it cannot land on ' + via(l.base) + ' as it is now: sent back as another attempt' + (l.reason ? ' — ' + l.reason : ''))
  : l.state === 'queued' || l.state === 'stacked' ? el('div', {}, 'Accepted — waiting its turn to land on ' + via(l.base) + (l.state === 'stacked' ? ', stacked with the results next to it' : ', behind the result landing now') + ': one result lands at a time')
  : el('div', {}, 'Accepted — being committed on ' + (l.branch || 'its run\'s branch') + ' to be merged')
/** Where an accepted result stands (ADR-0060) and who decided each step (ADR-0076): the operator, a project's lead, or System. */
export const landingLine = (l: Landing): HTMLElement => {
  const line = landingText(l)
  const by = [l.acceptedBy ? 'accepted by ' + l.acceptedBy.label : '', l.approvedBy ? 'merge approved by ' + l.approvedBy.label : ''].filter(Boolean)
  if (by.length) line.append(el('span', { class: 'muted decider' }, ' · ' + by.join(' · ')))
  return line
}
/** Where a task's run started its work (ADR-0061): from the change its previous attempt left, or over from the code. */
export const carryLine = (c: Carry): HTMLElement => {
  const from = c.from ? 'attempt ' + c.from.attempt : 'the previous attempt', link: Child[] = c.from ? [' (', runLink(c.from.runId, 'its run'), ')'] : []
  return c.state === 'carried' ? el('li', {}, 'Continued from ' + from, link, whatIs('carry'),
    fold('Details', 'That change was already in its worktree' + (c.commit ? ', saved as ' : ''), c.commit ? shortId(c.commit, 'Copy commit') : null, '; its writing step built on it instead of starting over.'))
    : c.state === 'due' ? el('li', {}, 'Continues from ' + from, link, ' · before its first step', whatIs('carry'))
    : el('li', {}, 'Started over' + (c.reason ? ' — ' + c.reason.replace(/\.$/, '') : ''), link, whatIs('carry'),
      fold('Details', c.from ? 'The work ' + from + ' left was not reused: it started from the code.' : 'It started from the code.'))
}
// A review's evidence, read once per run and result; a failed read is kept too, until the operator asks again (readAgain) or the result changes.
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
const readAgain = (runId: string) => el('button', { onclick: async (e) => { (e.currentTarget as HTMLButtonElement).disabled = true; evidenceCache.delete(runId); await refresh() } }, 'Read it again')
const SHOWN_LINES = 200
const diffLines = (text: string) => {
  const lines = text.split('\n'), line = (l: string) => el('span', l.startsWith('+') && !l.startsWith('+++') ? { class: 'add' } : l.startsWith('-') && !l.startsWith('---') ? { class: 'del' } : l.startsWith('@@') ? { class: 'hunk' } : {}, l + '\n')
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
      const count = (k: 'added' | 'removed') => c.files.reduce((n, f) => n + (f[k] || 0), 0), total = c.files.length + c.more
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
const verdictsView = (assessments: RunReview['assessments']) => !('value' in assessments) ? el('p', { class: 'unknown' }, 'The reviewers\' verdicts are unknown (' + assessments.unknown + ').')
  : !assessments.value.length ? el('p', { class: 'muted' }, 'No reviewer gave a verdict on this change. When a review step of the run reads it, its verdict appears here.')
  : el('div', {}, el('ul', { class: 'verdicts' }, assessments.value.map((a) => el('li', {},
    el('strong', { class: a.verdict === 'approve' ? 'state completed' : 'state failed' }, verdictWord(a)), ' by the review at ' + (a.nodeId || 'a step') + (a.reviewer ? ' (' + a.reviewer + ')' : ''),
    a.summary ? el('div', { class: 'muted' }, a.summary) : null,
    a.findings.length ? el('ul', {}, bySeverity(a.findings).map(findingView)) : el('span', { class: 'muted' }, '; no finding')))),
    assessments.more ? el('p', { class: 'muted' }, 'The newest ' + assessments.value.length + ' verdicts are shown; ' + assessments.more + (assessments.moreAtLeast ? ' or more' : '') + ' older ' + (assessments.more === 1 && !assessments.moreAtLeast ? 'one is' : 'ones are') + ' not.') : null)
const reportView = (report: NonNullable<RunReview['report']>) => el('div', {},
  el('p', { class: 'muted' }, 'The run\'s last step, ' + report.nodeId + ', reported this, in its own words:'),
  el('pre', { class: 'report' }, report.text.split('\n').map((l) => el('span', /\b(not met|failed|not run)\b/i.test(l) ? { class: 'state failed' } : /\bnot measured\b/i.test(l) ? { class: 'soon' } : /\bmet\b/i.test(l) ? { class: 'state completed' } : {}, l + '\n'))),
  report.truncated ? el('p', { class: 'muted' }, 'Cut at 32,000 characters: the whole report is the run\'s answer.') : null)
export const evidenceView = (review: Evidence, withReport = true): HTMLElement => 'error' in review
  ? el('p', { class: 'state failed' }, 'What the run changed and what its steps said could not be read: ' + review.error.message + '. Do not accept what you could not see. ', readAgain(review.runId))
  : el('div', { class: 'evidence' },
    el('h4', {}, 'What changed'), workChangeView(review.change, review.runId),
    el('h4', {}, 'What the reviewers said'), verdictsView(review.assessments),
    review.report && withReport ? [el('h4', {}, 'What the checks measured'), reportView(review.report)] : null)
const CHECK_STATE: Record<string, [string, string]> = { passed: ['Passed', 'ok'], failed: ['Failed', 'bad'], 'not-run': ['Not run', 'warn'], pending: ['Pending', 'warn'] }
// A pass whose command reported tests it did not run (T247) is never a plain pass; never "passed" without a record.
const stateChip = (c: ReviewCheck) => { const [word, tone] = CHECK_STATE[c.state] ?? [c.state, 'idle']; return c.state === 'passed' && c.notRun ? chip('Passed, browser tests not run', 'warn') : chip(word, tone) }
const exitText = (c: ReviewCheck) => (c.exitCode !== undefined ? ' · exit code ' + c.exitCode : '')
const recorded = (r: ReviewCard) => r.checks?.value ?? []
export const unrunWarning = (r: ReviewCard): HTMLElement | null => {
  const unrun = recorded(r).filter((c) => c.state === 'passed' && c.notRun)
  if (!unrun.length) return null
  return el('p', { class: 'unrun-tests', role: 'note' },
    el('strong', {}, 'Checks passed, browser tests not run: ' + unrun.map((c) => c.check + ' (' + c.notRun + ' did not run)').join(', ') + '. '),
    'Their pass says nothing of those tests, so the result was not accepted automatically — run them where a browser is, or accept knowing they did not run.', whatIs('checks'))
}
export const pendingWarning = (r: ReviewCard): HTMLElement | null => {
  if (!r.pendingChecks.length) return null
  const failed = r.pendingChecks.filter((c) => recorded(r).some((s) => s.check === c && s.state === 'failed')), notRun = r.pendingChecks.filter((c) => !failed.includes(c))
  return el('p', { class: 'pending-checks', role: 'note' },
    failed.length ? el('strong', {}, 'Checks that failed: ' + failed.join(', ') + '. ') : null,
    notRun.length ? el('strong', {}, 'Checks not run: ' + notRun.join(', ') + '. ') : null,
    'Accepting counts them as passed — ' + (failed.length ? (notRun.length ? 'fix the failed ones and run the others first.' : 'fix them first.') : 'run them first.'),
    ' For a change in a run\'s worktree the board refuses that: the system runs them on its tree, and to accept without one, say below why it did not run.', whatIs('checks'))
}
/** The pending checks no run recorded as failed: the operator may accept past each, naming why (T293). */
export const notRunChecks = (r: ReviewCard): string[] => r.pendingChecks.filter((c) => ['tests', 'typecheck', 'lint'].includes(c) && !recorded(r).some((s) => s.check === c && s.state === 'failed'))
export const changeSummary = (change: RunReview['change']): Child => {
  if (!('value' in change)) return chip('Change unknown', 'bad')
  const { changes, unread } = change.value
  if (!changes.length) return unread.length ? chip('Change unread', 'bad') : chip('No file changed', 'idle')
  const files = changes.reduce((n, c) => n + c.files.length + c.more, 0), sum = (k: 'added' | 'removed') => changes.reduce((n, c) => n + c.files.reduce((m, f) => m + (f[k] || 0), 0), 0)
  return [el('span', { class: 'change-stat', 'aria-label': 'Change summary' }, qty(files, 'file') + ' ', el('span', { class: 'add' }, '+' + sum('added')), ' ', el('span', { class: 'del' }, '−' + sum('removed'))),
    unread.length ? chip('Partly unread', 'bad') : null]
}
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
export const checksDetail = (r: ReviewCard): HTMLElement => {
  // Why the board holds it for the operator, in the hold decision's words (T330): a heavy hold has no check pending.
  const held = r.holdReason ? el('p', { class: 'held-reason' }, 'Held for the operator: ' + r.holdReason) : null
  if (!r.checks) return el('div', { class: 'checks' }, held, el('p', { class: 'muted' }, r.pendingChecks.length ? 'Pending on the board: ' + r.pendingChecks.join(', ') + '; what the checks came to is not known here.' : 'No check is pending on the board; what the checks came to is not known here.'))
  const list = r.checks.value
  return el('div', { class: 'checks' }, held,
    list.length ? el('ul', { class: 'checks', 'aria-label': 'Each required check' }, list.map((c) => el('li', {}, el('strong', {}, c.check + ': '),
      stateChip(c), c.state === 'passed' || c.state === 'failed' ? exitText(c) + (c.notRun ? ' — ' + c.notRun + ' did not run' : '') : ' — ' + c.why)))
      : el('p', { class: 'muted' }, 'The policy requires no check of this kind of work.'),
    r.checks.requiredUnknown ? el('p', { class: 'unknown' }, 'Which checks the policy requires is unknown (' + r.checks.requiredUnknown + '): those listed are the ones the board holds pending.') : null)
}
