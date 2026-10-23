/**
 * The selection rule of the extractive digest provider (docs/design/digests.md#extractive-first):
 * verbatim spans of a request's sources, chosen by code before any Worker writes. A Worker then
 * reads these spans, never the whole sources, and cites each claim by a span's id; the citation is
 * filled from here, so a cited quote is verbatim by construction, and the seam's quote check still
 * reads the sources. Pure and deterministic: the same stored sources, rule, and bound give the
 * same `digest-extract@1.0`, so a restart records the same artifact.
 */
import { type ArtifactRef, DIGEST_LIMITS } from '@tsuuanmi/system-digest-core'
import { bodyText } from '@tsuuanmi/system-libs'

/** The rule and its version: a change to what is selected, or how it is written, is a new version. */
export const RULE = { id: 'digest-extractive.select', version: '1' } as const
/** The characters (code points) of a source's text the rule reads (INV-9); past them, the source is `truncated`. */
export const SCAN_LIMIT = 1_000_000
/** Most extracts a request may be given (`maxExtracts`, INV-9); the schema's bound. */
export const MAX_EXTRACTS = 200

/** Why a span was selected: a signal its text carries, or `context` (a source's first or last span, or room left). */
export type Signal = 'failure' | 'risk' | 'decision' | 'metric' | 'result' | 'context'

export interface Extract { id: string; source: number; offset: number; quote: string; signal: Signal }

/** `digest-extract@1.0`, the body of an `evidence` artifact whose envelope inputs are its sources. */
export interface DigestExtract {
  schema: 'digest-extract@1.0'
  rule: { id: string; version: string }
  sources: Array<{ ref: ArtifactRef; spans: number; truncated?: true }>
  extracts: Extract[]
  text: string
}

/**
 * The signals in the order a span is classified by, each a pattern of its text; the first that
 * matches names it. A span that starts with a test runner's pass marker is a result before it is a
 * metric (its timing is incidental); `×` marks a failure only at a span's start (elsewhere it
 * multiplies).
 */
const SIGNALS: ReadonlyArray<readonly [Exclude<Signal, 'context'>, RegExp]> = [
  ['failure', /^×(?:\s|$)|[✗✘❌]|\b(?:fail(?:s|ed|ing|ures?)?|errors?|exceptions?|traceback|panic(?:ked)?|fatal|assert(?:ion)?(?:error)?|not ok|abort(?:ed)?|crash(?:ed)?)\b/i],
  ['risk', /\b(?:warn(?:s|ing|ings)?|risks?|risky|todo|fixme|deprecat(?:ed|ion)|flaky|skipp?ed|timed out|timeouts?|regress(?:ed|ions?)?|unsafe|vulnerab(?:le|ility|ilities))\b|⚠/i],
  ['decision', /\b(?:decid(?:e|ed|es)|decisions?|chose|chosen|approved|rejected|accepted|merged|reverted)\b/i],
  ['result', /^(?:[✓✔✅]|(?:pass(?:es|ed)?|ok)\b)/i],
  ['metric', /\d(?:\.\d+)?\s?(?:x|×|%|ms|µs|us|ns|s|sec|seconds|min|minutes|kb|mb|gb|tokens?)(?!\w)|\b(?:median|mean|average|p\d\d|speed-?ups?|throughput|latency|coverage|accuracy|benchmarks?)\b/i],
  ['result', /\b(?:pass(?:es|ed|ing)?|ok|succe(?:ss|eded|ssful)|done|completed?|totals?|summary|results?|exit(?: code)? \d+)\b|[✓✔✅]/i],
]
const RANK: Record<Signal, number> = { context: 7, failure: 1, risk: 2, decision: 3, metric: 4, result: 6 }
/** A source's first span ranks before every signal (each source is seen); its last one (often its conclusion) before plain results. */
const FIRST = 0
const LAST = 5

const signalOf = (quote: string): Signal => SIGNALS.find(([, pattern]) => pattern.test(quote))?.[0] ?? 'context'
const blank = (ch: string | undefined): boolean => ch !== undefined && /\s/u.test(ch)

interface Span { source: number; offset: number; quote: string; signal: Signal; rank: number; nth: number }

/**
 * The spans of one source's text, in code points: each non-blank line, its surrounding whitespace
 * left out, cut into parts of at most {@link DIGEST_LIMITS}`.quote` characters (at a space past
 * half the part, where there is one), so any span can be a claim's quote. At most
 * {@link SCAN_LIMIT} characters are read.
 */
