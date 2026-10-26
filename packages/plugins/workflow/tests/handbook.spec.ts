import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import type { ArtifactRef } from '@tsuuanmi/system-board-core'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { type BriefHandbook, type HandbookRole, lessonsSection } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { activeProject, CONFIG, readyTask, ScriptedWorkers, TEMPLATES } from '../conformance/workflow.ts'
import { applyHandbook, blobOf, buildSlice, engineHandbook, HANDBOOK_BOUND, HANDBOOK_LAYERS, HANDBOOK_RULE, type HandbookPart, type HandbookSource, lessonsFor, type Read, readHomes, type Selection, selectParts, SOURCE_MAX, tokensOf } from '../src/handbook.ts'
import Workflow from '../src/index.ts'
import type { NodeTemplate } from '../src/spec.ts'

// The per-Worker handbook slice (docs/design/handbook.md, PROP-0016 I1 part 2): a step is given the
// parts of the handbook's layers that bear on its role, task class, risk tier, and touched paths,
// within 6,000 estimated tokens, each layer's version recorded in its brief; over the bound, a
// warning for the first `handbook.warnTasks` board tasks, then a refusal.
vi.setConfig({ testTimeout: 60_000 })

const ROLES: readonly HandbookRole[] = ['develop', 'review', 'validate', 'research', 'lead']

/** A fixture handbook: every key a part can carry, and one playbook per role. */
const FIXTURE: HandbookSource = {
  versions: { 1: 'git:inv', 2: 'policy:studio@1:h', 3: 'charter:p1:2', 4: 'playbook:t:abc' },
  parts: [
    { id: 'L1.pointer', layer: 1, text: '- the invariants bind' },
    { id: 'L1.titles', layer: 1, text: '- INV-1 … INV-15', applies: { tiers: ['heavy'] } },
    { id: 'L2.tier.light', layer: 2, text: '- light', applies: { tiers: ['light'] } },
    { id: 'L2.tier.heavy', layer: 2, text: '- heavy', applies: { tiers: ['heavy'] } },
    { id: 'L2.gate-view', layer: 2, text: '', source: { tokens: SOURCE_MAX.gateView, atMost: true } },
    { id: 'L3.objective', layer: 3, text: '- objective' },
    { id: 'L3.constraints', layer: 3, text: '- constraints', applies: { roles: ['develop', 'review'] } },
    { id: 'L4.writer', layer: 4, text: '- write the change with its docs and tests', applies: { roles: ['develop'] } },
    { id: 'L4.writer.docs', layer: 4, text: '- every statement true of the code', applies: { roles: ['develop'], classes: ['docs'] } },
    { id: 'T4', layer: 4, text: '- wait for the event, not the clock', applies: { roles: ['develop'], classes: ['tests'], paths: ['tests/'] } },
    { id: 'W18', layer: 4, text: '- how a schema changes', applies: { roles: ['develop'], paths: ['schemas/'] } },
    { id: 'L4.reviewer', layer: 4, text: '- review independently', applies: { roles: ['review'] } },
    { id: 'L4.validator', layer: 4, text: '- run each check as written', applies: { roles: ['validate'] } },
    { id: 'L4.researcher', layer: 4, text: '- cite', applies: { roles: ['research'] } },
    { id: 'L4.lead', layer: 4, text: '- the lead\'s playbook', applies: { roles: ['lead'] } },
    { id: 'L5.lessons', layer: 5, text: '', source: { tokens: SOURCE_MAX.lessons, atMost: true }, applies: { roles: ['develop', 'review'] } },
  ],
}

const sel = (role: HandbookRole, extra: Partial<Selection> = {}): Selection => ({ role, tier: 'normal', tierFrom: 'map', paths: 'subject', touched: ['src/a.ts'], ...extra })
const ids = (s: Selection): string[] => selectParts(FIXTURE, s).map((p) => p.id)

