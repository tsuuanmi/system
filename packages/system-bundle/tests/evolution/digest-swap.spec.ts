/**
 * Base exit criterion 6, evolution (docs/design/digests.md#replacing-the-provider): the digest
 * provider is replaced through its manifest, by configuration only, and measured before and after
 * on the same fixtures.
 *
 * The compositions are the bundle's own rows: as shipped, and with the operator's swap patch
 * (`swap-digests.yml`, which only turns rows on and off). The test names no provider: under each
 * composition it finds the one mounted row whose manifest provides `digests`, mounts it from the
 * package the row names, with the rows its manifest requires (found the same way), and digests the
 * same fixtures with the same scripted Worker, which answers from the prompt its brief rendered to,
 * as a text-prompted Worker does. Every figure is read from what the ledger of record holds, the
 * same for any provider: each request's settling decision and escalation decision, and the runs the
 * Worker was started with. The record is checked in beside this test (`digest-swap.record.json`);
 * a change in either provider that moves a figure fails here until it is regenerated
 * (`vitest -u`) and reviewed. The end-to-end test boots the shipped profile with the same patch
 * through the real launcher (packages/cli/tests/profile.e2e.ts).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-ledger-core'
import type { ArtifactRef, DigestView } from '@tsuuanmi/system-digest-core'
import { contentId } from '@tsuuanmi/system-libs'
import { packageManifest } from '@tsuuanmi/system-plugin-host'
import { checkComposition, type CompositionRow, type ManifestRead, type PluginManifest, reconcile, type RecordedLifecycle } from '@tsuuanmi/system-plugin-host-core'
import { describe, expect, it, vi } from 'vitest'
import type { Drafter } from '../../../digest-core/conformance/digests.ts'
import { DigestWorker } from '../../../digest-core/conformance/worker.ts'
import { bundleAllowance } from '../../../../scripts/gen-manifests.ts'
import { bundleRows } from '../../../../scripts/gen-packages.ts'
import { type Fixture, FIXTURES } from './fixtures.ts'

vi.setConfig({ testTimeout: 120_000 })

const BUNDLE = fileURLToPath(new URL('../..', import.meta.url))
const PATCH = fileURLToPath(new URL('./swap-digests.yml', import.meta.url))

/** The operator's patch, read as DSH reads a targeted row: an id and, in a swap, only `disabled`. */
function swapPatch(): Array<{ id: string; disabled: boolean }> {
  const entries: Array<{ id: string; disabled?: boolean }> = []
  for (const line of readFileSync(PATCH, 'utf8').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const id = /^- id: ([\w-]+)$/.exec(line)
    const disabled = /^ {2}disabled: (true|false)$/.exec(line)
    if (id) entries.push({ id: id[1]! })
    else if (disabled && entries.length) entries.at(-1)!.disabled = disabled[1] === 'true'
    else throw new Error(`the swap patch changes more than which rows are on: ${line}`)
  }
  return entries.map((e) => ({ id: e.id, disabled: e.disabled ?? false }))
}

/** The bundle's rows as shipped, and as the patch leaves them: each row on or off, nothing else. */
const SHIPPED: CompositionRow[] = bundleRows().map((r) => ({ id: r.id, name: r.name, mounted: !r.off }))
function patched(rows: readonly CompositionRow[], patch: ReturnType<typeof swapPatch>): CompositionRow[] {
  for (const { id } of patch) if (!rows.some((r) => r.id === id)) throw new Error(`the patch targets ${id}, which is not a row of the bundle`)
  return rows.map((r) => {
    const target = patch.find((p) => p.id === r.id)
    return target ? { ...r, mounted: !target.disabled } : r
  })
}
const SWAPPED = patched(SHIPPED, swapPatch())

