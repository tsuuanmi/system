/**
 * The UI engine (docs/design/ui-operations.md): resolves map elements to unique,
 * visible elements, runs actions and verifies their postconditions, evaluates states
 * with passive network signals, and heals a drifted element within bounds.
 */
import { createHash } from 'node:crypto'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type { Locator, Page } from 'patchright-core'
import { type Scored, choose, parseAiSnapshot, scoreNodes } from './heal.ts'
import { candidateFromLocator, toLocator } from './locate.ts'
import type { ActionSpec, Candidate, Condition, ElementSpec, UiMap } from './map.ts'
import { NetworkObserver } from './network.ts'

export interface Resolved {
  locator: Locator
  /** Index of the winning candidate; -1 for a healed element. */
  candidate: number
}

export interface DriftEvent {
  provider: string
  element: string
  candidate: number
  source: 'shipped' | 'overlay'
  mapHash: string
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
  onHeal?: (event: HealEvent) => void
  /** Default resolve timeout when an action does not set one (default 5 s). */
  defaultResolveMs?: number
  /** Default verify timeout when an action does not set one (default 15 s). */
  defaultVerifyMs?: number
}

export interface ActArgs {
  text?: string
  files?: string[]
  value?: string
}

export interface ActOptions {
  /** Allow the action's non-locator fallback (default true). */
  allowFallback?: boolean
}

const TICK_MS = 100
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
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

  /** Resolve an element, waiting until one candidate has exactly one visible match. */
  async resolve(id: string, timeoutMs = this.options.defaultResolveMs ?? 5000): Promise<Resolved> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = await this.tryResolve(id)
      if (found) return found
      if (Date.now() >= deadline) throw drift(`${this.map.provider}: no candidate of ${id} matched exactly one visible element`)
      await sleep(TICK_MS)
    }
  }

  /** Number of visible matches of a `many` element (or 0/1 for a `one` element). */
  async count(id: string): Promise<number> {
    const found = await this.tryResolve(id)
    return found ? found.locator.filter({ visible: true }).count() : 0
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
   * Run an action: guards, resolve (candidates, then a bounded heal, then the fallback),
   * preconditions, the action itself, and its postcondition.
   */
  async act(id: string, args: ActArgs = {}, options: ActOptions = {}): Promise<void> {
    const spec = this.map.actions[id]
    if (!spec) throw new ProviderError('config_error', `${this.map.provider}: unknown action ${id}`)
    await this.checkGuards()
    const resolveMs = spec.timeouts?.resolveMs ?? this.options.defaultResolveMs ?? 5000
    const verifyMs = spec.timeouts?.verifyMs ?? this.options.defaultVerifyMs ?? 15_000
    const baselines = await this.baselines(spec.verify)

    let target: Resolved | undefined
    let healed: HealEvent | undefined
    try {
      target = await this.resolve(spec.target, resolveMs)
    } catch (error) {
      if (!(error instanceof ProviderError) || error.kind !== 'ui_drift') throw error
      await this.checkGuards()
      const heal = await this.heal(id, spec)
      if (heal) ({ target, event: healed } = heal)
      else if (spec.fallback && options.allowFallback !== false) {
        const on = await this.resolve(spec.fallback.on, resolveMs)
        await on.locator.press(spec.fallback.press)
        await this.verify(id, spec, verifyMs, baselines)
        return
      } else throw error
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
    let root: Page | Locator = this.page
    if (spec.scope) {
      const scope = await this.tryResolve(spec.scope)
      if (!scope) return undefined
      root = scope.locator
    }
    for (const [index, candidate] of spec.candidates.entries()) {
      const locator = toLocator(root, candidate, this.map.locales)
      const visible = locator.filter({ visible: true })
      const n = await visible.count()
      if (spec.cardinality === 'many' ? n === 0 : n !== 1) continue
      if (index > 0) this.reportDrift(id, index, candidate.source)
      return { locator: spec.cardinality === 'many' ? locator : visible, candidate: index }
    }
    return undefined
  }

  private element(id: string): ElementSpec {
    const spec = this.map.elements[id]
    if (!spec) throw new ProviderError('config_error', `${this.map.provider}: unknown element ${id}`)
    return spec
  }

  private reportDrift(element: string, candidate: number, source: 'shipped' | 'overlay'): void {
    if (this.drifted.has(element)) return
    this.drifted.add(element)
    this.options.onDrift?.({ provider: this.map.provider, element, candidate, source, mapHash: this.map.hash })
  }

  /** The map's `errors` conditions guard every action: a login surface or challenge is never healed around. */
  private async checkGuards(): Promise<void> {
    for (const rule of this.map.errors) {
      if (await this.evaluate(rule.when, new Map())) {
        throw new ProviderError(rule.kind, rule.message ?? `${this.map.provider}: ${rule.kind} (${JSON.stringify(rule.when)})`)
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
      case 'insertText': {
        const text = args.text ?? ''
        await locator.click()
        // Insert as text (no key events), so editor shortcuts never fire; then read back.
        await this.page.keyboard.insertText(text)
        const value = await locator.evaluate((el) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent))
        if (normalizeText(value) !== normalizeText(text)) {
          throw new ProviderError('ui_drift', `${this.map.provider}: ${spec.target} readback differs from the inserted text`)
        }
      }
    }
  }

  private async verify(action: string, spec: ActionSpec, timeoutMs: number, baselines: Baselines): Promise<void> {
    try {
      await this.waitFor(spec.verify, timeoutMs, baselines)
    } catch (error) {
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

  private async evaluate(condition: Condition, baselines: Baselines): Promise<boolean> {
    if ('visible' in condition) return (await this.tryResolve(condition.visible)) !== undefined
    if ('hidden' in condition) return (await this.tryResolve(condition.hidden)) === undefined
    if ('countIncreased' in condition) return (await this.count(condition.countIncreased)) > (baselines.get(`count:${condition.countIncreased}`) ?? 0)
    if ('network' in condition) {
      const open = this.map.network[condition.network]?.open
      const seen = this.network.seen(condition.network)
      return open ? seen > 0 : seen > (baselines.get(`network:${condition.network}`) ?? 0)
    }
    if ('url' in condition) return new RegExp(condition.url).test(this.page.url())
    if ('state' in condition) return this.evaluate(this.map.states[condition.state]!, baselines)
    if ('attr' in condition) {
      const found = await this.tryResolve(condition.attr.of)
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
      for (const c of condition.anyOf) if (await this.evaluate(c, baselines)) return true
      return false
    }
    if ('allOf' in condition) {
      for (const c of condition.allOf) if (!(await this.evaluate(c, baselines))) return false
      return true
    }
    return !(await this.evaluate(condition.not, baselines))
  }
}
