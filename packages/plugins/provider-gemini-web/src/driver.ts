/**
 * The Gemini Web driver (provider `gemini-web`). Its operations are data, the UI map in
 * `ui/gemini-web.ui.yaml` (ADR-0021). It proves `reason` through one-shot turns in a Temporary
 * chat on the Chat tab (never Spark, the agent), with the model and thinking level chosen and
 * read back before sending. Persistent conversations and site features (Deep research) are not
 * proven, so a turn asking for them fails closed and no session is routed here.
 */
import { readFileSync } from 'node:fs'
import { type AskOptions, type AskResult, type AuthState, ProviderError, type ProviderDriver, type ProviderMode, type TurnSnapshot, sameWords, waitForStableCompletion } from '@tsuuanmi/system-provider-core'
import { UiEngine, type UiMap, loadUiMap } from '@tsuuanmi/system-ui-ops'
import type { Locator, Page } from 'patchright-core'

const MAP_URL = new URL('../ui/gemini-web.ui.yaml', import.meta.url)

/** The shipped map, with an optional local overlay merged after it. */
export function shippedMap(overlay?: string): UiMap {
  return loadUiMap(readFileSync(MAP_URL, 'utf8'), overlay)
}

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
  /** Site origin (default https://gemini.google.com); tests point it at a local fake. */
  origin?: string
  overlay?: string
  timeouts?: DriverTimeouts
  /**
   * Named mode presets: a model and a thinking level as the site names them. A model may be
   * named without its version ("Flash" matches "3.8 Flash", never "3.5 Flash-Lite").
   */
  modes?: Record<string, ProviderMode>
  /** Preset used when a turn names none; with no default the site's current selection is kept and read back. */
  defaultMode?: string
}

/** The first line of a mode item ("3.8 Flash\nAll-around help"). */
const itemName = (text: string): string => text.split('\n')[0]!.trim()
/** Whether a model as the site shows it is the wanted one, with or without its version. */
const sameModel = (shown: string, wanted: string): boolean => shown === wanted || shown.replace(/^\d[\d.]*\s+/, '') === wanted

export class GeminiWebDriver implements ProviderDriver<Page> {
  readonly provider = 'gemini-web'
  readonly capabilities = ['reason'] as const
  readonly loginUrl: string
  /** Google's sign-in lives on google.com; Gemini on its own subdomain. */
  readonly stateOrigins: readonly string[]
  readonly map: UiMap
  private readonly origin: string
  private readonly timeouts: Required<DriverTimeouts>
  private readonly modes: Record<string, ProviderMode>
  private readonly defaultMode: string | undefined
  private readonly engines = new WeakMap<Page, UiEngine>()

  constructor(options: DriverOptions = {}) {
    this.map = shippedMap(options.overlay)
    this.origin = (options.origin ?? 'https://gemini.google.com').replace(/\/$/, '')
    this.loginUrl = `${this.origin}/app`
    this.stateOrigins = options.origin ? [this.origin] : ['https://gemini.google.com', 'https://accounts.google.com', 'https://www.google.com', 'https://google.com']
    this.modes = options.modes ?? {}
    this.defaultMode = options.defaultMode
    if (this.defaultMode !== undefined && !this.modes[this.defaultMode]) {
      throw new ProviderError('config_error', `gemini-web: default mode ${this.defaultMode} is not a configured mode`)
    }
    this.timeouts = { turnMs: 15 * 60_000, stallMs: 3 * 60_000, stableMs: 1500, pollMs: 250, readyMs: 30_000, ...options.timeouts }
  }

  async checkAuth(page: Page): Promise<AuthState> {
    if (!page.url().startsWith(this.origin)) await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' })
    const engine = this.engine(page)
    try {
      await engine.waitFor({ anyOf: [{ state: 'auth.signed-in' }, { state: 'auth.signed-out' }] }, this.timeouts.readyMs)
    } catch {
      return 'unknown'
    }
    return (await engine.state('auth.signed-out')) ? 'signed-out' : 'signed-in'
  }

  /** The account named on its own Google Account button; only a hash of it is ever stored. */
  async identity(page: Page): Promise<string> {
    const label = await (await this.engine(page).resolve('auth.account', this.timeouts.readyMs)).locator.first().getAttribute('aria-label')
    if (!label) throw new ProviderError('session_broken', 'gemini-web: the account button has no name')
    return label.replace(/^Google Account:\s*/, '').trim()
  }

