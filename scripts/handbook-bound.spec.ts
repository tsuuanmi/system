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
    version: 3, intent: 'Build System: an operator-owned studio that runs work on the operator\'s own Workers, every decision recorded.',
    criteria: [{ id: 'c1', statement: 'Every change lands reviewed, with its checks passing on the exact tree' }, { id: 'c2', statement: 'No silent loss of work or of a rule' }],
    constraints: { egressPolicy: 'operator-shared', notes: ['the repository is public'] },
    stopRules: [{ id: 'quota', condition: 'the week\'s quota under its reserve', action: 'pause' }],
  },
}

const AREAS = {
  'one area': ['packages/plugins/workflow/src/views.ts'],
  'two areas': ['packages/plugins/workflow/src/views.ts', 'packages/plugins/agent-workers/src/lessons.ts'],
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
      }
    })
  }
})
