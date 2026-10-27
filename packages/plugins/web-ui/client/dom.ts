// The shared building blocks (T172), one implementation each, used by every page: elements, chips, folds, lists, copy buttons,
// tables, decision buttons with their tooltips, and the times as the operator reads them.
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

// Times as the operator reads them: relative first, the absolute time beside it.
export const absolute = (iso: string): string => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
export const relative = (iso: string): string => {
  const ms = Date.parse(iso) - Date.now()
  const m = Math.round(Math.abs(ms) / 60000)
  const span = m < 1 ? '<1 min' : m < 60 ? m + ' min' : m < 48 * 60 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' days'
  return ms < 0 ? span + ' ago' : 'in ' + span
}
/** A time as its clock time ("14:20"), with the day when it is not today. */
export const clockOf = (iso: string): string => {
  const d = new Date(iso)
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : absolute(iso)
}
/** A time as "in 2 h (11:40)": relative, then the clock time. */
export const when = (iso: string): string => relative(iso) + ' (' + clockOf(iso) + ')'
/** A window's length as "5 h" or "7 d" (ADR-0059's "used 42 % of 5 h"). */
export const span = (seconds: number): string => seconds % 86400 === 0 ? seconds / 86400 + ' d' : seconds % 3600 === 0 ? seconds / 3600 + ' h' : seconds % 60 === 0 ? seconds / 60 + ' min' : seconds + ' s'
/** A span of time in a few words: "40 s", "14 min", "2 h 5 min", "3 days". */
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60)
  return s < 60 ? s + ' s' : m < 60 ? m + ' min' : h < 48 ? h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '') : Math.floor(h / 24) + ' days'
}
/** A relative time: its exact time on hover (title) and on keyboard focus. */
export const ago = (iso: string): HTMLElement => el('time', { class: 'rel', datetime: iso, title: absolute(iso), 'data-exact': absolute(iso), tabindex: '0' }, relative(iso))
/** A deadline: when it expires, marked within the hour, and what no response means. */
export const expires = (iso: string, noResponse?: string): HTMLElement => el('span', { class: 'expiry ' + (Date.parse(iso) - Date.now() < 3600000 ? 'soon' : 'muted') },
  Date.parse(iso) > Date.now() ? 'Expires ' : 'Expired ', ago(iso), noResponse ? ' · No response: ' + noResponse : '')
/** How long something ran (T256): its exact start and end on hover and on keyboard focus. */
export const tookView = (from: string, to: string): HTMLElement => {
  const exact = absolute(from) + ' – ' + absolute(to)
  return el('span', { class: 'took', tabindex: '0', title: exact, 'data-exact': exact }, duration(Date.parse(to) - Date.parse(from)))
}
/** How long something has been running, ticking each second (T256). */
export const elapsedView = (since: string): HTMLElement => {
  const exact = 'since ' + absolute(since)
  return el('span', { class: 'took elapsed', 'data-since': since, tabindex: '0', title: exact, 'data-exact': exact }, duration(Date.now() - Date.parse(since)))
}
setInterval(() => {
  for (const node of document.querySelectorAll<HTMLElement>('.elapsed[data-since]')) {
    const text = duration(Date.now() - Date.parse(node.dataset.since ?? ''))
    if (node.textContent !== text) node.textContent = text
  }
}, 1000)

// A status chip: a word, a colour, and a symbol of its own shape, so it is never told by colour alone.
const GLYPH: Record<string, string> = { ok: '●', warn: '▲', bad: '■', info: '◆', idle: '○' }
export const chip = (word: Child, tone?: string): HTMLElement => {
  const known = tone !== undefined && tone in GLYPH ? tone : 'idle'
  return el('span', { class: 'chip ' + known }, el('span', { class: 'glyph', 'aria-hidden': 'true' }, GLYPH[known]), ' ', word)
}
// A number with its unit: "1 task", "3 tasks"; qtyView sets the number apart.
const unit = (n: number, one: string, many?: string): string => n === 1 ? one : (many ?? one + 's')
export const qty = (n: number, one: string, many?: string): string => n + ' ' + unit(n, one, many)
export const qtyView = (n: number, one: string): HTMLElement => el('span', { class: 'qty' }, el('span', { class: 'n' }, String(n)), ' ' + unit(n, one))

/** A fold for an explanation or a technical fact: closed by default, never deleted. */
export const fold = (summary: Child, ...body: Child[]): HTMLDetailsElement => el('details', { class: 'fold' }, el('summary', {}, summary), el('div', { class: 'fold-body' }, body))
// A card's one fold (T186), closed by default and, once opened, kept open through the 5-second refresh; a fold open by default
// that the operator closed stays closed.
const openFolds = new Set<string>()
const closedFolds = new Set<string>()
export const keptFold = (key: string, summary: Child, ...body: Child[]): HTMLDetailsElement => {
  const details = fold(summary, ...body)
  if (openFolds.has(key)) details.open = true
  details.addEventListener('toggle', () => { if (details.open) openFolds.add(key); else openFolds.delete(key) })
  return details
}
export const cardFold = (key: string, ...body: Child[]): HTMLDetailsElement => {
  const details = keptFold(key, 'Details', ...body)
  details.classList.add('card-details')
  return details
}
export const keepOpen = (details: HTMLDetailsElement, key: string, alarm: boolean): void => {
  if (openFolds.has(key) || (!closedFolds.has(key) && alarm)) details.open = true
  details.addEventListener('toggle', () => { if (details.open) { openFolds.add(key); closedFolds.delete(key) } else { openFolds.delete(key); closedFolds.add(key) } })
}
/** Lists and long texts the operator expanded, kept so through the refresh. */
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

