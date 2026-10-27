// The approval queue, by batch: each verdict names the exact subject shown (INV-5). Absent when no queue runs.
import type { ApprovalRequest, ApprovalsResponse, Batch, DecideResponse, PolicyResponse, ProjectsResponse, Subject, VerdictBody, ProjectCard } from '../src/api.js'
import { absolute, cardFold, chip, copyId, el, expires, fold, qtyView, relative, shortId, verdictButtons, decision, type Child } from './dom.js'
import { changeView } from './changeview.js'
import { describe, type Described } from './describe.js'
import { whatIs } from './glossary.js'
import { api, asApiError, refresh, refusal, report, type ApiError } from './state.js'

export const subjectText = (s: Subject): string => s.type + ' ' + s.ref + (s.version ? ' @ ' + s.version : '')
/** The notes the operator is typing, kept through the refresh. */
export const notes = new Map<string, string>()
export const noteInput = (id: string, key = id, props: Record<string, string> = {}): HTMLInputElement => {
  const input = el('input', { id, ...props, value: notes.get(key) || '', oninput: () => notes.set(key, input.value) })
  return input
}

const VERB: Record<string, string> = { approved: 'Approved', rejected: 'Denied' }
const NOUN: Record<string, string> = { approved: 'approval', rejected: 'denial' }
// Why a verdict was not applied, in plain words: each leaves its request as it was.
const REFUSED: Record<string, string> = {
  'unknown-request': 'the queue does not know this request any more. Nothing was decided.',
  'already-resolved': 'it was already decided, withdrawn, or expired before your verdict arrived. Your verdict was not applied.',
  expired: 'it expired before your verdict arrived; an unanswered request counts as denied. Your verdict was not applied.',
  'subject-changed': 'what it asks about changed since the page showed it. Nothing was decided: read it again, then decide.',
  failed: 'the queue could not store your verdict, and nothing of it changed. Try again.',
}
// A text as a person reads it first: the proposed set for a policy set's hash, a hash in parentheses left out, any other long
// hash cut to its first 8 characters. The exact text stays folded beside it.
const LONG_HASH = /(?:sha256:)?[0-9a-f]{16,}/
const plainly = (text: string) => text
  .replace(/the set (?:sha256:)?[0-9a-f]{16,}/g, 'the proposed set')
  .replace(/\s*\((?:at )?(?:sha256:)?[0-9a-f]{16,}\)/g, '')
  .replace(/(?:sha256:)?[0-9a-f]{16,}/g, (hash) => hash.replace(/^sha256:/, '').slice(0, 8) + '…')
const folded = (text: string, summary: string): Child[] => LONG_HASH.test(text) ? [plainly(text), el('details', {}, el('summary', {}, summary), el('code', { class: 'exact' }, text))] : [text]

export interface Queue {
  batches: Batch[]
  requests: ApprovalRequest[]
  described: Map<string, Described>
  projects: Map<string, ProjectCard>
  card: (r: ApprovalRequest) => HTMLElement
  decide: (verdicts: VerdictBody[], note: string | undefined, batchId: string | undefined, buttons: HTMLButtonElement[], clicked: HTMLButtonElement) => Promise<void>
  noteFor: (key: string, label: string) => HTMLElement
  noteOf: (key: string) => string
}
export type QueueRead = Queue | { error: ApiError } | null

/**
 * The open requests, each as a card the operator decides in place: on the home page, and on the page of what a request is about.
 * Null when no queue runs; `{ error }` when it could not be read.
 */
