// "Held for you": every result held for the operator in one list, oldest expiry first, decided together (T336). Each row is still its own decision (INV-5), sent one by one with the same note.
import type { ReviewCard } from '../src/api.js'
import { absolute, ago, chip, el, expires, recording, type Child } from './dom.js'
import { changeSummary, checkChips, notRunChecks, type Evidence } from './evidence.js'
import { decideTogether, digestLines, heldOrder, isExpired, whyHeld, type NotRun, type RowResult, type Send, type Verdict } from './heldbatch.js'
import { noteInput, notes } from './queue.js'
import { jump } from './router.js'
import { refresh, refusal, report } from './state.js'

export const notRunKey = (r: ReviewCard, c: string) => 'notrun-' + r.taskId + '-' + c
const NOTE_KEY = 'held-note'
// What the page keeps through its refreshes: the rows selected, and what a row's last try said (a refusal, or the why still asked).
const selected = new Set<string>(), said = new Map<string, string>()

const notRunOf = (r: ReviewCard): NotRun => {
  const needed = notRunChecks(r)
  return { needed, given: Object.fromEntries(needed.map((c) => [c, (notes.get(notRunKey(r, c)) || '').trim()]).filter(([, why]) => why)) }
}
const verdictChip = (a: { verdict: string; nodeId?: string; reviewer?: string }, family: string | undefined) => chip((a.verdict === 'approve' ? 'Approved' : 'Changes requested') + ' · ' + (a.reviewer || a.nodeId || 'a reviewer') + (family ? ' (' + family + ')' : ''), a.verdict === 'approve' ? 'ok' : 'bad')
const verdictsOf = (evidence: Evidence | undefined, families: Map<string, string>): Child => {
  if (!evidence || 'error' in evidence || !('value' in evidence.assessments)) return chip('Verdicts unknown', 'idle')
  const list = evidence.assessments.value
  return list.length ? el('ul', { class: 'chips', 'aria-label': 'Reviewers\' verdicts and families' }, list.map((a) => el('li', {}, verdictChip(a, a.reviewer ? families.get(a.reviewer) : undefined)))) : chip('No reviewer verdict', 'idle')
}

const row = (r: ReviewCard, evidence: Evidence | undefined, families: Map<string, string>, count: () => void): HTMLElement => {
  const read = evidence && !('error' in evidence) ? evidence : undefined, lines = digestLines(read?.report?.text), needed = notRunChecks(r)
  const box = el('input', { type: 'checkbox', 'aria-label': 'Select ' + r.title, onchange: () => { if (box.checked) selected.add(r.taskId); else selected.delete(r.taskId); count() } })
  box.checked = selected.has(r.taskId)
  const result = el('p', { class: 'row-result state failed', role: 'status', 'data-result': r.taskId }, said.get(r.taskId))
  if (!said.has(r.taskId)) result.hidden = true
  return el('li', { class: 'held-row', 'data-task': r.taskId },
    el('div', { class: 'line' }, box, el('strong', {}, isExpired(r) ? r.title : jump('review-' + r.taskId, r.title)), ' ',
      isExpired(r) ? [chip('Review expired', 'warn'), ' ', el('span', { class: 'expiry soon' }, 'Expired ', ago(r.expiredAt as string), ' · can be reopened until ', absolute(r.expiresAt as string))] : r.expiresAt ? expires(r.expiresAt) : null, el('span', { class: 'muted' }, ' · ' + (r.project.title || r.project.projectId))),
    el('p', { class: 'why' }, el('strong', {}, 'Held: '), whyHeld(r)),
    el('div', { class: 'summary' }, read ? changeSummary(read.change) : chip('Change unknown', 'idle'), checkChips(r), verdictsOf(evidence, families)),
    lines.length ? el('div', { class: 'digest muted', 'aria-label': 'Its digest' }, lines.map((l) => el('div', {}, l))) : null,
    needed.length ? el('div', { class: 'not-run' }, needed.map((c) => {
      const id = 'held-' + notRunKey(r, c)
      return el('p', {}, el('label', { for: id }, 'Accept with ' + c + ' not run, because: '), noteInput(id, notRunKey(r, c), { maxlength: '500' }))
    })) : null,
    result)
}