  /**
   * One turn in a new Temporary chat on the Chat tab: the prompt is typed, the preset chosen
   * and read back, Chat and Temporary chat checked again, then the receipt is written and the
   * prompt sent.
   */
  async ask(page: Page, prompt: string, options: AskOptions): Promise<AskResult> {
    if (options.conversation !== 'temporary') throw new ProviderError('invalid_input', 'gemini-web: only Temporary chat is proven; a persistent conversation is not offered')
    if ((options.feature ?? 'chat') !== 'chat') throw new ProviderError('invalid_input', `gemini-web: ${options.feature} is not offered`)
    const preset = this.preset(options.mode)
    await this.open(page)
    const engine = this.engine(page)
    const before = await engine.count('turn.assistant')
    await engine.act('composer.insert', { text: prompt })
    const mode = await this.selectMode(page, preset)
    await this.requireChat(engine, 'before sending')
    if ((await engine.count('temporary.notice')) === 0) throw new ProviderError('ui_drift', 'gemini-web: Temporary chat is not on before sending; refusing to save the conversation')
    options.signal?.throwIfAborted()
    // A Temporary chat is always new: there is no earlier answer.
    await options.beforeSend?.({ previousResponse: null, mode })
    await engine.act('composer.send')
    const rendered = await this.waitForAnswer(engine, before, options.signal, options.deadlines)
    return { text: await this.markdownOf(engine, rendered), binding: undefined, mode }
  }

  /** Persistent conversations are not offered, so there is never a binding to reopen. */
  async snapshot(): Promise<TurnSnapshot> {
    throw new ProviderError('invalid_input', 'gemini-web: no persistent conversation to reopen (Temporary chat only)')
  }

  /** A new chat on the Chat tab, with Temporary chat on. */
  private async open(page: Page): Promise<void> {
    await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' })
    const auth = await this.checkAuth(page)
    if (auth === 'signed-out') throw new ProviderError('reauth_required', 'gemini-web: signed out')
    if (auth === 'unknown') throw new ProviderError('session_broken', 'gemini-web: page did not become ready')
    const engine = this.engine(page)
    await engine.waitFor({ visible: 'composer.input' }, this.timeouts.readyMs)
    // A Chat tab that does not become active is refused just below, with its reason.
    if ((await engine.count('tab.any')) > 0 && (await engine.count('tab.chat-active')) === 0) {
      await engine.act('tab.select-chat').catch((error: unknown) => {
        if (!(error instanceof ProviderError && error.kind === 'ui_drift')) throw error
      })
    }
    await this.requireChat(engine, 'after opening')
    await engine.act('temporary.enable')
  }

  /** Where the tabs are shown, Chat must be the active one. */
  private async requireChat(engine: UiEngine, when: string): Promise<void> {
    if ((await engine.count('tab.any')) > 0 && (await engine.count('tab.chat-active')) === 0) {
      throw new ProviderError('ui_drift', `gemini-web: the Chat tab is not active ${when}; refusing to use Spark (the agent)`)
    }
  }

  /**
   * Choose a model and thinking level in the mode menu, then read both back. Nothing is
   * assumed: an item the account does not offer, or a read-back that differs, fails before
   * sending. An empty preset on an account without the picker selects nothing.
   */
  async selectMode(page: Page, wanted: ProviderMode | undefined): Promise<ProviderMode> {
    const engine = this.engine(page)
    if (!wanted?.model && !wanted?.effort && (await engine.count('composer.mode')) === 0) return {}
    try {
      if (wanted?.model) await this.choose(engine, 'mode.model', 'model', wanted.model, sameModel)
      if (wanted?.effort) await this.choose(engine, 'mode.level', 'thinking level', wanted.effort, (shown, name) => shown === name)
      await this.openMenu(engine)
      const model = await this.chosen(engine, 'mode.model.selected')
      const effort = await this.chosen(engine, 'mode.level.selected')
      if (wanted?.model && !(model && sameModel(model, wanted.model))) throw new ProviderError('config_error', `gemini-web: model reads back as ${model ?? 'none'}, not ${wanted.model}`)
      if (wanted?.effort && effort !== wanted.effort) throw new ProviderError('config_error', `gemini-web: thinking level reads back as ${effort ?? 'none'}, not ${wanted.effort}`)
      return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    } finally {
      await page.keyboard.press('Escape')
      await engine.waitFor({ hidden: 'mode.menu' }, 3000).catch(() => page.keyboard.press('Escape'))
    }
  }

