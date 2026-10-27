/**
 * The UI engine (docs/design/ui-operations.md): resolves map elements to unique,
 * visible elements, runs actions and verifies their postconditions, evaluates states
 * with passive network signals, and heals a drifted element within bounds.
 */
import { createHash } from 'node:crypto'
import { sleep } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type { Frame, Locator, Page } from 'patchright-core'
import { type Scored, choose, parseAiSnapshot, scoreNodes } from './heal.ts'
import { candidateFromLocator, toLocator } from './locate.ts'
import type { ActionSpec, Candidate, Condition, ElementSpec, UiMap } from './map.ts'
import { NetworkObserver } from './network.ts'
import { outlineOf, type UiOutline } from './outline.ts'

export interface Resolved {
  locator: Locator
  /** Index of the winning candidate; -1 for a healed element. */
  candidate: number
}

/**
 * A stale map: an element found only on a later candidate (`fallback`), an action's target not
 * found (`unresolved`), or an action that did not reach its postcondition (`postcondition`; its
 * `element` is the action). It carries a structural outline of the region, when one could be read.
 */
export interface DriftEvent {
  provider: string
  element: string
  kind: 'fallback' | 'unresolved' | 'postcondition' | 'readback'
  /** The winning candidate (`fallback`), or -1. */
  candidate: number
  source?: 'shipped' | 'overlay'
  mapHash: string
  outline?: UiOutline
  /** `readback`: where the text read back first differs from the text inserted (structure only). */
  readback?: ReadbackDiff
  /** The page's path when it drifted (never its query), as a stall's `url`: a page the site sent elsewhere shows here. */
  url?: string
  /**
   * `unresolved`: what each candidate found, in the map's order, where the element is looked for
   * (its scope, or the page): counts only. A candidate that finds the element but shows none of it
   * (`found` above `shown`) tells a control the page hides from one it renamed or removed.
   */
  matches?: CandidateMatches[]
}

/** One candidate's matches: every element it finds, hidden ones too, and how many of them are visible. */
export interface CandidateMatches {
  found: number
  shown: number
}

/**
 * Where a composer's text differs from what was inserted: lengths, lines, and the first difference
 * by line and offset, with only the class of the characters there. It never contains the text
 * itself: only an ASCII punctuation mark is named, since a composer that rewrites one (a code
 * fence, say) is the likely cause.
 */
export interface ReadbackDiff {
  insertedChars: number
  readChars: number
  /** Non-empty lines after whitespace is normalized, as the comparison sees them. */
  insertedLines: number
  readLines: number
  /** The first line (0-based) and offset in it where they differ. */
  line: number
  offset: number
  inserted: string
  read: string
  /** The text read back is the start of the text inserted: it was cut short. */
  truncated: boolean
}

/**
 * The text typed into a composer, block-aware: each paragraph, div, or <br> is a line; non-editable
 * islands (tool mention chips) are not part of it.
 */
function typedText(locator: Locator): Promise<string> {
  return locator.evaluate((el) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value
    const lines: string[] = ['']
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        lines[lines.length - 1] += node.textContent ?? ''
        return
      }
      if (!(node instanceof Element) || node.getAttribute('contenteditable') === 'false') return
      if (node.tagName === 'BR') lines.push('')
      const block = /^(P|DIV|LI|PRE|BLOCKQUOTE|H[1-6])$/.test(node.tagName)
      if (block && lines[lines.length - 1] !== '') lines.push('')
      for (const child of node.childNodes) walk(child)
      if (block) lines.push('')
    }
    for (const child of el.childNodes) walk(child)
    return lines.join('\n')
  })
}

