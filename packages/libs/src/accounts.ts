/**
 * How each provider's accounts are used (ADR-0052): `assigned`, the default and the only one for
 * personal subscriptions, or `pooled`, only on the operator's recorded confirmation of that
 * provider's terms. Shared by the Worker sources that describe accounts (website and agent), which
 * read it from their own configuration and record a pooled provider's terms at each start.
 */
import { canonicalJson, sha256 } from './canonical.ts'

export type AccountMode = 'assigned' | 'pooled'

/** The operator's record that a provider's terms allow pooling its accounts. */
export interface PooledTerms {
  /** Who confirmed it. */
  confirmedBy: string
  /** When, as an ISO 8601 time. */
  confirmedAt: string
  /** Which terms they read: a title, a version, or a link. */
  terms: string
}

/** One provider's setting, as configured. */
export interface ProviderAccounts {
  provider: string
  /** Default `assigned`. */
  accounts?: AccountMode | undefined
  /** Required for `pooled`. */
  pooledTerms?: Partial<PooledTerms> | undefined
}

export interface AccountSetting {
  mode: AccountMode
  pooledTerms?: PooledTerms
}

/** The setting of a provider no entry names: assigned. */
export const ASSIGNED: AccountSetting = Object.freeze({ mode: 'assigned' as const })

const LIMITS = { confirmedBy: 128, terms: 1000 }

/**
 * Each configured provider's setting, checked: a provider named twice, an unknown mode, or `pooled`
 * without whole `pooledTerms` (who, an ISO time, which terms) is refused, naming its place (`where`)
 * (REQ-HOST-2, INV-2). Terms given for an assigned provider are kept and change nothing.
 */
export function accountSettings(entries: readonly ProviderAccounts[] | undefined, where: string): Map<string, AccountSetting> {
  const out = new Map<string, AccountSetting>()
  for (const [i, entry] of (entries ?? []).entries()) {
    const at = `${where}[${i}]`
    if (typeof entry?.provider !== 'string' || !entry.provider) throw new Error(`${at}.provider: a provider is required`)
    if (out.has(entry.provider)) throw new Error(`${at}.provider: ${entry.provider} is configured twice`)
    const mode = entry.accounts ?? 'assigned'
    if (mode !== 'assigned' && mode !== 'pooled') throw new Error(`${at}.accounts: ${String(mode)} is neither assigned nor pooled`)
    const terms = termsOf(entry.pooledTerms, `${at}.pooledTerms`)
    if (mode === 'pooled' && !terms) {
      throw new Error(`${at}: ${entry.provider} is pooled, and no pooledTerms record who confirmed its terms allow it, when, and which terms (personal subscriptions are never pooled; ADR-0052)`)
    }
    out.set(entry.provider, { mode, ...(terms ? { pooledTerms: terms } : {}) })
  }
  return out
}

/** Whole terms, or undefined when none are given (an empty object is none); part of them is refused. */
function termsOf(value: Partial<PooledTerms> | undefined, at: string): PooledTerms | undefined {
  if (value === undefined || value === null || (typeof value === 'object' && !Object.keys(value).length)) return undefined
  const { confirmedBy, confirmedAt, terms } = value
  if (typeof confirmedBy !== 'string' || !confirmedBy.trim() || confirmedBy.length > LIMITS.confirmedBy) throw new Error(`${at}.confirmedBy: who confirmed the terms, 1 to ${LIMITS.confirmedBy} characters`)
  if (typeof confirmedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(confirmedAt) || !Number.isFinite(Date.parse(confirmedAt))) throw new Error(`${at}.confirmedAt: when they were confirmed, an ISO 8601 time`)
  if (typeof terms !== 'string' || !terms.trim() || terms.length > LIMITS.terms) throw new Error(`${at}.terms: which terms were read, 1 to ${LIMITS.terms} characters`)
  return { confirmedBy, confirmedAt, terms }
}

/**
 * The `gate` decision a source records at each start for a pooled provider (ADR-0052, INV-13):
 * the operator's confirmation, by its content, so the same terms record the same decision.
 */
export function pooledTermsDecision(provider: string, terms: PooledTerms, decider: string) {
  return {
    decisionType: 'gate',
    question: `May the accounts of ${provider} be pooled, a limit on one moving its work to another?`,
    inputs: [],
    candidates: [
      { option: 'pooled', selected: true, reasons: [`${terms.confirmedBy} recorded on ${terms.confirmedAt} that its terms allow it: ${terms.terms}`] },
      { option: 'assigned', selected: false, reasons: ['not assigned: the operator configured it pooled, with its terms recorded'] },
    ],
    decider: { type: 'rule' as const, id: decider, version: '1', hash: sha256(canonicalJson({ provider, terms })) },
    outcome: { option: 'pooled', detail: { provider, ...terms } },
    deterministic: true,
  }
}