  private async openMenu(engine: UiEngine): Promise<void> {
    if ((await engine.count('mode.model')) === 0) await engine.act('mode.open')
  }

  /** Click the item named `name` unless it is already the chosen one. */
  private async choose(engine: UiEngine, element: string, what: string, name: string, matches: (shown: string, name: string) => boolean): Promise<void> {
    await this.openMenu(engine)
    const items = (await engine.resolve(element, 3000)).locator
    const names = (await items.allInnerTexts()).map(itemName)
    const index = names.findIndex((shown) => matches(shown, name))
    if (index < 0) throw new ProviderError('config_error', `gemini-web: ${what} ${name} is not offered (available: ${names.join(', ')})`)
    const item = items.nth(index)
    if ((await item.getAttribute('aria-disabled')) === 'true') throw new ProviderError('config_error', `gemini-web: ${what} ${name} is locked for this account`)
    const current = await this.chosen(engine, `${element}.selected`)
    if (current === names[index]) return
    await item.click()
  }

  private async chosen(engine: UiEngine, element: string): Promise<string | undefined> {
    const found = await engine.resolve(element, 1000).catch(() => undefined)
    return found ? itemName(await found.locator.innerText()) : undefined
  }

  private async lastAnswer(engine: UiEngine): Promise<Locator> {
    return (await engine.resolve('turn.assistant', 1000)).locator.last()
  }

  /** The rendered answer, read under `white-space: pre-wrap` so code indentation survives. */
  private async answerText(engine: UiEngine): Promise<string> {
    const content = await engine.findIn('answer.content', await this.lastAnswer(engine))
    if (!content) return ''
    return (await content.locator.evaluate((el) => {
      ;(el as HTMLElement).style.whiteSpace = 'pre-wrap'
      return (el as HTMLElement).innerText
    }).catch(() => '')).trim()
  }

  private async waitForAnswer(engine: UiEngine, before: number, signal: AbortSignal | undefined, deadlines: AskOptions['deadlines']): Promise<string> {
    const completed = await waitForStableCompletion(async () => {
      if ((await engine.count('turn.assistant')) <= before) return { responsePresent: false, text: '', html: '', running: true }
      const text = await this.answerText(engine)
      const finished = (await engine.findIn('turn.assistant.done', await this.lastAnswer(engine))) !== undefined
      return { responsePresent: text !== '', text, html: '', running: (await engine.state('turn.running')) || !finished }
    }, {
      timeoutMs: deadlines?.timeoutMs ?? this.timeouts.turnMs,
      stallTimeoutMs: deadlines?.stallTimeoutMs ?? this.timeouts.stallMs,
      stableMs: this.timeouts.stableMs,
      pollMs: this.timeouts.pollMs,
      ...(signal ? { signal } : {}),
    })
    return completed.text
  }

  /**
   * The answer as Markdown (REQ-PRV-5), from its own Copy, kept only when its words are the
   * rendered answer's (the clipboard may be shared); otherwise the rendered text stands.
   * Copy ends each code block with a blank line before the closing fence, which is dropped.
   */
  private async markdownOf(engine: UiEngine, rendered: string): Promise<string> {
    try {
      const copy = await engine.findIn('turn.assistant.done', await this.lastAnswer(engine))
      const markdown = copy ? await engine.copied(copy.locator.last()) : ''
      if (!markdown || !sameWords(markdown, rendered)) return rendered
      return markdown.replace(/^(```[^\n]*\n[\s\S]*?)\n+(```[ \t]*)$/gm, '$1\n$2').trim()
    } catch {
      return rendered
    }
  }

  private preset(name: string | undefined): ProviderMode | undefined {
    const key = name ?? this.defaultMode
    if (key === undefined) return undefined
    const preset = this.modes[key]
    if (!preset) throw new ProviderError('config_error', `gemini-web: unknown mode ${key} (configured: ${Object.keys(this.modes).join(', ') || 'none'})`)
    return preset
  }

  private engine(page: Page): UiEngine {
    let engine = this.engines.get(page)
    if (!engine) {
      // No self-heal here: a drifted element fails closed until the map is updated.
      engine = new UiEngine(page, this.map, { heal: false })
      this.engines.set(page, engine)
    }
    return engine
  }
}
