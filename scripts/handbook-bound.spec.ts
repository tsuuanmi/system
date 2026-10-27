// The handbook's bound on this repository's own rules (docs/design/handbook.md#the-6000-token-bound,
// T259): the slice the board's `algorithm-development` steps are given, built from the real homes,
// the real review guides, the real lessons file, the real templates, and the real path map, fits in
// 6,000 estimated tokens for a writer and for a review of a change in one area, in two, and with its
// paths unknown (every guide). The Worker source's lessons are counted at what they render to.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AutonomyPolicy, changeTier, riskTierMaps } from '../packages/approvals-core/src/index.ts'
import { ALGORITHM_DEVELOPMENT } from '../packages/plugins/profile-software-development/src/index.ts'
import { buildSlice, engineHandbook, HANDBOOK_BOUND, lessonsFor, type Read, readHomes, type Selection } from '../packages/plugins/workflow/src/handbook.ts'
import { guidesTouching, loadGuides, renderGuides } from '../packages/plugins/workflow/src/review-guides.ts'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const maps = riskTierMaps([JSON.parse(readFileSync(join(root, 'policies/system.json'), 'utf8')) as AutonomyPolicy])
/** A project's charter as the board holds one: an objective, criteria, a constraint, a stop rule. */
const CHARTER: NonNullable<Read['charter']> = {
  projectId: 'system',
  charter: {
    // The size of the live charter of project system (T321 measured it at about 470 tokens).
    version: 3, intent: 'Build `system` (tsuuanmi/system) toward the base release (PROP-0010 B1-B8), developed through System itself, and run as Base\'s pilot (D68, D69 A, 2026-10-25): the board\'s tasks run in System, one algorithm-development run per attempt, Claude Code writes every change, Codex validates and reviews, the lead proposes and starts, the operator approves the charter, answers the queue and merges dev into main. Five working days through at least one restart, measured against the Claude-alone baseline.',
    criteria: [{ id: 'base-release', statement: 'The base release (PROP-0010 B1-B8) is merged to main and reviewed by the operator' }, { id: 'accepted-work', statement: 'At least 25 tasks of the pilot end with an accepted result landed on dev' }, { id: 'tests-pass', statement: 'Every accepted result passes the policy\'s required checks (tests, lint) on its exact tree (ADR-0063)' }, { id: 'pilot-close', statement: 'The pilot ran five working days through at least one restart, and the board shows its progress without a transcript' }],
    constraints: { deadline: '2026-11-01T00:00:00Z', notes: ['Pilot days: 2026-10-26 to 2026-10-30 (Mon-Fri), plus 2026-10-25 as day 0. Restarts so far: the live updates of 2026-10-25.', 'Only work that runs in System is on this board (sysboard: unmirror, 2026-10-25); the coordination board keeps the rest.', 'Claude Code writes code, docs and tests; Codex validates and reviews (operator, 2026-10-25; base exit criterion 3 amended, D69 A).', 'The lead accepts and merges dev-branch results on the operator\'s permission (sysdev.mjs); main is the operator\'s.'] },
    stopRules: [{ id: 'operator-stops', condition: 'The operator stops or pauses the project', action: 'stop' }, { id: 'three-rejections', condition: 'A task\'s three attempts end without an accepted result twice in one working day', action: 'pause' }, { id: 'quota-spent', condition: 'Every Claude Code account\'s five-hour window is limited at once for a whole working day', action: 'pause' }],
  },
}

const AREAS = {
  'one area': ['packages/plugins/workflow/src/views.ts'],
  'two areas': ['packages/plugins/workflow/src/views.ts', 'packages/plugins/agent-workers/src/lessons.ts'],
  // The measured p99 shapes (T321): a heavy change (by the path map) in two areas, and paths unknown (heavy, every guide).
  'a heavy change in two areas': ['packages/plugins/workflow/src/handbook.ts', 'packages/approvals-core/src/index.ts', 'packages/plugins/board/src/index.ts'],
  'paths unknown': undefined,
} as const

/** The slice `nodeId` of algorithm-development is given for a change touching `touched` (undefined: unknown). */
function slice(nodeId: 'develop:1' | 'review:1', touched: readonly string[] | undefined) {
  const spec = ALGORITHM_DEVELOPMENT.find((n) => n.nodeId === nodeId)!
  const role = nodeId === 'develop:1' ? 'develop' : 'review'
  // The tier as the engine reads it: the map on the change's paths, heavy when they are unknown (INV-2).
  const tier = touched ? changeTier(maps, { paths: [...touched], unreadable: [] })?.tier ?? 'heavy' : 'heavy'
  const selection: Selection = { role, ...(role === 'develop' ? { class: 'code' } : {}), tier, tierFrom: touched ? 'map' : 'unknown', ...(touched ? { paths: 'subject', touched } : { paths: 'unknown' }) }
  const { guides, problems } = loadGuides(root)
  const picked = guidesTouching(guides, { paths: touched ?? [], unreadable: [] })
  const rendered = role === 'review' ? renderGuides(picked.selected, picked.left, picked.all, problems) : undefined
  const lessons = lessonsFor(root, selection)
  expect(lessons, 'the lessons file of this repository is read').toBeDefined()
  const read: Read = {
    selection, policy: 'policy:system.policy@2', homes: readHomes(root), charter: CHARTER, lessons: lessons!,
    ...(rendered ? { guides: { text: rendered.text, guides: rendered.body.guides } } : {}),
  }
  return buildSlice(engineHandbook({ template: 'algorithm-development' }, spec, read, '0.0.0'), selection)
}

describe('the handbook slice of this repository\'s own steps (T259)', () => {
  for (const [name, touched] of Object.entries(AREAS)) {
    it(`fits a writer and a review of a change in ${name} within the bound, the review's guides counted`, () => {
      for (const nodeId of ['develop:1', 'review:1'] as const) {
        const built = slice(nodeId, touched)
        expect(built.tokens, `${nodeId}, ${name}: ${built.layers.map((l) => `L${l.layer}${l.renderedBy === 'source' ? ' source' : ''} ${l.tokens}`).join(', ')}`).toBeLessThanOrEqual(HANDBOOK_BOUND)
        expect(built.sourceOver).toEqual([])
        if (nodeId === 'review:1') expect(built.parts).toContain('L4.review-guides')
        // Each layer within its share (T321), but one: a review with its paths unknown is given every
        // guide, so its layer 4 alone passes its share by design (recorded, never refused while the total holds).
        const everyGuide = nodeId === 'review:1' && touched === undefined
        expect(built.over.map((l) => l.layer), `${nodeId}, ${name}: layers over their shares`).toEqual(everyGuide ? [4] : [])
      }
    })
  }

  it('reads the heavy change in two areas as heavy, so its slice carries every invariant and the tier\'s heavy line', () => {
    const built = slice('review:1', AREAS['a heavy change in two areas'])
    expect(built.parts).toEqual(expect.arrayContaining(['INV-1', 'INV-15', 'L2.tier.heavy']))
  })
})
