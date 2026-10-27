/**
 * The handbook slice (docs/design/handbook.md, ADR-0072; PROP-0016 I1 part 2): every step of a board
 * task's run is given the parts of System's rules that bear on its role, its task class, its risk
 * tier, and the paths it touches, never the whole, within a bound of 6,000 estimated tokens, with
 * each layer's version recorded in its brief (`brief@1.6` `handbook`), so a result traces to the
 * rules it was given (INV-13).
 *
 * - **The layers, declared here once** ({@link HANDBOOK_LAYERS}): each with its owner, its homes,
 *   how its version is read, its share of the bound, and which half renders it.
 * - **Two halves.** The engine renders layers 1 to 4 (the constitution, the tier's line, the
 *   project's charter, the role's playbook and rules) as a `handbook-slice@1.0` report its brief
 *   points at (role `context`), from the homes it reads under `handbook.root`. The Worker source
 *   renders the gate view (layer 2) and the lessons (layer 5), bounded in UTF-8 bytes by
 *   construction: the engine counts them at their constructed maximum, and the source records what
 *   it rendered ({@link HANDBOOK_SOURCE_EVENT}).
 * - **Selection** ({@link selectParts}): a part carries where it applies (roles, task classes, risk
 *   tiers, paths); a part with no key applies to every role. A class the step does not name leaves
 *   none of the role's parts out; unknown touched paths select every path-keyed part (INV-2). A
 *   review's guides (./review-guides.ts, T267) are a part of its playbook: selected there by the
 *   paths the change touches and carried by their own pointer, counted and versioned here.
 * - **The bound** ({@link HANDBOOK_BOUND}): measured as `ceil(UTF-8 bytes / 4)`, the estimate the MCP
 *   surface budget uses, no vendor's tokenizer (INV-11). A slice over it is sent whole with a
 *   `handbook.bound` decision while the bound is in warn mode, and refused (the step fails
 *   `config_error`, nothing routed or sent) once slices were built for `handbook.warnTasks` distinct
 *   board tasks; either way the decision names each layer over its share, its size, and its owner.
 *   Nothing is cut (INV-9: never silently).
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AutonomyPolicy, changeTier, type RiskTier, riskTierMaps } from '@tsuuanmi/system-approvals-core'
import type { Lease } from '@tsuuanmi/system-leases'
import { type BriefHandbook, BRIEF_LIMITS, type BriefPointer, type HandbookLayer, type HandbookRole, LESSONS_LIMITS, LESSONS_PATH, lessonsSectionOf, lessonsText, pathMatches, sha256 } from '@tsuuanmi/system-libs'
import { dispositionOf } from '@tsuuanmi/system-provider-core'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import type { Draft } from './briefs.ts'
import { landingTargets } from './checks.ts'
import { roleOf } from './dossiers.ts'
import type { Engine } from './engine.ts'
import { queueOf } from './queue.ts'
import { changePaths, riskOf } from './risk.ts'
import { DEFAULT_TEMPLATES, type ResolvedNode } from './spec.ts'
import { type NodeRecord, type NodeRow, now, type RunRow, type WorkflowError } from './types.ts'

/** The bound on a slice, both halves, in estimated tokens (D83 #3). */
export const HANDBOOK_BOUND = 6000
/** Distinct board tasks whose slice is built in warn mode, by default (`handbook.warnTasks`). */
export const DEFAULT_WARN_TASKS = 30
/** The rule that records a slice over the bound, and the bound's move to refuse. */
export const HANDBOOK_RULE = 'handbook.bound'

/** One layer of the handbook, declared once: who owns it, where its rules live, how its version is read, its share of the bound. */
export interface LayerDeclaration {
  layer: HandbookLayer
  name: string
  owner: string
  /** The files (or records) its rules live in. */
  homes: readonly string[]
  /** How the version a brief records is read. */
  version: string
  /** Its share of {@link HANDBOOK_BOUND}, in estimated tokens. */
  share: number
  /** Which half renders it: the engine's (in the slice), the Worker source's (in its prompt), or both. */
  renderedBy: ReadonlyArray<'engine' | 'source'>
}

/**
 * The five layers (docs/design/handbook.md#the-five-layers), each source declared here and nowhere
 * else. A higher layer wins over a lower one; a lower layer may only be stricter.
 */
export const HANDBOOK_LAYERS: readonly LayerDeclaration[] = [
  {
    layer: 1, name: 'Constitution', owner: 'operator', share: 600, renderedBy: ['engine'],
    homes: ['docs/architecture/invariants.md', 'docs/decisions/adr/README.md', 'docs/decisions/README.md#decision-rules', 'docs/governance/documentation.md'],
    version: 'git:<blob of docs/architecture/invariants.md under handbook.root>;adr:<the highest accepted ADR\'s number>',
  },
  {
    layer: 2, name: 'Organisation policy', owner: 'operator (the lead proposes)', share: 1100, renderedBy: ['engine', 'source'],
    homes: ['the studio and project autonomy policies (approvals)', 'policies/system.json', 'docs/operations/'],
    version: 'policy:<id>@<version>,…:<hash of the set in force>:map@<id>@<riskTiers.version>,…; the gate view: the policy it was rendered from, recorded by the source',
  },
  {
    layer: 3, name: 'Project charter', owner: 'operator, with the lead', share: 550, renderedBy: ['engine'],
    homes: ['the board\'s project record (project@1.x charter)'],
    version: 'charter:<projectId>:<charter.version>',
  },
  {
    layer: 4, name: 'Role playbook', owner: 'lead', share: 2300, renderedBy: ['engine'],
    homes: ['the templates\' prompts (profile plugins)', 'docs/design/handbook.md#layer-4-role-playbooks (each rule of AGENTS.md, CONTRIBUTING.md, and docs/engineering/ one line, with its home and check)', 'docs/operations/lead-playbook.md'],
    version: 'playbook:<template>@<its package\'s version>:<sha256 of the playbook text the slice carries>',
  },
  {
    layer: 5, name: 'Repository lessons', owner: 'lead and review', share: 1450, renderedBy: ['source'],
    homes: ['docs/engineering/lessons.md'],
    version: 'git:<blob of the lessons file at the Worker repository\'s HEAD>, recorded by the source',
  },
]

const LAYER = new Map(HANDBOOK_LAYERS.map((l) => [l.layer, l]))

