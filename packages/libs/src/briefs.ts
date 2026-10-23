/**
 * Briefs (`brief@1.x`; docs/design/workflow-engine.md#briefs): what one Worker run is given. A
 * caller (the workflow engine, a digest provider) composes the record and stores it as an
 * `objective` artifact; the Worker source that runs it renders it into its own prompt format when
 * it starts the run, resolving each pointer to the artifact's text there (INV-12: what it renders
 * is what its egress check sees). This module holds the record's vocabulary and the default text
 * rendering every text-prompted source uses. `schemas/brief.v1.json` is canonical.
 */
import { canonicalJson, type ContentId } from './canonical.ts'

export type BriefClassification = 'public' | 'operator-shared' | 'local-private'
/** `input`: the material to work on; `context`: background; `prior`: an earlier attempt's result or digest; `review`: findings to address. */
export type BriefRole = 'input' | 'context' | 'prior' | 'review'
export interface BriefPointer { ref: ContentId; role: BriefRole; note?: string }
/** One piece of a brief's instructions: text, or the pointer at that index of `artifacts`. */
export type BriefSegment = { text: string } | { artifact: number }
/** The confinement a run is held to, from trusted configuration (a Worker source's), never from model text. */
export interface BriefSandbox { mode: 'read-only' | 'workspace-write'; workspace?: string; network: 'none' | 'allow-list'; commands?: boolean }
export interface BriefBudgetLine { pool: string; unit: 'tokens' | 'usd' | 'turns' | 'runs' | 'minutes'; amount: number }

export interface Brief {
  schema: 'brief@1.0' | 'brief@1.1'
  projectId?: string
  taskId?: string
  attempt?: number
  goal: string
  acceptance: Array<{ id: string; statement: string }>
  artifacts: BriefPointer[]
  /** `@1.1`: what the Worker is told, in order; pointers by index, never their content. */
  instructions?: BriefSegment[]
  subject?: { type: 'content' | 'git-head' | 'pull-request' | 'artifact' | 'external'; ref: string; version?: string }
  openQuestions?: string[]
  budget: { remaining: BriefBudgetLine[]; deadline?: string }
  sandbox: BriefSandbox
  resume?: { nativeHandle: string; fork?: boolean }
  classification: BriefClassification
}

/** The bounds `brief@1.x` puts on a record (INV-9): a composer keeps within them. */
export const BRIEF_LIMITS = { goal: 4000, statement: 500, pointers: 64, note: 300, segments: 256, segmentText: 262_144 } as const

/**
 * A sandbox for a Worker whose source declares none: it writes nothing on this machine and runs no
 * command here, and what it is sent leaves only as the egress policy allows (a website or an API
 * model Worker).
 */
export const NO_LOCAL_SANDBOX: BriefSandbox = { mode: 'read-only', network: 'allow-list', commands: false }

/** A brief that cannot be rendered: not a brief, a pointer not stored, an index out of range. Nothing was sent. */
export class BriefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BriefError'
  }
}

/** A stored artifact as rendering reads it (`ctx.artifacts.get`). */
export interface ReadArtifact { bodySchema: string; body?: unknown; classification: BriefClassification }
export type ArtifactLookup = (ref: ContentId) => ReadArtifact | undefined

/**
 * The text of an artifact body as a brief renders it and a quote check reads it: its `text` field
 * when it has one (an answer, a report), else its canonical JSON.
 */
export function bodyText(body: unknown): string {
  const text = (body as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : canonicalJson(body ?? null)
}

/**
 * The default text rendering of a brief, which website, model, and agent Worker sources send as
 * their prompt. Instructions render in order, each pointer they place replaced by its artifact's
 * text. A brief for a board task, or one without instructions, first states the task, its goal,
 * its acceptance criteria, and its open questions. Pointers the instructions do not place follow,
 * each with its role and note. Deterministic for the same brief and stored artifacts, so a
 * repeated start renders the same prompt.
 */
export function renderBrief(brief: Brief, read: ArtifactLookup): string {
  const textOf = (index: number): string => {
    const pointer = brief.artifacts[index]
    if (!pointer) throw new BriefError(`the brief's instructions place artifact ${index}, and it points at ${brief.artifacts.length}`)
    const stored = read(pointer.ref)
    if (!stored || stored.body === undefined) throw new BriefError(`the brief points at ${pointer.ref}, which is not stored here (expired, or never stored); nothing was sent`)
    return bodyText(stored.body)
  }
  const placed = new Set<number>()
  const parts: string[] = []
  if (!brief.instructions || brief.taskId !== undefined) parts.push(frame(brief))
  if (brief.instructions) {
    parts.push(brief.instructions.map((segment) => {
      if ('text' in segment) return segment.text
      placed.add(segment.artifact)
      return textOf(segment.artifact)
    }).join(''))
  }
  const rest = brief.artifacts.map((pointer, index) => ({ pointer, index })).filter(({ index }) => !placed.has(index))
  if (rest.length) {
    parts.push(['Read these too:', ...rest.map(({ pointer, index }) =>
      `<artifact id="${pointer.ref}" role="${pointer.role}"${pointer.note ? ` note=${JSON.stringify(pointer.note)}` : ''}>\n${textOf(index)}\n</artifact>`)].join('\n\n'))
  }
  return parts.join('\n\n')
}

/** What a brief asks before its instructions: the task it serves, its goal, how it is accepted, what is open. */
function frame(brief: Brief): string {
  const lines: string[] = []
  if (brief.taskId !== undefined) lines.push(`Board task ${brief.taskId} of project ${brief.projectId}${brief.attempt !== undefined ? `, attempt ${brief.attempt}` : ''}.`)
  lines.push(`Goal: ${brief.goal}`, 'Acceptance criteria:', ...brief.acceptance.map((a) => `- ${a.id}: ${a.statement}`))
  if (brief.openQuestions?.length) lines.push('Open questions:', ...brief.openQuestions.map((q) => `- ${q}`))
  return lines.join('\n')
}

/** A Worker start as a source sees it: a rendered prompt, or a brief to render (exactly one). */
export interface StartInput { prompt?: string | undefined; brief?: string | undefined; requirement: { data: { classification: BriefClassification } } }

/**
 * The prompt a Worker source sends for a start, and the classification its egress check uses: the
 * given prompt, or the start's brief rendered, at the requirement's classification, the work's own
 * from its trusted envelope (INV-12), as for any prompt. The brief's record may be stricter (it is
 * at least as strict as what it points at, for storage), which never loosens that check. Throws
 * {@link BriefError} when the start names neither or both, or the brief cannot be rendered.
 */
export function startPrompt(request: StartInput, read: ArtifactLookup): { prompt: string; classification: BriefClassification } {
  const required = request.requirement.data.classification
  if ((request.prompt === undefined) === (request.brief === undefined)) throw new BriefError('a start names its prompt or its brief, exactly one')
  if (request.prompt !== undefined) return { prompt: request.prompt, classification: required }
  const stored = read(request.brief as ContentId)
  if (!stored) throw new BriefError(`brief ${request.brief} is not stored here; nothing was sent`)
  if (!/^brief@1\.\d+$/.test(stored.bodySchema)) throw new BriefError(`artifact ${request.brief} is a ${stored.bodySchema}, not a brief`)
  return { prompt: renderBrief(stored.body as Brief, read), classification: required }
}
