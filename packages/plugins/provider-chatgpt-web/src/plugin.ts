/**
 * Registers the ChatGPT Web driver on `ctx.providers`. The local overlay of healed
 * candidates is read from `<DSH_HOME>/system/ui/chatgpt-web.overlay.yaml` when present.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-artifacts'
import type {} from '@tsuuanmi/system-event-log'
import { type ContentId, dshHome } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-providers'
import type { ProviderMode } from '@tsuuanmi/system-provider-core'
import { type HealEvent, appendOverlay } from '@tsuuanmi/system-ui-ops'
import { ChatGptWebDriver } from './driver.ts'

export interface Config {
  /** Site origin (default https://chatgpt.com); tests point it at a local fake. */
  origin?: string
  /** Local overlay file (default `<DSH_HOME>/system/ui/chatgpt-web.overlay.yaml`). */
  overlayPath?: string
  /**
   * Named mode presets: a model and a Power level as the site names them (models seen on
   * 2026-10-12: Latest, GPT-6, GPT-5.6 Sol, GPT-5.5; levels: Instant, Medium, High). Account
   * catalogs map tiers to these names.
   */
  modes?: Record<string, ProviderMode>
  /** Preset for turns whose tier maps to no preset. */
  defaultMode?: string
}

const DEFAULT_MODES: Record<string, ProviderMode> = {
  instant: { model: 'Latest', effort: 'Instant' },
  medium: { model: 'Latest', effort: 'Medium' },
  high: { model: 'Latest', effort: 'High' },
}

export const name = 'provider-chatgpt-web'
export const inject = ['providers']
export const Config: z<Config> = z.object({
  origin: z.string().description('Site origin (default https://chatgpt.com)'),
  overlayPath: z.string().description('Local UI overlay file'),
  modes: z.dict(z.object({ model: z.string(), effort: z.string() })).default(DEFAULT_MODES).description('Named mode presets (model and Power level)'),
  defaultMode: z.string().default('instant').description('Preset for turns whose tier maps to no preset'),
})

export function apply(ctx: Context, config: Config = {}): void {
  const overlayPath = config.overlayPath ?? join(dshHome(), 'system', 'ui', 'chatgpt-web.overlay.yaml')
  const overlay = existsSync(overlayPath) ? readFileSync(overlayPath, 'utf8') : undefined
  const driver = new ChatGptWebDriver({
    ...(config.origin ? { origin: config.origin } : {}),
    ...(overlay ? { overlay } : {}),
    modes: config.modes ?? DEFAULT_MODES,
    defaultMode: config.defaultMode ?? 'instant',
  })
  wireHealAudit(ctx, driver, overlayPath)
  ctx.providers.register(driver)
}

/**
 * Self-heal is audited (INV-13, ADR-0021): every chosen heal is a `recovery` decision
 * recorded before the healed element is acted on, a rejected heal is recorded too, a
 * verified heal is appended to the local overlay, and drift and heal outcomes go to the
 * event log. Without a decision store, healing is off.
 */
function wireHealAudit(ctx: Context, driver: ChatGptWebDriver, overlayPath: string): void {
  const decisions = new WeakMap<object, ContentId>()
  const key = (e: HealEvent): object => e.scores
  const record = (e: HealEvent, chosen: boolean): ContentId | undefined => {
    const artifacts = ctx.get('artifacts')
    if (!artifacts) throw new Error('self-heal needs ctx.artifacts to record its decision')
    const top = e.scores.slice(0, 3)
    const option = chosen ? `${top[0]?.role} "${top[0]?.name}"` : 'fail-closed'
    const candidates = [
      ...top.map((s, i) => ({ option: `${s.role} "${s.name}"`, selected: chosen && i === 0, reasons: [`score ${s.score}`] })),
      ...(chosen ? [] : [{ option: 'fail-closed', selected: true, reasons: ['no node scored above the threshold with a clear margin'] }]),
    ].filter((c, i, all) => all.findIndex((d) => d.option === c.option) === i)
    const decision = artifacts.recordDecision({
      decisionType: 'recovery',
      question: `How does ${e.provider} recover ${e.element} (action ${e.action}) after its locators failed?`,
      inputs: [],
      candidates,
      decider: { type: 'rule', id: 'ui-ops.heal.deterministic', version: '1' },
      outcome: { option, detail: { element: e.element, action: e.action, mapHash: e.mapHash, snapshotHash: e.snapshotHash, candidate: e.candidate ?? null } },
      deterministic: true,
    }, { producer: { type: 'system', ref: `ui-ops/${e.provider}` } })
    return decision.id
  }
  const log = (type: string, data: Record<string, unknown>, decision?: ContentId): void => {
    ctx.get('eventLog')?.append({ type, data, ...(decision ? { decision } : {}) })
  }
  driver.healEnabled = () => ctx.get('artifacts') !== undefined
  driver.beforeHealedAction = (e) => {
    const id = record(e, true)
    if (id) decisions.set(key(e), id)
  }
  driver.onDrift = (e) => log('ui.drift', { provider: e.provider, element: e.element, candidate: e.candidate, source: e.source, mapHash: e.mapHash })
  driver.onHeal = (e) => {
    const decision = e.outcome === 'rejected' ? record(e, false) : decisions.get(key(e))
    if (e.outcome === 'healed' && e.candidate) {
      const element = driver.map.elements[e.element]
      if (appendOverlay(overlayPath, e.element, e.candidate, `healed ${new Date().toISOString()} decision ${decision ?? 'unknown'}`) && element) {
        element.candidates.push({ ...e.candidate, source: 'overlay' })
      }
    }
    log('ui.heal', { provider: e.provider, element: e.element, outcome: e.outcome, candidate: e.candidate ?? null }, decision)
  }
}
