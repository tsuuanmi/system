// The page's one state: the token and the API client, what the address names (the run, the view, the projects shown), what a
// render may draw, the line a verdict leaves above the page, and what waits for the operator.
import type { WaitingResponse } from '../src/api.js'
import { byId, el, type Child } from './dom.js'

// `app.ts` moved the token from the address into session storage before this module loaded.
let token: string | null = null
try { token = sessionStorage.getItem('system.token') } catch {}
export const hasToken = (): boolean => !!token

/** A failed call: the server's own words and its status, 0 when there was no answer. */
export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
export const asApiError = (error: unknown): ApiError => error instanceof ApiError ? error : new ApiError(error instanceof Error ? error.message : String(error), 0)
/** The words of a failure, with its status as "(404)" or "(no answer)". */
export const refusal = (error: unknown): string => { const e = asApiError(error); return `(${e.status || 'no answer'}): ${e.message}` }

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/ui/api/' + path, body === undefined
    ? { headers: { authorization: 'Bearer ' + token } }
    : { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const value: { error?: string } = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(value.error || response.statusText, response.status)
  return value as T
}
/** A read that may be absent (a plugin not running: 503) or refused: null when absent, `{ error }` when it failed. */
export async function optional<T>(path: string, absent: number[] = [503]): Promise<T | { error: ApiError } | null> {
  try { return await api<T>(path) } catch (error) { const e = asApiError(error); return absent.includes(e.status) ? null : { error: e } }
}
export const failed = <T extends object>(value: T | { error: ApiError } | null): value is { error: ApiError } => !!value && 'error' in value

export type Waits = WaitingResponse | { unknown: string }
export const app = {
  current: new URLSearchParams(location.search).get('run'),
  view: new URLSearchParams(location.search).get('view'),
  /** A confirmation is open: the page does not refresh under it. */
  confirming: false,
  /** Home shows every project, or the one the address names (T253), until "All projects". */
  homeProject: ((): string | null => { const q = new URLSearchParams(location.search); return !q.get('view') && !q.get('run') ? q.get('project') : null })(),
  /** The project the Board shows (T253), or 'all'; null until chosen. */
  boardProject: ((): string | null => { const q = new URLSearchParams(location.search); return q.get('view') === 'board' ? q.get('project') : null })(),
  focusRequest: new URLSearchParams(location.search).get('request'),
  waits: null as Waits | null,
  /** Set by the boot module: draws the page the address names. */
  refresh: async (): Promise<void> => {},
}
const PAGE_VIEWS = ['policy', 'board', 'workers', 'help', 'reports']
/** The page the address names now: what a render must be of to be shown. */
export const shownPage = (): string => app.view !== null && PAGE_VIEWS.includes(app.view) ? app.view : app.current ? 'run:' + app.current : 'home'
export const refresh = (): Promise<void> => app.refresh()

// A render that lands while a pointer or key is pressed waits for its release: replacing the button under a press would drop
// the click, and with it the operator's verdict (T84). A page that finished rendering after the operator moved on is dropped.
const main = byId('main')
let pressed = false
let pending: Array<Node | string> | null = null
export function show(...parts: Child[]): void {
  const kept = parts.flat(Infinity as 1).filter((part): part is Node | string => part !== null && part !== undefined)
  const head = kept[0]
  if (head instanceof HTMLElement && head.dataset.page && head.dataset.page !== shownPage()) return
  if (pressed) pending = kept
  else { pending = null; main.replaceChildren(...kept) }
}
const press = () => { pressed = true }
const release = () => setTimeout(() => {
  pressed = false
  if (pending) { const parts = pending; pending = null; main.replaceChildren(...parts) }
}, 0)
document.addEventListener('pointerdown', press, true)
document.addEventListener('pointerup', release, true)
document.addEventListener('pointercancel', release, true)
document.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') press() }, true)
document.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') release() }, true)

// What the operator's last verdict did, outside the refreshed page: it stays until dismissed. A verdict that was not recorded
// is an alert, never only a line a refresh overwrites (INV-2). ok: true for done, false for refused, 'pending' for neither.
const outcome = byId('outcome')
export function report(ok: boolean | 'pending', title: string, lines: Child[]): void {
  outcome.replaceChildren(el('div', { class: 'panel' + (ok === 'pending' ? '' : ok ? ' ok' : ' bad'), role: ok === false ? 'alert' : 'status' },
    el('h3', { class: ok === 'pending' ? 'state running' : ok ? 'state completed' : 'state failed' }, title),
    lines.filter(Boolean).map((line) => line instanceof Element ? line : el('p', {}, line)),
    el('button', { onclick: () => outcome.replaceChildren() }, 'Dismiss')))
  outcome.scrollIntoView({ block: 'nearest' })
}
/** An error state with its one next action; the page also tries again by itself every 5 seconds. */
export const errorState = (text: string): HTMLElement => el('div', { class: 'panel bad error-state' }, el('p', { class: 'state failed' }, text), el('button', { type: 'button', onclick: () => void refresh() }, 'Try again'))
/** A message in the header ("proposed …", "could not refresh: …") stays until the next refresh that succeeds. */
export const status = byId('status')
export const say = (text: string): void => { status.textContent = text; status.dataset.message = '1' }
export const saySoftly = (error: unknown): void => say('could not refresh: ' + asApiError(error).message)

// "Since you last looked" (T124): kept in this browser only (localStorage), never on the server: when the operator last marked
// Home as seen, and each Worker's status then.
export interface Seen { at: string; workers: Record<string, string> }
export const seenOf = (): Seen | null => {
  try {
    const v: Partial<Seen> | null = JSON.parse(localStorage.getItem('system.seen') || 'null')
    return v && typeof v.at === 'string' && !Number.isNaN(Date.parse(v.at)) ? { at: v.at, workers: v.workers ?? {} } : null
  } catch { return null }
}
export const markSeen = (workers: Record<string, string>): void => { try { localStorage.setItem('system.seen', JSON.stringify({ at: new Date().toISOString(), workers })) } catch {} }

/** What waits for the operator and they can act on, from one read on every page (GET waiting, T127). */
export const readWaiting = async (): Promise<Waits> => {
  const seen = seenOf()
  try { return await api<WaitingResponse>('waiting' + (seen ? '?since=' + encodeURIComponent(seen.at) : '')) } catch (error) { return { unknown: asApiError(error).message } }
}
export const badge = (): string => {
  const w = app.waits
  return !w ? '' : 'unknown' in w ? '(?) ' : w.count ? '(' + w.count + (w.partial ? '+' : '') + ') ' : w.partial ? '(?) ' : ''
}
