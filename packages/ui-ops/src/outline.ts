/**
 * Drift evidence (docs/design/ui-operations.md#drift-evidence): a bounded structural outline of
 * a page region, so a stale map element can be fixed without opening the operator's browser. It
 * holds structure only: tags, roles, labels and states, test ids, the names of data attributes,
 * ids, and classes, plus each node's visible text length. Never text, input values, or URLs.
 */
import type { Locator, Page } from 'patchright-core'

export interface OutlineNode {
  /** Depth among the kept nodes (wrappers with nothing to show are skipped). */
  depth: number
  tag: string
  role?: string
  /** `aria-label` (not on links, whose labels are often content such as chat titles), at most 80 characters. */
  label?: string
  /** aria-pressed, -checked, -expanded, -selected, -disabled, -current, as set. */
  states?: Record<string, string>
  testid?: string
  /** Names of the other `data-*` attributes; never their values. */
  data?: string[]
  id?: string
  classes?: string[]
  editable?: true
  /** Visible text length of the node (its own and its descendants'); never the text. */
  text: number
  /** Further siblings with the same signature, folded into this node. */
  repeat?: number
}

export interface UiOutline {
  schema: 'ui-outline@1.0'
  /** The region outlined: a map element, or the page body. */
  root: string
  nodes: OutlineNode[]
  /** True when the node bound cut the outline short. */
  truncated: boolean
}

export const OUTLINE_LIMITS = { nodes: 200, depth: 12 }

/** Outline `root` (a resolved element, or the page body). */
export async function outlineOf(root: Page | Locator, name: string, limits = OUTLINE_LIMITS): Promise<UiOutline> {
  const handle = 'mainFrame' in root ? root.locator('body') : root
  const walked = await handle.first().evaluate((el, max) => {
    const INTERESTING = new Set(['button', 'a', 'input', 'textarea', 'select', 'form', 'main', 'nav', 'header', 'footer', 'aside', 'dialog', 'menu', 'h1', 'h2', 'h3', 'label', 'pre', 'code', 'img', 'svg'])
    const STATES = ['aria-pressed', 'aria-checked', 'aria-expanded', 'aria-selected', 'aria-disabled', 'aria-current', 'aria-hidden']
    const out: Array<Record<string, unknown>> = []
    // The last kept node at each depth under the current parent: like siblings fold into it.
    const lastAt: Array<Record<string, unknown> | undefined> = []
    let truncated = false
    const visible = (e: Element): boolean => {
      const box = (e as HTMLElement).getBoundingClientRect?.()
      const style = getComputedStyle(e)
      return !!box && box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const describe = (e: Element, depth: number): Record<string, unknown> => {
      const tag = e.tagName.toLowerCase()
      const node: Record<string, unknown> = { depth, tag, text: visible(e) ? ((e as HTMLElement).innerText ?? '').trim().length : 0 }
      const role = e.getAttribute('role')
      if (role) node.role = role
      const label = e.getAttribute('aria-label')
      if (label && tag !== 'a') node.label = label.slice(0, 80)
      const states = Object.fromEntries(STATES.filter((s) => e.hasAttribute(s)).map((s) => [s.slice(5), (e.getAttribute(s) ?? '').slice(0, 20)]))
      if (Object.keys(states).length) node.states = states
      const testid = e.getAttribute('data-testid') ?? e.getAttribute('data-test-id')
      if (testid) node.testid = testid.slice(0, 80)
      const data = [...e.attributes].map((a) => a.name).filter((n) => n.startsWith('data-') && n !== 'data-testid' && n !== 'data-test-id').slice(0, 8)
      if (data.length) node.data = data
      if (e.id) node.id = e.id.slice(0, 40)
      const classes = [...e.classList].slice(0, 5).map((c) => c.slice(0, 30))
      if (classes.length) node.classes = classes
      if ((e as HTMLElement).isContentEditable && e.getAttribute('contenteditable') !== null) node.editable = true
      return node
    }
    const shown = (e: Element): boolean => {
      const tag = e.tagName.toLowerCase()
      return INTERESTING.has(tag) || tag.includes('-') || e.hasAttribute('role') || e.hasAttribute('aria-label') || e.hasAttribute('data-testid')
        || e.hasAttribute('data-test-id') || e.getAttribute('contenteditable') !== null || STATES.some((s) => e.hasAttribute(s))
    }
    const signature = (n: Record<string, unknown>): string => JSON.stringify({ ...n, depth: 0, text: 0, label: undefined, id: undefined, repeat: undefined })
    const walk = (e: Element, depth: number): void => {
      if (truncated) return
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(e.tagName)) return
      const keep = depth === 0 || shown(e)
      let next = depth
      if (keep) {
        const node = describe(e, depth)
        const last = lastAt[depth]
        // A run of like siblings (a list of chats, of messages) is one node with a count.
        if (last && signature(last) === signature(node) && depth > 0) {
          last.repeat = ((last.repeat as number | undefined) ?? 0) + 1
          return
        }
        if (out.length >= max.nodes) {
          truncated = true
          return
        }
        out.push(node)
        lastAt.length = depth
        lastAt[depth] = node
        next = depth + 1
      }
      if (next > max.depth) return
      for (const child of e.children) walk(child, next)
      if (e.shadowRoot) for (const child of e.shadowRoot.children) walk(child, next)
    }
    walk(el, 0)
    return { nodes: out, truncated }
  }, limits)
  return { schema: 'ui-outline@1.0', root: name, nodes: walked.nodes as unknown as OutlineNode[], truncated: walked.truncated }
}

/** What a drift report needs of the artifact store: a local-private `evidence` artifact with an id. */
export interface EvidenceStore {
  put(input: { kind: 'evidence'; bodySchema: 'ui-outline@1.0'; body: UiOutline; classification: 'local-private'; producer: { type: 'system'; ref: string } }): { id: string }
}

/**
 * The `ui.drift` event's data for a drift report. The outline goes to the store as a
 * local-private `evidence` artifact (it never leaves the machine, INV-12) and the event names it,
 * since an event carries no page detail.
 */
export function driftData(event: { provider: string; element: string; kind: string; candidate: number; source?: string; mapHash: string; outline?: UiOutline }, store?: EvidenceStore): Record<string, unknown> {
  const { outline, ...data } = event
  const kept = outline && store ? store.put({ kind: 'evidence', bodySchema: 'ui-outline@1.0', body: outline, classification: 'local-private', producer: { type: 'system', ref: `ui-ops/${event.provider}` } }).id : undefined
  return { ...data, ...(kept ? { outline: kept } : {}) }
}