/** Each row's manifest, as the plugin host reads it from the package the row names. */
const MANIFESTS = new Map<string, ManifestRead>(SHIPPED.map((r) => [r.name, packageManifest(r.name, [BUNDLE])]))
const manifestOf = (row: CompositionRow): PluginManifest | undefined => {
  const read = MANIFESTS.get(row.name)
  return read?.state === 'valid' ? read.manifest : undefined
}
/** The mounted rows whose manifest provides `seam`. */
const providers = (rows: readonly CompositionRow[], seam: string): CompositionRow[] => rows.filter((r) => r.mounted && manifestOf(r)?.provides.some((p) => p.seam === seam))

/** A scripted Worker that answers from its prompt, as the brief asks: claims on its salient lines, each citing an extract when it was given extracts, else a source and a quote. */
const SALIENT = /fail|error|assert|×|✗|warn|risk|blocking|median|speed-?up|improved|criterion|hypothesis|exit \d/i
const MAX_CLAIMS = 6
/**
 * How the Worker copies a quote: verbatim, or, for `paraphrases` on the economy tier, the way the
 * design names a cheap Worker's failure (docs/design/digests.md#one-escalation): its runs of
 * whitespace collapsed and its closing punctuation dropped. On the standard tier it copies verbatim.
 */
const paraphrase = (line: string): string => line.replace(/\s+/g, ' ').replace(/[.;:,]+$/, '')
function reader(paraphrases: boolean): Drafter {
  return (_sources, tier, prompt = '') => {
    const loose = paraphrases && tier === 'economy'
    const extracts = [...prompt.matchAll(/^(E\d+) S\d+: (.*)$/gm)].map((m) => ({ extract: m[1]!, line: m[2]! }))
    const lines: Array<{ line: string } & ({ extract: string } | { artifact: string })> = extracts.length ? extracts
      : [...prompt.matchAll(/<artifact id="(sha256:[0-9a-f]{64})">\n([\s\S]*?)\n<\/artifact>/g)].flatMap((m) => m[2]!.split('\n').map((line) => ({ artifact: m[1]!, line: line.trim().slice(0, 300) })))
    const claims = lines.filter((l) => l.line && SALIENT.test(l.line)).slice(0, MAX_CLAIMS).map((l, i) => ({
      id: `C${i + 1}`, kind: /fail|error|assert|×|✗/i.test(l.line) ? 'failure' : /warn|risk|blocking/i.test(l.line) ? 'risk' : 'finding', text: `It says: ${l.line.slice(0, 200)}`,
      ...('extract' in l ? { extract: l.extract } : { citation: { artifact: l.artifact, quote: loose ? paraphrase(l.line) : l.line } }),
    }))
    const status = claims.some((c) => c.kind === 'failure') ? 'failed' : 'passed'
    return { text: `\`\`\`json\n${JSON.stringify({ status, summary: `What the ${claims.length} salient lines of the artifacts say.`, claims })}\n\`\`\`` }
  }
}

const chars = (text: string): number => [...text].length
interface RequestFigures { fixture: string; state: string; kept: number; dropped: number; escalated: boolean; runs: number; promptChars: number; answerChars: number }
interface Figures {
  provider: string
  digests: { written: number; notWritten: number; bypassed: number }
  claims: { kept: number; dropped: number; passRate: number }
  escalations: number
  worker: { runs: number; promptChars: number; answerChars: number }
  requests: RequestFigures[]
}

/** Store a fixture's sources, the same artifacts under every composition. */
function store(ctx: Context, fixture: Fixture): ArtifactRef[] {
  return fixture.sources.map((source, i) => ctx.artifacts.put('body' in source
    ? { kind: 'assessment', bodySchema: 'assessment@1.0', body: source.body, classification: 'operator-shared', producer: { type: 'worker', ref: 'w:fixture' } }
    : {
      kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: 'w:fixture' },
      body: { schema: 'provider-answer@1.0', provider: 'fixture', account: 'fixture', turnId: `${fixture.name}-${i}`, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text: source.text },
    }).id as ArtifactRef)
}

/**
 * Digest every fixture under `rows`: the provider of `digests` its rows mount, the rows its manifest
 * requires, and the scripted Worker; the figures read back from the ledger of record.
 */