/** The section, or null when nothing is held. `send` is the one decision the page records for a row (the same as a card's). */
export function heldSection(list: ReviewCard[], evidence: Map<string, Evidence | undefined>, families: Map<string, string>, send: Send): HTMLElement | null {
  const held = heldOrder(list)
  for (const id of selected) if (!held.some((r) => r.taskId === id)) selected.delete(id)
  for (const id of said.keys()) if (!held.some((r) => r.taskId === id)) said.delete(id)
  if (!held.length) return null
  const accept = el('button', { type: 'button', class: 'primary' }), back = el('button', { type: 'button' })
  const count = () => {
    const reopened = held.filter((r) => selected.has(r.taskId) && isExpired(r)).length
    accept.textContent = 'Accept ' + selected.size + ' selected' + (reopened ? ' (reopens ' + reopened + ' expired)' : ''); back.textContent = 'Send back ' + selected.size + ' selected'
    accept.disabled = back.disabled = !selected.size
  }
  const section = el('section', { class: 'panel held', id: 'held', tabindex: '-1', 'aria-label': 'Held for you' },
    el('h3', { class: 'kind' }, 'Held for you'),
    el('p', { class: 'muted' }, held.length + (held.length === 1 ? ' result waits' : ' results wait') + ' for you, the one that expires first on top. Select some to decide them together: each is still its own decision, recorded one by one with the same note.'),
    el('div', { class: 'actions' }, accept, back, el('label', { for: 'note-' + NOTE_KEY }, 'Note for all (optional)', noteInput('note-' + NOTE_KEY, NOTE_KEY))),
    el('ul', { class: 'held-rows' }, held.map((r) => row(r, evidence.get(r.taskId), families, count))))
  count()
  const show = (id: string, text: string | undefined) => {
    const line = section.querySelector<HTMLElement>('[data-result="' + id + '"]')
    if (!line) return
    line.textContent = text ?? ''
    line.hidden = !text
  }
  const decide = (verdict: Verdict, clicked: HTMLButtonElement) => void recording([accept, back], clicked, async () => {
    const rows = held.filter((r) => selected.has(r.taskId))
    if (!rows.length) return
    const results = await decideTogether(rows, verdict, (notes.get(NOTE_KEY) || '').trim(), notRunOf, send, refusal)
    const word = verdict === 'accept' ? 'Accept' : 'Send back'
    const lines: string[] = []
    for (const r of rows) {
      const res = results.get(r.taskId) as RowResult
      if (res.state === 'recorded') {
        selected.delete(r.taskId); said.delete(r.taskId)
        for (const c of notRunChecks(r)) notes.delete(notRunKey(r, c))
        // At once: its row and its card leave, so no stale Accept is left to press.
        section.querySelector('[data-task="' + r.taskId + '"]')?.remove()
        document.getElementById('review-' + r.taskId)?.remove()
        lines.push((verdict === 'accept' ? 'Accepted: ' : 'Sent back: ') + r.title + ' — recorded as your decision ' + res.decision + '; the task is now ' + res.task + '.')
      } else {
        const text = res.state === 'refused' ? 'Not recorded: the server refused it ' + res.reason + '. Nothing was decided: it is still held for you.'
          : 'Not sent: say why ' + res.checks.join(', ') + ' did not run, then ' + word.toLowerCase() + ' again.'
        said.set(r.taskId, text); show(r.taskId, text)
        lines.push(r.title + ' — ' + text)
      }
    }
    const recorded = [...results.values()].filter((x) => x.state === 'recorded').length, open = rows.length - recorded
    if (recorded) notes.delete(NOTE_KEY)
    if (!section.querySelector('.held-row')) section.remove()
    report(!open, recorded + (verdict === 'accept' ? ' accepted' : ' sent back') + (open ? ' · ' + open + ' not recorded' : ''), lines)
  }, refresh)
  accept.addEventListener('click', () => decide('accept', accept))
  back.addEventListener('click', () => decide('reject', back))
  return section
}