describe('the slice of each role (docs/design/handbook.md#the-slice-of-each-role), on a fixture handbook', () => {
  it('gives each role its own parts: its playbook, the charter parts it judges by, and the source\'s half it is sent', () => {
    expect(ids(sel('develop', { class: 'code' }))).toEqual(['L1.pointer', 'L2.gate-view', 'L3.objective', 'L3.constraints', 'L4.writer', 'L5.lessons'])
    expect(ids(sel('review'))).toEqual(['L1.pointer', 'L2.gate-view', 'L3.objective', 'L3.constraints', 'L4.reviewer', 'L5.lessons'])
    expect(ids(sel('validate', { class: 'validation' }))).toEqual(['L1.pointer', 'L2.gate-view', 'L3.objective', 'L4.validator'])
    expect(ids(sel('research'))).toEqual(['L1.pointer', 'L2.gate-view', 'L3.objective', 'L4.researcher'])
    expect(ids(sel('lead'))).toEqual(['L1.pointer', 'L2.gate-view', 'L3.objective', 'L4.lead'])
  })

  it('selects by task class, risk tier, and touched paths; a class or paths it cannot read leave none of the role\'s parts out (INV-2)', () => {
    // The docs variant adds its own rule; a tests rule comes with the tests class or a touched tests/ path.
    expect(ids(sel('develop', { class: 'docs' }))).toContain('L4.writer.docs')
    expect(ids(sel('develop', { class: 'tests' }))).toContain('T4')
    expect(ids(sel('develop', { class: 'code', touched: ['tests/a.spec.ts'] }))).toContain('T4')
    expect(ids(sel('develop', { class: 'code', touched: ['src/a.ts'] }))).not.toContain('T4')
    expect(ids(sel('develop', { class: 'code', touched: ['schemas/brief.v1.json'] }))).toContain('W18')
    // Unknown paths: every path-keyed part; no class named: every class's part.
    const { touched: _touched, ...unknown } = sel('develop', { class: 'code', paths: 'unknown' })
    expect(ids(unknown)).toEqual(expect.arrayContaining(['T4', 'W18']))
    const { class: _class, ...classless } = sel('develop')
    expect(ids(classless)).toEqual(expect.arrayContaining(['L4.writer.docs', 'T4']))
    // The tier's lines: heavy adds the invariants' titles; tiering off carries no tier line.
    expect(ids(sel('develop', { tier: 'heavy' }))).toEqual(expect.arrayContaining(['L1.titles', 'L2.tier.heavy']))
    expect(ids(sel('develop', { tier: 'light' }))).toContain('L2.tier.light')
    expect(ids(sel('develop', { tier: 'off', tierFrom: 'off' })).filter((id) => id.startsWith('L2.tier') || id === 'L1.titles')).toEqual([])
  })

  it('never gives a role another role\'s playbook, whatever its class, tier, or paths', () => {
    const playbooks = new Map<string, HandbookRole>(FIXTURE.parts.filter((p) => p.layer === 4).map((p) => [p.id, p.applies!.roles![0]!]))
    for (const role of ROLES) {
      for (const tier of ['light', 'normal', 'heavy', 'off'] as const) {
        for (const klass of [undefined, 'code', 'docs', 'tests', 'validation']) {
          for (const touched of [undefined, ['src/a.ts'], ['tests/a.spec.ts', 'schemas/x.v1.json']]) {
            const s: Selection = { role, tier, tierFrom: 'map', paths: touched ? 'subject' : 'unknown', ...(klass ? { class: klass } : {}), ...(touched ? { touched } : {}) }
            const others = selectParts(FIXTURE, s).filter((p) => p.layer === 4 && playbooks.get(p.id) !== role)
            expect(others.map((p) => p.id), `${role} ${tier} ${klass} ${touched}`).toEqual([])
          }
        }
      }
    }
  })

  it('renders the engine\'s half by layer, counts the source\'s half at its maximum, and records each layer\'s version, parts, and size', () => {
    const slice = buildSlice(FIXTURE, sel('develop', { class: 'docs' }))
    expect(slice.text).toMatch(/^Handbook slice for this step: role develop, class docs, risk tier normal/)
    expect(slice.text).toContain('## 4. Role playbook (owner: lead)\n- write the change with its docs and tests\n- every statement true of the code')
    expect(slice.text).not.toContain('review independently')
    expect(slice.layers.map(({ layer, renderedBy, version, parts }) => ({ layer, renderedBy, version, parts }))).toEqual([
      { layer: 1, renderedBy: 'engine', version: 'git:inv', parts: ['L1.pointer'] },
      { layer: 2, renderedBy: 'source', version: 'source', parts: ['L2.gate-view'] },
      { layer: 3, renderedBy: 'engine', version: 'charter:p1:2', parts: ['L3.objective', 'L3.constraints'] },
      { layer: 4, renderedBy: 'engine', version: 'playbook:t:abc', parts: ['L4.writer', 'L4.writer.docs'] },
      { layer: 5, renderedBy: 'source', version: 'source', parts: ['L5.lessons'] },
    ])
    expect(slice.layers.find((l) => l.layer === 5)).toMatchObject({ tokens: SOURCE_MAX.lessons, atMost: true })
    expect(slice.tokens).toBe(slice.layers.reduce((sum, l) => sum + l.tokens, 0))
    // Estimated tokens are UTF-8 bytes over four, rounded up: a multi-byte character counts its bytes.
    expect(tokensOf('abcd')).toBe(1)
    expect(tokensOf('abcde')).toBe(2)
    expect(tokensOf('é'.repeat(4))).toBe(2)
    // Within the bound: no layer over its share, nothing exceeds.
    expect(slice).toMatchObject({ over: [], exceeds: false })
  })

  it('counts a part whose text the brief carries elsewhere, renders only its line, and names every layer over its share when the slice passes the bound', () => {
    const long: HandbookPart = { id: 'L4.long', layer: 4, text: 'x'.repeat(4 * 2500), elsewhere: '- your playbook is this step\'s instructions', applies: { roles: ['develop'] } }
    const slice = buildSlice({ ...FIXTURE, parts: [...FIXTURE.parts, long] }, sel('develop', { class: 'code' }))
    expect(slice.text).toContain('- your playbook is this step\'s instructions')
    expect(slice.text).not.toContain('xxxx')
    const layer4 = slice.layers.find((l) => l.layer === 4)!
    expect(layer4.tokens).toBeGreaterThan(2500)
    expect(slice.tokens).toBeGreaterThan(HANDBOOK_BOUND)
    expect(slice.exceeds).toBe(true)
    expect(slice.over).toEqual([{ layer: 4, tokens: layer4.tokens, share: 900, owner: 'lead' }])
  })

  it('counts the source\'s half at what it renders to when that is known, at its maximum only when not, and flags a source half over its layer\'s share', () => {
    const at = (tokens: number): HandbookSource => ({ ...FIXTURE, parts: FIXTURE.parts.map((p) => (p.id === 'L5.lessons' ? { ...p, source: { tokens } } : p)) })
    const measured = buildSlice(at(640), sel('develop', { class: 'code' }))
    const layer5 = measured.layers.find((l) => l.layer === 5)!
    expect(layer5).toMatchObject({ renderedBy: 'source', tokens: 640 })
    expect(layer5).not.toHaveProperty('atMost')
    expect(measured.tokens).toBe(buildSlice(FIXTURE, sel('develop', { class: 'code' })).tokens - SOURCE_MAX.lessons + 640)
    expect(measured.sourceOver).toEqual([])
    // A source's half past its layer's share: flagged whatever the slice's size, so it is refused in either mode.
    const grown = buildSlice(at(3200), sel('develop', { class: 'code' }))
    expect(grown.exceeds).toBe(false)
    expect(grown.sourceOver).toEqual([{ layer: 5, tokens: 3200, share: 3100, owner: 'lead and review' }])
    // The constructed maxima are within their layers' shares.
    expect(SOURCE_MAX.lessons).toBeLessThanOrEqual(HANDBOOK_LAYERS.find((l) => l.layer === 5)!.share)
    expect(SOURCE_MAX.gateView).toBeLessThanOrEqual(HANDBOOK_LAYERS.find((l) => l.layer === 2)!.share)
    // Refused even in warn mode, before anything is sent: the decision first, then the step fails config_error.
    const decisions: Array<{ decider: { id: string }; outcome: { option: string } }> = []
    const writes: Array<{ state: string; error: string }> = []
    const engine = {
      ctx: {
        artifacts: { recordDecision: (d: (typeof decisions)[number]) => (decisions.push(d), { id: `sha256:${'d'.repeat(64)}` }) },
        store: { transaction: (fn: () => void) => fn() },
        eventLog: { append: () => undefined },
      },
      writeNode: (_node: unknown, patch: (typeof writes)[number]) => writes.push(patch),
    }
    const built = { selection: sel('develop', { class: 'code' }), slice: grown, mode: 'warn' as const, projectId: 'p1', taskId: 't1' }
    const draft = { schema: 'brief@1.2', goal: 'g', acceptance: [], artifacts: [], budget: { remaining: [] }, classification: 'public' }
    expect(applyHandbook(engine as never, { run_id: 'r1' } as never, { node_id: 'n1' } as never, draft as never, built, () => ({}) as never)).toBe('refused')
    expect(decisions.map((d) => [d.decider.id, d.outcome.option])).toEqual([[HANDBOOK_RULE, 'refuse']])
    expect(writes).toEqual([expect.objectContaining({ state: 'FAILED', error: expect.stringMatching(/config_error.*handbook_over_bound.*layer 5 \(Repository lessons, owner lead and review\) renders 3200 tokens/) })])
  })

  it('measures the lessons as the Worker source renders them for the role and paths, none without a lessons file, and unknown without a repository', () => {
    const repo = mkdtempSync(join(tmpdir(), 'system-workflow-lessons-'))
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }))
    expect(lessonsFor(repo, { role: 'develop' })).toEqual({ tokens: 0, lessons: 0 })
    mkdirSync(join(repo, 'docs/engineering'), { recursive: true })
    writeFileSync(join(repo, 'docs/engineering/lessons.md'), [
      '# Lessons', '',
      '- a test never sleeps a fixed time. Check: the tests check.',
      '- a schema never changes in place. Check: check:schemas. Applies: develop; schemas/',
      '- cite every claim. Check: the review. Applies: research',
    ].join('\n'))
    const develop = lessonsFor(repo, { role: 'develop', touched: ['src/a.ts'] })!
    const section = lessonsSection(readFileSync(join(repo, 'docs/engineering/lessons.md'), 'utf8'), { role: 'develop', touched: ['src/a.ts'] })!
    expect(develop).toEqual({ tokens: tokensOf(section), lessons: 1 })
    expect(lessonsFor(repo, { role: 'develop', touched: ['schemas/a.v1.json'] })!.lessons).toBe(2)
    expect(lessonsFor(repo, { role: 'develop' })!.lessons).toBe(2)
    expect(lessonsFor(repo, { role: 'research' })!.lessons).toBe(1)
    expect(lessonsFor(repo, { role: 'validate' })).toEqual({ tokens: 0, lessons: 0 })
    expect(lessonsFor(undefined, { role: 'develop' })).toBeUndefined()
    expect(lessonsFor(join(repo, 'nowhere'), { role: 'develop' })).toBeUndefined()
  })

  it('declares the five layers once, each with its owner, homes, version, and share, the shares summing to the bound', () => {
    expect(HANDBOOK_LAYERS.map((l) => l.layer)).toEqual([1, 2, 3, 4, 5])
    for (const layer of HANDBOOK_LAYERS) expect(layer.owner && layer.homes.length && layer.version).toBeTruthy()
    expect(HANDBOOK_LAYERS.reduce((sum, l) => sum + l.share, 0)).toBe(HANDBOOK_BOUND)
  })
})

