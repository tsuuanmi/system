// The shared building blocks (T172), one implementation each, used by every page: elements, chips, folds, lists, copy buttons, tables, decision buttons, times.
export type Child = Node | string | number | null | undefined | Child[]
export type Props = Record<string, string | boolean | undefined | ((event: Event) => void)>

export const byId = (id: string): HTMLElement => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`the page has no #${id}`)
  return node
}

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue
    if (typeof value === 'function') node.addEventListener(key.slice(2), value)
    else if (key === 'class') node.className = String(value)
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity as 1)) if (child !== null && child !== undefined) node.append(child instanceof Node ? child : String(child))
  return node
}

export const absolute = (iso: string): string => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
export const relative = (iso: string): string => {
  const ms = Date.parse(iso) - Date.now()
  const m = Math.round(Math.abs(ms) / 60000)
  const span = m < 1 ? '<1 min' : m < 60 ? m + ' min' : m < 48 * 60 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' days'
  return ms < 0 ? span + ' ago' : 'in ' + span
}
export const clockOf = (iso: string): string => new Date(iso).toDateString() === new Date().toDateString() ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : absolute(iso)
export const when = (iso: string): string => relative(iso) + ' (' + clockOf(iso) + ')'
export const span = (seconds: number): string => seconds % 86400 === 0 ? seconds / 86400 + ' d' : seconds % 3600 === 0 ? seconds / 3600 + ' h' : seconds % 60 === 0 ? seconds / 60 + ' min' : seconds + ' s'
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60)
  return s < 60 ? s + ' s' : m < 60 ? m + ' min' : h < 48 ? h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '') : Math.floor(h / 24) + ' days'
}
export const ago = (iso: string): HTMLElement => el('time', { class: 'rel', datetime: iso, title: absolute(iso), 'data-exact': absolute(iso), tabindex: '0' }, relative(iso))
export const expires = (iso: string, noResponse?: string): HTMLElement => el('span', { class: 'expiry ' + (Date.parse(iso) - Date.now() < 3600000 ? 'soon' : 'muted') },
  Date.parse(iso) > Date.now() ? 'Expires ' : 'Expired ', ago(iso), noResponse ? ' · No response: ' + noResponse : '')
const took = (cls: string, exact: string, text: string, props: Props = {}) => el('span', { class: cls, ...props, tabindex: '0', title: exact, 'data-exact': exact }, text)
export const tookView = (from: string, to: string): HTMLElement => took('took', absolute(from) + ' – ' + absolute(to), duration(Date.parse(to) - Date.parse(from)))
export const elapsedView = (since: string): HTMLElement => took('took elapsed', 'since ' + absolute(since), duration(Date.now() - Date.parse(since)), { 'data-since': since })
setInterval(() => {
  for (const node of document.querySelectorAll<HTMLElement>('.elapsed[data-since]')) { const text = duration(Date.now() - Date.parse(node.dataset.since ?? '')); if (node.textContent !== text) node.textContent = text }
}, 1000)
// A status chip: a word, a colour, and a symbol of its own shape, so it is never told by colour alone.
const GLYPH: Record<string, string> = { ok: '●', warn: '▲', bad: '■', info: '◆', idle: '○' }
export const chip = (word: Child, tone?: string): HTMLElement => {
  const known = tone !== undefined && tone in GLYPH ? tone : 'idle'
  return el('span', { class: 'chip ' + known }, el('span', { class: 'glyph', 'aria-hidden': 'true' }, GLYPH[known]), ' ', word)
}
const unit = (n: number, one: string, many?: string): string => n === 1 ? one : (many ?? one + 's')
export const qty = (n: number, one: string, many?: string): string => n + ' ' + unit(n, one, many)
export const qtyView = (n: number, one: string): HTMLElement => el('span', { class: 'qty' }, el('span', { class: 'n' }, String(n)), ' ' + unit(n, one))

