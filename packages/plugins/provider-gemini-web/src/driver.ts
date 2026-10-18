/**
 * The Gemini Web driver (provider `gemini-web`). Its operations are data, the UI map in
 * `ui/gemini-web.ui.yaml` (ADR-0021). Turns run on the Chat tab, never Spark (the agent), with
 * the model and thinking level chosen and read back before sending:
 * - `temporary`: a Temporary chat, proven on by its notice; nothing is kept;
 * - `persistent`: a normal chat, bound by its `/app/<id>` URL, continued and reopened there;
 * - Deep research (an account feature, normal chats only): its plan is started, and its
 *   report is read from the report panel, with the sources it used.
 * A bound chat is deleted from its own menu, only once it opens as itself (PROP-0004 Phase 5).
 */
import { readFileSync } from 'node:fs'
import { type AskOptions, type AskResult, type AuthState, bindingReporter, completionOptions, type DeleteOptions, modePresets, ProviderError, type ProviderDriver, type ProviderFeature, type ProviderMode, type ResearchState, type TurnSnapshot, waitForReport, waitForStableCompletion, withSources } from '@tsuuanmi/system-provider-core'
import { copiedMarkdown, type DriftEvent, outlineOf, preWrapText, type StallEvent, UiEngine, type UiMap, type UiOutline, loadUiMap, unverifiedEntries } from '@tsuuanmi/system-ui-ops'
import type { Locator, Page, Route } from 'patchright-core'

const MAP_URL = new URL('../ui/gemini-web.ui.yaml', import.meta.url)
const CONVERSATION = /^\/app\/([0-9a-f]{16})$/

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
  /** Page readiness after navigation (default 60 s: the live app took over 30 s to render several times). */
  readyMs?: number
  /** How long a reopened conversation may take to render before it counts as not observed (default 20 s). */
  snapshotMs?: number
  /** How long a completed Deep research report may stay unreadable before it is UI drift (default 30 s). */
  reportReadMs?: number
}

/** The map entries the deletion depends on: each must be checked on the live site before anything is deleted. */
const DELETION_ENTRIES = ['conversation.pane', 'conversation.options', 'conversation.delete', 'conversation.delete-dialog', 'conversation.delete-confirm', 'conversation.missing', 'conversation.open-options', 'conversation.choose-delete', 'conversation.confirm-delete']
/** The site's RPC endpoint, which a deletion goes through. */
const RPC_REQUEST = /\/_\/BardChatUi\/data\/batchexecute/

/**
 * Whether an RPC request names no conversation but `binding`: its form-encoded `f.req` calls are
 * parsed, and every conversation id any call carries (16 hex digits, `c_`-prefixed or not) must be
 * the bound one. A body that cannot be read is refused.
 */
export function namesOnly(body: string, binding: string): boolean {
  let calls: unknown
  try {
    calls = JSON.parse(new URLSearchParams(body).get('f.req') ?? '[]')
  } catch {
    return false
  }
  const ids = [...JSON.stringify(calls).matchAll(/(?<![0-9a-f])(?:c_)?([0-9a-f]{16})(?![0-9a-f])/g)].map((m) => m[1])
  return ids.every((id) => id === binding)
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
  /** The longest prompt sent, in characters (default 30,000, observed): a longer one is refused, unsent. */
  maxPromptChars?: number
  /** The account's page loads are spaced at least this far apart (default 10 s, ADR-0030). */
  pageGapMs?: number
}

/** The first line of a mode item ("3.8 Flash\nAll-around help"). */
const itemName = (text: string): string => text.split('\n')[0]!.trim()
/**
 * Whether an item as the site shows it is `name`: alone, or followed on the same line by its note
 * ("Medium Balanced depth", seen live on 2026-10-16; the note used to be on its own line).
 */
const named = (shown: string, name: string): boolean => shown === name || shown.startsWith(`${name} `)
/** Whether a model as the site shows it is the wanted one, with or without its version. */
const sameModel = (shown: string, wanted: string): boolean => named(shown, wanted) || named(shown.replace(/^\d[\d.]*\s+/, ''), wanted)
/** A matched item's name without a note on its line: "3.8 Flash" of "3.8 Flash All-around help". */
const nameOf = (shown: string, wanted: string): string => shown.slice(0, shown.indexOf(wanted) + wanted.length)