// --- The engine's handbook, read from the homes ------------------------------------------------

const INVARIANTS = '# System invariants\n\n### INV-1 One authoritative runtime\n\nOne.\n\n### INV-2 Fail closed\n\nTwo.\n'
/** A System repository in miniature: the homes of layers 1 and 4 the engine reads (`handbook.root`). */
function homesRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'system-workflow-homes-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  put('docs/architecture/invariants.md', INVARIANTS)
  put('docs/decisions/adr/README.md', [
    '| ADR | Decision | Status |', '|---|---|---|',
    '| [0001](0001-one.md) | One runtime | Accepted |',
    '| [0002](0002-the-engine.md) | The engine briefs its steps | Accepted; amended 2026-10-26 |',
    '| [0003](0003-draft.md) | A draft about the engine | Proposed |',
  ].join('\n'))
  put('docs/decisions/adr/0001-one.md', '# One runtime\n\nRelated: packages/store\n')
  put('docs/decisions/adr/0002-the-engine.md', '# The engine briefs its steps\n\nRelated: packages/plugins/workflow\n')
  put('docs/decisions/adr/0003-draft.md', '# A draft\n\nRelated: packages/plugins/workflow\n')
  put('docs/design/handbook.md', [
    '| Id | Rule | Home today | Check |', '|---|---|---|---|',
    ...[['W2', 'change only what the task needs'], ['W3', 'never weaken, skip, or loosen a test'], ['W4', 'the docs variant changes documents only'], ['W5', 'the tests variant changes tests only'],
      ['W18', 'how a schema changes'], ['Q1', 'a package imports from its layer or a lower one'], ['T1', 'real plugins over mocks'], ['T4', 'wait for the event, not the clock'],
      ['V1', 'review independently'], ['V5', 'a heavy change\'s second review is by another provider family']].map(([id, rule]) => `| ${id} | ${rule} | AGENTS.md | **none** |`),
  ].join('\n'))
  return root
}

