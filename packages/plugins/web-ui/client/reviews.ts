// The board's tasks in review, one card each: the operator's Accept or Send back names the exact result shown (INV-5). Absent when no board runs.
import type { AcceptedCard, ReviewCard, ReviewDecideResponse, ReviewReopenResponse, ReviewsResponse, RosterResponse } from '../src/api.js'
import { heldSection, notRunKey } from './held.js'
import { reopenFirst, type Send } from './heldbatch.js'
import { isKnown } from './roster.js'
import { absolute, ago, cardFold, copyId, el, expires, keptFold, recording, relative, shortId, verdictButtons, type Child } from './dom.js'
import { changeSummary, changeWarning, checkChips, checksDetail, evidenceView, landingLine, notRunChecks, pendingWarning, reviewOf, unrunWarning, verdictChips, type Evidence } from './evidence.js'
import { whatIs } from './glossary.js'
import { runLink } from './router.js'
import { api, app, asApiError, quiet, refresh, refusal, report } from './state.js'
import { noteInput, notes, subjectText } from './queue.js'

const notRunInputs = (r: ReviewCard) => {
  const checks = notRunChecks(r)
  if (!checks.length || r.heldFor !== 'operator') return null
  return el('div', { class: 'not-run' }, checks.map((c) => {
    const id = notRunKey(r, c)
    return el('p', {}, el('label', { for: id }, 'Accept with ' + c + ' not run, because: '), noteInput(id, id, { maxlength: '500' }))
  }))
}
const checksNotRunOf = (r: ReviewCard): Record<string, string> => Object.fromEntries(notRunChecks(r).map((c) => [c, (notes.get(notRunKey(r, c)) || '').trim()]).filter(([, note]) => note))

export interface Reviews {
  listed: ReviewCard[]
  accepted: AcceptedCard[]
  /** The reviews held for the operator that expire. */
  held: ReviewCard[]
  /** "Held for you": all of them (a project's, when named) in one list to decide together (T336); null when none is held. */
  heldView: (project?: string | null) => HTMLElement | null
  sectionOf: (list?: ReviewCard[], id?: string, level?: 'h2' | 'h3', withAccepted?: boolean) => HTMLElement
  acceptedView: (list: AcceptedCard[] | undefined, level: 'h2' | 'h3' | 'h4') => HTMLElement | null
}
export type ReviewsRead = Reviews | { failed: HTMLElement } | null

// A review held for the operator expires unseen, and its task then waits for input that only a re-opening revives.
const heldOf = (list: ReviewCard[]) => list.filter((r) => r.heldFor === 'operator' && r.expiresAt)