export async function queue(): Promise<QueueRead> {
  let batches: Batch[]
  try { ({ batches } = await api<ApprovalsResponse>('approvals')) } catch (error) { const e = asApiError(error); return e.status === 503 ? null : { error: e } }
  const requests = batches.flatMap((b) => b.requests)
  // The board's projects name what a charter or a task request is about; without a board, ids only.
  const projects = new Map<string, ProjectCard>()
  if (requests.some((r) => r.requester.component === 'board' || (r.requester.component === 'workflow' && (r.requester.runId || r.requester.taskId)))) {
    try { for (const p of (await api<ProjectsResponse>('projects')).projects) projects.set(p.projectId, p) } catch {}
  }
  const described = new Map(requests.map((r) => [r.requestId, describe(r, projects)]))
  const told = (id: string): Described => described.get(id) as Described
  const noteFor = (key: string, label: string) => el('label', { for: 'note-' + key }, label, noteInput('note-' + key, key))
  const noteOf = (key: string) => (notes.get(key) || '').trim()
  // One call for the verdicts shown; each result is reported, recorded or not, until dismissed.
  const decide: Queue['decide'] = async (verdicts, note, batchId, buttons, clicked) => {
    const labels = buttons.map((b) => b.textContent)
    for (const b of buttons) b.disabled = true
    clicked.textContent = 'Recording…'
    const many = verdicts.length > 1
    const first = verdicts[0] as VerdictBody
    const what = (v: VerdictBody) => VERB[v.verdict] + ': ' + told(v.requestId).title
    const lost = (v: VerdictBody) => 'your ' + NOUN[v.verdict] + ' of ' + told(v.requestId).title
    try {
      const { results } = await api<DecideResponse>('approvals/decide', { verdicts, ...(note ? { note } : {}), ...(batchId ? { batchId } : {}) })
      const refused = results.filter((r) => r.refused)
      const recorded = results.filter((r) => !r.refused)
      for (const v of verdicts) notes.delete(v.requestId)
      if (batchId && !refused.length) notes.delete(batchId)
      // What happens next first, each failure with why; the request and record ids folded (T171).
      const lines = results.map((r) => {
        const v = verdicts.find((x) => x.requestId === r.requestId) as VerdictBody
        return r.refused ? 'Not recorded: ' + lost(v) + ': ' + (REFUSED[r.refused] || r.refused)
          : (many ? what(v) + ' — ' : '') + (v.verdict === 'approved' ? told(r.requestId).next : 'Nothing of it goes ahead.')
      })
      const ids = fold('Record IDs', results.map((r) => el('div', {}, r.refused ? ['Request ', shortId(r.requestId, 'Copy request ID'), ': not recorded (' + r.refused + ').'] : ['Recorded as your verdict on request ', shortId(r.requestId, 'Copy request ID'), ' (approval record ', shortId(r.approval ?? '', 'Copy approval ID'), ').'])))
      const word = (VERB[first.verdict] ?? '').toLowerCase()
      report(!refused.length, refused.length ? (many ? recorded.length + ' ' + word + ' · ' + refused.length + ' not recorded' : 'Not recorded: ' + lost(first))
        : many ? recorded.length + ' ' + word : what(first), [...lines, ids])
    } catch (error) {
      report(false, 'Not recorded: ' + (many ? 'your ' + verdicts.length + ' verdicts' : lost(first)),
        ['The server refused the call ' + refusal(error) + '.', 'Nothing was decided: ' + (many ? 'the requests are' : 'the request is') + ' still open in the queue.'])
    }
    buttons.forEach((b, i) => { b.disabled = false; b.textContent = labels[i] ?? '' })
    await refresh()
  }
  const verdictOf = (r: ApprovalRequest, verdict: VerdictBody['verdict']): VerdictBody => ({ requestId: r.requestId, subject: r.subject, verdict, ...(noteOf(r.requestId) ? { note: noteOf(r.requestId) } : {}) })
  const card = (r: ApprovalRequest) => {
    const d = told(r.requestId)
    // Approve / Deny, what each does its accessible description (T191); the card is named by its title.
    const buttons = verdictButtons(d.yes, d.no, (verdict, pair, clicked) => void decide([verdictOf(r, verdict)], undefined, undefined, pair, clicked))
    // A policy change shows what it changes: its effective modes and the record's diff (INV-5: the subject is its set's hash).
    const shown = el('div', {})
    const showChange = async () => {
      try {
        const { changes } = await api<PolicyResponse>('policy')
        const change = (changes ?? []).find((c) => c.requestId === r.requestId)
        shown.replaceChildren(change ? changeView(change) : el('p', { class: 'muted' }, 'The change of ' + r.requestId + ' is not among the latest.'))
      } catch (error) { shown.replaceChildren(el('p', { class: 'state failed' }, 'The change could not be read: ' + asApiError(error).message)) }
    }
    // An irreversible consequence stays in sight, as a chip on the line (T172: never folded).
    const undone = (text?: string) => /Cannot be undone/.test(text || '')
    const irreversible = undone(d.deny) ? 'Deny cannot be undone' : undone(d.approve) ? 'Approve cannot be undone' : undone(r.action.consequences) ? 'Cannot be undone' : null
    const approveDeny = (): Child[] => [el('dt', {}, 'If you approve'), el('dd', {}, d.approve), el('dt', {}, 'If you deny'), el('dd', {}, d.deny)]
    // Its title and, as its one chip, an irreversible verdict; one line of context, when it expires; then the two buttons
    // (T239); every other fact under one closed Details (T186).
    return el('article', { class: 'panel request', id: 'request-' + r.requestId, tabindex: '-1', 'aria-labelledby': 'title-' + r.requestId },
      el('div', { class: 'line' }, el('h3', { id: 'title-' + r.requestId }, d.title), irreversible ? chip(irreversible, 'warn') : null),
      el('p', { class: 'meta' }, expires(r.expiresAt)),
      // A policy change's own diff stays one press away, beside the verdict buttons: never folded away (T186).
      el('div', { class: 'actions' }, buttons,
        r.action.class === 'policy-change' && r.requester.policyChangeId ? decision('Show change', 'shows what this request changes, below; decides nothing', { onclick: () => void showChange(), 'aria-label': 'Show the change of ' + r.requestId }) : null),
      shown,
      cardFold('request-' + r.requestId,
        el('p', {}, 'Asked by ' + d.by + ' · ', el('span', { class: 'tag' }, r.action.class), whatIs(r.action.class === 'policy-change' ? 'policy-change' : r.action.class === 'merge' ? 'merge' : 'action-class')),
        el('dl', {},
          d.for ? [el('dt', {}, 'For'), el('dd', {}, d.for)] : null,
          el('dt', {}, 'No response'), el('dd', {}, 'denied'),
          d.title === r.action.summary ? null : [el('dt', {}, 'Request'), el('dd', {}, folded(r.action.summary, 'details'))],
          el('dt', {}, 'About'), el('dd', {}, d.subject),
          el('dt', {}, 'Exact subject'), el('dd', {}, el('code', { class: 'subject' }, subjectText(r.subject)), copyId('Copy subject', subjectText(r.subject))),
          // A merge says what each verdict does in words first; the requester's own text, with its paths and hashes, after it (T141).
          r.action.consequences && d.approve && r.action.class === 'merge' ? [approveDeny(),
            el('dt', {}, 'In detail'), el('dd', {}, el('details', {}, el('summary', {}, 'what the system will do, exactly'), el('code', { class: 'exact' }, r.action.consequences)))]
            : r.action.consequences ? [el('dt', {}, 'What a verdict does'), el('dd', {}, folded(r.action.consequences, 'details'))]
            : d.approve ? approveDeny()
            : [el('dt', {}, 'What a verdict does'), el('dd', { class: 'muted' }, 'The requester did not say. Approving lets it go ahead with exactly what is shown; denying refuses it.')],
          r.action.recommendation ? [el('dt', {}, 'Recommended'), el('dd', {}, r.action.recommendation === 'approve' ? 'approve' : 'deny')] : null,
          d.more ? [el('dt', {}, 'How it works'), el('dd', {}, d.more)] : null),
        el('div', { class: 'actions' }, noteFor(r.requestId, 'Note (optional)')),
        el('div', { class: 'muted' }, 'request ', shortId(r.requestId, 'Copy request ID')), el('div', { class: 'muted' }, 'expires ' + absolute(r.expiresAt)),
        d.ids.map(([k, v]) => el('div', { class: 'muted' }, k + ' ' + v))))
  }
  return { batches, requests, described, projects, card, decide, noteFor, noteOf }
}