const read = (root: string, selection: Selection): Read => ({ selection, policy: 'policy:studio@1:h', homes: readHomes(root) })
const RUN = { template: 't' }
const PROMPT = { prompt: 'Do it: {{input}}' }
const production = (root: string, s: Selection): string[] => selectParts(engineHandbook(RUN, PROMPT, read(root, s), '1.2.3'), s).filter((p) => !p.source).map((p) => p.id)

describe('the engine\'s handbook from its homes: the parts each role, class, tier, and touched path selects', () => {
  it('gives a heavy change the invariants\' titles and the accepted ADRs that name a touched package; a normal one the pointer alone', () => {
    const root = homesRoot()
    const heavy = production(root, sel('develop', { class: 'code', tier: 'heavy', touched: ['packages/plugins/workflow/src/a.ts'] }))
    expect(heavy.filter((id) => id.startsWith('L1') || id.startsWith('INV') || id.startsWith('ADR'))).toEqual(['L1.pointer', 'INV-1', 'INV-2', 'ADR-0002'])
    // A proposed ADR is no rule, and one of an untouched package is not named; with the paths unknown, the pointer's index stands for them.
    expect(production(root, sel('develop', { class: 'code', tier: 'heavy', touched: ['packages/libs/src/a.ts'] }))).not.toContain('ADR-0002')
    const { touched: _t, ...unknown } = sel('develop', { class: 'code', tier: 'heavy', paths: 'unknown' })
    expect(production(root, unknown).filter((id) => id.startsWith('ADR'))).toEqual([])
    expect(production(root, sel('develop', { class: 'code' })).filter((id) => id.startsWith('INV') || id.startsWith('ADR'))).toEqual([])
  })

  it('gives a writer the inventory\'s rules by its class and the paths it touches, a reviewer its own, and neither the other\'s', () => {
    const root = homesRoot()
    const rules = (s: Selection): string[] => production(root, s).filter((id) => /^[WQTV]\d+$/.test(id))
    expect(rules(sel('develop', { class: 'code', touched: ['packages/a/src/x.ts'] }))).toEqual(['W2', 'W3', 'Q1'])
    expect(rules(sel('develop', { class: 'code', touched: ['packages/a/tests/x.spec.ts', 'schemas/a.v1.json'] }))).toEqual(['W2', 'W3', 'W18', 'Q1', 'T1', 'T4'])
    expect(rules(sel('develop', { class: 'docs', touched: ['docs/a.md'] }))).toEqual(['W4'])
    expect(rules(sel('develop', { class: 'tests', touched: ['packages/a/tests/x.spec.ts'] }))).toEqual(['W3', 'W5', 'T1', 'T4'])
    expect(rules(sel('review'))).toEqual(['V1'])
    expect(rules(sel('review', { tier: 'heavy' }))).toEqual(['V1', 'V5'])
    expect(rules(sel('validate', { class: 'validation' }))).toEqual([])
    expect(rules(sel('research'))).toEqual([])
    expect(production(root, sel('review'))).toContain('L4.rules')
    expect(production(root, sel('validate'))).not.toContain('L4.rules')
  })

  it('counts a review\'s guides (T267) in its layer 4 without repeating them, names each guide\'s version there, and gives them to no other role', () => {
    const root = homesRoot()
    // The rules T267 added: the author's checks before review (W19) for every writing class, the guides' rule (V6) for every review.
    writeFileSync(join(root, 'docs/design/handbook.md'), `${readFileSync(join(root, 'docs/design/handbook.md'), 'utf8')}\n| W19 | the author runs the required checks before its review | the writing prompts | the evidence gate |\n| V6 | a review follows the review guides of the areas its change touches | the guides | **none** |\n`)
    const rules = (s: Selection): string[] => production(root, s).filter((id) => /^[WQTV]\d+$/.test(id))
    expect(rules(sel('develop', { class: 'docs', touched: ['docs/a.md'] }))).toEqual(['W4', 'W19'])
    expect(rules(sel('review'))).toEqual(['V1', 'V6'])
    const guides = { text: `Review guides for the areas this change touches (2 of 3).\n\n${'# Review guide: the workflow engine\n'.repeat(40)}`, guides: [{ file: 'docs/review/workflow-engine.REVIEW.md', version: 2 }, { file: 'docs/review/docs.REVIEW.md', version: 1 }] }
    const review = sel('review')
    const slice = buildSlice(engineHandbook(RUN, PROMPT, { ...read(root, review), guides }, '1.2.3'), review)
    expect(slice.parts).toContain('L4.review-guides')
    const layer4 = slice.layers.find((l) => l.layer === 4)!
    expect(layer4.version).toBe(`playbook:t@1.2.3:${layer4.sha256};guides:workflow-engine@2,docs@1`)
    // Counted whole, rendered as one line: the brief's review-guides pointer carries the text.
    expect(slice.text).toContain('- The review guides of the areas this change touches (2) are part of your playbook')
    expect(slice.text).not.toContain('# Review guide: the workflow engine')
    expect(layer4.tokens).toBeGreaterThan(tokensOf(guides.text))
    const without = buildSlice(engineHandbook(RUN, PROMPT, read(root, review), '1.2.3'), review)
    expect(slice.tokens - without.tokens).toBeGreaterThanOrEqual(tokensOf(guides.text))
    // Never a writer's, a validator's, or a researcher's, whatever they are handed.
    for (const role of ['develop', 'validate', 'research'] as const) {
      const s = sel(role)
      expect(buildSlice(engineHandbook(RUN, PROMPT, { ...read(root, s), guides }, '1.2.3'), s).parts).not.toContain('L4.review-guides')
    }
  })

  it('versions layer 1 by the invariants\' blob and the highest accepted ADR, and layer 4 by its template, package version, and the sha256 of what it carries', () => {
    const root = homesRoot()
    const s = sel('develop', { class: 'code', tier: 'heavy', touched: ['packages/plugins/workflow/src/a.ts'] })
    const slice = buildSlice(engineHandbook(RUN, PROMPT, read(root, s), '1.2.3'), s)
    const blob = blobOf(readFileSync(join(root, 'docs/architecture/invariants.md')))
    expect(blob).toBe(createHash('sha1').update(`blob ${Buffer.byteLength(INVARIANTS)}\0${INVARIANTS}`).digest('hex'))
    expect(slice.layers.find((l) => l.layer === 1)!.version).toBe(`git:${blob};adr:0002`)
    const layer4 = slice.layers.find((l) => l.layer === 4)!
    expect(layer4.version).toBe(`playbook:t@1.2.3:${layer4.sha256}`)
    // A changed invariant moves layer 1's version.
    writeFileSync(join(root, 'docs/architecture/invariants.md'), `${INVARIANTS}\n### INV-3 Completion boundaries are distinct\n`)
    const again = buildSlice(engineHandbook(RUN, PROMPT, read(root, s), '1.2.3'), s)
    expect(again.layers.find((l) => l.layer === 1)!.version).not.toBe(`git:${blob};adr:0002`)
    expect(again.parts).toContain('INV-3')
    // Homes that cannot be read say so in the version, never silently.
    expect(buildSlice(engineHandbook(RUN, { prompt: 'x' }, read(join(root, 'nowhere'), s)), s).layers.find((l) => l.layer === 1)!.version).toMatch(/^unread: docs\/architecture\/invariants\.md: ENOENT/)
  })
})