async function measure(rows: readonly CompositionRow[], drafter: Drafter): Promise<Figures> {
  const [digests, ...more] = providers(rows, 'digests')
  expect(more, 'one provider of ctx.digests is mounted').toEqual([])
  const needed: CompositionRow[] = []
  const visit = (row: CompositionRow): void => {
    if (needed.includes(row)) return
    for (const { seam } of manifestOf(row)!.consumes.filter((c) => !c.optional)) {
      const [provider, ...others] = providers(rows, seam)
      if (!provider || others.length) throw new Error(`${row.name} requires ctx.${seam}, which ${others.length ? 'several rows' : 'no row'} of the composition provide`)
      visit(provider)
    }
    needed.push(row)
  }
  visit(digests!)
  const dir = mkdtempSync(join(tmpdir(), 'system-evolution-'))
  const ctx = new Context()
  const worker = new DigestWorker(drafter)
  const fibers: Fiber[] = []
  try {
    for (const row of needed) {
      const plugin = (await import(row.name) as { default: Plugin }).default
      fibers.push(ctx.plugin(plugin, providers([row], 'store').length ? { path: join(dir, 'system.db') } : {}))
      if (providers([row], 'workers').length) fibers.push(ctx.plugin({ name: 'digest-worker', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(worker.source(c)) }))
    }
    await Promise.all(fibers)
    const requests: RequestFigures[] = []
    for (const fixture of FIXTURES) {
      const view: DigestView = await ctx.digests.wait((await ctx.digests.request({ sources: store(ctx, fixture) })).requestId, 60_000)
      const settled = ctx.artifacts.get(view.decision!)!.body as { outcome: { option: string; detail: { kept: number; dropped: unknown[] } } }
      const escalated = view.escalation ? (ctx.artifacts.get(view.escalation)!.body as { outcome: { detail: { dropped: unknown[] } } }).outcome.detail.dropped.length : 0
      const runs = worker.started.filter((s) => s.key === `digests:${view.requestId}` || s.key.startsWith(`digests:${view.requestId}:`))
      requests.push({
        fixture: fixture.name, state: settled.outcome.option, kept: settled.outcome.detail.kept, dropped: settled.outcome.detail.dropped.length + escalated, escalated: !!view.escalation,
        runs: runs.length, promptChars: runs.reduce((n, r) => n + chars(r.prompt), 0), answerChars: runs.reduce((n, r) => n + chars(worker.answers.get(r.id) ?? ''), 0),
      })
    }
    const sum = (key: 'kept' | 'dropped' | 'runs' | 'promptChars' | 'answerChars'): number => requests.reduce((n, r) => n + r[key], 0)
    const count = (state: string): number => requests.filter((r) => r.state === state).length
    return {
      provider: digests!.name,
      digests: { written: count('written'), notWritten: count('not-written'), bypassed: count('bypassed') },
      claims: { kept: sum('kept'), dropped: sum('dropped'), passRate: Math.round((sum('kept') / Math.max(1, sum('kept') + sum('dropped'))) * 1000) / 1000 },
      escalations: requests.filter((r) => r.escalated).length,
      worker: { runs: sum('runs'), promptChars: sum('promptChars'), answerChars: sum('answerChars') },
      requests,
    }
  } finally {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('evolution: the digest provider replaced by configuration (Base exit criterion 6)', () => {
  it('swaps the provider by turning two rows on and off, which the plugin host records as two lifecycle changes, its manifest check finding nothing in either composition (REQ-HOST-4, REQ-HOST-7, QA-9, INV-1)', () => {
    expect(swapPatch()).toEqual([{ id: 'digest', disabled: true }, { id: 'digest-extractive', disabled: false }])
    expect(SWAPPED.filter((r, i) => r.mounted !== SHIPPED[i]!.mounted).map((r) => r.id)).toEqual(['digest', 'digest-extractive'])
    expect(providers(SHIPPED, 'digests').map((r) => r.name)).toEqual(['@tsuuanmi/system-digest'])
    expect(providers(SWAPPED, 'digests').map((r) => r.name)).toEqual(['@tsuuanmi/system-digest-extractive'])
    // Both providers declare the contract every consumer's range accepts, so neither composition has a finding.
    const allowed = bundleAllowance()!
    expect([...checkComposition(SHIPPED, MANIFESTS, allowed)]).toEqual([])
    expect([...checkComposition(SWAPPED, MANIFESTS, allowed)]).toEqual([])
    // The host's record after a boot as shipped, then the swap: the two plugins change state, nothing else.
    const first = reconcile(SHIPPED, MANIFESTS, new Map())
    const recorded = new Map<string, RecordedLifecycle>(first.changes.map((c) => [c.name, { name: c.name, version: c.version, rows: c.rows, state: c.state, since: '2026-10-24T00:00:00.000Z', decision: contentId(c.decision) as ArtifactRef }]))
    expect(reconcile(SHIPPED, MANIFESTS, recorded).changes).toEqual([])
    const swap = reconcile(SWAPPED, MANIFESTS, recorded)
    expect(swap.changes.map((c) => [c.name, c.previous?.state, c.state, c.decision.inputs])).toEqual([
      ['@tsuuanmi/system-digest', 'default', 'candidate', [recorded.get('@tsuuanmi/system-digest')!.decision]],
      ['@tsuuanmi/system-digest-extractive', 'candidate', 'default', [recorded.get('@tsuuanmi/system-digest-extractive')!.decision]],
    ])
  })

  it('digests the same fixtures before and after with the same Worker: every request written, every claim kept or dropped by the same quote check, fewer characters sent after, and no misquote to drop after (QA-9, INV-13)', async () => {
    const compare = async (drafter: Drafter) => ({ before: await measure(SHIPPED, drafter), after: await measure(SWAPPED, drafter) })
    const copies = await compare(reader(false))
    const paraphrases = await compare(reader(true))
    const record = {
      criterion: 'Base exit criterion 6: the digest provider replaced through its manifest with no core change, with metrics before and after (docs/design/digests.md#replacing-the-provider)',
      patch: swapPatch(),
      fixtures: FIXTURES.map((f) => ({ name: f.name, sources: f.sources.length, chars: f.sources.reduce((n, s) => n + ('text' in s ? chars(s.text) : chars(JSON.stringify(s.body))), 0) })),
      workers: {
        copies: { description: 'copies each quote verbatim on every tier', ...copies },
        paraphrases: { description: 'on the economy tier, collapses whitespace and drops closing punctuation when it copies a quote; on the standard tier, copies verbatim', ...paraphrases },
      },
    }
    await expect(`${JSON.stringify(record, null, 2)}\n`).toMatchFileSnapshot('./digest-swap.record.json')
    for (const { before, after } of [copies, paraphrases]) {
      expect([before.provider, after.provider]).toEqual(['@tsuuanmi/system-digest', '@tsuuanmi/system-digest-extractive'])
      expect([before.digests, after.digests]).toEqual([{ written: FIXTURES.length, notWritten: 0, bypassed: 0 }, { written: FIXTURES.length, notWritten: 0, bypassed: 0 }])
      // Fewer characters each way on every request: the extract in place of the whole sources and a short
      // example in place of the digest@1.0 schema going in, an extract's id in place of a copied quote coming out.
      for (const [i, request] of after.requests.entries()) {
        expect(request.promptChars, request.fixture).toBeLessThan(before.requests[i]!.promptChars)
        expect(request.answerChars, request.fixture).toBeLessThan(before.requests[i]!.answerChars)
      }
      expect(after.claims).toMatchObject({ dropped: 0, passRate: 1 })
      expect(after.escalations).toBe(0)
    }
    // A Worker that copies quotes verbatim loses no claim either way; one that paraphrases on the
    // economy tier loses some to the quote check before the swap, and none after it.
    expect(copies.before.claims).toMatchObject({ dropped: 0, passRate: 1 })
    expect(copies.before.claims.kept).toBe(copies.after.claims.kept)
    expect(paraphrases.before.claims.passRate).toBeLessThan(1)
    expect(paraphrases.before.claims.dropped).toBeGreaterThan(0)
  })
})
