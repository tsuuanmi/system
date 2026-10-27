// Help: how System works, in plain words, with links into the real pages, then the glossary.
import { el, fold, table, type Child } from './dom.js'
import { GLOSSARY, pageHead, termWord } from './glossary.js'
import { anchor, homeLink, pageLink } from './router.js'
import { show } from './state.js'

const openTerm = (key: string, open: boolean) => {
  const definition = document.getElementById('def-' + key), button = document.querySelector('#term-' + key + ' button.term')
  if (!definition || !button) return
  definition.hidden = !open; button.setAttribute('aria-expanded', String(open))
}
// The glossary's search: a term shows when its word or its sentence holds what is typed.
const filterTerms = (query: string) => {
  const q = query.trim().toLowerCase()
  let shown = 0
  for (const [key, [word, sentence]] of Object.entries(GLOSSARY)) {
    const term = document.getElementById('term-' + key), definition = document.getElementById('def-' + key)
    if (!term || !definition) continue
    const hit = !q || word.toLowerCase().includes(q) || sentence.toLowerCase().includes(q)
    term.hidden = !hit
    if (!hit) definition.hidden = true
    else if (term.querySelector('button.term')?.getAttribute('aria-expanded') === 'true') definition.hidden = false
    if (hit) shown++
  }
  const none = document.getElementById('glossary-none')
  if (none) none.hidden = shown > 0
}
// A link straight to a term opens its definition (a search that hides it is cleared) and focuses it.
const focusTerm = (key: string) => {
  const target = document.getElementById('term-' + key)
  if (!target) return
  const search = document.getElementById('glossary-search')
  if (search instanceof HTMLInputElement && search.value) { search.value = ''; filterTerms('') }
  openTerm(key, true)
  history.replaceState(null, '', '?view=help#term-' + key)
  target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true })
}
const termLink = (key: string, text?: string) => anchor('#term-' + key, text ?? termWord(key), () => focusTerm(key))

const section = (id: string, title: string, ...body: Child[]) => el('section', { class: 'panel help', id, 'aria-labelledby': id + '-title' }, el('h3', { id: id + '-title' }, title), body)
// Each answer is folded under its question or state: the section's navigation stays in sight (T171).
const item = (summary: string, ...body: Child[]) => el('li', {}, fold(summary, body))
const term = (key: string, word: string, sentence: string) => {
  const button = el('button', { type: 'button', class: 'term', 'aria-expanded': 'false', 'aria-controls': 'def-' + key, onclick: () => openTerm(key, button.getAttribute('aria-expanded') !== 'true') }, word)
  return [el('dt', { id: 'term-' + key, tabindex: '-1' }, button), el('dd', { id: 'def-' + key, hidden: '' }, sentence)]
}
const CONTENTS = [['help-workers', 'Workers'], ['help-flow', 'Task lifecycle'], ['help-waits', 'Your decisions'], ['help-policy', 'Autonomy'], ['help-stuck', 'Troubleshooting'], ['help-glossary', 'Glossary']] as const

