/**
 * Digest seam definition: `ctx.digests` (docs/design/digests.md), the digest family's capability
 * seam (ADR-0036): a cited `digest@1.0` summary of raw artifacts for the lead, every claim
 * quote-checked against the artifact it cites before the digest is written. A digest fails open:
 * a request no Worker can serve, or whose Worker fails, is settled `bypassed` and recorded, and
 * nothing waits on it. The protocol, the vocabulary below, the quote check every provider
 * applies, and the `digests_*` MCP tools every provider serves live here; `schemas/digest.v1.json`
 * and `schemas/mcp-digests.v1.json` are canonical.
 * @module @tsuuanmi/system-digest-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import { bodyText, SchemaRegistry } from '@tsuuanmi/system-libs'

export { DIGEST_TOOL_INPUTS, DIGEST_TOOLS, type DigestTool, digestTool, digestToolHandlers, registerDigestTools } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    digests: Digests
  }
}

/**
 * The contract version this definition and its conformance suite describe. 1.1 adds the one
 * escalation: a request whose every claim failed the quote check is written once more on the
 * standard tier, never higher ({@link escalation}), named by the request's `escalation`.
 */
export const DIGESTS_CONTRACT = '1.1' as const

/** A content id (`sha256:<hex>`) of an artifact. */
export type ArtifactRef = `sha256:${string}`

/**
 * `pending` until settled, then one of three ends: `written` (a digest passed the quote check),
 * `not-written` (no claim survived it, or the Worker's answer was no digest), `bypassed` (no Worker
 * admitted the work, or its run failed: the digest failed open).
 */
export type DigestState = 'pending' | 'written' | 'not-written' | 'bypassed'

export interface DigestRequest {
  /** The raw artifacts to digest: 1 to 64 stored artifacts, by content id. */
  sources: ArtifactRef[]
  /** Retry-safe key: the same key returns the same request; another request under it is refused. */
  key?: string | undefined
}

/** A request as its provider holds it (`schemas/mcp-digests.v1.json` `$defs/request`). */
export interface DigestView {
  requestId: string
  state: DigestState
  sources: ArtifactRef[]
  /** The `digest@1.0` report, when written. */
  digest?: ArtifactRef
  /** The `acceptance` decision that settled it. */
  decision?: ArtifactRef
  /** The brief the digest Worker was started with. */
  brief?: ArtifactRef
  /** The Worker routing admitted. */
  worker?: string
  /** Claims of the Worker's draft that passed the quote check, and those dropped (the last draft's, after an escalation). */
  claims?: { kept: number; dropped: number }
  /** The `escalation` decision that had the request written once more on a higher tier (1.1). */
  escalation?: ArtifactRef
  /** Why it was bypassed, or why nothing was written. */
  reason?: string
  createdAt: string
  updatedAt: string
}

export type ClaimKind = 'finding' | 'failure' | 'decision' | 'risk'
export interface DigestClaim { id: string; kind: ClaimKind; text: string; citation: { artifact: ArtifactRef; quote: string; offset?: number } }

/** `digest@1.0`, the body of a `report` artifact whose envelope inputs are its sources. */
export interface DigestBody {
  schema: 'digest@1.0'
  sources: ArtifactRef[]
  status: 'passed' | 'failed' | 'partial' | 'blocked'
  summary: string
  claims: DigestClaim[]
  openQuestions?: string[]
  nextActions?: string[]
  dropped?: Array<{ what: string; why: string }>
  confidence?: number
}

/** Why a request was refused. Nothing was recorded and nothing runs. */
export type DigestFailure = 'invalid' | 'unknown-request' | 'overloaded'
export class DigestError extends Error {
  constructor(readonly failure: DigestFailure, message: string) {
    super(message)
    this.name = 'DigestError'
  }
}

/** The bounds `digest@1.0` puts on a digest (INV-9). */
export const DIGEST_LIMITS = { sources: 64, claims: 50, dropped: 32, quote: 500, text: 1000, summary: 2000, shortText: 500, list: 16, what: 300 } as const

export abstract class Digests extends Service {
  constructor(ctx: Context) {
    super(ctx, 'digests')
  }

  /**
   * Ask for a digest of `sources`. Durable at once and settled in the background; the same `key`
   * returns the same request. Refused (a {@link DigestError}, nothing recorded) only for its input:
   * a source that is not a stored artifact, a key reused for other sources, or too many requests
   * pending. A Worker that cannot serve it never refuses it: the request settles `bypassed`.
   */
  abstract request(input: DigestRequest): Promise<DigestView>