// --- In the engine -----------------------------------------------------------------------------

const policy: AutonomyPolicy = {
  schema: 'autonomy-policy@1.1', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }, { actionClass: 'merge', mode: 'ask' }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
  riskTiers: { version: 1, rules: [{ tier: 'normal', note: 'the source', paths: ['src/'] }] },
}
const step = (prompt: string, kind?: string): NodeTemplate[] => [{ nodeId: 'develop', objective: 'Change it', prompt, capabilities: ['develop'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', ...(kind ? { kind } : {}) }]
const SMALL = 'Change it: {{input}}'
/** A playbook far over layer 4's share: with the source's half at its maximum, the slice passes the bound. */
const BIG = `Change it: {{input}}\n${'Follow this rule. '.repeat(600)}`

async function boot(handbook: { warnTasks?: number; enabled?: boolean }, touched?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-handbook-'))
  const root = homesRoot()
  const ctx = new Context()
  const workers = new ScriptedWorkers()
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => {
      c.workers.register(workers.source(c))
      // A source that holds the run's worktree and tells the paths its change touches.
      if (touched) {
        c.workers.register({
          name: 'holder', describe: async () => [],
          changes: async (runId: string) => [{ repository: '/repo', workspace: '/repo', branch: `system/run/${runId}`, base: { branch: 'dev', sha: 'b'.repeat(40) }, head: 'b'.repeat(40), files: touched.map((path) => ({ path, status: 'modified' as const, added: 1, removed: 1 })), more: 0, truncated: false }],
          start: () => {
            throw new Error('the holder runs no Worker')
          },
          get: () => undefined, wait: () => Promise.reject(new Error('the holder runs no Worker')),
        } as never)
      }
    } }),
    ctx.plugin(StoreApprovals, { policies: [policy], sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
  ]
  await Promise.all(fibers)
  const engine = ctx.plugin(Workflow, { ...CONFIG, handbook: { root, ...handbook }, templates: { ...TEMPLATES, small: step(SMALL), big: step(BIG), coded: step(SMALL, 'code') } })
  await engine
  onTestFinished(async () => {
    await engine.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  await activeProject(ctx)
  const run = async (template: string, title: string): Promise<string> => {
    const task = await readyTask(ctx, title)
    const { runId } = await ctx.workflow.start({ template, input: 'change it', classification: 'public', task: { taskId: task.taskId } })
    await vi.waitFor(() => expect(ctx.workflow.get(runId)!.status).not.toBe('running'), { timeout: 30_000, interval: 25 })
    return runId
  }
  return { ctx, workers, run }
}

type Decision = { decider: { id: string }; outcome: { option: string; detail: Record<string, unknown> } }
const boundDecisions = (ctx: Context, runId: string): Decision[] =>
  ctx.artifacts.list({ kind: 'decision', runId, limit: 1000 }).map((a) => a.body as Decision).filter((d) => d.decider.id === HANDBOOK_RULE)

describe('the slice in each step\'s brief (brief@1.6 handbook)', () => {
  it('records each layer\'s version and the slice\'s size in the brief, points at the engine\'s half, and shows them in explain', async () => {
    const { ctx, workers, run } = await boot({})
    const runId = await run('small', 'within')
    expect(ctx.workflow.get(runId)!.status).toBe('completed')
    const started = workers.started[0]!
    const brief = ctx.artifacts.get(started.brief! as ArtifactRef)!.body as { schema: string; handbook: BriefHandbook; artifacts: Array<{ ref: ArtifactRef; role: string }> }
    expect(brief.schema).toBe('brief@1.6')
    // No source holds the run's change, so its paths are unknown and its tier heavy (INV-2).
    expect(brief.handbook).toMatchObject({ bound: { tokens: HANDBOOK_BOUND, mode: 'warn' }, selection: { role: 'develop', tier: 'heavy', tierFrom: 'unknown', paths: 'unknown' } })
    const layers = brief.handbook.layers
    expect(layers.map((l) => [l.layer, l.renderedBy])).toEqual([[1, 'engine'], [2, 'engine'], [2, 'source'], [3, 'engine'], [4, 'engine'], [5, 'source']])
    // Layer 1: the invariants file's blob and the highest accepted ADR, read from handbook.root.
    expect(layers[0]!.version).toBe(`git:${createHash('sha1').update(`blob ${Buffer.byteLength(INVARIANTS)}\0${INVARIANTS}`).digest('hex')};adr:0002`)
    expect(layers[1]).toMatchObject({ parts: ['L2.tier.heavy'], version: expect.stringMatching(/^policy:studio@1:.+:map@studio@1$/) })
    expect(layers[2]).toMatchObject({ parts: ['L2.gate-view'], version: 'source', tokens: SOURCE_MAX.gateView, atMost: true })
    expect(layers[3]!.version).toMatch(/^charter:p1:\d+$/)
    // Layer 4: a configured template, the sha256 of the playbook text the slice carries.
    expect(layers[4]).toMatchObject({ version: `playbook:small@configured:${layers[4]!.sha256}` })
    expect(layers[5]).toMatchObject({ parts: ['L5.lessons'], version: 'source', tokens: SOURCE_MAX.lessons, atMost: true })
    expect(brief.handbook.tokens).toBe(layers.reduce((sum, l) => sum + l.tokens, 0))
    expect(brief.handbook.tokens).toBeLessThanOrEqual(HANDBOOK_BOUND)
    // The engine's half, a context pointer the Worker read; the playbook not repeated in it. The step
    // names no class and its paths are unknown, so every writing rule is in it (INV-2).
    const pointed = brief.artifacts.map((p) => ctx.artifacts.get(p.ref)!.body as { schema?: string; role?: string; text?: string }).find((b) => b.schema === 'handbook-slice@1.0')!
    expect(pointed).toMatchObject({
      role: 'develop', tier: 'heavy',
      parts: ['L1.pointer', 'INV-1', 'INV-2', 'L2.tier.heavy', 'L3.objective', 'L3.criteria', 'L3.constraints', 'L4.playbook', 'L4.rules', 'W2', 'W3', 'W4', 'W5', 'W18', 'Q1', 'T1', 'T4'],
    })
    expect(pointed.text).toContain('stop rule no-gain: Below 1.5x after two milestones (pivot)')
    expect(pointed.text).toContain('- INV-2 Fail closed (docs/architecture/invariants.md#inv-2-fail-closed)')
    expect(pointed.text).toContain('- T4 wait for the event, not the clock')
    expect(pointed.text).not.toContain('V1')
    expect(started.prompt).toContain('Handbook slice for this step: role develop, risk tier heavy')
    expect(started.prompt.split('Change it:').length).toBe(2)
    expect(boundDecisions(ctx, runId)).toEqual([])
    expect(ctx.workflow.explain(runId)!.nodes[0]!.handbook).toEqual(brief.handbook)
  })

  it('selects by the paths the change touches, read from the source that holds it, and records them for the Worker source', async () => {
    const { ctx, workers, run } = await boot({}, ['packages/plugins/workflow/src/handbook.ts'])
    const runId = await run('coded', 'touched')
    expect(ctx.workflow.get(runId)!.status).toBe('completed')
    const brief = ctx.artifacts.get(workers.started[0]!.brief! as ArtifactRef)!.body as { handbook: BriefHandbook; artifacts: Array<{ ref: ArtifactRef }> }
    // No rule of the map matches the path, so the change is heavy, by the map, on the subject's paths.
    expect(brief.handbook.selection).toEqual({ role: 'develop', class: 'code', tier: 'heavy', tierFrom: 'map', paths: 'subject', touched: ['packages/plugins/workflow/src/handbook.ts'] })
    const pointed = brief.artifacts.map((p) => ctx.artifacts.get(p.ref)!.body as { schema?: string; parts?: string[] }).find((b) => b.schema === 'handbook-slice@1.0')!
    expect(pointed.parts).toEqual(['L1.pointer', 'INV-1', 'INV-2', 'ADR-0002', 'L2.tier.heavy', 'L3.objective', 'L3.criteria', 'L3.constraints', 'L4.playbook', 'L4.rules', 'W2', 'W3', 'Q1'])
  })

  it('sends a slice over the bound whole with a warning for the first warnTasks board tasks, then refuses it before anything is routed (handbook_over_bound)', async () => {
    const { ctx, workers, run } = await boot({ warnTasks: 1 })
    // The first task: warn mode, sent whole, the warning naming the layer over its share, its size, and its owner.
    const first = await run('big', 'first')
    expect(ctx.workflow.get(first)!.status).toBe('completed')
    expect(workers.started).toHaveLength(1)
    const sent = (ctx.artifacts.get(workers.started[0]!.brief! as ArtifactRef)!.body as { handbook: BriefHandbook }).handbook
    expect(sent.bound.mode).toBe('warn')
    expect(sent.tokens).toBeGreaterThan(HANDBOOK_BOUND)
    const decided = boundDecisions(ctx, first)
    expect(decided).toHaveLength(2)
    const warned = decided.find((d) => d.outcome.option === 'warn')
    const moved = decided.find((d) => d.outcome.detail['move'] === 'refuse')
    expect(warned!.outcome).toMatchObject({ option: 'warn', detail: { tokens: sent.tokens, bound: HANDBOOK_BOUND, over: [{ layer: 4, share: 900, owner: 'lead' }] } })
    // That task was the warnTasks-th: the bound moves to refuse, a decision of its own.
    expect(moved!.outcome).toMatchObject({ option: 'refuse', detail: { move: 'refuse', tasks: 1 } })

    // The next task: refused, nothing sent, the step failed config_error naming the layer and its size.
    const second = await run('big', 'second')
    const view = ctx.workflow.get(second)!
    expect(view.status).toBe('failed')
    expect(workers.started).toHaveLength(1)
    expect(view.nodes[0]!.error).toMatchObject({ kind: 'config_error', message: expect.stringMatching(/handbook_over_bound.*layer 4 \(Role playbook, owner lead\) holds \d+ tokens of its 900/) })
    expect(boundDecisions(ctx, second).map((d) => d.outcome.option)).toEqual(['refuse'])

    // In refuse mode, a slice within the bound is sent.
    const third = await run('small', 'third')
    expect(ctx.workflow.get(third)!.status).toBe('completed')
    expect((ctx.artifacts.get(workers.started[1]!.brief! as ArtifactRef)!.body as { handbook: BriefHandbook }).handbook.bound.mode).toBe('refuse')
  })

  it('gives no slice when it is turned off: the brief is as before', async () => {
    const { ctx, workers, run } = await boot({ enabled: false })
    const runId = await run('big', 'off')
    expect(ctx.workflow.get(runId)!.status).toBe('completed')
    const brief = ctx.artifacts.get(workers.started[0]!.brief! as ArtifactRef)!.body as { schema: string; handbook?: unknown }
    expect(brief.schema).not.toBe('brief@1.6')
    expect(brief.handbook).toBeUndefined()
  })
})
