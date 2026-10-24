/**
 * How each provider's accounts are used (ADR-0052, ADR-0055): `assigned`, the default, or `pooled`,
 * only on the operator's recorded decision to pool that provider. Shared by the Worker sources that
 * describe accounts (website and agent), which read it from their own configuration and record a
 * pooled provider's record at each start.
 */
import { canonicalJson, sha256 } from './canonical.ts'

export type AccountMode = 'assigned' | 'pooled'

/**
 * The operator's recorded decision to pool a provider's accounts (ADR-0055). Its basis is in
 * `terms`, in the operator's words: either the terms they read that allow it, or, for a personal
 * subscription, that they accept the risk under its terms. It never claims more than it says.
 */
export interface PooledTerms {
  /** Who decided. */
  confirmedBy: string
  /** When, as an ISO 8601 time. */
  confirmedAt: string
  /** Which terms, and on what basis: a title, a version, or a link, or the operator's decision and acceptance of the risk. */
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
      throw new Error(`${at}: ${entry.provider} is pooled, and no pooledTerms record who decided to pool it, when, and on which terms (ADR-0055)`)
    }
    out.set(entry.provider, { mode, ...(terms ? { pooledTerms: terms } : {}) })
  }
  return out
}

/** Whole terms, or undefined when none are given (an empty object is none); part of them is refused. */
function termsOf(value: Partial<PooledTerms> | undefined, at: string): PooledTerms | undefined {
  if (value === undefined || value === null || (typeof value === 'object' && !Object.keys(value).length)) return undefined
  const { confirmedBy, confirmedAt, terms } = value
  if (typeof confirmedBy !== 'string' || !confirmedBy.trim() || confirmedBy.length > LIMITS.confirmedBy) throw new Error(`${at}.confirmedBy: who decided to pool it, 1 to ${LIMITS.confirmedBy} characters`)
  if (typeof confirmedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(confirmedAt) || !Number.isFinite(Date.parse(confirmedAt))) throw new Error(`${at}.confirmedAt: when it was decided, an ISO 8601 time`)
  if (typeof terms !== 'string' || !terms.trim() || terms.length > LIMITS.terms) throw new Error(`${at}.terms: which terms, and on what basis, 1 to ${LIMITS.terms} characters`)
  return { confirmedBy, confirmedAt, terms }
}

/**
 * The `gate` decision a source records at each start for a pooled provider (ADR-0055, INV-13):
 * the operator's record, by its content, so the same record makes the same decision. It names the
 * record and claims nothing about what the provider's terms allow.
 */
export function pooledTermsDecision(provider: string, terms: PooledTerms, decider: string) {
  return {
    decisionType: 'gate',
    question: `May the accounts of ${provider} be pooled, a limit on one moving its work to another?`,
    inputs: [],
    candidates: [
      { option: 'pooled', selected: true, reasons: [`${terms.confirmedBy} recorded pooling for ${provider} on ${terms.confirmedAt}: ${terms.terms}`] },
      { option: 'assigned', selected: false, reasons: ['not assigned: the operator configured it pooled, with its terms recorded'] },
    ],
    decider: { type: 'rule' as const, id: decider, version: '1', hash: sha256(canonicalJson({ provider, terms })) },
    outcome: { option: 'pooled', detail: { provider, ...terms } },
    deterministic: true,
  }
}