  /** A request as it stands, or undefined when there is none. */
  abstract get(requestId: string): Promise<DigestView | undefined>

  /** Wait until the request settles or `timeoutMs` passes; it as it stands either way. Unknown: `unknown-request`. */
  abstract wait(requestId: string, timeoutMs: number): Promise<DigestView>
}

/**
 * Why a draft gave no digest: it held no JSON object (`no-object`), no status or summary
 * (`no-status`), no claim (`no-claim`), claims none of which survived the quote check
 * (`quote-check`), or what survived was not a valid `digest@1.0` (`invalid`).
 */
export type QuoteFailure = 'no-object' | 'no-status' | 'no-claim' | 'quote-check' | 'invalid'

/** The outcome of the quote check: the digest to write, if any, and every claim it dropped, with why. */
export interface QuoteCheck {
  digest?: DigestBody
  kept: number
  dropped: Array<{ claim: string; why: string }>
  /** Why there is no digest. */
  reason?: string
  /** Why there is no digest, as a code: only `quote-check` lets a request escalate ({@link escalation}). */
  failure?: QuoteFailure
}

const CLAIM_ID = /^C[1-9][0-9]{0,2}$/
const KINDS: readonly ClaimKind[] = ['finding', 'failure', 'decision', 'risk']
const STATUSES: ReadonlyArray<DigestBody['status']> = ['passed', 'failed', 'partial', 'blocked']
const schemas = new SchemaRegistry()

const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim() && [...value].length <= max ? value : undefined)
const clamp = (value: string, max: number): string => ([...value].length <= max ? value : `${[...value].slice(0, max - 1).join('')}…`)
const texts = (value: unknown, max: number): string[] => (Array.isArray(value) ? value.map((v) => text(v, max)).filter((v): v is string => !!v).slice(0, DIGEST_LIMITS.list) : [])

/**
 * The quote check (docs/design/digests.md): a Worker's draft is untrusted model output, so the
 * digest written from it keeps only what code can check. The sources are the request's, never
 * the draft's. Each claim must be well formed, cite one of the sources, and quote that source's
 * text (`bodyText`: its body's `text`, else its canonical JSON) verbatim, at `offset` (in code
 * points) when it gives one; a claim that does not is dropped and recorded in the digest's
 * `dropped`, as is every claim past `maxClaims`. A draft with no status or summary, or whose
 * claims are all dropped, gives no digest. Deterministic for the same draft and stored sources.
 */
