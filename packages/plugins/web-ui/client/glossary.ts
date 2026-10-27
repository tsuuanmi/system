// Every page opens with its title; where the title alone does not say what the page is for, one short sentence (T239).
import { el, type Child } from './dom.js'
import { openHelp } from './router.js'

const PAGES: Record<string, [string, string?]> = {
  home: ['Home'],
  board: ['Board'],
  workers: ['Workers'],
  policy: ['Autonomy policy', 'Control which actions need approval.'],
  run: ['Run'],
  help: ['How System works', 'Find an answer or look up a term.'],
  reports: ['Reports', 'Run a command where System runs.'],
}
export const pageTitle = (page: string): string => PAGES[page]?.[0] ?? page
export const pageHead = (page: string, title?: string, runId?: string): Child[] => {
  const lead = PAGES[page]?.[1]
  return [el('h2', { class: 'page', 'data-page': page === 'run' ? 'run:' + runId : page }, title ?? pageTitle(page)), lead ? el('p', { class: 'lead' }, lead) : null]
}

// The words a person meets on these pages, each in one plain sentence (T126): the Help page lists them, and every place that
// shows one has a "?" that opens its sentence in place, by click, tap, or keyboard, never by hover alone, with a link to Help.
export const GLOSSARY: Record<string, [word: string, sentence: string]> = {
  worker: ['Worker', 'A Worker is one AI helper the system can give work to: one account of a tool, set up for one job.'],
  account: ['account', 'An account is one signed-in subscription or key; the Workers set up on it share its quota.'],
  role: ['role', 'A role is the job an account\'s Worker is set up for, such as develop or review.'],
  tier: ['tier', 'A tier says how capable a Worker is (economy, standard, or frontier); a step asks for at least one.'],
  kind: ['kind of work', 'A kind of work (code, docs, tests) is a label: a Worker given kinds takes only that work.'],
  quota: ['quota', 'Quota is how much an account may use in a stretch of time, such as 5 hours; the bar shows the share used.'],
  window: ['window', 'A window is the stretch of time a quota counts over, such as 5 hours or 7 days; it starts again at the time shown.'],
  resting: ['resting', 'A Worker rests when its account used up its quota: it takes no work until the time shown, then comes back by itself.'],
  project: ['project', 'A project groups tasks under a charter, what it is for, which you approve before any of its tasks starts.'],
  task: ['task', 'A task is one piece of a project\'s work: what it should achieve, and how to tell that it did.'],
  run: ['run', 'A run is one go at some work: its steps, one after another, each on a Worker.'],
  start: ['ready task', 'A ready task starts when you press Start on its card or the lead runs it: the run claims the task, and a Worker that can do it takes it.'],
  step: ['step', 'A step is one part of a run, done by one Worker, such as changing the code, reviewing it, or testing it.'],
  attempt: ['attempt', 'An attempt is one try at a task or a step; one that fails can be tried again, up to its limit.'],
  review: ['review', 'A review is a finished task\'s result waiting for you: you accept it, or send it back for another try.'],
  checks: ['checks', 'Checks are the tests and lint the policy wants passed; one nothing ran counts as passed if you accept.'],
  landing: ['merge progress', 'An accepted result goes into the code in two moves: it is saved on its run\'s own branch, then merged once you approve.'],
  merge: ['merge', 'A merge brings an accepted change into the main line of the code; nothing merges without your yes.'],
  branch: ['branch', 'A branch is a separate line of changes in the code; each run works on its own, apart from yours.'],
  approval: ['approval request', 'An approval request is a question the system asks you before it does something it may not do alone.'],
  'action-class': ['action type', 'An action type is the kind of thing a request is about, such as a merge, a deploy, or a command.'],
  batch: ['batch', 'A batch is a group of related requests you can approve or deny together.'],
  policy: ['autonomy policy', 'The autonomy policy says which actions run on their own, which tell you after, which ask you first, and which never run.'],
  mode: ['mode', 'A mode is what the policy does with an action: Automatic runs it, Notify runs it then tells you, Ask approval waits for you, Blocked never runs it.'],
  'always-ask': ['always requires approval', 'Some actions always require your approval, whatever the policy says: anything that cannot be undone, spends money, or merges code.'],
  'policy-change': ['policy change', 'A policy change is a proposed new autonomy policy; it applies only once you approve it.'],
  quarantine: ['quarantined', 'A quarantined account is held back because its sign-in is not the one that was set up; it takes no work until that is checked.'],
  stalled: ['stalled', 'A stalled run showed no activity for longer than its limit; nothing is sent to it, and Stop run ends it.'],
  held: ['not known to be gone', 'A run not known to be gone may still be working somewhere; what it holds stays held until it is freed.'],
  derived: ['derived', 'A derived line is what the system could tell about a Worker when no one wrote what it is for.'],
  team: ['team', 'A team is two or more Workers, each of another provider, that answer one step on their own and then vote; you can exclude a Worker from teams in the configuration.'],
  carry: ['continued from earlier work', 'When a task\'s attempt fails after its code was already changed, the next attempt starts from that change instead of doing it again.'],
  resend: ['retried after a service error', 'When a website answers a team member\'s question with its own error instead of an answer, the question is sent once more, in a new conversation; never twice.'],
  stale: ['stale', 'Shown data is stale when the last refresh failed: the page keeps what it read before, says when it read it, and tries again every 5 seconds.'],
}

const openTerms = new Set<string>()
let explained = 0
/** A "?" after a word: it opens the word's sentence in place (and closes it), reachable by keyboard and touch. */
export const whatIs = (key: string): HTMLElement => {
  const [word, sentence] = GLOSSARY[key] ?? [key, ''], id = 'explain-' + key + '-' + (++explained)
  const more = el('a', { href: '/ui/?view=help#term-' + key, onclick: (e) => { e.preventDefault(); openHelp(key) } }, 'more in Help')
  const note = el('span', { id, class: 'explain-note', role: 'note' }, sentence + ' ', more), open = openTerms.has(key)
  note.hidden = !open
  const button = el('button', { type: 'button', class: 'why', 'aria-expanded': String(open), 'aria-controls': id, 'aria-label': 'What is ' + word + '?', title: sentence }, el('span', { class: 'q', 'aria-hidden': 'true' }, '?'))
  button.addEventListener('click', () => {
    const opening = note.hidden
    note.hidden = !opening
    button.setAttribute('aria-expanded', String(opening))
    if (opening) openTerms.add(key)
    else openTerms.delete(key)
  })
  // A no-break space before the "?" keeps it on its word's line (T274); the note may wrap after it.
  return el('span', { class: 'explain' }, ' ', button, ' ', note)
}
export const termWord = (key: string): string => GLOSSARY[key]?.[0] ?? key
