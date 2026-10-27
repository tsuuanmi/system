// The page's start: the navigation, the address's back and forward, the page shown marked in the navigation and named in the
// window's title, and the refresh that draws the page the address names every 5 seconds.
import { byId, el, watchBlocks } from './dom.js'
import { pageTitle } from './glossary.js'
import { helpView } from './help.js'
import { go } from './router.js'
import { app, asApiError, badge, errorState, hasToken, readWaiting, say, shownPage, show, status } from './state.js'
import { boardView } from './board.js'
import { detail } from './runpage.js'
import { list } from './home.js'
import { policyView } from './policy.js'
import { reportsView } from './reports.js'
import { workersView } from './workers.js'

watchBlocks()
const main = byId('main')
const stale = byId('stale')
const nav = (id: string, name: string) => byId(id).addEventListener('click', (e) => {
  e.preventDefault()
  app.current = null
  app.view = name
  app.confirming = false
  // The Board's address names the project it shows (T253), so a reload shows the same board.
  history.pushState(null, '', '?view=' + name + (name === 'board' && app.boardProject ? '&project=' + encodeURIComponent(app.boardProject) : ''))
  void refresh()
})
byId('home-link').addEventListener('click', (e) => { e.preventDefault(); go() })
for (const name of ['board', 'workers', 'policy', 'help']) nav(name + '-link', name)
window.addEventListener('popstate', () => {
  const query = new URLSearchParams(location.search)
  app.current = query.get('run')
  app.view = query.get('view')
  // The project each page shows is in its address (T253): Home's filter, the Board's project.
  if (app.view === 'board') app.boardProject = query.get('project')
  else if (!app.view && !app.current) app.homeProject = query.get('project')
  app.confirming = false
  void refresh()
})
const NAV = ['home', 'board', 'workers', 'policy', 'help']
const mark = () => {
  const shown = shownPage()
  const page = shown.startsWith('run:') ? 'run' : shown
  for (const name of NAV) {
    const link = byId(name + '-link')
    if (name === page || ((page === 'run' || page === 'reports') && name === 'home')) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  document.title = badge() + 'system — ' + pageTitle(page) + (app.current ? ' ' + app.current : '')
}
// Production states (T170): a skeleton while a page first loads; "updated 12 s ago" in the header, ticking without being
// announced; and, when a refresh fails over a page already shown, a stale banner that says when the data shown was read. A page
// that never loaded shows its error with one next action, Try again.
let readAt = 0
const freshness = () => {
  if (status.dataset.message || !readAt) return
  const s = Math.max(0, Math.round((Date.now() - readAt) / 1000))
  const text = 'updated ' + (s < 60 ? s + ' s' : Math.round(s / 60) + ' min') + ' ago'
  if (status.textContent !== text) status.textContent = text
}
setInterval(freshness, 1000)
// Whether the page the address names is on screen, read whole at least once.
const pageShown = () => { const head = main.querySelector<HTMLElement>('[data-page]'); return !!head && head.dataset.page === shownPage() && !head.dataset.failed }
const draw = () => app.view === 'policy' ? policyView() : app.view === 'board' ? boardView() : app.view === 'workers' ? workersView() : app.view === 'reports' ? reportsView() : app.current ? detail(app.current) : list()

async function refresh(): Promise<void> {
  mark()
  // Help reads nothing from the server: it shows with or without a token.
  if (app.view === 'help') { stale.hidden = true; helpView(); if (hasToken()) app.waits = await readWaiting(); mark(); return }
  if (!hasToken()) { show(el('p', {}, 'Open the link that ', el('code', {}, 'system ui'), ' prints.')); return }
  const want = shownPage()
  if (!pageShown() && !main.querySelector('.loading')) {
    stale.hidden = true
    main.setAttribute('aria-busy', 'true')
    main.replaceChildren(el('p', { class: 'loading' }, 'Loading…'))
  }
  try {
    await draw()
    readAt = Date.now()
    stale.hidden = true
    delete status.dataset.message
    freshness()
  } catch (error) {
    const message = asApiError(error).message
    if (want === shownPage()) {
      if (pageShown()) {
        const text = 'Stale: the last refresh failed (' + message + '). Showing what was read at ' + new Date(readAt).toLocaleTimeString() + '; trying again every 5 s.'
        if (stale.textContent !== text) stale.textContent = text
        stale.hidden = false
      } else {
        const failed = errorState('This page could not be loaded: ' + message + '.')
        failed.dataset.page = want
        failed.dataset.failed = '1'
        main.replaceChildren(failed)
      }
      say('could not refresh: ' + message)
    }
  }
  main.removeAttribute('aria-busy')
  // Home reads what waits as it renders; any other page reads the same.
  if (app.view || app.current) app.waits = await readWaiting()
  mark()
}
app.refresh = refresh
void refresh()
// The policy page holds an edit in progress, and an open confirmation a move not yet made: neither is refreshed away.
setInterval(() => { if (app.view !== 'policy' && app.view !== 'help' && !app.confirming && !document.hidden && !main.contains(document.activeElement)) void refresh() }, 5000)