const charClass = (c: string | undefined): string => (c === undefined ? 'end' : /\p{L}/u.test(c) ? 'letter' : /\p{N}/u.test(c) ? 'digit' : /\s/.test(c) ? 'space' : /[!-/:-@[-`{-~]/.test(c) ? `punctuation ${c}` : 'other')

/** The first difference between an inserted text and what the composer shows, structure only. */
export function readbackDiff(inserted: string, read: string): ReadbackDiff {
  const a = lineText(inserted)
  const b = lineText(read)
  const al = a.split('\n')
  const bl = b.split('\n')
  let line = 0
  while (line < al.length && line < bl.length && al[line] === bl[line]) line++
  const x = al[line] ?? ''
  const y = bl[line] ?? ''
  let offset = 0
  while (offset < x.length && offset < y.length && x[offset] === y[offset]) offset++
  return {
    insertedChars: inserted.length, readChars: read.length, insertedLines: a ? al.length : 0, readLines: b ? bl.length : 0,
    line, offset, inserted: charClass(x[offset]), read: charClass(y[offset]), truncated: b.length < a.length && a.startsWith(b),
  }
}

/**
 * A turn whose answer stalled or ran out of time: the page outlined (structure only, redacted as a
 * drift outline is), with what it said of itself. So a stall can be read without the operator's
 * browser.
 */
export interface StallEvent {
  provider: string
  /** Where it stalled: `answer`, `research`. */
  phase: string
  /** `document.visibilityState` and `document.hasFocus()` of the page, when readable. */
  visibility?: string
  focused?: boolean
  url?: string
  outline?: UiOutline
}

/**
 * A Copy whose Markdown was not kept, so the answer was read as rendered text: nothing copied
 * (`empty`), its words not the rendered answer's (`words`, with the counts of the comparison), or
 * the copy failing (`failed`). Counts only, never text (`provider.copy-refused`).
 */
export interface CopyRefusedEvent {
  provider: string
  reason: 'empty' | 'words' | 'failed'
  prose?: number
  shown?: number
  matched?: number
  links?: number
  linkWords?: number
  allowance?: number
}

export interface HealEvent {
  provider: string
  element: string
  action: string
  outcome: 'healed' | 'rejected' | 'failed'
  model: boolean
  /** The durable locator to append to the overlay (healed only). */
  candidate?: Candidate
  scores: Scored[]
  snapshotHash: string
  mapHash: string
}

export interface EngineOptions {
  onDrift?: (event: DriftEvent) => void
  /** A Copy that was not kept (see `CopyRefusedEvent`). */
  onCopyRefused?: (event: CopyRefusedEvent) => void
  /** After a heal settles: `healed` (verified), `failed` (acted, postcondition not met), or `rejected` (no action). */
  onHeal?: (event: HealEvent) => void
  /**
   * Called with the chosen heal **before** the healed element is acted on, so the
   * decision is recorded before its effect (INV-13). A throw aborts the action.
   */
  beforeHealedAction?: (event: HealEvent) => void | Promise<void>
  /** Set false to disable healing entirely (e.g. no decision store is available). */
  heal?: boolean
  /** Default resolve timeout when an action does not set one (default 5 s). */
  defaultResolveMs?: number
  /** Default verify timeout when an action does not set one (default 15 s). */
  defaultVerifyMs?: number
  /**
   * Values a drift outline masks: the account's own name and address, as the driver reads them
   * from the page. Email addresses are masked anyway.
   */
  redact?: () => Promise<readonly string[]>
}

export interface ActArgs {
  text?: string
  files?: string[]
  value?: string
}

export interface ActOptions {
  /** Allow the action's non-locator fallback (default true). */
  allowFallback?: boolean
  /**
   * Check the map's `errors` guards first (default true). Sign-in steps turn this off,
   * because a signed-out page is where they run; they check their own stop conditions.
   */
  guards?: boolean
}

const TICK_MS = 100
/**
 * How long a later candidate's match waits for an earlier one before it counts as drift: a page
 * still rendering shows some elements a moment before others (Gemini's prompt host before its
 * bubble, a menu still opening).
 */
const SETTLE_MS = 250
/** Lines with inner spacing collapsed and blank lines dropped: what an editor must preserve. */
const lineText = (s: string | null): string => (s ?? '').split('\n').map((l) => l.replace(/[\s\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n')
const normalizeText = (s: string | null): string => (s ?? '').replace(/ /g, ' ').trim()
const drift = (message: string): ProviderError => new ProviderError('ui_drift', message)

type Baselines = Map<string, number>

export class UiEngine {
  readonly network: NetworkObserver
  private readonly drifted = new Set<string>()
  private readonly texts = new Map<string, { text: string; since: number }>()

  constructor(private readonly page: Page, readonly map: UiMap, private readonly options: EngineOptions = {}) {
    this.network = new NetworkObserver(page, map.network)
  }

  dispose(): void {
    this.network.dispose()
  }

  /** Resolve an element, waiting until one candidate has exactly one visible match (`many`: any). */
  async resolve(id: string, timeoutMs = this.options.defaultResolveMs ?? 5000): Promise<Resolved> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = await this.tryResolve(id)
      if (found) return found
      if (Date.now() >= deadline) throw drift(`${this.map.provider}: no candidate of ${id} matched ${this.element(id).cardinality === 'many' ? 'any' : 'exactly one'} visible element`)
      await sleep(TICK_MS)
    }
  }

  /**
   * Resolve an element inside one given frame (for example, the frames of one embedded app),
   * instead of the first frame anywhere that matches. Undefined when nothing matches there.
   */
  async findIn(id: string, root: Frame | Locator): Promise<Resolved | undefined> {
    const detached = (): boolean => 'isDetached' in root && root.isDetached()
    if (detached()) return undefined
    return this.matchIn(id, this.element(id), root).catch((error: unknown) => {
      if (detached() || /detached/i.test((error as Error).message)) return undefined
      throw error
    })
  }

  /** Number of visible matches of a `many` element (or 0/1 for a `one` element). */
  async count(id: string): Promise<number> {
    const found = await this.tryResolve(id)
    return found ? found.locator.filter({ visible: true }).count() : 0
  }

  /**
   * Report a stale element the driver found itself (a mode it could not reach, say), with drift
   * evidence, before the driver fails the turn as `ui_drift`.
   */
  async drift(element: string, kind: DriftEvent['kind'] = 'unresolved'): Promise<void> {
    await this.reportDrift(element, kind, -1)
  }

  /**
   * What each of an element's candidates finds now, where the element is looked for (its scope,
   * or every frame for `frames: any`), hidden matches counted apart from visible ones. Undefined
   * when its scope does not resolve, so nothing is counted in the wrong place.
   */
  async matches(id: string): Promise<CandidateMatches[] | undefined> {
    const spec = this.element(id)
    const roots: Array<Page | Locator | Frame> = []
    if (spec.frames === 'any') roots.push(...this.page.frames().filter((frame) => !frame.isDetached()))
    else if (spec.scope) {
      const scope = await this.tryResolve(spec.scope)
      if (!scope) return undefined
      roots.push(scope.locator)
    } else roots.push(this.page)
    const counts: CandidateMatches[] = []
    for (const candidate of spec.candidates) {
      let found = 0
      let shown = 0
      for (const root of roots) {
        found += await toLocator(root, candidate, this.map.locales, { includeHidden: true }).count()
        shown += await toLocator(root, candidate, this.map.locales).filter({ visible: true }).count()
      }
      counts.push({ found, shown })
    }
    return counts
  }

  /** Evaluate a named state now. */
  async state(id: string): Promise<boolean> {
    return this.evaluate({ state: id }, new Map())
  }

  /** Poll a condition until it holds; a timeout is a typed failure. */
  async waitFor(condition: Condition, timeoutMs: number, baselines: Baselines = new Map()): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await this.evaluate(condition, baselines)) return
      if (Date.now() >= deadline) throw new ProviderError('timeout', `${this.map.provider}: condition not met within ${timeoutMs} ms: ${JSON.stringify(condition)}`)
      await sleep(TICK_MS)
    }
  }

  /** Text of an element, normalized (non-breaking spaces, outer whitespace). */
  async text(id: string): Promise<string> {
    const { locator } = await this.resolve(id)
    return normalizeText(await locator.innerText())
  }

  /**
   * What a copy control puts on the clipboard: the clipboard is cleared, the control clicked,
   * and the clipboard read until it holds text (briefly). Empty when the control copied
   * nothing, so an earlier copy is never mistaken for this one.
   */
  /** Report a Copy that was not kept, with its counts. */
  copyRefused(event: Omit<CopyRefusedEvent, 'provider'>): void {
    this.options.onCopyRefused?.({ provider: this.map.provider, ...event })
  }

  async copied(control: Locator): Promise<string> {
    await this.page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(this.page.url()).origin })
    await this.page.evaluate(() => navigator.clipboard.writeText(''))
    await control.click({ timeout: 3000 })
    let text = ''
    for (let tries = 0; tries < 10 && !text; tries++) {
      text = await this.page.evaluate(() => navigator.clipboard.readText())
      if (!text) await sleep(100)
    }
    return text
  }

  /**
   * Run an action: guards, resolve (candidates, then a bounded heal, then the fallback),
   * preconditions, the action itself, and its postcondition.
   */
  async act(id: string, args: ActArgs = {}, options: ActOptions = {}): Promise<void> {
    const spec = this.map.actions[id]
    if (!spec) throw new ProviderError('config_error', `${this.map.provider}: unknown action ${id}`)
    const guarded = options.guards !== false
    if (guarded) await this.checkGuards()
    const resolveMs = spec.timeouts?.resolveMs ?? this.options.defaultResolveMs ?? 5000
    const verifyMs = spec.timeouts?.verifyMs ?? this.options.defaultVerifyMs ?? 15_000
    const baselines = await this.baselines(spec.verify)

    let target: Resolved | undefined
    let healed: HealEvent | undefined
    try {
      target = await this.resolve(spec.target, resolveMs)
    } catch (error) {
      if (!(error instanceof ProviderError) || error.kind !== 'ui_drift') throw error
      if (guarded) await this.checkGuards()
      const heal = this.options.heal === false ? undefined : await this.heal(id, spec)
      if (heal) {
        ;({ target, event: healed } = heal)
        await this.options.beforeHealedAction?.(heal.event)
      }
      else if (spec.fallback && options.allowFallback !== false) {
        const on = await this.resolve(spec.fallback.on, resolveMs)
        await on.locator.press(spec.fallback.press)
        await this.verify(id, spec, verifyMs, baselines)
        return
      } else {
        await this.reportDrift(spec.target, 'unresolved', -1)
        throw error
      }
    }

    await this.require(target.locator, spec, resolveMs)
    await this.perform(spec, target.locator, args)
    try {
      await this.verify(id, spec, verifyMs, baselines)
    } catch (error) {
      if (healed) this.options.onHeal?.({ ...healed, outcome: 'failed' })
      throw error
    }
    if (healed) this.options.onHeal?.(healed)
  }

  private async tryResolve(id: string): Promise<Resolved | undefined> {
    const spec = this.element(id)
    if (spec.frames === 'any') {
      for (const frame of this.page.frames()) {
        // A frame can be replaced while it is searched (pages re-render their iframes).
        if (frame.isDetached()) continue
        const found = await this.matchIn(id, spec, frame).catch((error: unknown) => {
          if (frame.isDetached() || /detached/i.test((error as Error).message)) return undefined
          throw error
        })
        if (found) return found
      }
      return undefined
    }
    let root: Page | Locator = this.page
    if (spec.scope) {
      const scope = await this.tryResolve(spec.scope)
      if (!scope) return undefined
      root = scope.locator
    }
    return this.matchIn(id, spec, root)
  }

  private async matchIn(id: string, spec: ElementSpec, root: Page | Locator | Frame, settled = false): Promise<Resolved | undefined> {
    for (const [index, candidate] of spec.candidates.entries()) {
      const locator = toLocator(root, candidate, this.map.locales)
      const visible = locator.filter({ visible: true })
      const n = await visible.count()
      if (spec.cardinality === 'many' ? n === 0 : n !== 1) continue
      // A later candidate matched: the earlier ones are tried once more after the page settles.
      if (index > 0 && !settled) {
        await sleep(SETTLE_MS)
        return this.matchIn(id, spec, root, true)
      }
      const resolved = { locator: spec.cardinality === 'many' ? locator : visible, candidate: index }
      if (index > 0) await this.reportDrift(id, 'fallback', index, candidate.source, resolved.locator)
      return resolved
    }
    return undefined
  }

  private element(id: string): ElementSpec {
    const spec = this.map.elements[id]
    if (!spec) throw new ProviderError('config_error', `${this.map.provider}: unknown element ${id}`)
    return spec
  }

  /**
   * Report a stale map once per element and kind for this page, with a structural outline: of the
   * found element's parent on a fallback, of an unresolved element's scope, or else of the page
   * body, its side navigation folded. It names the page's path, and for an unresolved element what
   * each candidate found. Evidence that cannot be read is left out; it never fails the turn.
   */
  private async reportDrift(element: string, kind: DriftEvent['kind'], candidate: number, source?: 'shipped' | 'overlay', found?: Locator, readback?: ReadbackDiff): Promise<void> {
    if (!this.options.onDrift || this.drifted.has(`${kind}\0${element}`)) return
    this.drifted.add(`${kind}\0${element}`)
    const spec = this.map.elements[element]
    const scope = kind === 'unresolved' && spec?.scope ? await this.tryResolve(spec.scope).catch(() => undefined) : undefined
    const root = found ? found.first().locator('xpath=..') : scope?.locator
    const redact = await this.options.redact?.().catch(() => []) ?? []
    const outline = await outlineOf(root ?? this.page, found ? `parent of ${element}` : scope ? spec!.scope! : 'body', undefined, redact, { foldNavigation: !root }).catch(() => undefined)
    const matches = kind === 'unresolved' && spec ? await this.matches(element).catch(() => undefined) : undefined
    const url = this.path()
    this.options.onDrift({
      provider: this.map.provider, element, kind, candidate, ...(source ? { source } : {}), mapHash: this.map.hash, ...(url ? { url } : {}),
      ...(matches ? { matches } : {}), ...(outline ? { outline } : {}), ...(readback ? { readback } : {}),
    })
  }

  /** The page's path, never its query or fragment; undefined when its URL cannot be read. */
  private path(): string | undefined {
    try {
      return new URL(this.page.url()).pathname
    } catch {
      return undefined
    }
  }

  /**
   * The page as it stands, for a stall: outlined (structure only, redacted, its side navigation
   * folded), with its visibility, focus, and path.
   */
  async stall(phase: string): Promise<StallEvent> {
    const redact = await this.options.redact?.().catch(() => []) ?? []
    const outline = await outlineOf(this.page, `turn page (${phase} stalled)`, undefined, redact, { foldNavigation: true }).catch(() => undefined)
    const seen = await this.page.evaluate(() => ({ visibility: document.visibilityState as string, focused: document.hasFocus() })).catch(() => undefined)
    const url = this.path()
    return { provider: this.map.provider, phase, ...seen, ...(url ? { url } : {}), ...(outline ? { outline } : {}) }
  }

  /** The map's `errors` conditions guard every action: a login surface or challenge is never healed around. */
  private async checkGuards(): Promise<void> {
    await this.checkErrors('act')
  }

  /**
   * The map's error rules checked on a turn's answer once it is read (`on: answer`): the site
   * answered with its own usage limit, say. The turn was sent; the caller fails it with the rule's
   * kind and feature (ADR-0034). The rule's elements are looked for inside `answer` only, so the
   * same text in an earlier answer of the conversation never counts again.
   */
  async answerErrors(answer: Locator): Promise<void> {
    await this.checkErrors('answer', answer)
  }

  private async checkErrors(on: 'act' | 'answer', root?: Locator): Promise<void> {
    for (const rule of this.map.errors) {
      if ((rule.on ?? 'act') !== on) continue
      if (await this.evaluate(rule.when, new Map(), root)) {
        throw new ProviderError(rule.kind, rule.message ?? `${this.map.provider}: ${rule.kind} (${JSON.stringify(rule.when)})`, rule.feature ? { feature: rule.feature } : undefined)
      }
    }
  }

  private async heal(action: string, spec: ActionSpec): Promise<{ target: Resolved; event: HealEvent } | undefined> {
    const policy = spec.heal ?? 'off'
    if (policy === 'off') return undefined
    const element = this.element(spec.target)
    if (!element.fingerprint) return undefined
    const scope = element.scope ? await this.tryResolve(element.scope) : undefined
    const root = scope?.locator ?? this.page.locator('body')
    const snapshot = await root.ariaSnapshot({ mode: 'ai' })
    const scores = scoreNodes(parseAiSnapshot(snapshot), element.fingerprint, this.map.locales).slice(0, 5)
    const base: HealEvent = {
      provider: this.map.provider, element: spec.target, action, outcome: 'rejected', model: false, scores,
      snapshotHash: `sha256:${createHash('sha256').update(snapshot).digest('hex')}`, mapHash: this.map.hash,
    }
    // A model proposal (policy `model`) arrives with the ctx.models seam; until then healing is deterministic.
    const best = choose(scores)
    const located = best && this.page.locator(`aria-ref=${best.ref}`)
    if (!best || !located || (await located.count()) !== 1) {
      this.options.onHeal?.(base)
      return undefined
    }
    const durable = await located.normalize()
    if ((await durable.filter({ visible: true }).count()) !== 1) {
      this.options.onHeal?.(base)
      return undefined
    }
    const candidate = candidateFromLocator(durable, this.map.locales[0] ?? 'en')
    return { target: { locator: durable, candidate: -1 }, event: { ...base, outcome: 'healed', ...(candidate ? { candidate } : {}) } }
  }

  private async require(locator: Locator, spec: ActionSpec, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (const need of spec.require ?? []) {
      for (;;) {
        const ok = need === 'enabled' ? await locator.isEnabled() : await locator.isEditable()
        if (ok) break
        if (Date.now() >= deadline) throw drift(`${this.map.provider}: ${spec.target} is not ${need}`)
        await sleep(TICK_MS)
      }
    }
  }

  private async perform(spec: ActionSpec, locator: Locator, args: ActArgs): Promise<void> {
    switch (spec.do) {
      case 'click':
        await locator.click()
        return
      case 'press':
        await locator.press(spec.key ?? 'Enter')
        return
      case 'setFiles':
        await locator.setInputFiles(args.files ?? [])
        return
      case 'select':
        await locator.selectOption(args.value ?? '')
        return
      case 'clearText': {
        // A site can keep an unsent draft across page loads (Gemini in a login profile, live
        // 2026-10-17): it is removed before a turn types anything, and must read back empty.
        await locator.click()
        await locator.press('ControlOrMeta+A')
        await locator.press('Delete')
        const value = await typedText(locator)
        if (lineText(value)) {
          const diff = readbackDiff('', value)
          await this.reportDrift(spec.target, 'readback', -1, undefined, locator, diff)
          throw new ProviderError('ui_drift', `${this.map.provider}: ${spec.target} could not be cleared (${diff.readChars} characters, ${diff.readLines} lines still there)`)
        }
        return
      }
      case 'insertText': {
        const text = args.text ?? ''
        await locator.click()
        // After anything already in the composer (such as a tool mention chip).
        await locator.press('ControlOrMeta+End')
        // Insert as text (no key events), so editor shortcuts never fire; then read back.
        await this.page.keyboard.insertText(text)
        const value = await typedText(locator)
        // Editors turn line breaks into paragraphs and may change spacing; the lines and
        // their characters must survive.
        if (lineText(value) !== lineText(text)) {
          // Outlined with where it differs (never the text), so a composer that rewrites a paste can be read.
          const diff = readbackDiff(text, value)
          await this.reportDrift(spec.target, 'readback', -1, undefined, locator, diff)
          throw new ProviderError('ui_drift', `${this.map.provider}: ${spec.target} readback differs from the inserted text (${diff.insertedChars} characters inserted, ${diff.readChars} read back; ${diff.insertedLines} lines against ${diff.readLines}; first difference at line ${diff.line}, offset ${diff.offset}: ${diff.inserted} against ${diff.read}${diff.truncated ? '; cut short' : ''})`)
        }
      }
    }
  }

  private async verify(action: string, spec: ActionSpec, timeoutMs: number, baselines: Baselines): Promise<void> {
    try {
      await this.waitFor(spec.verify, timeoutMs, baselines)
    } catch (error) {
      await this.reportDrift(action, 'postcondition', -1)
      throw new ProviderError('ui_drift', `${this.map.provider}: ${action} did not reach its postcondition`, { cause: error })
    }
  }

  /** Counts that `countIncreased` and `network` compare against, taken before acting. */
  private async baselines(condition: Condition, into: Baselines = new Map()): Promise<Baselines> {
    if ('countIncreased' in condition) into.set(`count:${condition.countIncreased}`, await this.count(condition.countIncreased))
    else if ('network' in condition) into.set(`network:${condition.network}`, this.network.seen(condition.network))
    else if ('state' in condition) await this.baselines(this.map.states[condition.state]!, into)
    else if ('anyOf' in condition) for (const c of condition.anyOf) await this.baselines(c, into)
    else if ('allOf' in condition) for (const c of condition.allOf) await this.baselines(c, into)
    else if ('not' in condition) await this.baselines(condition.not, into)
    return into
  }

  /** A condition over the page; with `root`, its elements are looked for inside it only. */
  private async evaluate(condition: Condition, baselines: Baselines, root?: Locator): Promise<boolean> {
    const find = (id: string): Promise<Resolved | undefined> => (root ? this.findIn(id, root) : this.tryResolve(id))
    if ('visible' in condition) return (await find(condition.visible)) !== undefined
    if ('hidden' in condition) return (await find(condition.hidden)) === undefined
    if ('countIncreased' in condition) return (await this.count(condition.countIncreased)) > (baselines.get(`count:${condition.countIncreased}`) ?? 0)
    if ('network' in condition) {
      const open = this.map.network[condition.network]?.open
      const seen = this.network.seen(condition.network)
      return open ? seen > 0 : seen > (baselines.get(`network:${condition.network}`) ?? 0)
    }
    if ('url' in condition) return new RegExp(condition.url).test(this.page.url())
    if ('state' in condition) return this.evaluate(this.map.states[condition.state]!, baselines, root)
    if ('attr' in condition) {
      const found = await find(condition.attr.of)
      if (!found) return false
      const value = await found.locator.getAttribute(condition.attr.name)
      if (condition.attr.equals !== undefined) return value === condition.attr.equals
      return (value !== null) === (condition.attr.present ?? true)
    }
    if ('stableTextMs' in condition) {
      const found = await this.tryResolve(condition.of)
      if (!found) return false
      const text = normalizeText(await found.locator.innerText())
      const now = Date.now()
      const last = this.texts.get(condition.of)
      if (!last || last.text !== text) {
        this.texts.set(condition.of, { text, since: now })
        return false
      }
      return now - last.since >= condition.stableTextMs
    }
    if ('anyOf' in condition) {
      for (const c of condition.anyOf) if (await this.evaluate(c, baselines, root)) return true
      return false
    }
    if ('allOf' in condition) {
      for (const c of condition.allOf) if (!(await this.evaluate(c, baselines, root))) return false
      return true
    }
    return !(await this.evaluate(condition.not, baselines, root))
  }
}