export function spansOf(text: string, source: number): { spans: Array<Omit<Span, 'rank' | 'nth'>>; truncated: boolean } {
  const chars: string[] = []
  let truncated = false
  for (const ch of text) {
    if (chars.length === SCAN_LIMIT) {
      truncated = true
      break
    }
    chars.push(ch)
  }
  const spans: Array<Omit<Span, 'rank' | 'nth'>> = []
  const push = (from: number, to: number): void => {
    while (from < to && blank(chars[from])) from++
    while (to > from && blank(chars[to - 1])) to--
    if (from >= to) return
    const quote = chars.slice(from, to).join('')
    spans.push({ source, offset: from, quote, signal: signalOf(quote) })
  }
  const max = DIGEST_LIMITS.quote
  let start = 0
  for (let i = 0; i <= chars.length; i++) {
    if (i < chars.length && chars[i] !== '\n') continue
    let from = start
    while (from < i) {
      while (from < i && blank(chars[from])) from++
      if (i - from <= max) {
        push(from, i)
        break
      }
      let cut = from + max
      for (let j = cut; j > from + max / 2; j--) {
        if (blank(chars[j])) {
          cut = j
          break
        }
      }
      push(from, cut)
      from = cut
    }
    start = i + 1
  }
  return { spans, truncated }
}

/**
 * The extract of a request's sources: every span weighed, at most `maxExtracts` kept. A source's
 * first span comes first, so no source goes unseen; then spans by signal (failure, risk, decision,
 * metric), each signal taken across the sources in turn (the first failure of each source before
 * the second of any); then each source's last span; then results (passed, ok, totals); then the
 * rest, while there is room. Kept spans are listed in the sources' order, numbered E1, E2, and so
 * on. Undefined when no source has a non-blank span: there is nothing to quote.
 */
export function extractOf(sources: readonly ArtifactRef[], read: (ref: ArtifactRef) => { body?: unknown } | undefined, maxExtracts: number): DigestExtract | undefined {
  const weighed: Span[] = []
  const counts: DigestExtract['sources'] = []
  sources.forEach((ref, source) => {
    const stored = read(ref)
    const { spans, truncated } = spansOf(stored?.body === undefined ? '' : bodyText(stored.body), source)
    counts.push({ ref, spans: spans.length, ...(truncated ? { truncated: true as const } : {}) })
    const nth = new Map<number, number>()
    spans.forEach((span, i) => {
      const rank = i === 0 ? FIRST : i === spans.length - 1 && span.signal === 'context' ? LAST : RANK[span.signal]
      const n = nth.get(rank) ?? 0
      nth.set(rank, n + 1)
      weighed.push({ ...span, rank, nth: n })
    })
  })
  if (!weighed.length) return undefined
  const order = (a: Span, b: Span): number => a.rank - b.rank || a.nth - b.nth || a.source - b.source || a.offset - b.offset
  const kept = [...weighed].sort(order).slice(0, Math.min(maxExtracts, MAX_EXTRACTS)).sort((a, b) => a.source - b.source || a.offset - b.offset)
  const extracts: Extract[] = kept.map((span, i) => ({ id: `E${i + 1}`, source: span.source, offset: span.offset, quote: span.quote, signal: span.signal }))
  return { schema: 'digest-extract@1.0', rule: { ...RULE }, sources: counts, extracts, text: render(counts, extracts) }
}

/** What the Worker reads: the sources by number, then each extract with its id and its source's number. */
function render(sources: DigestExtract['sources'], extracts: readonly Extract[]): string {
  const total = sources.reduce((n, s) => n + s.spans, 0)
  const shown = (source: number): number => extracts.filter((e) => e.source === source).length
  return [
    `Verbatim extracts of ${sources.length} artifact(s): ${extracts.length} of their ${total} spans (a span is a non-blank line, or part of a long one), selected by rule ${RULE.id} ${RULE.version}.${extracts.length < total ? ' The other spans are left out.' : ''}`,
    ...sources.map((s, i) => `S${i + 1} = ${s.ref}: ${shown(i)} of its ${s.spans} spans${s.truncated ? `; only its first ${SCAN_LIMIT} characters were read` : ''}`),
    '',
    ...extracts.map((e) => `${e.id} S${e.source + 1}: ${e.quote}`),
  ].join('\n')
}

/** Where a claim that cites an extract the Worker was not given points: no source, so the quote check drops it, saying so. */
const notGiven = (id: unknown): string => `extract ${String(id).slice(0, 20)} (not given)`

/**
 * A Worker's draft with each claim that cites an extract (`"extract": "E3"`) given that extract's
 * citation: its source, quote, and offset, from the extract, never from the answer. A claim citing
 * an extract it was not given cites no source, and the quote check drops it. A claim that cites a
 * source and a quote itself is left as it is, for the quote check to read. Anything else is
 * returned unchanged.
 */
export function resolveDraft(draft: Record<string, unknown> | undefined, extract: DigestExtract): Record<string, unknown> | undefined {
  if (!draft || !Array.isArray(draft.claims)) return draft
  const byId = new Map(extract.extracts.map((e) => [e.id, e]))
  const claims = draft.claims.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('extract' in raw)) return raw
    const { extract: id, ...claim } = raw as Record<string, unknown>
    const cited = typeof id === 'string' ? byId.get(id) : undefined
    return { ...claim, citation: cited ? { artifact: extract.sources[cited.source]!.ref, quote: cited.quote, offset: cited.offset } : { artifact: notGiven(id), quote: '?' } }
  })
  return { ...draft, claims }
}
