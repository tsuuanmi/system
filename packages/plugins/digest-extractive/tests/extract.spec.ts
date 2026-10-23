import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type ArtifactRef, quoteCheck } from '@tsuuanmi/system-digest-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { describe, expect, it } from 'vitest'
import { BENCH, LOG } from '../../../digest-core/conformance/digests.ts'
import { type DigestExtract, extractOf, resolveDraft, SCAN_LIMIT, spansOf } from '../src/index.ts'

const schemas = new SchemaRegistry()
const ref = (n: number): ArtifactRef => `sha256:${n.toString(16).padStart(64, '0')}`
const reader = (texts: Record<string, unknown>) => (r: ArtifactRef) => (r in texts ? { body: texts[r] } : undefined)
const text = (value: string) => ({ text: value })

describe('the selection rule (digest-extractive.select 1)', () => {
  it('writes the schema\'s example from the conformance suite\'s log and benchmark: each source\'s spans, verbatim, in order (INV-14)', () => {
    const example = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../schemas/examples/digest-extract.test-run.json', import.meta.url)), 'utf8')) as DigestExtract
    const [log, bench] = example.sources.map((s) => s.ref)
    const extract = extractOf([log!, bench!], reader({ [log!]: text(LOG), [bench!]: text(BENCH) }), 40)
    expect(extract).toEqual(example)
    schemas.assertRecord(extract!)
  })

  it('takes each non-blank line without its surrounding whitespace, at its offset in code points, and cuts a long line into parts a quote may be', () => {
    const long = `${'word '.repeat(150)}end`
    const source = `  😀 first line\r\n\n\t\nsecond\n${long}\n`
    const { spans, truncated } = spansOf(source, 0)
    expect(truncated).toBe(false)
    const chars = [...source]
    for (const s of spans) {
      expect(chars.slice(s.offset, s.offset + [...s.quote].length).join('')).toBe(s.quote)
      expect([...s.quote].length).toBeLessThanOrEqual(500)
      expect(s.quote).toBe(s.quote.trim())
    }
    expect(spans.slice(0, 2).map((s) => [s.offset, s.quote])).toEqual([[2, '😀 first line'], [19, 'second']])
    // The long line, in parts cut at a space: nothing of it lost but the spaces between parts.
    const parts = spans.slice(2).map((s) => s.quote)
    expect(parts.length).toBe(2)
    expect(parts.join(' ')).toBe(long)
  })

  it('reads at most its scan bound of a source, and says the source was truncated (INV-9)', () => {
    const { spans, truncated } = spansOf(`${'a'.repeat(SCAN_LIMIT)}\nFAIL past the bound`, 0)
    expect(truncated).toBe(true)
    expect(spans.some((s) => s.quote.includes('FAIL'))).toBe(false)
    const extract = extractOf([ref(1)], reader({ [ref(1)]: text(`${'ok\n'.repeat(SCAN_LIMIT / 3 + 10)}`) }), 5)!
    expect(extract.sources[0]).toMatchObject({ truncated: true })
    expect(extract.text).toMatch(/only its first 1000000 characters were read/)
  })

  it('keeps at most maxExtracts spans: each source\'s first, then failures across the sources in turn, then risks and metrics, then each source\'s last, then results, then the rest', () => {
    const a = ['header a', ...Array.from({ length: 30 }, (_, i) => `PASS test ${i}`), 'FAIL a1', 'FAIL a2', 'FAIL a3', 'WARN slow test', 'median 3.1 ms', 'trailer a'].join('\n')
    const b = ['header b', 'FAIL b1', 'note', 'trailer b'].join('\n')
    const extract = extractOf([ref(1), ref(2)], reader({ [ref(1)]: text(a), [ref(2)]: text(b) }), 9)!
    expect(extract.extracts.map((e) => [e.id, `S${e.source + 1}`, e.quote, e.signal])).toEqual([
      ['E1', 'S1', 'header a', 'context'], ['E2', 'S1', 'FAIL a1', 'failure'], ['E3', 'S1', 'FAIL a2', 'failure'], ['E4', 'S1', 'FAIL a3', 'failure'],
      ['E5', 'S1', 'WARN slow test', 'risk'], ['E6', 'S1', 'median 3.1 ms', 'metric'], ['E7', 'S1', 'trailer a', 'context'],
      ['E8', 'S2', 'header b', 'context'], ['E9', 'S2', 'FAIL b1', 'failure'],
    ])
    expect(extract.sources.map((s) => s.spans)).toEqual([37, 4])
    expect(extract.text.split('\n')[0]).toMatch(/9 of their 41 spans .* The other spans are left out\.$/)
    // Room for two more: the other source's last span, then the first result.
    expect(extractOf([ref(1), ref(2)], reader({ [ref(1)]: text(a), [ref(2)]: text(b) }), 11)!.extracts.map((e) => e.quote)).toEqual(expect.arrayContaining(['trailer b', 'PASS test 0']))
    // Everything fits: every span, in order.
    expect(extractOf([ref(2)], reader({ [ref(2)]: text(b) }), 40)!.extracts.map((e) => e.quote)).toEqual(['header b', 'FAIL b1', 'note', 'trailer b'])
  })

  it('reads a body with no text as its canonical JSON, as the quote check does, and gives no extract of blank sources', () => {
    const body = { schema: 'x', b: [1], a: 'Tests: 2 failed' }
    const extract = extractOf([ref(3)], reader({ [ref(3)]: body }), 40)!
    const check = quoteCheck({ status: 'failed', summary: 's', claims: [{ id: 'C1', kind: 'failure', text: 't', citation: { artifact: ref(3), quote: extract.extracts[0]!.quote, offset: extract.extracts[0]!.offset } }] }, [ref(3)], reader({ [ref(3)]: body }))
    expect(check.kept).toBe(1)
    expect(extractOf([ref(1), ref(2)], reader({ [ref(1)]: text(' \n\t\n'), [ref(2)]: text('') }), 40)).toBeUndefined()
  })
})

