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
import { type AskOptions, type AskResult, type AuthState, type ConversationMode, ProviderError, type ProviderDriver, type ProviderFeature, type ProviderMode, type TurnSnapshot, waitForStableCompletion } from '@tsuuanmi/system-provider-core'
import { type DriftEvent, type HealEvent, UiEngine, type UiMap, loadUiMap } from '@tsuuanmi/system-ui-ops'
import type { Frame, Page } from 'patchright-core'

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
  /** After Deep research's acknowledgement, how long to wait for its frame before treating the reply as a clarifying question (default 60 s). */
  researchStartMs?: number
  /** How long a reopened conversation may take to render before it counts as not observed (default 20 s). */
  snapshotMs?: number
  /** How long a completed Deep research report may stay unreadable before it is UI drift (default 30 s). */
  reportReadMs?: number
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

/** Sign-in steps run on signed-out pages, where the map's sign-out guard would always fire. */
const NO_GUARDS = { guards: false } as const

const MAP_URL = new URL('../ui/chatgpt-web.ui.yaml', import.meta.url)
const CONVERSATION = /\/c\/([0-9a-f-]{36})(?:[/?#]|$)/

/** The shipped map, with an optional local overlay merged after it. */
export function shippedMap(overlay?: string): UiMap {
  return loadUiMap(readFileSync(MAP_URL, 'utf8'), overlay)
}

/** The tools popover entry that proves each account feature. */
const FEATURE_ENTRIES = [['deep-research', 'tools.deep-research'], ['web-search', 'tools.web-search'], ['image-generation', 'tools.create-image']] as const

export class ChatGptWebDriver implements ProviderDriver<Page> {
  readonly provider = 'chatgpt-web'
  readonly capabilities = ['reason', 'persistent-conversation'] as const
  /** Account features, each proven on the account by `probeFeatures` (REQ-PRV-7). */
  readonly features = ['deep-research', 'web-search', 'image-generation'] as const
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
    this.timeouts = { turnMs: 15 * 60_000, stallMs: 3 * 60_000, stableMs: 1500, pollMs: 250, readyMs: 30_000, researchStartMs: 60_000, snapshotMs: 20_000, reportReadMs: 30_000, ...options.timeouts }
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
    if (feature === 'deep-research' || feature === 'web-search') {
      await engine.act('tools.open')
      await engine.act(feature === 'deep-research' ? 'tools.deep-research' : 'tools.web-search')
    }
    await engine.act('composer.insert', { text: prompt })
    await this.requireChat(engine, 'before sending')
    options.signal?.throwIfAborted()
    await options.beforeSend?.({ previousResponse, mode })
    await engine.act('composer.send')
    const reply = await this.waitForAnswer(page, before, options.signal, options.deadlines, options.conversation === 'persistent' && !options.binding ? options.onBinding : undefined)
    // Deep research answers with an acknowledgement; the report arrives later in its frame.
    const text = feature === 'deep-research' ? await this.waitForResearch(page, reply, options.signal, options.deadlines) : await this.markdownOf(page, reply)
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
    try {
      // View A: the Power level.
      await this.openModelMenu(engine)
      if (wanted?.effort) await this.selectEffort(engine, wanted.effort)
      const effort = (await this.effortStatus(engine))?.level
      // View B: the model list.
      await engine.act('model.show-models')
      let options = (await engine.resolve('model.option', 3000)).locator
      if (wanted?.model) {
        const names = await this.optionNames(options)
        const match = options.filter({ hasText: new RegExp(`^\\s*${escapeRegex(wanted.model)}(?![\\w.])`) })
        if ((await match.count()) !== 1) {
          throw new ProviderError('config_error', `chatgpt-web: model ${wanted.model} is not offered (available: ${names.join(', ')})`)
        }
        if ((await match.getAttribute('aria-disabled')) === 'true') {
          throw new ProviderError('config_error', `chatgpt-web: model ${wanted.model} is locked for this account`)
        }
        if ((await match.getAttribute('aria-checked')) !== 'true') {
          await match.click()
          // Choosing a model may close the menu or return to view A: reopen the list to read it back.
          await this.openModelMenu(engine)
          if ((await engine.count('model.option')) === 0) await engine.act('model.show-models')
          options = (await engine.resolve('model.option', 3000)).locator
        }
      }
      const states = await options.evaluateAll((els) => els.map((el) => [el.getAttribute('aria-checked'), (el as HTMLElement).innerText] as const))
      const checked = states.filter(([state]) => state === 'true')
      const model = checked.length === 1 ? this.optionName(checked[0]![1]) : undefined
      if (wanted?.model && model !== wanted.model) throw new ProviderError('config_error', `chatgpt-web: model reads back as ${model ?? 'none'}, not ${wanted.model}`)
      if (wanted?.effort && effort !== wanted.effort) throw new ProviderError('config_error', `chatgpt-web: Power reads back as ${effort ?? 'none'}, not ${wanted.effort}`)
      return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    } finally {
      await page.keyboard.press('Escape')
      await engine.waitFor({ hidden: 'model.menu' }, 3000).catch(() => page.keyboard.press('Escape'))
    }
  }

  /** Open the model menu unless it is already open. */
  private async openModelMenu(engine: UiEngine): Promise<void> {
    if ((await engine.count('model.menu')) === 0) await engine.act('model.open')
  }

  /**
   * Which features this account offers (REQ-PRV-7): a new chat's "+" tools popover is opened and
   * read, then closed. Nothing is typed or sent.
   */
  async probeFeatures(page: Page): Promise<string[]> {
    await this.open(page, { conversation: 'persistent' })
    const engine = this.engine(page)
    await engine.act('tools.open')
    const found: string[] = []
    for (const [feature, element] of FEATURE_ENTRIES) if ((await engine.count(element)) > 0) found.push(feature)
    await page.keyboard.press('Escape')
    return found
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

  /**
   * Reopen a bound conversation and report what it shows, for reconciliation. Only positive
   * evidence counts: a page that has not rendered a user turn was not observed, and for Deep
   * research only the run after the last prompt counts, never its acknowledgement.
   */
  async snapshot(page: Page, binding: string, options: { feature?: ProviderFeature } = {}): Promise<TurnSnapshot> {
    await page.goto(`${this.origin}/c/${binding}`, { waitUntil: 'domcontentloaded' })
    const auth = await this.checkAuth(page)
    if (auth === 'signed-out') throw new ProviderError('reauth_required', 'chatgpt-web: signed out')
    if (auth === 'unknown' || this.bindingOf(page) !== binding) return { text: '', running: false, observable: false }
    const engine = this.engine(page)
    const rendered = await engine.waitFor({ visible: 'turn.user' }, this.timeouts.snapshotMs).then(() => true, () => false)
    if (!rendered) return { text: '', running: false, observable: false }
    const lastPrompt = await this.promptText(engine)
    if (options.feature === 'deep-research') {
      const deadline = Date.now() + this.timeouts.snapshotMs
      for (;;) {
        const research = await this.researchState(engine)
        if (research.done && research.text) return { text: research.text, running: false, observable: true, lastPrompt }
        if (research.running) return { text: '', running: true, observable: true, lastPrompt }
        // No readable run after the prompt yet (frames load late), or a clarifying question.
        if (Date.now() > deadline) return { text: '', running: false, observable: false, lastPrompt }
        await page.waitForTimeout(500)
      }
    }
    await engine.waitFor({ visible: 'turn.assistant' }, 5000).catch(() => undefined)
    const text = (await engine.count('turn.assistant')) > 0 ? await this.answerText(engine) : ''
    return { text, running: await engine.state('turn.running'), observable: true, lastPrompt }
  }

  /** Text of the last user turn: the container of its "You said:" heading. */
  private async promptText(engine: UiEngine): Promise<string> {
    const heading = (await engine.resolve('turn.user', 1000)).locator.last()
    const raw = await heading.locator('xpath=..').innerText().catch(() => '')
    return raw.replace(/^\s*You said:?\s*/i, '').trim()
  }

  /**
   * The frames of the Deep research run that belongs to the last prompt: the last run host,
   * if it follows the last user turn, and every frame nested in it. A session can hold
   * several runs; an earlier run's frames never count.
   */
  private async researchFrames(engine: UiEngine): Promise<Frame[]> {
    if ((await engine.count('research.host')) === 0) return []
    const host = (await engine.resolve('research.host', 1000)).locator.last()
    if ((await engine.count('turn.user')) > 0) {
      const user = await (await engine.resolve('turn.user', 1000)).locator.last().elementHandle()
      const after = await host.evaluate((h, u) => !!u && (u.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, user).catch(() => false)
      if (!after) return []
    }
    const frame = await (await host.elementHandle().catch(() => null))?.contentFrame()
    if (!frame) return []
    const frames = [frame]
    for (let i = 0; i < frames.length; i++) frames.push(...frames[i]!.childFrames())
    return frames
  }

  private async researchState(engine: UiEngine): Promise<{ running: boolean; done: boolean; text: string }> {
    for (const frame of await this.researchFrames(engine)) {
      if (await engine.findIn('research.completed', frame)) return { running: false, done: true, text: await this.reportText(engine, frame) }
      if (await engine.findIn('research.running', frame)) return { running: true, done: false, text: '' }
    }
    return { running: false, done: false, text: '' }
  }

  private bindingOf(page: Page): string | undefined {
    const url = new URL(page.url())
    return CONVERSATION.exec(url.pathname + url.search)?.[1]
  }

  /**
   * Credential sign-in on the current (signed-out) page: email, password, then whatever second
   * step appears. Steps are recognized from the UI map, never by guessing; a challenge, an
   * unknown page, or a third code fails closed, so the account is never locked.
   */
  async signIn(page: Page, credentials: { email: string; password: string }, code: (kind: 'totp' | 'email') => Promise<string>): Promise<void> {
    if (!page.url().startsWith(this.origin) && !/auth/.test(page.url())) await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' })
    else if ((await this.checkAuth(page)) === 'signed-out' && (await this.engine(page).count('login.email')) === 0) await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' })
    const deadline = Date.now() + 3 * 60_000
    let submissions = 0
    let idleSince = Date.now()
    for (;;) {
      const engine = this.engine(page)
      if (Date.now() > deadline) throw new ProviderError('reauth_required', 'chatgpt-web: sign-in did not finish in time; use the remote login')
      if ((await engine.count('login.challenge')) > 0) throw new ProviderError('challenge', 'chatgpt-web: the sign-in shows a challenge; it is never solved automatically')
      if ((await engine.count('composer.input')) > 0) return
      let acted = true
      if ((await engine.count('login.code')) > 0) {
        if (submissions >= 2) throw new ProviderError('reauth_required', 'chatgpt-web: two codes were not accepted; stopping before the account is locked')
        const kind = (await engine.count('login.email-code-hint')) > 0 ? 'email' : 'totp'
        await engine.act('login.fill-code', { text: await code(kind) }, NO_GUARDS)
        submissions++
        await engine.act('login.submit-code', {}, NO_GUARDS)
      } else if ((await engine.count('login.password')) > 0) {
        await engine.act('login.fill-password', { text: credentials.password }, NO_GUARDS)
        await engine.act('login.submit-password', {}, NO_GUARDS)
      } else if ((await engine.count('login.email')) > 0) {
        await engine.act('login.fill-email', { text: credentials.email }, NO_GUARDS)
        await engine.act('login.submit-email', {}, NO_GUARDS)
      } else if ((await engine.count('login.try-another')) > 0) {
        await engine.act('login.choose-another', {}, NO_GUARDS)
        await engine.act('login.choose-authenticator', {}, NO_GUARDS)
      } else if ((await engine.count('login.not-now')) > 0) {
        await (await engine.resolve('login.not-now')).locator.click()
      } else {
        acted = false
      }
      if (acted) idleSince = Date.now()
      else if (Date.now() - idleSince > 15_000) throw new ProviderError('reauth_required', `chatgpt-web: unknown sign-in page (${new URL(page.url()).pathname}); use the remote login`)
      await page.waitForLoadState('domcontentloaded').catch(() => undefined)
      await new Promise((done) => setTimeout(done, 300))
    }
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

  /**
   * Wait for Deep research's report. If no research frame appears within `researchStartMs`,
   * the reply was a clarifying question, which is returned so the caller can answer it in the
   * same session.
   */
  private async waitForResearch(page: Page, reply: string, signal: AbortSignal | undefined, deadlines: AskOptions['deadlines']): Promise<string> {
    const engine = this.engine(page)
    const startBy = Date.now() + this.timeouts.researchStartMs
    for (;;) {
      const state = await this.researchState(engine)
      if (state.running || state.done) break
      if (Date.now() > startBy) return reply
      signal?.throwIfAborted()
      await page.waitForTimeout(500)
    }
    let unreadableSince: number | undefined
    const completed = await waitForStableCompletion(async () => {
      const state = await this.researchState(engine)
      // Completed but unreadable is drift: fail fast instead of waiting out the stall deadline.
      if (state.done && !state.text) {
        unreadableSince ??= Date.now()
        if (Date.now() - unreadableSince > this.timeouts.reportReadMs) {
          throw new ProviderError('ui_drift', 'chatgpt-web: Deep research completed, but its report cannot be read; update research.report-title in the UI map')
        }
      } else unreadableSince = undefined
      return { responsePresent: state.done && state.text !== '', text: state.text, html: '', running: !state.done }
    }, {
      timeoutMs: deadlines?.timeoutMs ?? this.timeouts.turnMs,
      stallTimeoutMs: deadlines?.stallTimeoutMs ?? this.timeouts.stallMs,
      stableMs: this.timeouts.stableMs,
      pollMs: Math.max(this.timeouts.pollMs, 1000),
      ...(signal ? { signal } : {}),
    })
    return completed.text
  }

  /**
   * The report in its frame: the container of the report's title (live layout of 2026-10-12),
   * then its citation links as a `Sources:` list, since rendered text keeps only the labels.
   */
  private async reportText(engine: UiEngine, frame: Frame): Promise<string> {
    const title = await engine.findIn('research.report-title', frame)
    if (!title) return ''
    const report = title.locator.locator('xpath=..')
    const text = (await report.innerText().catch(() => '')).trim()
    const anchors = await report.locator('a[href^="http"]').evaluateAll((links) => links.map((a) => [(a.textContent ?? '').trim(), (a as HTMLAnchorElement).href]))
      .catch(() => [] as string[][])
    const sources = new Map<string, string>()
    for (const [label, href] of anchors) if (href && !sources.has(href)) sources.set(href, label ?? '')
    if (!text || !sources.size) return text
    return `${text}\n\nSources:\n${[...sources].map(([href, label]) => `- ${label ? `${label} ` : ''}${href}`).join('\n')}`
  }

  /**
   * Text of the last assistant answer: the container of its "ChatGPT said:" heading. It is read
   * under `white-space: pre-wrap`, so runs of spaces survive (rendering collapses them, which
   * would strip the indentation from code in a tool call's arguments).
   */
  private async answerText(engine: UiEngine): Promise<string> {
    const heading = (await engine.resolve('turn.assistant', 1000)).locator.last()
    const raw = await heading.locator('xpath=..').evaluate((el) => {
      ;(el as HTMLElement).style.whiteSpace = 'pre-wrap'
      return (el as HTMLElement).innerText
    }).catch(() => '')
    return raw.replace(/^\s*ChatGPT said:?\s*/i, '').trim()
  }

  /**
   * The answer as the Markdown that was streamed (REQ-PRV-5), from its own Copy button: read from
   * the clipboard, and kept only when its words are the rendered answer's words (the clipboard
   * may be shared). Otherwise the rendered text stands.
   */
  private async markdownOf(page: Page, rendered: string): Promise<string> {
    try {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
      const copy = (await this.engine(page).resolve('turn.assistant.done', 1000)).locator.last()
      await page.evaluate(() => navigator.clipboard.writeText(''))
      await copy.click({ timeout: 3000 })
      let markdown = ''
      for (let tries = 0; tries < 10 && !markdown; tries++) {
        markdown = await page.evaluate(() => navigator.clipboard.readText())
        if (!markdown) await page.waitForTimeout(100)
      }
      if (!markdown || !sameWords(markdown, rendered)) return rendered
      // Copy rebuilds code blocks from the page and loses their line breaks: take each block's
      // text from its rendered element instead, or keep the rendered answer if they do not pair.
      const fences = [...markdown.matchAll(/^(```[^\n]*)\n([\s\S]*?)\n```[ \t]*$/gm)]
      if (!fences.length) return markdown.trim()
      const answer = (await this.engine(page).resolve('turn.assistant', 1000)).locator.last().locator('xpath=..')
      const code = await this.engine(page).findIn('answer.code', answer)
      const blocks = code ? await code.locator.evaluateAll((els) => els.map((el) => {
        ;(el as HTMLElement).style.whiteSpace = 'pre-wrap'
        return (el as HTMLElement).innerText.replace(/\n$/, '')
      })) : []
      if (blocks.length !== fences.length) return rendered
      let index = 0
      return markdown.replace(/^(```[^\n]*)\n([\s\S]*?)\n```[ \t]*$/gm, (_, open: string) => `${open}\n${blocks[index++]}\n\`\`\``).trim()
    } catch {
      return rendered
    }
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

/** The words of a Markdown text as it renders: fences, emphasis, link targets, and markers dropped. */
export function renderedWords(markdown: string): string[] {
  const plain = markdown
    .replace(/^```[^\n]*$/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, ' ')
  return plain.match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Whether Markdown is the rendered answer: its words appear in the rendered words in order, and
 * rendering added only labels (a code block's language and its Copy button), nothing else.
 */
export function sameWords(markdown: string, rendered: string): boolean {
  const md = renderedWords(markdown)
  const shown = rendered.match(/[\p{L}\p{N}]+/gu) ?? []
  const blocks = Math.ceil((markdown.match(/^```/gm) ?? []).length / 2)
  if (!md.length || shown.length - md.length > 2 + 3 * blocks) return false
  let at = 0
  for (const word of shown) if (at < md.length && word === md[at]) at++
  return at === md.length
}

