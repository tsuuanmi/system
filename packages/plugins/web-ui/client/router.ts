// Moving between pages: the address, what it names, and the links that move (one implementation each).
import { byId, el, type Child, type Props } from './dom.js'
import { app, refresh } from './state.js'

/** A link that moves inside the page: its address for the eye and a new tab, `act` for a click. */
export const anchor = (href: string, text: Child, act: () => void, props: Props = {}): HTMLAnchorElement =>
  el('a', { href, ...props, onclick: (e) => { e.preventDefault(); act() } }, text)

/** Scroll to an element of the page and give it the focus; else to the first that matches `fallback`. */
export const focusOn = (id: string, fallback?: string): boolean => {
  const target = document.getElementById(id) ?? (fallback ? document.querySelector<HTMLElement>(fallback) : null)
  if (!target) return false
  target.scrollIntoView({ block: 'start' })
  target.focus({ preventScroll: true })
  return true
}
/** A link that scrolls to an element of the same page. */
export const jump = (id: string, text: Child): HTMLAnchorElement => anchor('#' + id, text, () => { focusOn(id) })

/** Opens a page: its address pushed, the state it names set, and the page drawn. */
export function open(address: string, state: { run?: string | null; view?: string | null }): void {
  app.current = state.run ?? null
  app.view = state.view ?? null
  app.confirming = false
  history.pushState(null, '', address)
  void refresh()
}
export const go = (runId?: string): void => open(runId ? '?run=' + encodeURIComponent(runId) : app.homeProject ? '?project=' + encodeURIComponent(app.homeProject) : '/ui/', { run: runId ?? null })
export const openHelp = (key: string): void => open('?view=help#term-' + key, { view: 'help' })
export const openReports = (projectId: string): void => open('?view=reports&project=' + encodeURIComponent(projectId), { view: 'reports' })
export function filterHome(projectId: string | null): void {
  app.homeProject = projectId || null
  open(app.homeProject ? '?project=' + encodeURIComponent(app.homeProject) : '/ui/', {})
}
/** Home, scrolled to one request's card, which takes the focus: every project shown, so the card is there. */
export function openRequest(requestId: string): void {
  app.focusRequest = requestId
  app.homeProject = null
  open('?request=' + encodeURIComponent(requestId), {})
}

export const runLink = (runId: string, text?: string, label?: string): HTMLAnchorElement =>
  anchor('?run=' + encodeURIComponent(runId), text ?? runId, () => go(runId), label ? { 'aria-label': label } : {})
/** Every pending decision links to the card it is decided on (an approval request's, on Home). */
export const decideLink = (requestId: string, text: string): HTMLAnchorElement =>
  anchor('/ui/?request=' + encodeURIComponent(requestId), text, () => { if (!focusOn('request-' + requestId)) openRequest(requestId) })
export const pageLink = (name: string, text: string): HTMLAnchorElement =>
  anchor('/ui/?view=' + name, text, () => byId(name + '-link').click())
export const homeLink = (text: string): HTMLAnchorElement => anchor('/ui/', text, () => go())
export const reportsLink = (projectId: string, title: string): HTMLAnchorElement =>
  anchor('/ui/?view=reports&project=' + encodeURIComponent(projectId), 'Reports', () => openReports(projectId), { class: 'reports', 'aria-label': 'Reports of ' + title })
/** A review's card on Home (T253: in its project's group), else the first Reviews shown. */
export const toReview = (taskId: string): boolean => focusOn('review-' + taskId, 'main section[aria-label="Reviews"]')