describe('a Worker\'s draft, resolved against the extract', () => {
  const extract = extractOf([ref(1)], reader({ [ref(1)]: text(LOG) }), 40)!
  const claim = (id: string, cite: Record<string, unknown>) => ({ id, kind: 'failure', text: 'Two end-gap tests fail.', ...cite })

  it('fills a claim that cites an extract with that extract\'s source, quote, and offset, never the answer\'s, and passes the quote check', () => {
    const draft = resolveDraft({ status: 'partial', summary: 's', claims: [claim('C1', { extract: 'E2', citation: { artifact: ref(9), quote: 'made up' } })] }, extract)!
    expect(draft.claims).toEqual([{ id: 'C1', kind: 'failure', text: 'Two end-gap tests fail.', citation: { artifact: ref(1), quote: 'FAIL tests/align/end-gaps.spec.ts (2 failed)', offset: 31 } }])
    expect(quoteCheck(draft, [ref(1)], reader({ [ref(1)]: text(LOG) })).kept).toBe(1)
  })

  it('lets the quote check drop a claim citing an extract it was not given, saying so, and leaves a claim that quotes a source itself for the check', () => {
    const draft = resolveDraft({ status: 'partial', summary: 's', claims: [claim('C1', { extract: 'E9' }), claim('C2', { extract: 3 }), claim('C3', { citation: { artifact: ref(1), quote: 'Tests: 41 passed' } })] }, extract)!
    const check = quoteCheck(draft, [ref(1)], reader({ [ref(1)]: text(LOG) }))
    expect(check.kept).toBe(1)
    expect(check.dropped).toEqual([
      { claim: 'C1', why: 'it cites extract E9 (not given), which is not one of the digested artifacts' },
      { claim: 'C2', why: 'it cites extract 3 (not given), which is not one of the digested artifacts' },
    ])
    expect(resolveDraft(undefined, extract)).toBeUndefined()
    expect(resolveDraft({ status: 'passed' }, extract)).toEqual({ status: 'passed' })
  })
})
