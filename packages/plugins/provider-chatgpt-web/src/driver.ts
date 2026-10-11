/**
 * The ChatGPT Web provider driver (docs/design/provider-turns.md). Procedures only: every
 * element, action, and state comes from `ui/chatgpt-web.ui.yaml` through the UI engine
 * (ADR-0021), so a UI change is a map change. Rules that are not UI:
 * - a new conversation starts in **Chat** mode, never Work (Work spends the Codex quota);
 * - one-shot turns run in Temporary chat; persistent turns bind `/c/<id>`;
 * - running is Stop in the action slot; completion also needs the answer's finished
 *   marker and stable text (the event stream stays open, so it is never consulted).
 */
import { readFileSync } from 'node:fs'
import { type AskOptions, type AskResult, type AuthState, type ConversationMode, ProviderError, type ProviderDriver, type ProviderMode, waitForStableCompletion } from '@tsuuanmi/system-provider-core'
import { type DriftEvent, type HealEvent, UiEngine, type UiMap, loadUiMap } from '@tsuuanmi/system-ui-ops'
import type { Page } from 'patchright-core'

export type { AskOptions, AskResult, AuthState, ConversationMode, ProviderMode }

export interface DriverTimeouts {
  /** Hard deadline for one turn (default 15 min). */
  turnMs?: number
  /** No-progress deadline (default 3 min). */
  stallMs?: number
  /** Unchanged-text window before an answer counts as complete (default 1.5 s). */
  stableMs?: number
  pollMs?: number
  /** Page readiness after navigation (default 30 s). */
  readyMs?: number
}