/** A copy button for an id or a hash: a small icon named by its label, the value its tooltip; without a clipboard the value is shown beside it, selected. */
export const copyId = (label: string, value: string): HTMLElement => {
  const button = el('button', { type: 'button', class: 'copy', 'data-copy': value, 'aria-label': label, title: label + ': ' + value })
  button.addEventListener('click', async (e) => {
    e.preventDefault()
    try {
      await navigator.clipboard.writeText(value)
      button.classList.add('done')
      button.setAttribute('aria-label', 'Copied')
      setTimeout(() => { button.classList.remove('done'); button.setAttribute('aria-label', label) }, 2000)
    } catch {
      if (button.nextElementSibling?.classList.contains('copied')) return
      const code = el('code', { class: 'copied' }, value)
      button.after(code)
      const range = document.createRange()
      range.selectNodeContents(code)
      const selection = window.getSelection()
      if (selection) { selection.removeAllRanges(); selection.addRange(range) }
    }
  })
  return button
}
// A hash, an id, or a long path as a person reads it first (T256): a path past 32 characters by its last two parts; in anything
// else each run of 12 or more hex digits by its first 8, and what is still past 32 characters by its start.
const shortText = (value: string): string => {
  if (value.includes('/') && !/[ :@]/.test(value)) return value.length <= 32 ? value : '…/' + value.split('/').filter(Boolean).slice(-2).join('/')
  const short = value.replace(/(?:sha256:)?[0-9a-f]{12,}/g, (hex) => hex.replace(/^sha256:/, '').slice(0, 8) + '…')
  return short.length <= 32 ? short : short.slice(0, 28) + '…'
}
export const shortId = (value: string, label: string): Node[] => [el('code', { class: 'short', title: value }, shortText(value)), copyId(label, value)]

/** A table; below 600 px each row is a card, each cell named by its column (data-label, T240). */
export const labelled = <R extends HTMLElement>(head: string[], row: R): R => {
  [...row.children].forEach((cell, i) => { const name = head[i]; if (name && cell instanceof HTMLElement) cell.dataset.label = name })
  return row
}
export const table = (head: string[], rows: HTMLElement[], cls?: string): HTMLElement => el('table', cls ? { class: cls } : {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows.map((row) => labelled(head, row))))

// A decision's button (T191), one implementation for every page: its label the concept's one wording, and what pressing it does
// its accessible description (aria-describedby), shown as a tooltip on hover and on keyboard focus (T239); Escape hides it.
let doesCount = 0
const placers = new WeakMap<HTMLElement, () => void>()
export const decision = (label: string, consequence: string, props: Props = {}): [HTMLButtonElement, HTMLElement] => {
  const id = 'does-' + (++doesCount)
  const button = el('button', { type: 'button', ...props, 'aria-describedby': id }, label)
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
  button.addEventListener('blur', hide)
  button.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide() })
  return [button, tip]
}
/** Approve / Deny on an exact subject, as on every card (T191): returns the two buttons with their descriptions, each clicking `onVerdict`. */
export const verdictButtons = (yesDoes: string, noDoes: string, onVerdict: (verdict: 'approved' | 'rejected', buttons: HTMLButtonElement[], clicked: HTMLButtonElement) => void, yesLabel = 'Approve', noLabel = 'Deny'): Node[] => {
  const [yes, yesTip] = decision(yesLabel, yesDoes, { class: 'primary' })
  const [no, noTip] = decision(noLabel, noDoes)
  yes.addEventListener('click', () => onVerdict('approved', [yes, no], yes))
  no.addEventListener('click', () => onVerdict('rejected', [yes, no], no))
  return [yes, yesTip, no, noTip]
}

// Where nothing hovers, a touch screen (T240): each row of described buttons gets one "?" that shows what each does, on a tap.
const setTips = (row: Element, open: boolean) => {
  row.classList.toggle('tips-open', open)
  row.querySelector(':scope > button.tips')?.setAttribute('aria-expanded', String(open))
}
const tapTips = (root: HTMLElement) => {
  for (const row of new Set([...root.querySelectorAll('.does')].map((tip) => tip.parentElement))) {
    if (!row || row.querySelector(':scope > button.tips')) continue
    const tips = [...row.querySelectorAll(':scope > .does')]
    const toggle = el('button', { type: 'button', class: 'tips', 'aria-expanded': 'false', 'aria-controls': tips.map((t) => t.id).join(' '),
      'aria-label': tips.length > 1 ? 'What these buttons do' : 'What this button does' }, el('span', { class: 'q', 'aria-hidden': 'true' }, '?'))
    toggle.addEventListener('click', () => setTips(row, !row.classList.contains('tips-open')))
    row.append(toggle)
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
  window.addEventListener('scroll', follow, { passive: true })
  window.addEventListener('resize', follow)
}