/**
 * The source's half at its constructed maximum, in estimated tokens: agent-workers bounds its gate
 * view to `TOOLS_NOTE_MAX` (4,000) UTF-8 bytes and its lessons section to `LESSONS_LIMITS.sectionBytes`
 * (12,400), so neither passes these at `ceil(bytes / 4)`. The lessons are counted at what they
 * render to ({@link lessonsFor}); a part is counted at its maximum only when its size cannot be read
 * before the Worker is routed: the gate view always (it is rendered from the routed Worker's own
 * evidence and tools), the lessons when their repository cannot be read (INV-2).
 */
export const SOURCE_MAX = { gateView: 1000, lessons: LESSONS_LIMITS.sectionBytes / 4 } as const

export type SliceTier = RiskTier | 'off'

/** Where a part applies. Absent keys do not narrow; `classes` and `paths` together apply where either matches. */
export interface Applies {
  roles?: readonly HandbookRole[]
  classes?: readonly string[]
  tiers?: readonly SliceTier[]
  /** Repository paths: `dir/` a directory prefix; `**` then `/dir/` that directory anywhere; any other a file. */
  paths?: readonly string[]
}

/**
 * The writing and reviewing rules of layer 4 (docs/design/handbook.md#layer-4-role-playbooks), each
 * one line of the rule inventory there by its id, with where it applies
 * (docs/design/handbook.md#the-slice-of-each-role): a writer's rules by its class, a test rule for
 * `tests` and for a touched `tests/` path, a schema rule for a touched `schemas/` path, the author's
 * checks before review (W19) for every class; a reviewer's, its guides' rule (V6), and the second
 * review's for a heavy change. Their text is the inventory's, never written again here.
 */
