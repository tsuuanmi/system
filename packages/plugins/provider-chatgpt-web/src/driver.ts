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
import { ProviderError, waitForStableCompletion } from '@tsuuanmi/system-provider-core'
import { type DriftEvent, type HealEvent, UiEngine, type UiMap, loadUiMap } from '@tsuuanmi/system-ui-ops'
import type { Page } from 'patchright-core'

export type AuthState = 'signed-in' | 'signed-out' | 'unknown'
export type ConversationMode = 'temporary' | 'persistent'

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
}

export interface AskOptions {
  conversation: ConversationMode
  /** Persistent conversation to continue (`/c/<id>`). */
  binding?: string | undefined
  signal?: AbortSignal
}

export interface AskResult {
  text: string
  /** Canonical conversation id for persistent turns; undefined for temporary ones. */
  binding: string | undefined
}

const MAP_URL = new URL('../ui/chatgpt-web.ui.yaml', import.meta.url)
const CONVERSATION = /\/c\/([0-9a-f-]{36})(?:[/?#]|$)/

/** The shipped map, with an optional local overlay merged after it. */
export function shippedMap(overlay?: string): UiMap {
  return loadUiMap(readFileSync(MAP_URL, 'utf8'), overlay)
}

export class ChatGptWebDriver {
  readonly provider = 'chatgpt-web'
  readonly map: UiMap
  onDrift: ((event: DriftEvent) => void) | undefined
  onHeal: ((event: HealEvent) => void) | undefined
  private readonly origin: string
  private readonly timeouts: Required<DriverTimeouts>
  private readonly engines = new WeakMap<Page, UiEngine>()

  constructor(options: DriverOptions = {}) {
    this.map = shippedMap(options.overlay)
    this.origin = (options.origin ?? 'https://chatgpt.com').replace(/\/$/, '')
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

  /** One turn: open the conversation, select Chat, submit, and wait for the answer. */
  async ask(page: Page, prompt: string, options: AskOptions): Promise<AskResult> {
    await this.open(page, options)
    const engine = this.engine(page)
    const before = await engine.count('turn.assistant')
    await engine.act('composer.insert', { text: prompt })
    await this.requireChat(engine, 'before sending')
    await engine.act('composer.send')
    const text = await this.waitForAnswer(page, before, options.signal)
    if (options.conversation === 'temporary') return { text, binding: undefined }
    const binding = await this.binding(page)
    if (options.binding !== undefined && binding !== options.binding) {
      throw new ProviderError('session_broken', `chatgpt-web: conversation moved from ${options.binding} to ${binding}`)
    }
    return { text, binding }
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

  /** The canonical conversation id from the URL, waiting briefly for it to appear. */
  async binding(page: Page): Promise<string> {
    const deadline = Date.now() + this.timeouts.readyMs
    for (;;) {
      const id = CONVERSATION.exec(new URL(page.url()).pathname + new URL(page.url()).search)?.[1]
      if (id) return id
      if (Date.now() >= deadline) throw new ProviderError('session_broken', 'chatgpt-web: no conversation id after the answer')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  engine(page: Page): UiEngine {
    let engine = this.engines.get(page)
    if (!engine) {
      engine = new UiEngine(page, this.map, {
        onDrift: (event) => this.onDrift?.(event),
        onHeal: (event) => this.onHeal?.(event),
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

  private async waitForAnswer(page: Page, before: number, signal: AbortSignal | undefined): Promise<string> {
    const engine = this.engine(page)
    const read = async () => {
      const count = await engine.count('turn.assistant')
      if (count <= before) return { responsePresent: false, text: '', html: '', running: true }
      const heading = (await engine.resolve('turn.assistant', 1000)).locator.last()
      const raw = await heading.locator('xpath=..').innerText().catch(() => '')
      const text = raw.replace(/^\s*ChatGPT said:?\s*/i, '').trim()
      const finished = (await engine.count('turn.assistant.done')) >= count
      const running = (await engine.state('turn.running')) || !finished
      return { responsePresent: true, text, html: '', running }
    }
    const completed = await waitForStableCompletion(read, {
      timeoutMs: this.timeouts.turnMs,
      stallTimeoutMs: this.timeouts.stallMs,
      stableMs: this.timeouts.stableMs,
      pollMs: this.timeouts.pollMs,
      ...(signal ? { signal } : {}),
    })
    return completed.text
  }
}
