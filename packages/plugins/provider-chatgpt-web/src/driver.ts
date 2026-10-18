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
import { type AskOptions, type AskResult, type AuthState, bindingReporter, completionOptions, type ConversationMode, type DeleteOptions, modePresets, ProviderError, type ProviderDriver, type ProviderFeature, type ProviderMode, type ResearchState, type TurnSnapshot, waitForReport, waitForStableCompletion, withMissingSources } from '@tsuuanmi/system-provider-core'
import { copiedMarkdown, type DriftEvent, type HealEvent, linksIn, outlineOf, preWrapText, type StallEvent, UiEngine, type UiMap, type UiOutline, loadUiMap, unverifiedEntries } from '@tsuuanmi/system-ui-ops'
import type { Frame, Locator, Page, Route } from 'patchright-core'

export type { AskOptions, AskResult, AuthState, ConversationMode, ProviderMode }

/** How long the logged-out home must hold, with no composer, before it counts as signed out. */
const LOGGED_OUT_HOLD_MS = 3000

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
  /** The account's page opens are spaced at least this far apart (default 10 s, ADR-0030). */
  pageGapMs?: number
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Sign-in steps run on signed-out pages, where the map's sign-out guard would always fire. */
const NO_GUARDS = { guards: false } as const

const MAP_URL = new URL('../ui/chatgpt-web.ui.yaml', import.meta.url)
const CONVERSATION = /^\/c\/([0-9a-f-]{36})(?:[/?#]|$)/
/** The map entries the deletion depends on: each must be checked on the live site before anything is deleted. */
const DELETION_ENTRIES = ['conversation.pane', 'conversation.options', 'conversation.delete', 'conversation.delete-dialog', 'conversation.delete-confirm', 'conversation.missing', 'conversation.open-options', 'conversation.choose-delete', 'conversation.confirm-delete']
/** Every request that could delete or change a conversation: during a deletion only the bound one's deletion passes. */
const DELETE_REQUEST = /\/backend-api\/conversations?(?:\/[^?#]*)?(?:[?#]|$)/

/** The shipped map, with an optional local overlay merged after it. */
export function shippedMap(overlay?: string): UiMap {
  return loadUiMap(readFileSync(MAP_URL, 'utf8'), overlay)
}

/** The tools popover entry that proves each account feature. */
const FEATURE_ENTRIES = [['deep-research', 'tools.deep-research'], ['web-search', 'tools.web-search'], ['image-generation', 'tools.create-image']] as const

/** Where a Deep research report was read: its frame, or inline as the last answer. */
type ReportPath = 'frame' | 'inline'

/** The failures that are the site's own error page, which `open` loads once more. */
const SITE_ERROR_PAGES = new WeakSet<object>()
function siteErrorPage(): ProviderError {
  const error = new ProviderError('overloaded', 'chatgpt-web: the site shows its own error page instead of the app; nothing was sent')
  SITE_ERROR_PAGES.add(error)
  return error
}

/** How long a page may take to settle (its Stop control gone) before it counts as busy and is not kept. */
const PAGE_IDLE_WAIT_MS = 3000

export class ChatGptWebDriver implements ProviderDriver<Page> {
  readonly provider = 'chatgpt-web'
  readonly capabilities = ['reason', 'persistent-conversation'] as const
  /** Account features, each proven on the account by `probeFeatures` (REQ-PRV-7). */
  readonly features = ['deep-research', 'web-search', 'image-generation'] as const
  /** Conversations `deleteConversation` deletes; a Deep research one waits for its live check (PROP-0004 Phase 5). */
  readonly deletes = ['chat', 'web-search'] as const
  readonly loginUrl: string
  /**
   * Copies of chatgpt-main's session died (live 2026-10-17, twice: after six days, then about 9 h
   * after a Save) while its login profile stayed signed in: the account works in its own login
   * profile (ADR-0030), as Gemini's does.
   */
  readonly sessionBound = true
  readonly pageGapMs: number
  readonly stateOrigins: readonly string[]
  readonly map: UiMap
  onDrift: ((event: DriftEvent) => void) | undefined
  /** A turn whose answer stalled or ran out of time, outlined; the plugin records it (`provider.stall`). */
  onStall: ((event: StallEvent) => void) | undefined
  /**
   * A Deep research report as read: from its frame or inline, its length, and the source links it
   * carries; counts only, never text (`provider.report-read`), so an unread citation is decidable.
   */
  onReport: ((event: { provider: string; path: ReportPath; chars: number; links: number }) => void) | undefined
  onHeal: ((event: HealEvent) => void) | undefined
  /** Records a chosen heal before it acts (INV-13); a throw aborts the action. */
  beforeHealedAction: ((event: HealEvent) => void | Promise<void>) | undefined
  /** Whether self-heal may run; the plugin turns it off when no decision store exists. */
  healEnabled: () => boolean = () => true
  private readonly origin: string
  private readonly timeouts: Required<DriverTimeouts>
  private readonly engines = new WeakMap<Page, UiEngine>()
  readonly modes: readonly string[]
  private readonly preset: (name: string | undefined) => ProviderMode | undefined

  constructor(options: DriverOptions = {}) {
    this.map = shippedMap(options.overlay)
    this.origin = (options.origin ?? 'https://chatgpt.com').replace(/\/$/, '')
    this.preset = modePresets(this.provider, options.modes, options.defaultMode)
    this.modes = Object.keys(options.modes ?? {})
    this.loginUrl = `${this.origin}/auth/login`
    this.stateOrigins = [this.origin]
    this.pageGapMs = options.pageGapMs ?? 10_000
    this.timeouts = { turnMs: 15 * 60_000, stallMs: 3 * 60_000, stableMs: 1500, pollMs: 250, readyMs: 30_000, researchStartMs: 60_000, snapshotMs: 20_000, reportReadMs: 30_000, ...options.timeouts }
  }

  /**
   * Signed in (composer present), signed out (positive evidence only), or unknown. The site's own
   * error page in place of the app is none of them: `overloaded`, a transient failure.
   */
  async checkAuth(page: Page): Promise<AuthState> {
    if (!page.url().startsWith(this.origin)) await page.goto(`${this.origin}/`, { waitUntil: 'domcontentloaded' })
    const engine = this.engine(page)
    try {
      await engine.waitFor({ anyOf: [{ state: 'auth.signed-in' }, { state: 'auth.signed-out' }, { state: 'auth.challenge' }, { state: 'site.error-page' }] }, this.timeouts.readyMs)
    } catch {
      // Neither state: whatever the page shows instead is outlined as drift evidence, so it can be
      // read without opening the operator's browser.
      await engine.drift('composer.input').catch(() => undefined)
      return 'unknown'
    }
    // A challenge page is neither: only the operator can pass it, and loading again deepens it.
    if (await engine.state('auth.challenge')) throw new ProviderError('challenge', 'chatgpt-web: the site shows a challenge (Verify you are human); pass it in the login profile (system account login) and Save')
    if (await engine.state('site.error-page')) throw siteErrorPage()
    if (!(await engine.state('auth.signed-out'))) return 'signed-in'
    if (await engine.state('auth.login-page')) return 'signed-out'
    // Only the logged-out home: a signed-in app may paint that shell before it loads its session, and
    // a false sign-out takes the operator to undo. It counts only if no composer appears meanwhile.
    if (await engine.waitFor({ state: 'auth.signed-in' }, LOGGED_OUT_HOLD_MS).then(() => true, () => false)) return 'signed-in'
    if (await engine.state('auth.signed-out')) return 'signed-out'
    await engine.drift('composer.input').catch(() => undefined)
    return 'unknown'
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
    // An unsent draft the site kept (as Gemini does in a login profile) never goes with the prompt.
    await engine.act('composer.clear')
    const mode = await this.selectMode(page, preset)
    if (feature === 'deep-research' || feature === 'web-search') {
      await engine.act('tools.open')
      await engine.act(feature === 'deep-research' ? 'tools.deep-research' : 'tools.web-search')
    }
    await engine.act('composer.insert', { text: prompt })
    try {
      await this.requireChat(engine, 'before sending')
      await this.refuseWorkComposer(engine)
      options.signal?.throwIfAborted()
      await options.beforeSend?.({ previousResponse, mode })
    } catch (error) {
      // Typed, never sent: the text is not left behind as a draft for the next turn or the operator.
      await engine.act('composer.clear').catch(() => undefined)
      throw error
    }
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
    // A kept tab already showing the conversation is checked as it is, never loaded again (ADR-0030).
    if (!(options.binding && (await this.showing(page, options.binding)))) await page.goto(url, { waitUntil: 'domcontentloaded' })
    // The site's own error page in place of the app (live, a fresh profile's first page): nothing
    // is typed yet, so it is loaded once more; a second one fails as transient.
    const auth = await this.checkAuth(page).catch(async (error: unknown) => {
      if (!SITE_ERROR_PAGES.has(error as object)) throw error
      await page.reload({ waitUntil: 'domcontentloaded' })
      return this.checkAuth(page)
    })
    if (auth === 'signed-out') throw new ProviderError('reauth_required', 'chatgpt-web: signed out')
    // Neither signed in nor signed out (outlined as drift): loading it again on this account only adds traffic.
    if (auth === 'unknown') throw new ProviderError('ui_drift', 'chatgpt-web: the page showed neither the composer nor a sign-in page in time (outlined as a ui.drift of composer.input)')
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

  /** The page shows `binding` already: its URL is the conversation's, and its turns are rendered. */
  private async showing(page: Page, binding: string): Promise<boolean> {
    return this.bindingOf(page) === binding && (await this.engine(page).count('turn.user')) > 0
  }

  /**
   * Nothing generating, no dialog or menu open: a session-bound account keeps the page for the
   * session's next turn. Right after an answer the Stop control may linger a moment, so it waits
   * briefly (`PAGE_IDLE_WAIT_MS`) before calling the page busy.
   */
  async pageIdle(page: Page): Promise<boolean> {
    return this.engine(page).waitFor({ state: 'page.idle' }, PAGE_IDLE_WAIT_MS).then(() => true, () => false)
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
        const research = await this.researchState(page, engine)
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

  /**
   * Delete one bound conversation from its own menu: it must open as exactly that conversation
   * (its id in the URL, its turns shown) before anything is clicked, and the page must still be on
   * it when the deletion is confirmed. Reopening it must then show that it no longer exists.
   */
  async deleteConversation(page: Page, binding: string, options: DeleteOptions = {}): Promise<'deleted' | 'gone'> {
    const before = await this.openConversation(page, binding)
    if (before === 'missing') return 'gone'
    if (options.confirmed) {
      throw new ProviderError('session_broken', before === 'shown'
        ? `chatgpt-web: conversation ${binding} still opens after a deletion was confirmed; it is not clicked again`
        : `chatgpt-web: conversation ${binding} could not be checked after a deletion was confirmed (the page showed neither it nor that it is gone); it is not clicked again`)
    }
    if (before === 'unknown') throw new ProviderError('ui_drift', `chatgpt-web: conversation ${binding} did not open as itself; nothing was deleted`)
    const engine = this.engine(page)
    // Exactly the conversation's own path before every click: a redirect or a dialog never points a click at another chat.
    const guard = (): void => {
      if (new URL(page.url()).pathname !== `/c/${binding}`) throw new ProviderError('ui_drift', `chatgpt-web: the page left conversation ${binding} before the deletion was confirmed; nothing was deleted`)
    }
    // At the network too: a deletion that names any other conversation, or that is not a deletion, never leaves the page.
    const own = `/backend-api/conversation/${binding}`
    const block = async (route: Route): Promise<void> => {
      const request = route.request()
      const body = (() => {
        try {
          return JSON.parse(request.postData() ?? '{}') as { is_visible?: unknown }
        } catch {
          return {}
        }
      })()
      const reads = request.method() === 'GET' || request.method() === 'HEAD'
      if (reads || (request.method() === 'PATCH' && new URL(request.url()).pathname === own && body.is_visible === false)) await route.continue()
      else await route.abort('blockedbyclient')
    }
    await page.route(DELETE_REQUEST, block)
    try {
      guard()
      await engine.act('conversation.open-options')
      guard()
      await engine.act('conversation.choose-delete')
      guard()
      await options.beforeConfirm?.()
      await engine.act('conversation.confirm-delete')
    } finally {
      await page.unroute(DELETE_REQUEST, block).catch(() => undefined)
    }
    // The site leaves the deleted conversation on its own; reopening it before then is aborted.
    await page.waitForURL((url) => CONVERSATION.exec(url.pathname)?.[1] !== binding, { timeout: this.timeouts.snapshotMs, waitUntil: 'domcontentloaded' }).catch(() => undefined)
    if ((await this.openConversation(page, binding)) === 'missing') return 'deleted'
    throw new ProviderError('session_broken', `chatgpt-web: conversation ${binding} still opens after its deletion`)
  }

  /** The deletion's map entries not yet checked on the live site: while any is, nothing is deleted. */
  deletionUnverified(): string[] {
    return unverifiedEntries(this.map, DELETION_ENTRIES)
  }

  /**
   * Outline a conversation's page and its own menu, choosing nothing: the evidence that fixes the
   * deletion's map entries without opening the operator's browser. The menu is closed with Escape.
   */
  async inspectConversation(page: Page, binding: string): Promise<UiOutline[]> {
    const shown = await this.openConversation(page, binding)
    const outlines = [await outlineOf(page, `conversation page (${shown})`)]
    if (shown !== 'shown') return outlines
    const opened = await this.engine(page).act('conversation.open-options').then(() => true, () => false)
    outlines.push(await outlineOf(page, opened ? 'conversation menu' : 'conversation menu (not opened)'))
    await page.keyboard.press('Escape')
    return outlines
  }

  /** Open a bound conversation: shown as itself (its own path, its turns), positively missing, or neither. */
  private async openConversation(page: Page, binding: string): Promise<'shown' | 'missing' | 'unknown'> {
    if (!/^[0-9a-f-]{36}$/.test(binding)) throw new ProviderError('invalid_input', `chatgpt-web: ${binding} is not a conversation id`)
    await page.goto(`${this.origin}/c/${binding}`, { waitUntil: 'domcontentloaded' })
    const auth = await this.checkAuth(page)
    if (auth === 'signed-out') throw new ProviderError('reauth_required', 'chatgpt-web: signed out')
    if (auth === 'unknown') return 'unknown'
    const engine = this.engine(page)
    await engine.waitFor({ anyOf: [{ visible: 'turn.user' }, { visible: 'conversation.missing' }] }, this.timeouts.snapshotMs).catch(() => undefined)
    if (await engine.count('conversation.missing')) {
      // Positive only when it holds again after a reload: a load that failed once is not a deletion.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await engine.waitFor({ anyOf: [{ visible: 'turn.user' }, { visible: 'conversation.missing' }] }, this.timeouts.snapshotMs).catch(() => undefined)
      return (await engine.count('conversation.missing')) && !(await engine.count('turn.user')) ? 'missing' : 'unknown'
    }
    return new URL(page.url()).pathname === `/c/${binding}` && (await engine.count('turn.user')) > 0 ? 'shown' : 'unknown'
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

  /**
   * The run of the last prompt: in its report frame (live layout of 2026-10-12), or inline as the
   * last answer, when the run shows no frame or its frame no report (the app shell seen live on
   * 2026-10-18, whose report sits in the conversation with its own Copy). `ack` is the run's
   * acknowledgement, when known: the report is never it.
   */
  private async researchState(page: Page, engine: UiEngine, ack?: string): Promise<ResearchState & { path?: ReportPath }> {
    for (const frame of await this.researchFrames(engine)) {
      if (await engine.findIn('research.completed', frame)) {
        const framed = await this.reportText(engine, frame)
        if (framed) return { running: false, done: true, text: framed, path: 'frame' }
        return { running: false, done: true, text: await this.inlineReport(page, engine, { ack }), path: 'inline' }
      }
      if (await engine.findIn('research.running', frame)) return { running: true, done: false, text: '' }
    }
    const marker = await this.afterPrompt(engine, 'research.completed')
    if (marker) return { running: false, done: true, text: await this.inlineReport(page, engine, { marker, ack }), path: 'inline' }
    if (await this.afterPrompt(engine, 'research.running')) return { running: true, done: false, text: '' }
    return { running: false, done: false, text: '' }
  }

  /**
   * The last `id` in the conversation's thread, if it follows the last prompt (an earlier run's
   * never counts, nor anything outside the thread, such as a floating copy of the conversation).
   */
  private async afterPrompt(engine: UiEngine, id: string): Promise<Locator | undefined> {
    const thread = await engine.resolve('conversation.thread', 1000).catch(() => undefined)
    if (!thread) return undefined
    const inThread = await engine.findIn(id, thread.locator.first())
    if (!inThread) return undefined
    const found = inThread.locator.last()
    if ((await engine.count('turn.user')) === 0) return found
    const user = await (await engine.resolve('turn.user', 1000)).locator.last().elementHandle()
    return (await found.evaluate((f, u) => !!u && (u.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, user).catch(() => false)) ? found : undefined
  }

  /**
   * The report as the last answer, read as an answer is (its own Copy, else the rendered text with
   * its links). With the run marked complete in the page, only the answer that holds or follows
   * the mark (the acknowledgement comes before it); marked complete in its frame only, only an
   * answer that is not the acknowledgement.
   */
  private async inlineReport(page: Page, engine: UiEngine, run: { marker?: Locator; ack?: string | undefined }): Promise<string> {
    if ((await engine.count('turn.assistant')) === 0) return ''
    const answer = (await engine.resolve('turn.assistant', 1000)).locator.last().locator('xpath=..')
    const rendered = await this.answerText(engine)
    if (run.marker) {
      // The page marks the run complete: the report is the answer that holds or follows the mark.
      const marker = await run.marker.elementHandle()
      const after = await answer.evaluate((a, m) => !!m && (a.contains(m) || (m.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0), marker).catch(() => false)
      if (!after) return ''
    } else {
      // Marked complete in its frame only: never the acknowledgement, and never without knowing it.
      const same = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
      if (run.ack === undefined || same(rendered, run.ack)) return ''
    }
    // Its citations may stand outside the answer's own container (inline source pills): every
    // link to another site after the prompt, in the conversation, follows the report as a source.
    return withMissingSources(await this.markdownOf(page, rendered), await this.linksAfterPrompt(engine))
  }

  /** The links to another site after the last prompt, within its conversation (href → text, first text wins). */
  private async linksAfterPrompt(engine: UiEngine): Promise<Map<string, string>> {
    if ((await engine.count('turn.user')) === 0) return new Map()
    const user = (await engine.resolve('turn.user', 1000)).locator.last()
    const found = await user.evaluate((u) => {
      const scope = u.closest('[role="region"]') ?? document.body
      return [...scope.querySelectorAll('a[href]')]
        .filter((a) => (u.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
        .map((a) => [(a as HTMLAnchorElement).href, (a.textContent ?? '').trim()] as const)
        .filter(([href]) => /^https?:/.test(href) && new URL(href).origin !== location.origin)
    }).catch(() => [] as Array<readonly [string, string]>)
    const links = new Map<string, string>()
    for (const [href, text] of found) if (!links.has(href)) links.set(href, text)
    return links
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
   * The textbox names the tab it sends to ("Work with ChatGPT" on Work, live 2026-10-18): one that
   * names Work never sends, whatever the switch shows (the switch is hidden in some views).
   */
  private async refuseWorkComposer(engine: UiEngine): Promise<void> {
    const input = await engine.resolve('composer.input', 1000).catch(() => undefined)
    const label = input ? await input.locator.getAttribute('aria-label') : null
    if (label && /\bWork\b/.test(label)) {
      throw new ProviderError('ui_drift', `chatgpt-web: the composer reads "${label.slice(0, 60)}" before sending; refusing to use Work (Codex quota)`)
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
      const state = await this.researchState(page, engine, reply)
      if (state.running || state.done) break
      if (Date.now() > startBy) return reply
      signal?.throwIfAborted()
      await page.waitForTimeout(500)
    }
    // How this run's report was read: per run, since one driver serves concurrent turns.
    let path: ReportPath = 'inline'
    const state = async (): Promise<ResearchState> => {
      const read = await this.researchState(page, engine, reply)
      if (read.path) path = read.path
      return read
    }
    const report = waitForReport(state, this.timeouts, { provider: this.provider, element: 'research.report-title', deadlines, signal })
    void report.then((text) => this.onReport?.({ provider: this.provider, path, chars: text.length, links: (text.match(/https?:\/\/[^\s)>"\]]+/g) ?? []).length }), () => undefined)
    return report.catch(async (error: unknown) => {
      await this.stalled(engine, 'research', error)
      // A completed report that cannot be read is outlined as drift evidence of the report's entry.
      if (error instanceof ProviderError && error.kind === 'ui_drift') await engine.drift('research.report-title').catch(() => undefined)
      throw error
    })
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
    return text ? withMissingSources(text, await linksIn(report)) : text
  }

  /**
   * Text of the last assistant answer: the container of its "ChatGPT said:" heading. It is read
   * under `white-space: pre-wrap`, so runs of spaces survive (rendering collapses them, which
   * would strip the indentation from code in a tool call's arguments).
   */
  private async answerText(engine: UiEngine): Promise<string> {
    const heading = (await engine.resolve('turn.assistant', 1000)).locator.last()
    return (await preWrapText(heading.locator('xpath=..'))).replace(/^\s*ChatGPT said:?\s*/i, '').trim()
  }

  /**
   * The answer as the Markdown that was streamed (REQ-PRV-5), from its own Copy button: read from
   * the clipboard, and kept only when its words are the rendered answer's words (the clipboard
   * may be shared). Otherwise the rendered text stands, followed by the answer's cited links.
   */
  private async markdownOf(page: Page, rendered: string): Promise<string> {
    const engine = this.engine(page)
    return copiedMarkdown(engine, rendered, async () => (await engine.resolve('turn.assistant.done', 1000)).locator.last(), async (markdown) => {
      // Copy rebuilds code blocks from the page and loses their line breaks: take each block's
      // text from its rendered element instead, or keep the rendered answer if they do not pair.
      const fences = [...markdown.matchAll(/^(```[^\n]*)\n([\s\S]*?)\n```[ \t]*$/gm)]
      if (!fences.length) return markdown.trim()
      const answer = (await engine.resolve('turn.assistant', 1000)).locator.last().locator('xpath=..')
      const code = await engine.findIn('answer.code', answer)
      const blocks = code ? await code.locator.evaluateAll((els) => els.map((el) => {
        ;(el as HTMLElement).style.whiteSpace = 'pre-wrap'
        return (el as HTMLElement).innerText.replace(/\n$/, '')
      })) : []
      if (blocks.length !== fences.length) return rendered
      let index = 0
      return markdown.replace(/^(```[^\n]*)\n([\s\S]*?)\n```[ \t]*$/gm, (_, open: string) => `${open}\n${blocks[index++]}\n\`\`\``).trim()
    }, async () => (await engine.resolve('turn.assistant', 1000)).locator.last().locator('xpath=..'))
  }

  private async waitForAnswer(page: Page, before: number, signal: AbortSignal | undefined, deadlines: AskOptions['deadlines'], onBinding?: (binding: string) => void): Promise<string> {
    const engine = this.engine(page)
    const reportBinding = bindingReporter(() => this.bindingOf(page), onBinding)
    const read = async () => {
      reportBinding()
      const count = await engine.count('turn.assistant')
      if (count <= before) return { responsePresent: false, text: '', html: '', running: true }
      const text = await this.answerText(engine)
      const finished = (await engine.count('turn.assistant.done')) >= count
      const running = (await engine.state('turn.running')) || !finished
      return { responsePresent: true, text, html: '', running }
    }
    const completed = await waitForStableCompletion(read, completionOptions(this.timeouts, deadlines, signal)).catch(async (error: unknown) => {
      await this.stalled(engine, 'answer', error)
      throw error
    })
    return completed.text
  }

  /** A stall or a deadline, with the page as it stands: outlined, never retried from here. */
  private async stalled(engine: UiEngine, phase: string, error: unknown): Promise<void> {
    if (!this.onStall || !(error instanceof ProviderError) || (error.kind !== 'provider_stalled' && error.kind !== 'timeout')) return
    this.onStall(await engine.stall(phase))
  }
}