/**
 * The approval queue's cards: every batch, or, on Home, a project's (T253: a batch stays whole, in its first request's project).
 * Its section is named by its heading level: a page's own section (h2), or a kind within a project's group (h3).
 */
export function approvals(q: QueueRead, shown?: Batch[], id = 'approvals', level: 'h2' | 'h3' = 'h2'): HTMLElement | null {
  if (!q) return null
  if ('error' in q) return el('section', { id, tabindex: '-1', 'aria-label': 'Approval queue' }, el(level, {}, 'Approvals'),
    el('p', { class: 'state failed' }, 'The approval queue could not be read: ' + q.error.message + '. Approvals unknown; retrying every 5 s.'))
  const { card, decide, noteFor, noteOf } = q
  const batches = shown ?? q.batches
  const requests = batches.flatMap((b) => b.requests)
  const earliest = requests.reduce<string | undefined>((min, r) => !min || r.expiresAt < min ? r.expiresAt : min, undefined)
  // Its count is Home's tile; its next expiry, the first card's, or in sight when within the hour (T239).
  return el('section', { id, tabindex: '-1', 'aria-label': 'Approval queue' }, el(level, { class: 'kind' }, 'Approvals', whatIs('approval')),
    !requests.length || !earliest ? el('p', { class: 'muted' }, 'No approvals needed.')
      : Date.parse(earliest) - Date.now() < 3600000 ? el('p', { class: 'soon' }, 'Next expiry ' + relative(earliest)) : null,
    batches.map((batch) => {
      const batchId = batch.batchId
      if (!batchId) return el('div', {}, batches.length > 1 ? el('h3', {}, 'Decided one by one') : null, batch.requests.map(card))
      const n = batch.requests.length
      const buttons = verdictButtons('approves each request below as shown', 'denies each request below', (verdict, pair, clicked) => void decide(batch.requests.map((r) => ({
        requestId: r.requestId, subject: r.subject, verdict, ...(noteOf(r.requestId) ? { note: noteOf(r.requestId) } : {}) })), noteOf(batchId), batchId, pair, clicked), 'Approve all ' + n, 'Deny all ' + n)
      // The batch's two buttons in sight; its note for all and its id under its one Details (T239).
      return el('section', { class: 'panel', 'aria-label': 'Batch ' + batchId },
        el('h3', {}, qtyView(n, 'related request'), whatIs('batch')),
        el('div', { class: 'actions' }, buttons),
        cardFold('batch-' + batchId, el('div', { class: 'batch-actions' }, noteFor(batchId, 'Note for all (optional)')),
          el('div', { class: 'muted' }, 'batch ', shortId(batchId, 'Copy batch ID'))),
        batch.requests.map(card))
    }))
}