/** The longest answer read for the site's own error: its errors are a sentence or two. */
const SITE_ERROR_MAX_CHARS = 300

/** How long a page may take to settle (its Stop control gone) before it counts as busy and is not kept. */
const PAGE_IDLE_WAIT_MS = 3000

export class GeminiWebDriver implements ProviderDriver<Page> {
  readonly provider = 'gemini-web'
  readonly capabilities = ['reason', 'persistent-conversation'] as const
  /** Account features, each proven on the account by `probeFeatures` (REQ-PRV-7). */
  readonly features = ['deep-research'] as const
  /** Conversations `deleteConversation` deletes; a Deep research one waits for its live check (PROP-0004 Phase 5). */
  readonly deletes = ['chat'] as const
  readonly loginUrl: string
  /**
   * Copies of a Gemini session died within a minute while its login profile stayed signed in
   * (live 2026-10-16): the account works in its own login profile (ADR-0030).
   */
  readonly sessionBound = true
  readonly pageGapMs: number
  /** Google's sign-in lives on google.com; Gemini on its own subdomain. */
  readonly stateOrigins: readonly string[]
  readonly map: UiMap
  /** A stale map element, with an outline of its region; the plugin records it. */
  onDrift: ((event: DriftEvent) => void) | undefined
  /** A turn whose answer stalled or ran out of time, outlined; the plugin records it (`provider.stall`). */
  onStall: ((event: StallEvent) => void) | undefined
  private readonly origin: string
  private readonly timeouts: Required<DriverTimeouts>
  /** The longest prompt sent (`maxPromptChars`): declared to admission (ADR-0032), and refused here too. */
  readonly maxInputChars: number
  private readonly preset: (name: string | undefined) => ProviderMode | undefined
  private readonly engines = new WeakMap<Page, UiEngine>()
  readonly modes: readonly string[]

  constructor(options: DriverOptions = {}) {
    this.map = shippedMap(options.overlay)
    this.origin = (options.origin ?? 'https://gemini.google.com').replace(/\/$/, '')
    this.loginUrl = `${this.origin}/app`
    this.stateOrigins = options.origin ? [this.origin] : ['https://gemini.google.com', 'https://accounts.google.com', 'https://www.google.com', 'https://google.com']
    this.preset = modePresets(this.provider, options.modes, options.defaultMode)
    this.modes = Object.keys(options.modes ?? {})
    this.maxInputChars = options.maxPromptChars ?? 30_000
    this.pageGapMs = options.pageGapMs ?? 10_000
    this.timeouts = { turnMs: 15 * 60_000, stallMs: 3 * 60_000, stableMs: 1500, pollMs: 250, readyMs: 60_000, snapshotMs: 20_000, reportReadMs: 30_000, ...options.timeouts }
  }

  async checkAuth(page: Page): Promise<AuthState> {
    if (!page.url().startsWith(this.origin)) await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' })
    const engine = this.engine(page)
    try {
      await engine.waitFor({ anyOf: [{ state: 'auth.signed-in' }, { state: 'auth.signed-out' }, { state: 'auth.challenge' }] }, this.timeouts.readyMs)
    } catch {
      // Neither state: whatever the page shows instead (a dialog, an interstitial) is outlined as
      // drift evidence, so it can be read without opening the operator's browser.
      await engine.drift('auth.account').catch(() => undefined)
      return 'unknown'
    }
    // Google's unusual-traffic check is neither: only the operator can pass it, and loading again deepens it.
    if (await engine.state('auth.challenge')) throw new ProviderError('challenge', 'gemini-web: Google shows its unusual-traffic check (a CAPTCHA); solve it in the login profile (system account login) and Save')
    if (await engine.state('auth.signed-out')) return 'signed-out'
    termsNotice(await engine.state('site.terms-notice'))
    return 'signed-in'
  }

  /** The account named on its own Google Account button; only a hash of it is ever stored. */
  async identity(page: Page): Promise<string> {
    const label = await (await this.engine(page).resolve('auth.account', this.timeouts.readyMs)).locator.first().getAttribute('aria-label')
    if (!label) throw new ProviderError('session_broken', 'gemini-web: the account button has no name')
    return label.replace(/^Google Account:\s*/, '').trim()
  }