export interface DriverOptions {
  /** Site origin; tests point it at a local fake (default https://chatgpt.com). */
  origin?: string
  /** Local overlay text (`<DSH_HOME>/system/ui/chatgpt-web.overlay.yaml`). */
  overlay?: string
  timeouts?: DriverTimeouts
  /** Named mode presets (model and Power level as the site names them). */
  modes?: Record<string, ProviderMode>
  /** Preset used when a turn names none; with no default the site's current selection is kept and read back. */
  defaultMode?: string
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const MAP_URL = new URL('../ui/chatgpt-web.ui.yaml', import.meta.url)
const CONVERSATION = /\/c\/([0-9a-f-]{36})(?:[/?#]|$)/

/** The shipped map, with an optional local overlay merged after it. */
export function shippedMap(overlay?: string): UiMap {
  return loadUiMap(readFileSync(MAP_URL, 'utf8'), overlay)
}

export class ChatGptWebDriver implements ProviderDriver<Page> {
  readonly provider = 'chatgpt-web'
  readonly loginUrl: string
  readonly stateOrigins: readonly string[]
  readonly map: UiMap
  onDrift: ((event: DriftEvent) => void) | undefined
  onHeal: ((event: HealEvent) => void) | undefined
  /** Records a chosen heal before it acts (INV-13); a throw aborts the action. */
  beforeHealedAction: ((event: HealEvent) => void | Promise<void>) | undefined
  /** Whether self-heal may run; the plugin turns it off when no decision store exists. */
  healEnabled: () => boolean = () => true
  private readonly origin: string
  private readonly timeouts: Required<DriverTimeouts>
  private readonly engines = new WeakMap<Page, UiEngine>()
  private readonly modes: Record<string, ProviderMode>
  private readonly defaultMode: string | undefined

  constructor(options: DriverOptions = {}) {
    this.map = shippedMap(options.overlay)
    this.origin = (options.origin ?? 'https://chatgpt.com').replace(/\/$/, '')
    this.modes = options.modes ?? {}
    this.defaultMode = options.defaultMode
    if (this.defaultMode !== undefined && !this.modes[this.defaultMode]) {
      throw new ProviderError('config_error', `chatgpt-web: default mode ${this.defaultMode} is not a configured mode`)
    }
    this.loginUrl = `${this.origin}/auth/login`
    this.stateOrigins = [this.origin]
    this.timeouts = { turnMs: 15 * 60_000, stallMs: 3 * 60_000, stableMs: 1500, pollMs: 250, readyMs: 30_000, ...options.timeouts }
  }

  /** Signed in (composer present), signed out (positive evidence only), or unknown. */
  async checkAuth(page: Page): Promise<AuthState> {
    if (!page.url().startsWith(this.origin)) await page.goto(`${this.origin}/`, { waitUntil: 'domcontentloaded' })
    const engine = this.engine(page)
    try {
      await engine.waitFor({ anyOf: [{ state: 'auth.signed-in' }, { state: 'auth.signed-out' }] }, this.timeouts.readyMs)
    } catch {
      return 'unknown'
    }
    return (await engine.state('auth.signed-out')) ? 'signed-out' : 'signed-in'
  }

  /**
   * The signed-in account's id, observed passively from the page's own account request
   * (the map's `account.me` signal). The page is reloaded so the request happens again;
   * nothing is requested by the driver itself. Only a hash of the result is ever stored.
   */
  async identity(page: Page): Promise<string> {
    const pattern = this.map.network['account.me']
    if (!pattern) throw new ProviderError('config_error', 'chatgpt-web: the UI map has no account.me signal')
    const url = new RegExp(pattern.url)
    const response = page.waitForResponse((r) => r.request().method() === (pattern.method ?? 'GET') && url.test(new URL(r.url()).pathname), { timeout: this.timeouts.readyMs })
    await page.reload({ waitUntil: 'domcontentloaded' })
    const body = (await (await response).json().catch(() => ({}))) as { id?: unknown }
    if (typeof body.id !== 'string' || !body.id) throw new ProviderError('ui_drift', 'chatgpt-web: the account response carried no id')
    return `${this.provider}:${body.id}`
  }

  /** One turn: open the conversation, select Chat, submit, and wait for the answer. */
  async ask(page: Page, prompt: string, options: AskOptions): Promise<AskResult> {
    const feature = options.feature ?? 'chat'
    if (feature === 'deep-research' && options.conversation !== 'persistent') {
      throw new ProviderError('invalid_input', 'chatgpt-web: Deep research needs a persistent conversation (it is not offered in Temporary chat)')
    }
    const preset = this.preset(options.mode)
    await this.open(page, options)
    const engine = this.engine(page)
    const before = await engine.count('turn.assistant')
    const previousResponse = before > 0 ? await this.answerText(engine) : null
    const mode = await this.selectMode(page, preset)
    if (feature === 'deep-research') {
      await engine.act('tools.open')
      await engine.act('tools.deep-research')
    }
    await engine.act('composer.insert', { text: prompt })
    await this.requireChat(engine, 'before sending')
    options.signal?.throwIfAborted()
    await options.beforeSend?.({ previousResponse, mode })
    await engine.act('composer.send')
    const text = await this.waitForAnswer(page, before, options.signal, options.deadlines, options.conversation === 'persistent' && !options.binding ? options.onBinding : undefined)
    if (options.conversation === 'temporary') return { text, binding: undefined, mode }
    const binding = await this.binding(page)
    if (options.binding !== undefined && binding !== options.binding) {
      throw new ProviderError('session_broken', `chatgpt-web: conversation moved from ${options.binding} to ${binding}`)
    }
    return { text, binding, mode }
  }

  /**
   * Select a model and Power level in the model menu, then read both back. Nothing is
   * assumed: an unknown or locked model, or an unreachable level, fails before sending.
   */
  async selectMode(page: Page, wanted: ProviderMode | undefined): Promise<ProviderMode> {
    const engine = this.engine(page)
    await engine.act('model.open')
    try {
      const options = (await engine.resolve('model.option', 3000)).locator
      if (wanted?.model) {
        const names = await this.optionNames(options)
        const match = options.filter({ hasText: new RegExp(`^\\s*${escapeRegex(wanted.model)}(?![\\w.])`) })
        if ((await match.count()) !== 1) {
          throw new ProviderError('config_error', `chatgpt-web: model ${wanted.model} is not offered (available: ${names.join(', ')})`)
        }
        if ((await match.getAttribute('aria-disabled')) === 'true') {
          throw new ProviderError('config_error', `chatgpt-web: model ${wanted.model} is locked for this account`)
        }
        if ((await match.getAttribute('aria-checked')) !== 'true') await match.click()
      }
      if (wanted?.effort) await this.selectEffort(engine, wanted.effort)
      const states = await options.evaluateAll((els) => els.map((el) => [el.getAttribute('aria-checked'), (el as HTMLElement).innerText] as const))
      const checked = states.filter(([state]) => state === 'true')
      const model = checked.length === 1 ? this.optionName(checked[0]![1]) : undefined
      const effort = (await this.effortStatus(engine))?.level
      if (wanted?.model && model !== wanted.model) throw new ProviderError('config_error', `chatgpt-web: model reads back as ${model ?? 'none'}, not ${wanted.model}`)
      if (wanted?.effort && effort !== wanted.effort) throw new ProviderError('config_error', `chatgpt-web: Power reads back as ${effort ?? 'none'}, not ${wanted.effort}`)
      return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    } finally {
      await page.keyboard.press('Escape')
      await engine.waitFor({ hidden: 'model.menu' }, 3000).catch(() => page.keyboard.press('Escape'))
    }
  }

  /** Navigate to a new or bound conversation in the requested mode. */
  async open(page: Page, options: AskOptions): Promise<void> {
    if (options.conversation === 'temporary' && options.binding !== undefined) {
      throw new ProviderError('invalid_input', 'chatgpt-web: a temporary turn has no conversation to continue')
    }
    const url = options.binding ? `${this.origin}/c/${options.binding}` : `${this.origin}/`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const auth = await this.checkAuth(page)
    if (auth === 'signed-out') throw new ProviderError('reauth_required', 'chatgpt-web: signed out')
    if (auth === 'unknown') throw new ProviderError('session_broken', 'chatgpt-web: page did not become ready')
    const engine = this.engine(page)
    if (!options.binding) {
      // A new conversation: Chat must be selected on the home page first.
      if ((await engine.count('mode.group')) === 0) {
        throw new ProviderError('ui_drift', 'chatgpt-web: the Chat/Work switch was not found; refusing to start a conversation in an unknown mode')
      }
      await this.ensureChat(engine, 'on the home page')
      if (options.conversation === 'temporary') await engine.act('temporary.enable')
    } else if ((await engine.count('mode.group')) > 0) {
      await this.ensureChat(engine, 'in the bound conversation')
    }
    await this.requireChat(engine, 'after opening the conversation')
  }

  /** Select Chat if it is not already the pressed mode, then require it. */
  private async ensureChat(engine: UiEngine, when: string): Promise<void> {
    if ((await this.pressed(engine)) !== 'true') await engine.act('mode.select-chat')
    await this.requireChat(engine, when)
  }

  /** Reopen a bound conversation and read its last answer and running state (for reconciliation). */
  async snapshot(page: Page, binding: string): Promise<{ text: string; running: boolean; observable: boolean }> {
    await page.goto(`${this.origin}/c/${binding}`, { waitUntil: 'domcontentloaded' })
    const auth = await this.checkAuth(page)
    if (auth === 'signed-out') throw new ProviderError('reauth_required', 'chatgpt-web: signed out')
    if (auth === 'unknown' || this.bindingOf(page) !== binding) return { text: '', running: false, observable: false }
    const engine = this.engine(page)
    const text = (await engine.count('turn.assistant')) > 0 ? await this.answerText(engine) : ''
    return { text, running: await engine.state('turn.running'), observable: true }
  }

  private bindingOf(page: Page): string | undefined {
    const url = new URL(page.url())
    return CONVERSATION.exec(url.pathname + url.search)?.[1]
  }

  /** The canonical conversation id from the URL, waiting briefly for it to appear. */
  async binding(page: Page): Promise<string> {
    const deadline = Date.now() + this.timeouts.readyMs
    for (;;) {
      const id = this.bindingOf(page)
      if (id) return id
      if (Date.now() >= deadline) throw new ProviderError('session_broken', 'chatgpt-web: no conversation id after the answer')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  private preset(name: string | undefined): ProviderMode | undefined {
    const key = name ?? this.defaultMode
    if (key === undefined) return undefined
    const preset = this.modes[key]
    if (!preset) throw new ProviderError('config_error', `chatgpt-web: unknown mode ${key} (configured: ${Object.keys(this.modes).join(', ') || 'none'})`)
    return preset
  }

  private optionName(text: string): string {
    // A radio's text may carry a note after the name, e.g. "GPT-5.5\nLeaving on October 14".
    return text.split('\n')[0]!.trim()
  }

  private async optionNames(options: import('patchright-core').Locator): Promise<string[]> {
    return (await options.allInnerTexts()).map((t) => this.optionName(t))
  }

  private async effortStatus(engine: UiEngine): Promise<{ level: string; index: number; total: number } | undefined> {
    const status = await engine.resolve('model.power-status', 2000).catch(() => undefined)
    const text = status ? await status.locator.innerText() : ''
    const m = /^\s*([^,]+),\s*(\d+)\s+of\s+(\d+)/.exec(text)
    return m ? { level: m[1]!.trim(), index: Number(m[2]), total: Number(m[3]) } : undefined
  }

  /** Step the Power slider with arrow keys until the status names the wanted level. */
  private async selectEffort(engine: UiEngine, level: string): Promise<void> {
    const control = (await engine.resolve('model.power', 3000)).locator
    await control.focus()
    const seen: string[] = []
    for (const key of ['ArrowLeft', 'ArrowRight'] as const) {
      for (let step = 0; step < 8; step++) {
        const status = await this.effortStatus(engine)
        if (!status) throw new ProviderError('ui_drift', 'chatgpt-web: the Power level cannot be read')
        if (!seen.includes(status.level)) seen.push(status.level)
        if (status.level === level) return
        if (key === 'ArrowLeft' ? status.index <= 1 : status.index >= status.total) break
        await control.press(key)
        await engine.waitFor({ anyOf: [{ visible: 'model.power-status' }] }, 1000)
      }
    }
    throw new ProviderError('config_error', `chatgpt-web: Power level ${level} is not offered (available: ${seen.join(', ')})`)
  }

  engine(page: Page): UiEngine {
    let engine = this.engines.get(page)
    if (!engine) {
      engine = new UiEngine(page, this.map, {
        onDrift: (event) => this.onDrift?.(event),
        onHeal: (event) => this.onHeal?.(event),
        beforeHealedAction: (event) => this.beforeHealedAction?.(event),
        heal: this.healEnabled(),
      })
      this.engines.set(page, engine)
    }
    return engine
  }

  private async pressed(engine: UiEngine): Promise<string | null> {
    const chat = await engine.resolve('mode.chat', 2000).catch(() => undefined)
    return chat ? chat.locator.getAttribute('aria-pressed') : null
  }

  /** Where the mode switch is shown, Chat must be the pressed one. */
  private async requireChat(engine: UiEngine, when: string): Promise<void> {
    if ((await engine.count('mode.group')) === 0) return
    if ((await this.pressed(engine)) !== 'true') {
      throw new ProviderError('ui_drift', `chatgpt-web: Chat mode is not selected ${when}; refusing to use Work (Codex quota)`)
    }
  }

  /** Text of the last assistant answer: the container of its "ChatGPT said:" heading. */
  private async answerText(engine: UiEngine): Promise<string> {
    const heading = (await engine.resolve('turn.assistant', 1000)).locator.last()
    const raw = await heading.locator('xpath=..').innerText().catch(() => '')
    return raw.replace(/^\s*ChatGPT said:?\s*/i, '').trim()
  }

  private async waitForAnswer(page: Page, before: number, signal: AbortSignal | undefined, deadlines: AskOptions['deadlines'], onBinding?: (binding: string) => void): Promise<string> {
    const engine = this.engine(page)
    let bound = false
    const read = async () => {
      if (onBinding && !bound) {
        const id = this.bindingOf(page)
        if (id) {
          bound = true
          onBinding(id)
        }
      }
      const count = await engine.count('turn.assistant')
      if (count <= before) return { responsePresent: false, text: '', html: '', running: true }
      const text = await this.answerText(engine)
      const finished = (await engine.count('turn.assistant.done')) >= count
      const running = (await engine.state('turn.running')) || !finished
      return { responsePresent: true, text, html: '', running }
    }
    const completed = await waitForStableCompletion(read, {
      timeoutMs: deadlines?.timeoutMs ?? this.timeouts.turnMs,
      stallTimeoutMs: deadlines?.stallTimeoutMs ?? this.timeouts.stallMs,
      stableMs: this.timeouts.stableMs,
      pollMs: this.timeouts.pollMs,
      ...(signal ? { signal } : {}),
    })
    return completed.text
  }
}