export function helpView(): void {
  const search = el('input', { id: 'glossary-search', type: 'search', 'aria-label': 'Search terms', placeholder: 'Search terms', oninput: () => filterTerms(search.value) })
  show(pageHead('help'),
    el('nav', { class: 'help-contents', 'aria-label': 'On this page' }, el('ul', {}, CONTENTS.map(([id, text]) => el('li', {}, anchor('#' + id, text, () => {
      const target = document.getElementById(id), heading = target?.querySelector('h3')
      if (!target || !heading) return
      target.scrollIntoView({ block: 'start' }); heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true })
    }))))),
    section('help-workers', 'Workers',
      el('p', {}, termLink('worker', 'Workers'), ' develop, review, and test tasks. Workers on one ', termLink('account', 'account'), ' share its ', termLink('quota', 'quota'), '.'),
      el('p', {}, 'Quota resets automatically. ', termLink('resting', 'Resting'), ' Workers return at the shown time.'),
      el('ul', { class: 'plain' },
        item('Accounts and roles', 'Each Worker is one account of a tool set up for one ', termLink('role', 'role'), ', such as developing or reviewing. When an account has used its quota for the current ', termLink('window', 'window'), ' (5 hours, say), its Workers take no work until the time shown, then come back by themselves.'),
        item('Teams and exclusions', 'Some steps are done by a ', termLink('team', 'team'), ': Workers of different providers answer independently, then vote. A Worker excluded from teams still takes every other step; its card says ', el('em', {}, 'Excluded from teams'), '.')),
      el('p', {}, 'Every account, its quota, and what each Worker does now: ', pageLink('workers', 'Workers'), '.')),
    section('help-flow', 'Task lifecycle',
      el('ol', { class: 'flow', 'aria-label': 'Proposed, Ready, Working, Review, Accepted, Merged' },
        item('Proposed', 'The lead proposes a ', termLink('task', 'task'), ' in a ', termLink('project', 'project'), ' whose charter you approved. A project shows on the Board once the lead proposes its charter, and starts once you approve it on Home.'),
        item('Ready', 'Once what it depends on is done and the ', termLink('policy', 'autonomy policy'), ' allows it, it is ready. Start: you press Start on its card on the ', pageLink('board', 'Board'), ', or the lead starts it, and its ', termLink('run', 'run'), ' begins.'),
        item('Working', 'Each ', termLink('step', 'step'), ' runs on a free Worker: for code, it changes the code on its own ', termLink('branch', 'branch'), ', another Worker reviews it, and a third runs the tests.'),
        item('Review', 'The result waits for you on ', homeLink('Home'), ': what changed, what the reviewer said, and what the ', termLink('checks', 'checks'), ' measured. You accept it, or send it back for another ', termLink('attempt', 'attempt'), '.'),
        item('Accepted', 'An accepted change is saved on its branch, and the system asks you to approve its ', termLink('merge', 'merge'), '.'),
        item('Merged', 'Once you approve, it is merged into the main line of the code. Nothing is pushed anywhere.'))),
    section('help-waits', 'Your decisions',
      el('p', {}, 'Home lists what needs your attention, and the window\'s title counts it: ', el('em', {}, '(3) system'), '.'),
      el('ul', { class: 'plain' },
        item('Approvals: allow or deny an action', 'An ', termLink('approval', 'approval request'), ' asks your yes or no before something the policy does not let run alone; a run, the board, or a Worker asks it. Each button says what it does. No response by its time: denied.'),
        item('Reviews: accept or send back work', 'When a Worker finishes a task, its result waits for you to accept it or send it back. No response by its time: the task waits for input.'),
        item('Runs: approve a plan, break a tie, or inspect a failure', 'A run that waits for your vote or your approval of its plan, or a run outside the board that failed since you last marked Home as seen, says why and what you can do. A board task\'s failed run is the board\'s: it decides the next attempt. A tied vote with no response ends inconclusive.')),
      el('p', {}, '“Since you last looked” on Home tells what happened while you were away.')),
    section('help-policy', 'Autonomy',
      table(['Mode', 'What it does'], [['Automatic', 'Runs on its own'], ['Notify', 'Runs, then tells you'], ['Ask approval', 'Waits for your approval'], ['Blocked', 'Never runs']].map(([m, what]) => el('tr', {}, el('td', {}, el('strong', {}, m)), el('td', {}, what))), 'modes'),
      el('p', {}, 'Each action type has a ', termLink('mode', 'mode'), ' in the ', termLink('policy', 'autonomy policy'), '. Some actions ', termLink('always-ask', 'always require approval'), '. ', pageLink('policy', 'Open Policy')),
      el('ul', { class: 'plain' },
        item('Which actions always require approval', 'A merge, a deploy, sending anything out, deleting data, spending, and changing the policy itself, whatever the policy says.'),
        item('Changing the policy', 'A change is a request too: it applies only once you approve it.'))),
    section('help-stuck', 'Troubleshooting',
      el('ul', { class: 'plain' },
        item('Run failed', 'Open it from Home: it says why. ', el('em', {}, 'Retry failed step'), ' runs the failed step again; completed steps are kept.'),
        item('Task retried', 'Its next run says under ', el('em', {}, 'What happened'), ' whether it ', termLink('carry', 'continued from the earlier work'), ' or started over, and whether a step was ', termLink('resend', 'retried after a service error'), '.'),
        item('Run stalled', 'Its page says its last event and how long ago. A ', termLink('stalled', 'stalled'), ' run is flagged; ', el('em', {}, 'Stop run'), ' ends it.'),
        item('Nothing starts', 'On ', pageLink('workers', 'Workers'), ', see whether a Worker is free, or resting until when. On the ', pageLink('board', 'Board'), ', a ready task waits for Start.'),
        item('Account unavailable', 'A ', termLink('quarantine', 'quarantined'), ' or signed-out account\'s Workers take no work: ask whoever set up the system to sign it in again or check it.'),
        item('Task needs input', 'It used its attempts, or asked a question: its card on the Board says which.'),
        item('Page says stale', 'The last refresh failed: the page shows what it read before, and when (', termLink('stale', 'stale'), '). It tries again every 5 seconds.'))),
    el('section', { class: 'panel help', id: 'help-glossary', 'aria-labelledby': 'help-glossary-title' }, el('h3', { id: 'help-glossary-title' }, 'Glossary'),
      el('p', {}, search),
      el('dl', { class: 'glossary' }, Object.entries(GLOSSARY).sort((a, b) => a[1][0].localeCompare(b[1][0])).flatMap(([key, [word, sentence]]) => term(key, word, sentence))),
      el('p', { id: 'glossary-none', class: 'muted', hidden: '' }, 'No term matches.')))
  const wanted = /^#term-([a-z-]+)$/.exec(location.hash)
  if (wanted?.[1]) { const key = wanted[1]; setTimeout(() => focusTerm(key), 0) }
}