  /** The account's name and address as the page shows them ("Name (address)"), for a drift outline to mask. */
  private async accountNames(page: Page): Promise<string[]> {
    const label = await (await this.engine(page).resolve('auth.account', 1000)).locator.first().getAttribute('aria-label')
    const shown = (label ?? '').replace(/^Google Account:\s*/, '').trim()
    return [shown, ...shown.split(/[()]/).map((part) => part.trim())].filter(Boolean)
  }

  /**
   * One turn on the Chat tab: the prompt is typed, the preset chosen and read back, Chat (and
   * Temporary chat, for a temporary turn) checked again, then the receipt is written and the
   * prompt sent. Deep research is chosen first, and its plan started once it is shown.
   */
  async ask(page: Page, prompt: string, options: AskOptions): Promise<AskResult> {
    const feature = options.feature ?? 'chat'
    if (feature !== 'chat' && feature !== 'deep-research') throw new ProviderError('invalid_input', `gemini-web: ${feature} is not offered`)
    if (feature === 'deep-research' && options.conversation !== 'persistent') {
      throw new ProviderError('invalid_input', 'gemini-web: Deep research needs a persistent conversation (it is not offered in Temporary chat)')
    }
    if (options.conversation === 'temporary' && options.binding !== undefined) {
      throw new ProviderError('invalid_input', 'gemini-web: a temporary turn has no conversation to continue')
    }
    // The site drops a paste over its input limit without an error: refused here, before anything is sent.
    if (prompt.length > this.maxInputChars) {
      throw new ProviderError('invalid_input', `gemini-web: the prompt has ${prompt.length} characters, over the ${this.maxInputChars} this site takes (maxPromptChars); nothing was sent`)
    }
    const preset = this.preset(options.mode)
    await this.open(page, options.conversation, options.binding)
    const engine = this.engine(page)
    const before = await engine.count('turn.assistant')
    const previousResponse = before > 0 ? await this.answerText(engine) : null
    // An unsent draft the site kept (live 2026-10-17, in the login profile) never goes with the prompt.
    await engine.act('composer.clear')
    if (feature === 'deep-research') await this.chooseDeepResearch(engine)
    // A reopened Deep research conversation keeps Deep research chosen: a plain turn clears it.
    else if ((await engine.count('composer.deep-research')) > 0) await engine.act('composer.clear-deep-research')
    // The mode first, as on ChatGPT: a long prompt grows the composer around the mode picker (live
    // 2026-10-17, a review's 26,000 characters: mode.open missed its postcondition).
    const mode = await this.selectMode(page, preset)
    await engine.act('composer.insert', { text: prompt })
    const asked = await engine.count('turn.user')
    try {
      await this.requireChat(engine, 'before sending')
      if (options.conversation === 'temporary' && (await engine.count('temporary.notice')) === 0) {
        throw new ProviderError('ui_drift', 'gemini-web: Temporary chat is not on before sending; refusing to save the conversation')
      }
      options.signal?.throwIfAborted()
      await options.beforeSend?.({ previousResponse, mode })
    } catch (error) {
      // Typed, never sent: the text is not left behind as a draft for the next turn or the operator.
      await engine.act('composer.clear').catch(() => undefined)
      throw error
    }
    await engine.act('composer.send').catch(async (error: unknown) => {
      // An emptied composer and no new prompt: the site dropped the text (too long, say), not a UI change.
      if (error instanceof ProviderError && error.kind === 'ui_drift' && (await engine.count('turn.user')) === asked && !(await engine.text('composer.input').catch(() => 'unknown')).trim()) {
        throw new ProviderError('input_dropped', `gemini-web: the site emptied the composer and took no prompt (${prompt.length} characters); it was not answered`, { cause: error })
      }
      throw error
    })
    const onBinding = options.conversation === 'persistent' && !options.binding ? options.onBinding : undefined
    const reply = await this.waitForAnswer(page, engine, before, options.signal, options.deadlines, onBinding)
    const text = feature === 'deep-research' ? await this.research(engine, reply, options.signal, options.deadlines) : await this.markdownOf(engine, reply)
    await this.refuseSiteError(engine, text)
    if (options.conversation === 'temporary') return { text, binding: undefined, mode }
    const binding = this.bindingOf(page)
    if (!binding) throw new ProviderError('session_broken', 'gemini-web: no conversation id after the answer')
    if (options.binding !== undefined && binding !== options.binding) {
      throw new ProviderError('session_broken', `gemini-web: conversation moved from ${options.binding} to ${binding}`)
    }
    return { text, binding, mode }
  }