export const fold = (summary: Child, ...body: Child[]): HTMLDetailsElement => el('details', { class: 'fold' }, el('summary', {}, summary), el('div', { class: 'fold-body' }, body))
// Folds kept through the 5-second refresh (T186): one opened stays open; one open by default (`alarm`) that the operator closed stays closed.
const openFolds = new Set<string>(), closedFolds = new Set<string>()
export const keepOpen = (details: HTMLDetailsElement, key: string, alarm: boolean): void => {
  if (openFolds.has(key) || (!closedFolds.has(key) && alarm)) details.open = true
  details.addEventListener('toggle', () => { if (details.open) { openFolds.add(key); closedFolds.delete(key) } else { openFolds.delete(key); closedFolds.add(key) } })
}
export const keptFold = (key: string, summary: Child, ...body: Child[]): HTMLDetailsElement => {
  const details = fold(summary, ...body)
  keepOpen(details, key, false)
  return details
}
export const cardFold = (key: string, ...body: Child[]): HTMLDetailsElement => Object.assign(keptFold(key, 'Details', ...body), { className: 'fold card-details' })
export const expandedLists = new Set<string>()
const LIST_SHOWN = 5
/** A list of at most LIST_SHOWN rows, and a "Show all N" that shows the rest and stays so through the refresh (T186). */
export function capped<T>(key: string, container: HTMLElement, items: T[], render: (item: T) => Node): Node[] {
  if (items.length <= LIST_SHOWN) { container.append(...items.map(render)); return [container] }
  const button = el('button', { type: 'button', class: 'show-all', 'aria-expanded': 'false', 'aria-controls': container.id || undefined })
  const draw = () => {
    const all = expandedLists.has(key)
    container.replaceChildren(...(all ? items : items.slice(0, LIST_SHOWN)).map(render))
    button.textContent = all ? 'Show first ' + LIST_SHOWN : 'Show all ' + items.length
    button.setAttribute('aria-expanded', String(all))
  }
  button.addEventListener('click', () => { if (expandedLists.has(key)) expandedLists.delete(key); else expandedLists.add(key); draw() })
  draw()
  return [container, button]
}
/** A copy button for an id or a hash, named by its label, the value its tooltip; without a clipboard the value is shown beside it, selected. */
export const copyId = (label: string, value: string): HTMLElement => {
  const button = el('button', { type: 'button', class: 'copy', 'data-copy': value, 'aria-label': label, title: label + ': ' + value })
  button.addEventListener('click', async (e) => {
    e.preventDefault()
    try {
      await navigator.clipboard.writeText(value)
      button.classList.add('done'); button.setAttribute('aria-label', 'Copied')
      setTimeout(() => { button.classList.remove('done'); button.setAttribute('aria-label', label) }, 2000)
    } catch {
      if (button.nextElementSibling?.classList.contains('copied')) return
      const code = el('code', { class: 'copied' }, value), range = document.createRange(), selection = window.getSelection()
      button.after(code)
      range.selectNodeContents(code)
      if (selection) { selection.removeAllRanges(); selection.addRange(range) }
    }
  })
  return button
}
/** A hash, an id, or a long path as a person reads it first (T256): a path past 32 characters by its last two parts; else each run of 12+ hex digits by its first 8, the rest past 32 characters cut. */
export const shortHash = (hex: string, from = 12): string => hex.replace(new RegExp('(?:sha256:)?[0-9a-f]{' + from + ',}', 'g'), (h) => h.replace(/^sha256:/, '').slice(0, 8) + '…')
const shortText = (value: string): string => {
  if (value.includes('/') && !/[ :@]/.test(value)) return value.length <= 32 ? value : '…/' + value.split('/').filter(Boolean).slice(-2).join('/')
  const short = shortHash(value)
  return short.length <= 32 ? short : short.slice(0, 28) + '…'
}
export const shortId = (value: string, label: string): Node[] => [el('code', { class: 'short', title: value }, shortText(value)), copyId(label, value)]
// Below 600 px each table row is a card, each cell named by its column (data-label, T240).
export const labelled = <R extends HTMLElement>(head: string[], row: R): R => {
  [...row.children].forEach((cell, i) => { const name = head[i]; if (name && cell instanceof HTMLElement) cell.dataset.label = name })
  return row
}
export const table = (head: string[], rows: HTMLElement[], cls?: string): HTMLElement => el('table', cls ? { class: cls } : {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows.map((row) => labelled(head, row))))
// A decision's button (T191): what pressing it does is its accessible description (aria-describedby), a tooltip on hover and keyboard focus (T239); Escape hides it.
let doesCount = 0
const placers = new WeakMap<HTMLElement, () => void>()
export const decision = (label: string, consequence: string, props: Props = {}): [HTMLButtonElement, HTMLElement] => {
  const id = 'does-' + (++doesCount), button = el('button', { type: 'button', ...props, 'aria-describedby': id }, label)
  const tip = el('span', { id, class: 'does', role: 'tooltip', 'data-for': label }, consequence)
  const place = () => {
    tip.classList.add('shown')
    const box = button.getBoundingClientRect()
    tip.style.left = Math.max(8, Math.min(box.left, innerWidth - tip.offsetWidth - 8)) + 'px'
    tip.style.top = (box.bottom + 4 + tip.offsetHeight > innerHeight ? Math.max(4, box.top - tip.offsetHeight - 4) : box.bottom + 4) + 'px'
  }
  const hide = () => tip.classList.remove('shown')
  placers.set(tip, place)
  button.addEventListener('mouseenter', place)
  button.addEventListener('mouseleave', () => { if (document.activeElement !== button || !button.matches(':focus-visible')) hide() })
  button.addEventListener('focus', () => { if (button.matches(':focus-visible')) place() })
  button.addEventListener('blur', hide); button.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide() })
  return [button, tip]
}
/** Approve / Deny, as on every card (T191): the two buttons with their descriptions, each clicking `onVerdict`. */
export const verdictButtons = (yesDoes: string, noDoes: string, onVerdict: (verdict: 'approved' | 'rejected', buttons: HTMLButtonElement[], clicked: HTMLButtonElement) => void, yesLabel = 'Approve', noLabel = 'Deny'): Node[] => {
  const [yes, yesTip] = decision(yesLabel, yesDoes, { class: 'primary' }), [no, noTip] = decision(noLabel, noDoes)
  yes.addEventListener('click', () => onVerdict('approved', [yes, no], yes))
  no.addEventListener('click', () => onVerdict('rejected', [yes, no], no))
  return [yes, yesTip, no, noTip]
}
/** A verdict's one call: its buttons disabled and the clicked one "Recording…" while `send` runs, then restored; the page refreshes after. */
export const recording = async (buttons: HTMLButtonElement[], clicked: HTMLButtonElement, send: () => Promise<void>, refresh: () => Promise<void>): Promise<void> => {
  const labels = buttons.map((b) => b.textContent)
  for (const b of buttons) b.disabled = true
  clicked.textContent = 'Recording…'
  await send()
  buttons.forEach((b, i) => { b.disabled = false; b.textContent = labels[i] ?? '' })
  await refresh()
}
// Where nothing hovers, a touch screen (T240): each row of described buttons gets one "?" that shows what each does, on a tap.
const setTips = (row: Element, open: boolean) => { row.classList.toggle('tips-open', open); row.querySelector(':scope > button.tips')?.setAttribute('aria-expanded', String(open)) }
const tapTips = (root: HTMLElement) => {
  for (const row of new Set([...root.querySelectorAll('.does')].map((tip) => tip.parentElement))) {
    if (!row || row.querySelector(':scope > button.tips')) continue
    const tips = [...row.querySelectorAll(':scope > .does')]
    row.append(el('button', { type: 'button', class: 'tips', 'aria-expanded': 'false', 'aria-controls': tips.map((t) => t.id).join(' '), 'aria-label': tips.length > 1 ? 'What these buttons do' : 'What this button does',
      onclick: () => setTips(row, !row.classList.contains('tips-open')) }, el('span', { class: 'q', 'aria-hidden': 'true' }, '?')))
  }
}
/** Starts the page-wide behaviour of the blocks: "?" rows, taps outside, Escape, and tooltips that follow their control. */
export function watchBlocks(): void {
  for (const root of [byId('main'), byId('outcome')]) new MutationObserver(() => tapTips(root)).observe(root, { childList: true, subtree: true })
  document.addEventListener('pointerdown', (e) => {
    const target = e.target instanceof Node ? e.target : null
    for (const row of document.querySelectorAll('.tips-open')) if (!target || !row.contains(target)) setTips(row, false)
    for (const button of document.querySelectorAll<HTMLElement>('button.why[aria-expanded="true"]')) if (!target || !button.parentElement?.contains(target)) button.click()
  }, true)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const row of document.querySelectorAll('.tips-open')) setTips(row, false) })
  const follow = () => { for (const tip of document.querySelectorAll<HTMLElement>('.does.shown')) placers.get(tip)?.() }
  window.addEventListener('scroll', follow, { passive: true }); window.addEventListener('resize', follow)
}