export async function reviews(): Promise<ReviewsRead> {
  let listed: ReviewCard[], accepted: AcceptedCard[] | undefined, expired: ReviewCard[] = []
  try { ({ reviews: listed, accepted, expired = [] } = await api<ReviewsResponse>('reviews')) } catch (error) {
    const e = asApiError(error)
    return e.status === 503 ? null : { failed: el('section', { id: 'reviews', tabindex: '-1', 'aria-label': 'Reviews' }, el('h2', {}, 'Reviews'), el('p', { class: 'state failed' }, 'The reviews could not be read: ' + e.message + '. The page tries again every 5 seconds.')) }
  }
  // One decision on the exact result the page showed (INV-5); a card and a row of "Held for you" send it the same way.
  const decideSend: Send = async (r, verdict, note, checksNotRun) => {
    const { task, decision } = await api<ReviewDecideResponse>('reviews/' + encodeURIComponent(r.taskId) + '/decide', { verdict, subject: r.subject, note, ...(Object.keys(checksNotRun).length ? { checksNotRun } : {}) })
    return { decision, task: task.state }
  }
  // A result whose review expired is reopened first, its own recorded decision, then accepted as a held result is (T350).
  const send = reopenFirst(decideSend, async (r) => {
    const { task } = await api<ReviewReopenResponse>('reviews/' + encodeURIComponent(r.taskId) + '/reopen', { subject: r.subject, reason: 'reopened from Held for you' })
    return { pendingChecks: task.waiting?.pendingChecks ?? [] }
  })
  const decide = (r: ReviewCard, verdict: 'accept' | 'reject', buttons: HTMLButtonElement[], clicked: HTMLButtonElement) => recording(buttons, clicked, async () => {
    const key = 'review-' + r.taskId
    try {
      const { task, decision } = await send(r, verdict, (notes.get(key) || '').trim(), verdict === 'accept' ? checksNotRunOf(r) : {})
      notes.delete(key)
      report(true, (verdict === 'accept' ? 'Accepted: ' : 'Sent back: ') + r.title, ['Recorded as your acceptance decision ' + decision + '. The task is now ' + task + (verdict === 'accept' ? '; tasks that depend on it become ready on the board\'s next sweep. When its result is a run\'s worktree, the system commits it on the run\'s branch and asks you here to merge it: see it under Accepted, on their way in.' : '; it goes back for another attempt if it has one left.')])
    } catch (error) {
      report(false, 'Not recorded: ' + (verdict === 'accept' ? 'Accept' : 'Send back') + ' on ' + r.title, ['The server refused it ' + refusal(error) + '. Nothing was decided: the task is still in review.'])
    }
  }, refresh)
  const card = (r: ReviewCard, evidence: Evidence | undefined) => {
    const buttons = verdictButtons('marks it done', 'sends it back for another attempt, if it has one left', (verdict, pair, clicked) => void decide(r, verdict === 'approved' ? 'accept' : 'reject', pair, clicked), 'Accept', 'Send back')
    const key = 'review-' + r.taskId, read = evidence && !('error' in evidence) ? evidence : undefined
    return el('article', { class: 'panel request', id: 'review-' + r.taskId, tabindex: '-1', 'aria-labelledby': 'review-title-' + r.taskId },
      el('div', { class: 'line' }, el('h3', { id: 'review-title-' + r.taskId }, r.title)),
      el('p', { class: 'meta' }, !r.expiresAt ? 'No expiry known' : r.heldFor === 'operator' ? expires(r.expiresAt) : ['Its reviewer\'s until ', ago(r.expiresAt)]),
      el('div', { class: 'summary' }, read ? changeSummary(read.change) : null, checkChips(r), read ? verdictChips(read.assessments) : null),
      evidence && 'error' in evidence ? evidenceView(evidence) : null,
      read ? changeWarning(read.change, r.run?.runId) : null,
      pendingWarning(r),
      notRunInputs(r),
      unrunWarning(r),
      el('div', { class: 'actions' }, buttons),
      cardFold(key,
        r.goal ? el('p', {}, el('strong', {}, 'Asked: '), r.goal) : null,
        el('p', {}, el('span', { class: 'tag' }, r.actionClass), ' project ' + (r.project.title || r.project.projectId) + ' · task ', shortId(r.taskId, 'Copy task ID'), r.expiresAt ? ' · expires ' + absolute(r.expiresAt) : '',
          r.heldFor === 'operator' && r.expiresAt ? ' · No response: it waits for input' : ''),
        el('p', {}, r.run ? runLink(r.run.runId, 'open the run that made it') : 'no run is named'),
        el('dl', {}, el('dt', {}, 'Exact result'), el('dd', {}, el('div', {}, el('code', { class: 'subject' }, subjectText(r.subject)), copyId('Copy result', subjectText(r.subject))), r.artifacts.map((a) => el('div', {}, shortId(a, 'Copy artifact ID'))))),
        el('h4', {}, 'Required checks'), checksDetail(r),
        read ? evidenceView(read) : null,
        el('div', { class: 'actions' }, el('label', { for: 'note-' + key }, 'Note with your verdict (optional)', noteInput('note-' + key, key)))))
  }
  // Every card once, its evidence read; Home places each in its project's group (T253).
  const evidence = new Map(await Promise.all([...listed, ...expired].map(async (r): Promise<[string, Evidence | undefined]> => [r.taskId, r.run ? await reviewOf(r.run.runId, subjectText(r.subject)) : undefined])))
  const cards = new Map(listed.map((r): [string, HTMLElement] => [r.taskId, card(r, evidence.get(r.taskId))]))
  // Each Worker's provider family, to say which family each reviewer is of (a heavy result needs two).
  const workers = heldOf(listed).length || expired.length ?(await quiet<RosterResponse>('roster'))?.workers : undefined
  const families = new Map<string, string>()
  for (const w of workers && isKnown(workers) ? workers.value : []) if (isKnown(w.family)) { families.set(w.worker, w.family.value); families.set(w.name, w.family.value) }
  const heldView: Reviews['heldView'] = (project) => heldSection([...listed, ...expired].filter((r) => !project || r.project.projectId === project), evidence, families, send)
  // Each accepted result still on its way into the repository, its project named unless its group's heading or the page's filter already names it (T256).
  const acceptedView: Reviews['acceptedView'] = (list, level) => list?.length ? el('section', { 'aria-label': 'Accepted, on their way in' }, el(level, { class: 'kind' }, 'Accepted, on their way in', whatIs('landing')),
    list.map((a) => el('article', { class: 'panel request', 'aria-label': 'Accepted: ' + a.title }, el('h4', {}, a.title),
      el('p', { class: 'meta' }, level !== 'h4' && !app.homeProject ? 'Project ' + (a.project.title || a.project.projectId) + ' · task ' : 'Task ', shortId(a.taskId, 'Copy task ID')), landingLine(a.landing),
      a.run ? el('p', {}, runLink(a.run.runId, 'open its run')) : null))) : null
  // The Reviews of some of the listed reviews (all by default): a page's own section (h2), or a kind within a project's group (h3).
  const sectionOf: Reviews['sectionOf'] = (list = listed, id = 'reviews', level = 'h2', withAccepted = true) => {
    const mine = heldOf(list), first = mine.reduce<string | undefined>((min, r) => !min || (r.expiresAt ?? '') < min ? r.expiresAt : min, undefined), soon = first !== undefined && Date.parse(first) - Date.now() < 3600000
    const expiry = (first: string): Child => {
      const said = [mine.length + (mine.length === 1 ? ' review is' : ' reviews are') + ' held for you; the first expires ',
        el('span', { class: soon ? 'soon' : '' }, relative(first) + ' — ' + absolute(first)), '. Unanswered by then, its task waits for input, which only a re-opening revives (board_reopen_review).']
      return soon ? el('p', {}, said) : keptFold(id + '-expiry', 'When they expire', said)
    }
    const section = el('section', { id, tabindex: '-1', 'aria-label': 'Reviews' }, el(level, { class: 'kind' }, 'Reviews', whatIs('review')),
      first ? expiry(first) : null,
      list.length ? list.map((r) => cards.get(r.taskId)) : el('p', { class: 'muted' }, 'No review waits. When a Worker finishes a task, its result waits here for you to accept it or send it back.'),
      withAccepted ? acceptedView(accepted, level === 'h2' ? 'h3' : 'h4') : null)
    if (first) section.dataset.firstExpires = first
    section.dataset.count = String(list.length)
    return section
  }
  return { listed, accepted: accepted ?? [], held: heldOf(listed), heldView, sectionOf, acceptedView }
}