  /**
   * The site's own error shown as the answer (`answer.site-error`, in a short answer only) is no
   * answer: the turn fails before any acceptance judges it. The prompt was sent, so it is
   * `overloaded` and never resent from here (INV-4).
   */
  private async refuseSiteError(engine: UiEngine, text: string): Promise<void> {
    if (text.length > SITE_ERROR_MAX_CHARS) return
    const answer = (await engine.resolve('turn.assistant', 1000)).locator.last()
    if (!(await engine.findIn('answer.site-error', answer))) return
    throw new ProviderError('overloaded', `gemini-web: the site answered with its own error instead of an answer ("${text.slice(0, 120)}"); the prompt was sent, so it is not resent`)
  }

  /**
   * Reopen a bound conversation and report what it shows, for reconciliation. Only positive
   * evidence counts: a conversation that does not open at its URL, or shows no prompt (or one it
   * cannot read), was not observed. For Deep research only the research after the last prompt
   * counts, never its plan.
   */
  async snapshot(page: Page, binding: string, options: { feature?: ProviderFeature } = {}): Promise<TurnSnapshot> {
    await page.goto(`${this.origin}/app/${binding}`, { waitUntil: 'domcontentloaded' })
    const auth = await this.checkAuth(page)
    if (auth === 'signed-out') throw new ProviderError('reauth_required', 'gemini-web: signed out')
    if (auth === 'unknown' || this.bindingOf(page) !== binding) return { text: '', running: false, observable: false }
    const engine = this.engine(page)
    const deadline = Date.now() + this.timeouts.snapshotMs
    if (!(await engine.waitFor({ visible: 'turn.user' }, this.timeouts.snapshotMs).then(() => true, () => false))) return { text: '', running: false, observable: false }
    // A prompt renders before its text does: read it again until it shows, within the same bound.
    let lastPrompt = await this.promptText(engine)
    while (!lastPrompt && Date.now() < deadline) {
      await page.waitForTimeout(250)
      lastPrompt = await this.promptText(engine)
    }
    // A prompt that cannot be read is no evidence of what was sent.
    if (!lastPrompt) return { text: '', running: false, observable: false }
    if (options.feature === 'deep-research') {
      for (;;) {
        const research = await this.researchState(engine)
        if (research.done && research.text) return { text: research.text, running: false, observable: true, lastPrompt }
        if (research.running) return { text: '', running: true, observable: true, lastPrompt }
        // No research after the prompt yet (still rendering, an unstarted plan, or a question).
        if (Date.now() > deadline) return { text: '', running: false, observable: false, lastPrompt }
        await page.waitForTimeout(500)
      }
    }
    await engine.waitFor({ visible: 'turn.assistant' }, 5000).catch(() => undefined)
    const answer = await this.currentAnswer(engine)
    const text = answer ? await this.answerText(engine) : ''
    const finished = answer ? (await engine.findIn('turn.assistant.done', answer)) !== undefined : false
    return { text, running: (await engine.state('turn.running')) || (!!answer && !finished), observable: true, lastPrompt }
  }