export const PLAYBOOK_RULES: ReadonlyArray<{ id: string; applies: Applies }> = [
  ...(['W2', 'W6', 'W7', 'W9', 'W10', 'W11', 'W12', 'W14', 'W15', 'W16'] as const).map((id) => ({ id, applies: { roles: ['develop'], classes: ['code'] } as Applies })),
  { id: 'W3', applies: { roles: ['develop'], classes: ['code', 'tests'] } },
  { id: 'W4', applies: { roles: ['develop'], classes: ['docs'] } },
  { id: 'W5', applies: { roles: ['develop'], classes: ['tests'] } },
  ...(['W8', 'W13', 'W17'] as const).map((id) => ({ id, applies: { roles: ['develop'], classes: ['code', 'docs'] } as Applies })),
  { id: 'W18', applies: { roles: ['develop'], paths: ['schemas/'] } },
  // T267: the author's own checks before its review, for every writing class.
  { id: 'W19', applies: { roles: ['develop'] } },
  ...(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'] as const).map((id) => ({ id, applies: { roles: ['develop'], classes: ['code'] } as Applies })),
  ...(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'] as const).map((id) => ({ id, applies: { roles: ['develop'], classes: ['tests'], paths: ['**/tests/'] } as Applies })),
  ...(['V1', 'V2', 'V3', 'V4', 'V6'] as const).map((id) => ({ id, applies: { roles: ['review'] } as Applies })),
  { id: 'V5', applies: { roles: ['review'], tiers: ['heavy'] } },
]

/** One part of a layer: a rule or a group of rules, with its id and where it applies. */
export interface HandbookPart {
  id: string
  layer: HandbookLayer
  /** What it counts: the text the Worker reads. */
  text: string
  applies?: Applies
  /** The text reaches the Worker elsewhere in its brief (a role's playbook is its step's instructions): counted, and only this line is rendered. */
  elsewhere?: string
  /** Rendered by the Worker source, counted at `tokens`: what it renders to, or its maximum (`atMost`) when that cannot be read before the Worker is routed. */
  source?: { tokens: number; atMost?: true }
}

/**
 * A handbook as the slice is built from it: its parts and the version of each layer's engine half,
 * or how to read it from the sha256 (hex) of the text the slice carries of that layer.
 */
export interface HandbookSource {
  parts: readonly HandbookPart[]
  versions: Partial<Record<HandbookLayer, string | ((sha256: string) => string)>>
}

/** What selects a slice (docs/design/handbook.md#what-selects-a-part). */
export interface Selection {
  role: HandbookRole
  class?: string
  tier: SliceTier
  tierFrom: string
  paths: BriefHandbook['selection']['paths']
  /** The touched paths, when they could be read; undefined selects every path-keyed part. */
  touched?: readonly string[]
}

/** The tokens a text is estimated at: its UTF-8 bytes over four, rounded up. */
export const tokensOf = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 4)

/** Whether a part applies to a selection. */
export function appliesTo(part: HandbookPart, s: Selection): boolean {
  const a = part.applies
  if (!a) return true
  if (a.roles && !a.roles.includes(s.role)) return false
  // Tiering off: no tier's lines.
  if (a.tiers && !a.tiers.includes(s.tier)) return false
  // A class the step does not name, or paths that could not be read, leave none of the role's parts out (INV-2).
  const byClass = a.classes ? (s.class === undefined ? true : a.classes.includes(s.class)) : undefined
  const byPath = a.paths ? (s.touched === undefined ? true : s.touched.some((p) => a.paths!.some((pattern) => pathMatches(pattern, p)))) : undefined
  if (byClass === undefined || byPath === undefined) return byClass ?? byPath ?? true
  return byClass || byPath
}

/** The parts of `source` a selection is given, in the source's order. */
export function selectParts(source: HandbookSource, s: Selection): HandbookPart[] {
  return source.parts.filter((p) => appliesTo(p, s))
}

/** A built slice: the engine's text, what each layer carried and its size, and how it stands against the bound. */
export interface Slice {
  /** The engine's half as the Worker reads it; empty when no engine part was selected. */
  text: string
  /** The ids of the engine's parts, in order. */
  parts: string[]
  layers: BriefHandbook['layers']
  tokens: number
  /** The layers over their share: each with its size, share, and owner. */
  over: Array<{ layer: HandbookLayer; tokens: number; share: number; owner: string }>
  /** Whether the slice is over {@link HANDBOOK_BOUND}. */
  exceeds: boolean
  /** The layers whose Worker source's half alone passes the layer's share: refused in either mode, whatever the slice's size. */
  sourceOver: Array<{ layer: HandbookLayer; tokens: number; share: number; owner: string }>
}

/**
 * Build the slice of `source` a selection is given: the engine's parts rendered layer by layer under
 * their layer's heading (a part whose text the brief carries elsewhere by its line alone, still
 * counted), the source's parts counted at their maximum, each layer's version, parts, and size, and
 * the layers over their share. Deterministic for the same input.
 */
export function buildSlice(source: HandbookSource, s: Selection): Slice {
  const chosen = selectParts(source, s)
  const engine = chosen.filter((p) => !p.source)
  const header = `Handbook slice for this step: role ${s.role}${s.class ? `, class ${s.class}` : ''}, risk tier ${s.tier} (docs/design/handbook.md). A higher layer wins over a lower one; a lower layer may only be stricter.`
  const blocks: string[] = []
  const layers: BriefHandbook['layers'] = []
  for (const declared of HANDBOOK_LAYERS) {
    const own = engine.filter((p) => p.layer === declared.layer)
    if (own.length) {
      const block = [`## ${declared.layer}. ${declared.name} (owner: ${declared.owner})`, ...own.map((p) => p.elsewhere ?? p.text)].join('\n')
      // The header is counted with the first layer the slice holds.
      const shown = blocks.length ? block : `${header}\n\n${block}`
      blocks.push(block)
      // What it counts: what is rendered, and the text a part's line stands for.
      const counted = [shown, ...own.filter((p) => p.elsewhere !== undefined).map((p) => p.text)].join('\n')
      const hash = sha256(counted).slice('sha256:'.length)
      const version = source.versions[declared.layer]
      layers.push({ layer: declared.layer, version: (typeof version === 'function' ? version(hash) : version ?? 'unversioned').slice(0, 300), renderedBy: 'engine', parts: own.map((p) => p.id), tokens: tokensOf(counted), sha256: hash })
    }
    const sourced = chosen.filter((p) => p.source && p.layer === declared.layer)
    if (sourced.length) {
      // Counted at what it renders to, or at its maximum when that cannot be read yet; the source records the version and size of what it rendered.
      const atMost = sourced.some((p) => p.source!.atMost)
      layers.push({ layer: declared.layer, version: 'source', renderedBy: 'source', parts: sourced.map((p) => p.id), tokens: sourced.reduce((sum, p) => sum + p.source!.tokens, 0), ...(atMost ? { atMost: true as const } : {}) })
    }
  }
  const tokens = layers.reduce((sum, l) => sum + l.tokens, 0)
  const over = HANDBOOK_LAYERS.map((d) => ({ layer: d.layer, tokens: layers.filter((l) => l.layer === d.layer).reduce((sum, l) => sum + l.tokens, 0), share: d.share, owner: d.owner }))
    .filter((l) => l.tokens > l.share)
  const sourceOver = layers.filter((l) => l.renderedBy === 'source' && l.tokens > LAYER.get(l.layer)!.share)
    .map((l) => ({ layer: l.layer, tokens: l.tokens, share: LAYER.get(l.layer)!.share, owner: LAYER.get(l.layer)!.owner }))
  return { text: blocks.length ? `${header}\n\n${blocks.join('\n\n')}` : '', parts: engine.map((p) => p.id), layers, tokens, over, exceeds: tokens > HANDBOOK_BOUND, sourceOver }
}

/**
 * The role a step plays: validate by its capabilities, else its role in its task's work as the
 * dossier and the review guides read it (./dossiers.ts `roleOf`): review (a heavy change's second
 * review too), develop (a writing step), else research.
 */
export function roleFor(spec: ResolvedNode, node: Pick<NodeRow, 'subject'>): HandbookRole {
  if (spec.capabilities.includes('validate')) return 'validate'
  const role = roleOf(spec, node)
  if (role === 'review' || spec.secondReview) return 'review'
  return role === 'author' ? 'develop' : 'research'
}

// --- The handbook's homes, read from the System repository ---------------------------------------

/** Where the engine reads the homes of layers 1 and 4 under `handbook.root`. */
const HOME = { invariants: 'docs/architecture/invariants.md', adrIndex: 'docs/decisions/adr/README.md', adrs: 'docs/decisions/adr', inventory: 'docs/design/handbook.md' } as const
/** ADRs a heavy change's slice names by the packages it touches, at most (INV-9); the rest are counted. */
const MAX_ADRS = 12
/** Touched paths a brief carries at most for its Worker source; past it the paths are unknown to both halves. */
export const MAX_TOUCHED = 200

/** What the engine read of the handbook's homes in the System repository (`handbook.root`). */
export interface Homes {
  /** The invariants' file as checked out: its git blob id, and each invariant's id, title, and anchor. */
  invariants?: { blob: string; titles: Array<{ id: string; title: string; anchor: string }> }
  /** The ADRs of the index, by number, with their title, file, and whether accepted. */
  adrs?: Array<{ number: string; title: string; file: string; accepted: boolean }>
  /** The rule inventory's layer-4 lines by id, and its file's blob. */
  inventory?: { blob: string; rules: Map<string, string> }
  /** The root read, and what of it could not be read (recorded in the versions, never left out silently). */
  root?: string
  problems: string[]
  /** The text of an ADR, by its file (read on demand, for a heavy change's touched packages). */
  adrText?: (file: string) => string | undefined
}

/** The git blob id of a file's bytes, as `git hash-object` gives it: the version of a home as checked out. */
export function blobOf(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

/** A heading's anchor as the docs' links write it (lower case; spaces to `-`; other punctuation dropped). */
const anchorOf = (heading: string): string => heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-')

/** The System repository this package sits in, when it holds the handbook's homes (a source checkout); undefined in an install without them. */
function defaultRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, HOME.inventory))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return undefined
}

/**
 * Read the homes of layers 1 and 4 under `root` (`handbook.root`, by default the System repository
 * this package sits in): the invariants' titles and blob, the ADR index, and the layer-4 rule
 * inventory. What cannot be read is named in `problems`, and its version says `unread` (INV-2).
 */