export function quoteCheck(draft: unknown, sources: readonly ArtifactRef[], read: (ref: ArtifactRef) => { body?: unknown } | undefined, maxClaims: number = DIGEST_LIMITS.claims): QuoteCheck {
  const value = draft && typeof draft === 'object' && !Array.isArray(draft) ? draft as Record<string, unknown> : undefined
  if (!value) return { kept: 0, dropped: [], reason: 'the answer holds no JSON object: no digest', failure: 'no-object' }
  const status = STATUSES.includes(value.status as DigestBody['status']) ? value.status as DigestBody['status'] : undefined
  const summary = text(value.summary, DIGEST_LIMITS.summary)
  if (!status || !summary) return { kept: 0, dropped: [], reason: 'the answer names no status (passed, failed, partial, blocked) or no summary: no digest', failure: 'no-status' }
  const bodies = new Map(sources.map((ref) => [ref, read(ref)]))
  const kept: DigestClaim[] = []
  const dropped: QuoteCheck['dropped'] = []
  const all = Array.isArray(value.claims) ? value.claims : []
  const claims = all.slice(0, DIGEST_LIMITS.claims)
  claims.forEach((raw, i) => {
    const claim = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const id = typeof claim.id === 'string' && CLAIM_ID.test(claim.id) ? claim.id : undefined
    const name = id ?? `claim ${i + 1}`
    const drop = (why: string): void => void dropped.push({ claim: name, why })
    const citation = claim.citation && typeof claim.citation === 'object' ? claim.citation as Record<string, unknown> : {}
    const artifact = citation.artifact as ArtifactRef
    const quote = text(citation.quote, DIGEST_LIMITS.quote)
    const offset = citation.offset
    const claimText = text(claim.text, DIGEST_LIMITS.text)
    if (kept.length >= maxClaims) return drop(`past the ${maxClaims} claims a digest keeps`)
    if (!id) return drop('its id is not C1 to C999')
    if (kept.some((c) => c.id === id)) return drop(`its id ${id} is taken by an earlier claim`)
    if (!KINDS.includes(claim.kind as ClaimKind)) return drop('its kind is not finding, failure, decision, or risk')
    if (!claimText) return drop(`its text is empty or longer than ${DIGEST_LIMITS.text} characters`)
    if (!quote) return drop(`its quote is empty or longer than ${DIGEST_LIMITS.quote} characters`)
    if (!bodies.has(artifact)) return drop(`it cites ${String(artifact).slice(0, 80)}, which is not one of the digested artifacts`)
    if (offset !== undefined && !(Number.isInteger(offset) && (offset as number) >= 0)) return drop('its offset is not a whole number from 0')
    const stored = bodies.get(artifact)
    if (!stored || stored.body === undefined) return drop(`${artifact} is no longer stored, so its quote cannot be checked`)
    const source = bodyText(stored.body)
    const found = offset === undefined ? source.includes(quote) : [...source].slice(offset as number, (offset as number) + [...quote].length).join('') === quote
    if (!found) return drop(offset === undefined ? `its quote is not verbatim in ${artifact}` : `its quote is not verbatim in ${artifact} at offset ${String(offset)}`)
    kept.push({ id, kind: claim.kind as ClaimKind, text: claimText, citation: { artifact, quote, ...(offset !== undefined ? { offset: offset as number } : {}) } })
  })
  if (all.length > claims.length) dropped.push({ claim: `claims ${claims.length + 1} to ${all.length}`, why: `a draft holds at most ${DIGEST_LIMITS.claims} claims; these were not checked` })
  if (!kept.length) {
    return claims.length
      ? { kept: 0, dropped, reason: `no claim survived the quote check (${dropped.length} dropped): no digest`, failure: 'quote-check' }
      : { kept: 0, dropped, reason: 'the answer has no claim: no digest', failure: 'no-claim' }
  }
  // What the check dropped comes first: it is what the lead must know was left out.
  const left = Array.isArray(value.dropped) ? value.dropped.flatMap((d) => {
    const entry = d && typeof d === 'object' ? d as Record<string, unknown> : {}
    const what = text(entry.what, DIGEST_LIMITS.what)
    const why = text(entry.why, DIGEST_LIMITS.what)
    return what && why ? [{ what, why }] : []
  }) : []
  const confidence = typeof value.confidence === 'number' && value.confidence >= 0 && value.confidence <= 1 ? value.confidence : undefined
  const openQuestions = texts(value.openQuestions, DIGEST_LIMITS.shortText)
  const nextActions = texts(value.nextActions, DIGEST_LIMITS.shortText)
  const recorded = [...dropped.map((d) => ({ what: clamp(/^claims? /.test(d.claim) ? d.claim : `claim ${d.claim}`, DIGEST_LIMITS.what), why: clamp(`dropped by the quote check: ${d.why}`, DIGEST_LIMITS.what) })), ...left].slice(0, DIGEST_LIMITS.dropped)
  const digest: DigestBody = {
    schema: 'digest@1.0', sources: [...sources], status, summary, claims: kept,
    ...(openQuestions.length ? { openQuestions } : {}), ...(nextActions.length ? { nextActions } : {}),
    ...(recorded.length ? { dropped: recorded } : {}), ...(confidence !== undefined ? { confidence } : {}),
  }
  try {
    schemas.assertRecord(digest)
  } catch (error) {
    return { kept: 0, dropped, reason: `the digest is not valid digest@1.0 (${(error as Error).message.slice(0, 300)}): no digest`, failure: 'invalid' }
  }
  return { digest, kept: kept.length, dropped }
}

/** A decision as a provider records it through `ctx.artifacts.recordDecision` (`decision@1.0`). */
export interface SettlementDecision {
  decisionType: 'acceptance'
  question: string
  inputs: ArtifactRef[]
  candidates: Array<{ option: 'written' | 'not-written' | 'bypassed'; selected: boolean; reasons: string[] }>
  decider: { type: 'rule'; id: 'digests.quote-check'; version: '1' }
  outcome: { option: 'written' | 'not-written' | 'bypassed'; detail: Record<string, unknown> }
  deterministic: true
}

/**
 * The `acceptance` decision that settles a request (INV-13), the same for every provider: written
 * (claims survived the quote check), not-written (none did, or the answer was no digest), or
 * bypassed (no Worker served it: the digest failed open). Its inputs are the sources and what the
 * Worker answered, or the admission decision that refused it; its detail names every dropped
 * claim with why.
 */