  /**
   * Delete one bound conversation from its own menu: it must open as exactly that conversation
   * (its `/app/<id>` path, a prompt shown) before anything is clicked, and the page must still be
   * at that path before each click. Reopening it must then show that it no longer exists.
   */
  async deleteConversation(page: Page, binding: string, options: DeleteOptions = {}): Promise<'deleted' | 'gone'> {
    const path = `/app/${binding}`
    // Never click on a page that has moved off this conversation.
    const click = async (action: string): Promise<void> => {
      if (new URL(page.url()).pathname !== path) throw new ProviderError('ui_drift', `gemini-web: the page left conversation ${binding} before ${action}; nothing was deleted`)
      await this.engine(page).act(action)
    }
    const before = await this.openConversation(page, binding)
    if (before === 'missing') return 'gone'
    if (options.confirmed) {
      throw new ProviderError('session_broken', before === 'shown'
        ? `gemini-web: conversation ${binding} still opens after a deletion was confirmed; it is not clicked again`
        : `gemini-web: conversation ${binding} could not be checked after a deletion was confirmed (the page showed neither it nor that it is gone); it is not clicked again`)
    }
    if (before === 'unknown') throw new ProviderError('ui_drift', `gemini-web: conversation ${binding} did not open as itself; nothing was deleted`)
    // From the first click on, no call of the site's RPC endpoint leaves the page if any of its
    // calls names another conversation: a click that reached another chat deletes nothing, even
    // in a request that also names this one.
    const block = async (route: Route): Promise<void> => {
      const request = route.request()
      if (request.method() !== 'POST' || namesOnly(request.postData() ?? '', binding)) await route.continue()
      else await route.abort('blockedbyclient')
    }
    await page.route(RPC_REQUEST, block)
    try {
      await click('conversation.open-options')
      await click('conversation.choose-delete')
      await options.beforeConfirm?.()
      await click('conversation.confirm-delete')
    } finally {
      await page.unroute(RPC_REQUEST, block).catch(() => undefined)
    }
    // The site leaves the deleted conversation on its own; reopening it before then is aborted.
    await page.waitForURL((url) => url.pathname !== path, { timeout: this.timeouts.snapshotMs, waitUntil: 'domcontentloaded' }).catch(() => undefined)
    if ((await this.openConversation(page, binding)) === 'missing') return 'deleted'
    throw new ProviderError('session_broken', `gemini-web: conversation ${binding} still opens after its deletion`)
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
    if (!/^[0-9a-f]{16}$/.test(binding)) throw new ProviderError('invalid_input', `gemini-web: ${binding} is not a conversation id`)
    const path = `/app/${binding}`
    await page.goto(`${this.origin}${path}`, { waitUntil: 'domcontentloaded' })
    const auth = await this.checkAuth(page)
    if (auth === 'signed-out') throw new ProviderError('reauth_required', 'gemini-web: signed out')
    if (auth === 'unknown') return 'unknown'
    const engine = this.engine(page)
    await engine.waitFor({ anyOf: [{ visible: 'turn.user' }, { visible: 'conversation.missing' }] }, this.timeouts.snapshotMs).catch(() => undefined)
    if (await engine.count('conversation.missing')) {
      // Positive only when it holds again after a reload: a load that failed once is not a deletion.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await engine.waitFor({ anyOf: [{ visible: 'turn.user' }, { visible: 'conversation.missing' }] }, this.timeouts.snapshotMs).catch(() => undefined)
      return (await engine.count('conversation.missing')) && !(await engine.count('turn.user')) ? 'missing' : 'unknown'
    }
    return new URL(page.url()).pathname === path && (await engine.count('turn.user')) > 0 ? 'shown' : 'unknown'
  }

  /**
   * Which features this account offers (REQ-PRV-7): a new normal chat's tools menu, with its
   * more tools shown, is read and closed. Nothing is typed or sent.
   */
  async probeFeatures(page: Page): Promise<string[]> {
    await this.open(page, 'persistent', undefined)
    const engine = this.engine(page)
    await engine.act('tools.open')
    // Without Deep research the more tools show no entry, so the action's check cannot pass.
    if ((await engine.count('tools.deep-research')) === 0) await engine.act('tools.show-more').catch(driftOnly)
    const found = (await engine.count('tools.deep-research')) > 0 ? ['deep-research'] : []
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    return found
  }