export function readHomes(root: string | undefined): Homes {
  if (!root) return { problems: ['no handbook.root is configured, and this package sits in no repository holding the handbook'] }
  const problems: string[] = []
  const read = (path: string): Buffer | undefined => {
    try {
      return readFileSync(join(root, path))
    } catch (error) {
      problems.push(`${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`)
      return undefined
    }
  }
  const homes: Homes = { root, problems }
  const invariants = read(HOME.invariants)
  if (invariants) {
    const titles = [...invariants.toString('utf8').matchAll(/^#{2,4} (INV-\d+) (.+)$/gm)].map((m) => ({ id: m[1]!, title: m[2]!.trim(), anchor: anchorOf(`${m[1]} ${m[2]!.trim()}`) }))
    homes.invariants = { blob: blobOf(invariants), titles }
  }
  const index = read(HOME.adrIndex)
  if (index) {
    homes.adrs = [...index.toString('utf8').matchAll(/^\| \[(\d{4})\]\(([^)]+\.md)\) \| (.+?) \| (.+?) \|$/gm)]
      .map((m) => ({ number: m[1]!, file: m[2]!, title: m[3]!.trim(), accepted: m[4]!.trim().startsWith('Accepted') }))
  }
  const inventory = read(HOME.inventory)
  if (inventory) {
    const rules = new Map<string, string>()
    for (const m of inventory.toString('utf8').matchAll(/^\| ((?:W|Q|T|V)\d+) \| (.+?) \| /gm)) if (!rules.has(m[1]!)) rules.set(m[1]!, m[2]!.trim())
    homes.inventory = { blob: blobOf(inventory), rules }
  }
  homes.adrText = (file) => {
    if (!/^[0-9A-Za-z._-]+\.md$/.test(file)) return undefined
    try {
      return readFileSync(join(root, HOME.adrs, file), 'utf8')
    } catch {
      return undefined
    }
  }
  return homes
}

/** The package directory a repository path is in (`packages/<name>` or `packages/plugins/<name>`), if any. */
function packageOf(path: string): string | undefined {
  return /^(packages\/plugins\/[^/]+|packages\/[^/]+)\//.exec(path)?.[1]
}

// --- The engine's half, from what the engine holds ----------------------------------------------

const TIER_LINES: Record<RiskTier, string> = {
  light: '- This change is light by the policy\'s path map (ADR-0071): one review; a step the template marks riskSkip (validation) is skipped once every check the policy requires passed on its exact tree.',
  normal: '- This change is normal by the policy\'s path map (ADR-0071): one review, then the steps after it and the checks the policy requires.',
  heavy: '- This change is heavy by the policy\'s path map (ADR-0071), or its paths could not be read: after an approving review, a second review by another provider family, and the operator accepts the result; it is never accepted automatically.',
}

const POINTER = '- System\'s constitution binds every change: its invariants (docs/architecture/invariants.md in the System repository, each at the anchor `#inv-<n>-<title in lower case, spaces as hyphens>`) and its accepted ADRs (docs/decisions/adr/README.md, each a file of that directory); the decision rules are docs/decisions/README.md#decision-rules. Read the ones a change bears on.'

/** What the engine read for a step's slice: its selection, the policy's version, the project's charter, and the handbook's homes. */
export interface Read {
  selection: Selection
  policy: string
  charter?: { projectId: string; charter: { version: number; intent: string; criteria: Array<{ id: string; statement: string }>; constraints: { deadline?: string; egressPolicy?: string; notes?: string[] }; stopRules: Array<{ id: string; condition: string; action: string }> } }
  homes: Homes
  /** A review's guides as its brief's pointer carries them (`review-guides@1.0`, ./review-guides.ts): their text, and each guide's file and version. */
  guides?: { text: string; guides: ReadonlyArray<{ file: string; version: number }> }
  /** The lessons the Worker source will render for the selection, measured ({@link lessonsFor}); absent: unknown, counted at their maximum. */
  lessons?: { tokens: number; lessons: number }
}

/** The policy's version as a layer-2 version: each policy's id and version, the set's hash, and each map's version. */
function policyVersion(policies: readonly AutonomyPolicy[], set: string | undefined): string {
  const maps = policies.filter((p) => p.riskTiers).map((p) => `${p.id}@${p.riskTiers!.version}`)
  return `policy:${policies.map((p) => `${p.id}@${p.version}`).join(',') || 'none'}:${set ?? 'unhashed'}${maps.length ? `:map@${maps.join(',')}` : ''}`.slice(0, 300)
}

/**
 * Read what a step's slice is selected by: its role and class; its risk tier, from the run's latest
 * `workflow.risk-tier` decision, else the policy's map on the change's paths (`map`), heavy when they
 * cannot be read (`unknown`), `off` with no map; the touched paths, when tiering is on and the change
 * can be read (with tiering off they are unknown: every path-keyed part). And the homes it reads.
 */
async function readFor(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, projectId: string): Promise<Read> {
  const role = roleFor(spec, node)
  const base = { role, ...(spec.kind !== undefined ? { class: spec.kind } : {}) }
  let policies: AutonomyPolicy[] | undefined
  let set: string | undefined
  let policy = 'policy:none: no approval queue'
  const approvals = queueOf(e)
  if (approvals) {
    try {
      const read = await approvals.policy(projectId)
      policies = read.policies
      set = read.set?.hash
      policy = policyVersion(policies, set)
    } catch (error) {
      policy = `policy:unread: ${(error as Error).message}`.slice(0, 300)
    }
  }
  let charter: Read['charter']
  try {
    const project = await e.board?.project(projectId)
    if (project) charter = { projectId, charter: project.charter }
  } catch {
    charter = undefined
  }
  const of = { policy, homes: readHomes(e.config.handbook?.root ?? defaultRoot()), ...(charter ? { charter } : {}) }
  const maps = policies ? riskTierMaps(policies) : []
  // The policy unread: the tier cannot be read, so it is heavy (INV-2).
  if (!policies && approvals) return { selection: { ...base, tier: 'heavy', tierFrom: 'unknown', paths: 'unknown' }, ...of }
  if (!maps.length) return { selection: { ...base, tier: 'off', tierFrom: 'off', paths: 'unknown' }, ...of }
  // The change's paths, as its tier reads them: unknown when they cannot be read, or are too many to carry.
  const change = await changePaths(e, run.run_id)
  const readable = !change.unreadable.length && change.paths.length > 0 && change.paths.length <= MAX_TOUCHED
  const touched = readable ? { paths: 'subject' as const, touched: [...new Set(change.paths)] } : { paths: 'unknown' as const }
  const decided = riskOf(e, run.run_id)
  const selection: Selection = decided
    ? { ...base, tier: decided.tier, tierFrom: decided.decision, ...touched }
    : { ...base, tier: (readable ? changeTier(maps, change)?.tier : undefined) ?? 'heavy', tierFrom: readable ? 'map' : 'unknown', ...touched }
  return { selection, ...of }
}

/** This package's version: a built-in template's playbook version. */
const WORKFLOW_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** The version of the package a run's template came from: a contributed one's (`Workflow.template`), the engine's own for a built-in one, `configured` for one from configuration. */
function templateVersion(e: Engine, template: string): string {
  return e.templateVersions.get(template) ?? (Object.hasOwn(DEFAULT_TEMPLATES, template) && e.templates[template] === DEFAULT_TEMPLATES[template] ? `workflow-${WORKFLOW_VERSION}` : 'configured')
}

/**
 * The engine's handbook for one step, from the homes it read:
 * - layer 1: the pointer for every role; for a heavy change, each invariant's title with its
 *   anchor, and the accepted ADRs that name a package the change touches (at most
 *   {@link MAX_ADRS}, the rest counted; with the paths unknown, the pointer's ADR index stands for them);
 * - layer 2: the tier's line;
 * - layer 3: the charter's objective, criteria, and constraints;
 * - layer 4: the role's playbook, its template's text (counted, never repeated: it is the step's
 *   instructions), a review's guides (counted, never repeated: the brief points at them), and the
 *   inventory's rules for the role ({@link PLAYBOOK_RULES}), one line each;
 * - the source's half: the lessons at what they render to when they could be read
 *   ({@link Read}`.lessons`), else at their maximum; the gate view at its maximum.
 * Versions: layer 1 the invariants' blob and the highest accepted ADR, layer 4 the template, its
 * package's version, and the sha256 of the playbook text carried, with each review guide's area and
 * version.
 */
export function engineHandbook(run: Pick<RunRow, 'template'>, spec: Pick<ResolvedNode, 'prompt'>, read: Read, version = 'unversioned'): HandbookSource {
  const { homes, selection } = read
  const parts: HandbookPart[] = [{ id: 'L1.pointer', layer: 1, text: POINTER }]
  for (const inv of homes.invariants?.titles ?? []) parts.push({ id: inv.id, layer: 1, text: `- ${inv.id} ${inv.title}`, applies: { tiers: ['heavy'] } })
  // A heavy change's ADRs, by the packages it touches; none to name while its paths are unknown.
  const packages = [...new Set((selection.touched ?? []).map(packageOf).filter((p): p is string => !!p))]
  if (selection.tier === 'heavy' && packages.length && homes.adrs && homes.adrText) {
    const named = homes.adrs.filter((a) => a.accepted).reverse().filter((a) => {
      const text = homes.adrText!(a.file)
      return !!text && packages.some((p) => text.includes(p))
    })
    for (const adr of named.slice(0, MAX_ADRS)) parts.push({ id: `ADR-${adr.number}`, layer: 1, text: `- ADR-${adr.number} ${adr.title} (${adr.file})`, applies: { tiers: ['heavy'] } })
    if (named.length > MAX_ADRS) parts.push({ id: 'ADR-more', layer: 1, text: `- and ${named.length - MAX_ADRS} more accepted ADRs name these packages (docs/decisions/adr/README.md)`, applies: { tiers: ['heavy'] } })
  }
  for (const tier of ['light', 'normal', 'heavy'] as const) parts.push({ id: `L2.tier.${tier}`, layer: 2, text: TIER_LINES[tier], applies: { tiers: [tier] } })
  parts.push({ id: 'L2.gate-view', layer: 2, text: '', source: { tokens: SOURCE_MAX.gateView, atMost: true } })
  let charterVersion: string
  if (read.charter) {
    const c = read.charter.charter
    charterVersion = `charter:${read.charter.projectId}:${c.version}`
    parts.push({ id: 'L3.objective', layer: 3, text: `- Objective (project ${read.charter.projectId}): ${c.intent}` })
    if (c.criteria.length) parts.push({ id: 'L3.criteria', layer: 3, text: `- Criteria: ${c.criteria.map((k) => `${k.id}: ${k.statement}`).join('; ')}`, applies: { roles: ['develop', 'review', 'validate'] } })
    const constraints = [
      ...(c.constraints.deadline ? [`deadline ${c.constraints.deadline}`] : []), ...(c.constraints.egressPolicy ? [`egress policy ${c.constraints.egressPolicy}`] : []),
      ...(c.constraints.notes ?? []), ...c.stopRules.map((r) => `stop rule ${r.id}: ${r.condition} (${r.action})`),
    ]
    if (constraints.length) parts.push({ id: 'L3.constraints', layer: 3, text: `- Constraints: ${constraints.join('; ')}`, applies: { roles: ['develop', 'review'] } })
  } else {
    charterVersion = 'charter:unread'
    parts.push({ id: 'L3.unread', layer: 3, text: '- The project\'s charter could not be read now: read it on the board before a change it may bear on.' })
  }
  // A role's playbook is its template's text, which the step's instructions already carry: counted, never repeated.
  const role = selection.role
  if (spec.prompt) {
    parts.push({
      id: 'L4.playbook', layer: 4, text: spec.prompt, applies: { roles: [role] },
      elsewhere: `- Your role's playbook (${role}) is this step's instructions, as template ${run.template} words them; it is not repeated here.`,
    })
  }
  // A review's guides, the reviewer's playbook for the areas its change touches: their own pointer carries them.
  if (read.guides) {
    parts.push({
      id: 'L4.review-guides', layer: 4, text: read.guides.text, applies: { roles: ['review'] },
      elsewhere: `- The review guides of the areas this change touches (${read.guides.guides.length}) are part of your playbook: this brief points at them; they are not repeated here.`,
    })
  }
  // The inventory's rules of the role, one line each, keyed by class, tier, and path; the inventory names each one's home and check.
  const rules = homes.inventory?.rules
  if (rules) {
    const keyed = PLAYBOOK_RULES.filter((r) => rules.has(r.id))
    const roles = [...new Set(keyed.flatMap((r) => r.applies.roles ?? []))]
    if (keyed.length) parts.push({ id: 'L4.rules', layer: 4, text: `- Your role's rules, each one line; its home and its check: ${HOME.inventory}#layer-4-role-playbooks`, applies: { roles } })
    for (const rule of keyed) parts.push({ id: rule.id, layer: 4, text: `- ${rule.id} ${rules.get(rule.id)}`, applies: rule.applies })
  }
  parts.push({ id: 'L5.lessons', layer: 5, text: '', source: read.lessons ? { tokens: read.lessons.tokens } : { tokens: SOURCE_MAX.lessons, atMost: true } })
  const unread = (what: string): string => `unread: ${homes.problems.find((p) => p.startsWith(what)) ?? homes.problems[0] ?? 'not read'}`
  return {
    parts,
    versions: {
      1: homes.invariants ? `git:${homes.invariants.blob};adr:${homes.adrs?.filter((a) => a.accepted).map((a) => a.number).sort().at(-1) ?? 'unread'}` : unread(HOME.invariants),
      2: read.policy,
      3: charterVersion,
      4: (hash: string) => `playbook:${run.template}@${version}:${hash}${guideVersions(read.guides)}${homes.inventory ? '' : `;rules ${unread(HOME.inventory)}`}`,
    },
  }
}

/**
 * The lessons the Worker source will render for a selection, measured as it renders them (libs
 * `lessonsSectionOf`, the one implementation): the lessons file of the repository the run's worktree
 * was cut from (as its review guides are read, never the worktree under change), within its read
 * bound, the lessons that apply to the selection's role and touched paths. None (0 tokens) when the
 * repository has no lessons file; undefined, so counted at the maximum, when there is no such
 * repository or it cannot be read (INV-2).
 */
export function lessonsFor(repository: string | undefined, selection: Pick<Selection, 'role' | 'touched'>): Read['lessons'] {
  if (!repository) return undefined
  let fd: number | undefined
  try {
    if (!statSync(repository).isDirectory()) return undefined
    const path = join(repository, LESSONS_PATH)
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { tokens: 0, lessons: 0 } : undefined
    }
    if (!fstatSync(fd).isFile()) return undefined
    // Characters at most `fileChars`, so at most four bytes each.
    const buffer = Buffer.alloc(LESSONS_LIMITS.fileChars * 4)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    const all = buffer.subarray(0, length).toString('utf8')
    const cut = all.length > LESSONS_LIMITS.fileChars || length === buffer.length
    const built = lessonsSectionOf(lessonsText(all.slice(0, LESSONS_LIMITS.fileChars), cut), { role: selection.role, ...(selection.touched ? { touched: selection.touched } : {}) })
    return built ? { tokens: tokensOf(built.section), lessons: built.shown } : { tokens: 0, lessons: 0 }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** A review's guides in layer 4's version: each guide's area (its file's name) and version; their text is in the layer's sha256. */
function guideVersions(guides: Read['guides']): string {
  if (!guides) return ''
  return `;guides:${guides.guides.map((g) => `${g.file.replace(/^.*\//, '').replace(/\.REVIEW\.md$/, '')}@${g.version}`).join(',') || 'none'}`
}

/** A review's guides as its brief's pointer carries them (`review-guides@1.0`, ./briefs.ts `guidesFor`), or undefined. */
function guidesOf(e: Engine, pointer: BriefPointer | undefined): Read['guides'] {
  const body = pointer ? e.ctx.artifacts.get(pointer.ref)?.body as { schema?: unknown; text?: unknown; guides?: unknown } | undefined : undefined
  if (body?.schema !== 'review-guides@1.0' || typeof body.text !== 'string' || !Array.isArray(body.guides)) return undefined
  return { text: body.text, guides: (body.guides as Array<{ file: string; version: number }>).map((g) => ({ file: g.file, version: g.version })) }
}

/** A step's slice, built: what selected it, the slice, and the bound's mode for it. */
export interface Built {
  selection: Selection
  slice: Slice
  mode: 'warn' | 'refuse'
  projectId: string
  taskId: string
}

/**
 * The slice a step of a board task's run is given, or undefined for a run that serves no task or
 * with the slice turned off (`handbook.enabled: false`). A review's `guides`, the pointer its brief
 * already carries (./briefs.ts `guidesFor`), are counted in its layer 4. Records the task among those a slice was
 * built for, which moves the bound to refuse once there are `handbook.warnTasks` of them (that move
 * a decision of its own).
 */
export async function buildHandbook(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, guides?: BriefPointer): Promise<Built | undefined> {
  if (e.config.handbook?.enabled === false) return undefined
  const frame = e.tasks.frame(run.run_id)
  if (!frame) return undefined
  const carried = guidesOf(e, guides)
  const base = await readFor(e, run, node, spec, frame.projectId)
  const lessons = lessonsFor((await landingTargets(e, run.run_id))[0]?.repository, base.selection)
  const read: Read = { ...base, ...(carried ? { guides: carried } : {}), ...(lessons ? { lessons } : {}) }
  const slice = buildSlice(engineHandbook(run, spec, read, templateVersion(e, run.template)), read.selection)
  const mode = boundMode(e, run, node, frame.taskId)
  return { selection: read.selection, slice, mode, projectId: frame.projectId, taskId: frame.taskId }
}

/**
 * The bound's mode for a step of `taskId`: warn while slices were built for fewer than
 * `handbook.warnTasks` distinct board tasks before this one, refuse after. The task is recorded the
 * first time; the record that reaches `warnTasks` decides the move to refuse.
 */
function boundMode(e: Engine, run: RunRow, node: NodeRow, taskId: string): 'warn' | 'refuse' {
  const warnTasks = e.config.handbook?.warnTasks ?? DEFAULT_WARN_TASKS
  return e.ctx.store.transaction((db) => {
    const before = Number((db.prepare('SELECT COUNT(*) AS n FROM workflow_handbook_tasks').get() as { n: number }).n)
    const known = !!db.prepare('SELECT 1 FROM workflow_handbook_tasks WHERE task_id = ?').get(taskId)
    const mode = before >= warnTasks ? 'refuse' : 'warn'
    if (!known) {
      db.prepare('INSERT INTO workflow_handbook_tasks (task_id, created_at) VALUES (?, ?)').run(taskId, now())
      if (warnTasks > 0 && before + 1 === warnTasks) {
        e.ctx.artifacts.recordDecision({
          decisionType: 'gate',
          question: 'Does the handbook\'s bound move from warn to refuse?',
          inputs: [],
          candidates: [
            { option: 'refuse', selected: true, reasons: [`the slice has now been built for ${warnTasks} distinct board tasks (handbook.warnTasks): from the next step on, a slice over ${HANDBOOK_BOUND} tokens is refused`] },
            { option: 'warn', selected: false, reasons: ['not warn: the warn period is the first handbook.warnTasks tasks (D83 #3)'] },
          ],
          decider: { type: 'rule', id: HANDBOOK_RULE, version: '1' },
          outcome: { option: 'refuse', detail: { move: 'refuse', tasks: warnTasks, taskId } },
          deterministic: true,
        }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id })
      }
    }
    return mode
  })
}

/** The words of the layers over their share. */
const overWords = (slice: Slice): string => slice.over.map((l) => `layer ${l.layer} (${LAYER.get(l.layer)!.name}, owner ${l.owner}) holds ${l.tokens} tokens of its ${l.share}`).join('; ')

/**
 * Record a slice over the bound (`handbook.bound`, under the step): warn (sent whole) or refuse,
 * naming each layer over its share, its size, and its owner. Undefined for a slice within the bound.
 */
function recordOver(e: Engine, run: RunRow, node: NodeRow, built: Built): ArtifactRef | undefined {
  const { slice, mode } = built
  if (!slice.exceeds) return undefined
  const why = `the slice holds ${slice.tokens} estimated tokens, over the bound of ${HANDBOOK_BOUND}: ${overWords(slice)}`
  return e.ctx.artifacts.recordDecision({
    decisionType: 'gate',
    question: `Is the handbook slice of node ${node.node_id} of run ${run.run_id} within its bound?`,
    inputs: [],
    candidates: [
      { option: 'warn', selected: mode === 'warn', reasons: mode === 'warn' ? [why, 'sent whole: the bound is in warn mode (handbook.warnTasks), and nothing is cut (INV-9)'] : ['not warn: the warn period is over'] },
      { option: 'refuse', selected: mode === 'refuse', reasons: mode === 'refuse' ? [why, 'not sent: the bound refuses a slice over it; the owner of a named layer shortens it, then continue the run'] : ['not refuse: the bound is in warn mode'] },
    ],
    decider: { type: 'rule', id: HANDBOOK_RULE, version: '1' },
    outcome: { option: mode, detail: { tokens: slice.tokens, bound: HANDBOOK_BOUND, mode, over: slice.over, layers: slice.layers.map(({ layer, renderedBy, tokens }) => ({ layer, renderedBy, tokens })) } },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
}

/**
 * Apply a built slice to a step's draft: within the bound, or over it in warn mode (recorded), the
 * brief points at the engine's half (`handbook-slice@1.0`, role `context`) and records the slice
 * (`brief@1.6` `handbook`); over it in refuse mode, with a Worker source's half over its layer's
 * share (in either mode), or with no room left for its pointer, the step
 * fails `config_error` before it is routed, with a `handbook.bound` decision first (INV-13), and
 * `refused` is returned.
 */
export function applyHandbook(e: Engine, run: RunRow, node: NodeRow, draft: Draft, built: Built, lease: () => Lease): Draft | 'refused' {
  const { slice, mode, selection } = built
  // The Worker source's half is counted at what it renders to; a half that grows past its layer's
  // share is refused in either mode, so the warn period never sends a source part over its share.
  if (slice.sourceOver.length) {
    const words = slice.sourceOver.map((l) => `layer ${l.layer} (${LAYER.get(l.layer)!.name}, owner ${l.owner}) renders ${l.tokens} tokens by its Worker source, over its share of ${l.share}`).join('; ')
    const decided = e.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `Is the handbook slice of node ${node.node_id} of run ${run.run_id} within its bound?`,
      inputs: [],
      candidates: [
        { option: 'refuse', selected: true, reasons: [`${words}: a source's half over its share is refused in either mode`] },
        { option: 'warn', selected: false, reasons: ['not warn: the warn period covers the slice\'s size, never a source\'s half over its share'] },
      ],
      decider: { type: 'rule', id: HANDBOOK_RULE, version: '1' },
      outcome: { option: 'refuse', detail: { tokens: slice.tokens, bound: HANDBOOK_BOUND, mode, sourceOver: slice.sourceOver } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
    refuse(e, run, node, decided, `node ${node.node_id}'s handbook slice is refused (handbook_over_bound): ${words}; nothing was sent: the owner of the layer shortens it, then continue the run`, lease)
    return 'refused'
  }
  const decision = recordOver(e, run, node, built)
  if (slice.exceeds && mode === 'refuse') {
    refuse(e, run, node, decision!, `node ${node.node_id}'s handbook slice holds ${slice.tokens} estimated tokens, over the bound of ${HANDBOOK_BOUND} (handbook_over_bound): ${overWords(slice)}; nothing was sent: the owner of a named layer shortens it, then continue the run`, lease)
    return 'refused'
  }
  if (slice.text && draft.artifacts.length >= BRIEF_LIMITS.pointers) {
    const full = e.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `Is the handbook slice of node ${node.node_id} of run ${run.run_id} within its bound?`,
      inputs: [],
      candidates: [{ option: 'refuse', selected: true, reasons: [`the brief already points at ${BRIEF_LIMITS.pointers} artifacts, its bound, so its handbook slice has no place; nothing is left out silently (INV-2)`] }],
      decider: { type: 'rule', id: HANDBOOK_RULE, version: '1' },
      outcome: { option: 'refuse', detail: { tokens: slice.tokens, bound: HANDBOOK_BOUND, mode, pointers: BRIEF_LIMITS.pointers } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
    refuse(e, run, node, full, `node ${node.node_id}'s brief points at ${BRIEF_LIMITS.pointers} artifacts, so its handbook slice has no place; nothing was sent`, lease)
    return 'refused'
  }
  const handbook: BriefHandbook = {
    bound: { tokens: HANDBOOK_BOUND, mode }, tokens: slice.tokens,
    selection: {
      role: selection.role, ...(selection.class !== undefined ? { class: selection.class.slice(0, 64) } : {}), tier: selection.tier, tierFrom: selection.tierFrom, paths: selection.paths,
      ...(selection.touched ? { touched: [...selection.touched] } : {}),
    },
    layers: slice.layers,
  }
  if (!slice.text) return { ...draft, schema: 'brief@1.6', handbook }
  const ref = e.ctx.artifacts.put({
    kind: 'report', bodySchema: 'handbook-slice@1.0',
    body: { schema: 'handbook-slice@1.0', projectId: built.projectId, taskId: built.taskId, role: selection.role, ...(selection.class !== undefined ? { class: selection.class.slice(0, 64) } : {}), tier: selection.tier, parts: slice.parts, text: slice.text },
    inputs: [], classification: run.classification ?? e.ctx.egress.defaultClassification, producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id,
  }).id as ArtifactRef
  return {
    ...draft, schema: 'brief@1.6', handbook,
    artifacts: [...draft.artifacts, { ref, role: 'context', note: `your handbook slice: the rules of layers 1 to 4 that bear on your role (${selection.role}), class, and risk tier (${selection.tier}); follow them` }],
  }
}

/**
 * File a board task for a refused slice (T321, in place of T320's lead notice): the layers' owners
 * shorten what the layers carry, and the lead sees it in the project's tasks. One open task per set
 * of layers, so a refusal that repeats (a free retry) files nothing again. Best effort: a board that
 * cannot take it is logged, never a second failure of a step that is already refused.
 */
export async function fileRefusal(e: Engine, built: Built, node: Pick<NodeRow, 'node_id'>): Promise<void> {
  const { slice } = built
  const named = [...slice.over, ...slice.sourceOver].map((l) => l.layer)
  const layers = [...new Set(named)].sort()
  const words = [...slice.over, ...slice.sourceOver].map((l) => `layer ${l.layer} (${LAYER.get(l.layer)!.name}, owner ${l.owner}) holds ${l.tokens} tokens of its ${l.share}`)
  const title = `Handbook slice refused: ${layers.length ? `layer ${layers.join(', ')} over ${layers.length === 1 ? 'its share' : 'their shares'}` : 'no room in the brief'}`.slice(0, 200)
  try {
    if (!e.board) return
    const open = await e.board.tasks({ projectId: built.projectId, states: ['proposed', 'ready', 'claimed', 'running', 'review', 'waiting-for-input', 'waiting-for-approval'] })
    if (open.some((t) => t.title === title)) return
    await e.board.propose({
      projectId: built.projectId, title, actionClass: 'workspace-write',
      goal: `Task ${built.taskId}'s step ${node.node_id} was refused at its start (handbook_over_bound): the slice holds ${slice.tokens} estimated tokens, the bound is ${HANDBOOK_BOUND}${words.length ? `; ${words.join('; ')}` : ''}. The attempt was not spent. Shorten what the named layers carry or move their shares (docs/design/handbook.md#the-6000-token-bound).`.slice(0, 2000),
      acceptance: [{ id: 'fits', statement: `A slice of the same shape is within ${HANDBOOK_BOUND} tokens and every layer within its share` }],
    })
  } catch (error) {
    e.ctx.logger.warn(`workflow: the refusal of ${node.node_id}'s handbook slice could not be filed as a task: ${(error as Error).message}`)
  }
}

/** Fail a step whose slice is refused, before anything is routed or sent: the decision first, then `config_error`, no input receipt, so `continue` builds the slice again. */
function refuse(e: Engine, run: RunRow, node: NodeRow, decision: ArtifactRef, message: string, lease: () => Lease): void {
  e.ctx.store.transaction(() => {
    const error: WorkflowError = { kind: 'config_error', disposition: dispositionOf('config_error'), message }
    // The handbook's own bound, never the task's work (T321): the task waits for input on the board's
    // question wait, so no attempt and no free retry is spent; the answer continues this attempt.
    e.tasks.waitsOnHandbook(run.run_id, node.node_id, decision, `Step ${node.node_id}'s handbook slice was refused at its start, before anything was sent; no attempt was spent. ${message}. Once the named layer is shortened, answer to continue this attempt.`)
    e.writeNode(node, { state: 'FAILED', error: JSON.stringify(error) }, (r) => {
      const next: NodeRecord = { ...r, lastDecision: decision }
      delete next.inputReceipt
      delete next.execution
      return next
    }, lease)
    e.ctx.eventLog.append({ type: 'workflow.node.failed', runId: run.run_id, nodeId: node.node_id, decision, data: { kind: error.kind, disposition: error.disposition, reason: 'handbook_over_bound' } })
  })
}

/**
 * The event a Worker source records what it rendered of a step's slice by. The agent Worker source
 * declares the same name (agent-workers `HANDBOOK_SOURCE_EVENT`): the engine never imports a Worker
 * source, as with its check events.
 */
export const HANDBOOK_SOURCE_EVENT = 'agent-workers.handbook'
/** The source's events of a run explain reads at most, the latest first (INV-9). */
const SOURCE_EVENTS_READ = 200

/** One part of the source's half as its Worker source rendered it for an execution: the version of its home, its text's sha256, and its estimated tokens. */
export interface SourceRecord { layer: number; part: string; version: string; sha256?: string; tokens: number; lessons?: number }

/** A step's handbook as explain shows it: its brief's record, and what the Worker source recorded it rendered of its half. */
export type HandbookView = BriefHandbook & { source?: SourceRecord[] }

/**
 * The handbook a step's brief recorded (`brief@1.6`), for `explain` and `/ui`, with what its Worker
 * source recorded it rendered for the execution (its latest {@link HANDBOOK_SOURCE_EVENT}); undefined
 * for an earlier brief or none. An event entry that is not one is skipped.
 */
export function handbookOf(e: Engine, brief: ArtifactRef | undefined, runId?: string, execution?: string | null): HandbookView | undefined {
  if (!brief) return undefined
  const handbook = (e.ctx.artifacts.get(brief)?.body as { handbook?: BriefHandbook } | undefined)?.handbook
  if (!handbook || !runId || !execution) return handbook
  let entries: Array<{ data?: unknown }> = []
  try {
    entries = e.ctx.eventLog.query({ type: HANDBOOK_SOURCE_EVENT, runId, order: 'desc', limit: SOURCE_EVENTS_READ })
  } catch (error) {
    e.ctx.logger.warn(`workflow: the handbook events of run ${runId} could not be read: ${(error as Error).message}`)
  }
  const data = entries.map((x) => x.data as { execution?: unknown; parts?: unknown } | undefined).find((d) => d?.execution === execution)
  if (!data || !Array.isArray(data.parts)) return handbook
  const source = (data.parts as unknown[]).filter((p): p is SourceRecord => {
    const r = p as Partial<SourceRecord> | undefined
    return typeof r?.layer === 'number' && typeof r.part === 'string' && typeof r.version === 'string' && typeof r.tokens === 'number'
  }).slice(0, 8)
  return { ...handbook, source }
}