export function settlement(request: { requestId: string; sources: readonly ArtifactRef[] }, outcome: { state: 'written'; check: QuoteCheck; inputs?: ArtifactRef[] } | { state: 'not-written'; check?: QuoteCheck; reason: string; inputs?: ArtifactRef[] } | { state: 'bypassed'; reason: string; inputs?: ArtifactRef[] }): SettlementDecision {
  const check = 'check' in outcome ? outcome.check : undefined
  const kept = check?.kept ?? 0
  const dropped = check?.dropped ?? []
  const why = outcome.state === 'written' ? `${kept} claim(s) quote their sources verbatim${dropped.length ? `; ${dropped.length} dropped and recorded in the digest` : ''}` : outcome.reason
  const reasons = (option: SettlementDecision['outcome']['option']): string[] => {
    if (option === outcome.state) return outcome.state === 'bypassed' ? [why, 'a digest fails open: it is bypassed and recorded, and nothing waits on it (ADR-0036)'] : [why]
    if (option === 'written') return [`not written: ${why}`]
    if (option === 'not-written') return outcome.state === 'written' ? ['not not-written: claims survived the quote check'] : ['not not-written: no Worker answered, so there was nothing to check']
    return ['not bypassed: a Worker answered, and its answer was checked']
  }
  return {
    decisionType: 'acceptance',
    question: `Is a digest of ${request.sources.length} artifact(s) written for digest request ${request.requestId}?`,
    inputs: [...new Set([...request.sources, ...(outcome.inputs ?? [])])],
    candidates: (['written', 'not-written', 'bypassed'] as const).map((option) => ({ option, selected: option === outcome.state, reasons: reasons(option) })),
    decider: { type: 'rule', id: 'digests.quote-check', version: '1' },
    outcome: { option: outcome.state, detail: { requestId: request.requestId, kept, dropped: dropped.slice(0, DIGEST_LIMITS.dropped), ...(outcome.state !== 'written' ? { reason: outcome.reason } : {}) } },
    deterministic: true,
  }
}

/** The tier a request escalates to, once, when every claim failed the quote check (PROP-0008, mechanism 1). */
export const ESCALATION_TIER = 'standard' as const

/** An `escalation` decision as a provider records it through `ctx.artifacts.recordDecision` (`decision@1.0`). */
export interface EscalationDecision {
  decisionType: 'escalation'
  question: string
  inputs: ArtifactRef[]
  candidates: Array<{ option: 'escalate' | 'give-up'; selected: boolean; reasons: string[] }>
  decider: { type: 'rule'; id: 'digests.escalation'; version: '1' }
  outcome: { option: 'escalate'; detail: Record<string, unknown> }
  deterministic: true
}

/**
 * The one escalation every provider applies the same way (contract 1.1): a request whose Worker,
 * on the economy tier, answered with claims none of which survived the quote check is written once
 * more by a Worker on the standard tier ({@link ESCALATION_TIER}), never higher and never twice. Any
 * other answer that gives no digest (no JSON, no status, no claim) is not escalated: a stronger
 * Worker would not change a missing answer into a checkable one. Returns the `escalation` decision
 * to record before the second run starts (INV-13), or undefined when the request does not escalate:
 * it then settles `not-written` with the check's reason. Its inputs are the sources and the answer
 * whose claims all failed.
 */
export function escalation(request: { requestId: string; sources: readonly ArtifactRef[]; tier: string; escalated: boolean }, check: QuoteCheck, answer: ArtifactRef): EscalationDecision | undefined {
  if (check.digest || check.failure !== 'quote-check' || request.escalated || request.tier !== 'economy') return undefined
  const to = ESCALATION_TIER
  return {
    decisionType: 'escalation',
    question: `Is digest request ${request.requestId} written once more on a higher tier after every claim failed the quote check?`,
    inputs: [...new Set([...request.sources, answer])],
    candidates: [
      { option: 'escalate', selected: true, reasons: [`every claim of the ${request.tier} answer failed the quote check (${check.dropped.length} dropped): a Worker on the ${to} tier writes it once more, never higher`] },
      { option: 'give-up', selected: false, reasons: [`not give up: the request has not escalated yet, and ${to} is the one tier a digest escalates to`] },
    ],
    decider: { type: 'rule', id: 'digests.escalation', version: '1' },
    outcome: { option: 'escalate', detail: { requestId: request.requestId, from: request.tier, to, dropped: check.dropped.slice(0, DIGEST_LIMITS.dropped) } },
    deterministic: true,
  }
}