  /** A new chat (or the bound one) on the Chat tab; a new temporary turn turns Temporary chat on. */
  private async open(page: Page, conversation: AskOptions['conversation'], binding: string | undefined): Promise<void> {
    // A kept tab already showing the conversation is checked as it is, never loaded again (ADR-0030).
    if (!(binding && (await this.showing(page, binding)))) await page.goto(binding ? `${this.origin}/app/${binding}` : this.loginUrl, { waitUntil: 'domcontentloaded' })
    const auth = await this.checkAuth(page)
    if (auth === 'signed-out') throw new ProviderError('reauth_required', 'gemini-web: signed out')
    // Neither signed in nor signed out (outlined as drift): loading it again on this account only adds traffic.
    if (auth === 'unknown') throw new ProviderError('ui_drift', 'gemini-web: the page showed neither the signed-in account nor a sign-in page in time (outlined as a ui.drift of auth.account)')
    if (binding && this.bindingOf(page) !== binding) {
      // Signed in, and the site sent the page elsewhere: it no longer has this conversation.
      throw new ProviderError('conversation_lost', `gemini-web: conversation ${binding} no longer opens (the site sent the page to ${new URL(page.url()).pathname}); a session that needs it cannot continue`)
    }
    const engine = this.engine(page)
    // A terms notice covers the input (it may render after the account): stop at once, never wait it out.
    await engine.waitFor({ anyOf: [{ visible: 'composer.input' }, { state: 'site.terms-notice' }] }, this.timeouts.readyMs)
    termsNotice(await engine.state('site.terms-notice'))
    // A bound conversation renders its turns after the page: its last answer is the boundary.
    if (binding) await engine.waitFor({ visible: 'turn.user' }, this.timeouts.readyMs)
    // A Chat tab that does not become active is refused just below, with its reason.
    if ((await engine.count('tab.any')) > 0 && (await engine.count('tab.chat-active')) === 0) await engine.act('tab.select-chat').catch(driftOnly)
    await this.requireChat(engine, 'after opening')
    if (conversation === 'temporary') await engine.act('temporary.enable')
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

  /** Where the tabs are shown, Chat must be the active one. */
  private async requireChat(engine: UiEngine, when: string): Promise<void> {
    if ((await engine.count('tab.any')) > 0 && (await engine.count('tab.chat-active')) === 0) {
      throw new ProviderError('ui_drift', `gemini-web: the Chat tab is not active ${when}; refusing to use Spark (the agent)`)
    }
  }

  /**
   * Deep research, from the tools menu (its more tools when it is not shown at once); the chip
   * proves it. Already chosen (a reopened Deep research conversation), it is kept: its entry is a
   * checkbox, so choosing it again would turn it off.
   */
  private async chooseDeepResearch(engine: UiEngine): Promise<void> {
    if ((await engine.count('composer.deep-research')) > 0) return
    await engine.act('tools.open')
    if ((await engine.count('tools.deep-research')) === 0) await engine.act('tools.show-more')
    await engine.act('tools.deep-research')
  }

  /**
   * Choose a model and thinking level in the mode menu, then read both back. Nothing is
   * assumed: an item the account does not offer, or a read-back that differs, fails before
   * sending. An empty preset on an account without the picker selects nothing.
   */
  async selectMode(page: Page, wanted: ProviderMode | undefined): Promise<ProviderMode> {
    const engine = this.engine(page)
    if (!wanted?.model && !wanted?.effort && (await engine.count('composer.mode')) === 0) return {}
    // A menu or dialog left open (the input menu, say) would take the picker's click: closed first.
    if (await engine.state('page.busy-overlay')) {
      await page.keyboard.press('Escape')
      await engine.waitFor({ state: 'page.overlay-closed' }, 3000).catch(() => undefined)
    }
    try {
      if (wanted?.model) await this.choose(engine, 'mode.model', 'model', wanted.model, sameModel)
      if (wanted?.effort) await this.choose(engine, 'mode.level', 'thinking level', wanted.effort, named)
      await this.openMenu(engine)
      let model = await this.chosen(engine, 'mode.model.selected')
      let effort = await this.chosen(engine, 'mode.level.selected')
      if (wanted?.model && !(model && sameModel(model, wanted.model))) throw new ProviderError('config_error', `gemini-web: model reads back as ${model ?? 'none'}, not ${wanted.model}`)
      if (wanted?.effort && !(effort && named(effort, wanted.effort))) throw new ProviderError('config_error', `gemini-web: thinking level reads back as ${effort ?? 'none'}, not ${wanted.effort}`)
      if (model && wanted?.model) model = nameOf(model, wanted.model)
      if (effort && wanted?.effort) effort = nameOf(effort, wanted.effort)
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
    if (!(await this.reach(engine, item))) {
      await engine.drift(element)
      throw new ProviderError('ui_drift', `gemini-web: ${what} ${name} is offered but cannot be reached in the mode menu`)
    }
    await item.click({ timeout: 5000 })
  }

  /** Make a menu item visible: it may sit in a submenu that one of the menu's items opens. */
  private async reach(engine: UiEngine, item: Locator): Promise<boolean> {
    if (await item.isVisible()) return true
    const openers = await engine.count('mode.submenu') ? (await engine.resolve('mode.submenu', 1000)).locator : undefined
    for (let i = 0; openers && i < (await openers.count()); i++) {
      await openers.nth(i).click({ timeout: 3000 }).catch(() => undefined)
      if (await item.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) return true
    }
    return false
  }

  /** The chosen item's name, opening a submenu when it sits in a closed one. */
  private async chosen(engine: UiEngine, element: string): Promise<string | undefined> {
    let found = await engine.resolve(element, 1000).catch(() => undefined)
    if (!found && (await engine.count('mode.submenu'))) {
      const openers = (await engine.resolve('mode.submenu', 1000)).locator
      for (let i = 0; !found && i < (await openers.count()); i++) {
        await openers.nth(i).click({ timeout: 3000 }).catch(() => undefined)
        found = await engine.resolve(element, 1500).catch(() => undefined)
      }
    }
    return found ? itemName(await found.locator.innerText()) : undefined
  }

  /** The last answer, if it follows the last prompt (an earlier answer never stands for a new prompt). */
  private async currentAnswer(engine: UiEngine): Promise<Locator | undefined> {
    if ((await engine.count('turn.assistant')) === 0) return undefined
    const answer = (await engine.resolve('turn.assistant', 1000)).locator.last()
    if ((await engine.count('turn.user')) === 0) return answer
    const prompt = await (await engine.resolve('turn.user', 1000)).locator.last().elementHandle()
    const follows = await answer.evaluate((a, u) => !!u && (u.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, prompt).catch(() => false)
    return follows ? answer : undefined
  }

  /** The rendered last answer, read under `white-space: pre-wrap` so code indentation survives. */
  private async answerText(engine: UiEngine): Promise<string> {
    const answer = (await engine.resolve('turn.assistant', 1000)).locator.last()
    const content = await engine.findIn('answer.content', answer)
    return content ? preWrapText(content.locator) : ''
  }

  /** Text of the last prompt, from its paragraphs (its heading repeats it, shortened). */
  private async promptText(engine: UiEngine): Promise<string> {
    const text = await engine.findIn('turn.user.text', (await engine.resolve('turn.user', 1000)).locator.last())
    return text ? (await text.locator.allInnerTexts()).join('\n').trim() : ''
  }

  private async waitForAnswer(page: Page, engine: UiEngine, before: number, signal: AbortSignal | undefined, deadlines: AskOptions['deadlines'], onBinding?: (binding: string) => void): Promise<string> {
    const reportBinding = bindingReporter(() => this.bindingOf(page), onBinding)
    const completed = await waitForStableCompletion(async () => {
      reportBinding()
      if ((await engine.count('turn.assistant')) <= before) return { responsePresent: false, text: '', html: '', running: true }
      const text = await this.answerText(engine)
      const answer = (await engine.resolve('turn.assistant', 1000)).locator.last()
      const finished = (await engine.findIn('turn.assistant.done', answer)) !== undefined
      return { responsePresent: text !== '', text, html: '', running: (await engine.state('turn.running')) || !finished }
    }, completionOptions(this.timeouts, deadlines, signal)).catch(async (error: unknown) => {
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

  /**
   * Deep research after its first reply: a plan is started and its report awaited; any other
   * reply (a clarifying question) is the answer, so the caller can reply in the same chat. An
   * earlier plan left unstarted would make Start research ambiguous, which fails as drift.
   */
  private async research(engine: UiEngine, reply: string, signal: AbortSignal | undefined, deadlines: AskOptions['deadlines']): Promise<string> {
    if ((await engine.count('research.start')) === 0) return this.markdownOf(engine, reply)
    signal?.throwIfAborted()
    await engine.act('research.start')
    return waitForReport(() => this.researchState(engine), this.timeouts, { provider: this.provider, element: 'research.report', deadlines, signal }).catch(async (error: unknown) => {
      await this.stalled(engine, 'research', error)
      throw error
    })
  }

  /** The research card in the answer after the last prompt: working, or done with its report. */
  private async researchState(engine: UiEngine): Promise<ResearchState> {
    const answer = await this.currentAnswer(engine)
    if (!answer) return { running: false, done: false, text: '' }
    const completed = await engine.findIn('research.completed', answer)
    if (completed) return { running: false, done: true, text: await this.reportText(engine, completed.locator.last()) }
    // Its activity in the panel, while it works: it grows, so a long run is not taken for a stall.
    const activity = await engine.resolve('research.activity', 0).then((found) => found.locator.first().evaluate((e) => (e.textContent ?? '').length), () => 0).catch(() => 0)
    return { running: (await engine.findIn('research.running', answer)) !== undefined, done: false, text: '', ...(activity ? { progress: String(activity) } : {}) }
  }

  /**
   * The report from its panel (opened from its card when closed), then the sources it used as
   * a `Sources:` list, since the report itself carries only footnote marks.
   */
  private async reportText(engine: UiEngine, card: Locator): Promise<string> {
    if ((await engine.count('research.panel')) === 0) {
      await card.click({ timeout: 3000 }).catch(() => undefined)
      await engine.waitFor({ visible: 'research.panel' }, 5000).catch(() => undefined)
    }
    const report = await engine.resolve('research.report', 3000).catch(() => undefined)
    const text = report ? await preWrapText(report.locator) : ''
    if (!text || (await engine.count('research.source')) === 0) return text
    const links = (await engine.resolve('research.source', 1000)).locator
    const sources = new Map<string, string>()
    for (let i = 0; i < (await links.count()); i++) {
      const link = links.nth(i)
      const href = await link.getAttribute('href')
      const title = await engine.findIn('research.source-title', link)
      if (href && !sources.has(href)) sources.set(href, title ? (await title.locator.innerText()).trim() : '')
    }
    return withSources(text, sources)
  }

  /**
   * The answer as Markdown (REQ-PRV-5), from its own Copy, kept only when its words are the
   * rendered answer's (the clipboard may be shared); otherwise the rendered text stands. Either
   * way the answer's cited links follow it when the text lacks them. Copy ends each code block
   * with a blank line before the closing fence, which is dropped.
   */
  private async markdownOf(engine: UiEngine, rendered: string): Promise<string> {
    const answer = async () => (await engine.resolve('turn.assistant', 1000)).locator.last()
    return copiedMarkdown(engine, rendered, async () => (await engine.findIn('turn.assistant.done', await answer()))?.locator.last(),
      (markdown) => markdown.replace(/^(```[^\n]*\n[\s\S]*?)\n+(```[ \t]*)$/gm, '$1\n$2').trim(), answer)
  }

  private bindingOf(page: Page): string | undefined {
    return CONVERSATION.exec(new URL(page.url()).pathname)?.[1]
  }

  private engine(page: Page): UiEngine {
    let engine = this.engines.get(page)
    if (!engine) {
      // No self-heal here: a drifted element fails closed until the map is updated, and is reported.
      engine = new UiEngine(page, this.map, { heal: false, onDrift: (event) => this.onDrift?.(event), redact: () => this.accountNames(page) })
      this.engines.set(page, engine)
    }
    return engine
  }
}

/**
 * A notice of updated terms over the input: only the operator acknowledges it, in the login
 * profile, so the account waits for them as for a challenge (it is never clicked here).
 */
function termsNotice(shown: boolean): void {
  if (shown) throw new ProviderError('challenge', 'gemini-web: the site shows a terms notice over the input; acknowledge it in the login profile (system account login) and Save')
}

/** Rethrow anything but UI drift, which the caller then refuses with its own reason. */
function driftOnly(error: unknown): void {
  if (!(error instanceof ProviderError && error.kind === 'ui_drift')) throw error
}
