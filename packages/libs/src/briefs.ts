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
/** A file a Worker source writes into the run's own workspace before it starts: the text of `ref`, at `path` under `.system/`. */
export interface BriefFile { path: string; ref: ContentId; note?: string }

export interface Brief {
  schema: 'brief@1.0' | 'brief@1.1' | 'brief@1.2'
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
  /** `@1.2`: the Worker may answer with at most `maxQuestions` questions instead of a result ({@link questionsOf}). */
  ask?: { maxQuestions: number }
  /** `@1.2`: files a source with a workspace of the run's own writes there before the run, read-only, each an artifact's text ({@link BRIEF_FILE_PATH}). */
  files?: BriefFile[]
  budget: { remaining: BriefBudgetLine[]; deadline?: string }
  sandbox: BriefSandbox
  resume?: { nativeHandle: string; fork?: boolean }
  classification: BriefClassification
}

/** The bounds `brief@1.x` puts on a record (INV-9): a composer keeps within them. */
export const BRIEF_LIMITS = { goal: 4000, statement: 500, pointers: 64, note: 300, segments: 256, segmentText: 262_144, files: 4 } as const

/**
 * Where a brief's files go in a run's workspace (`brief@1.2` `files`): one name with one extension
 * under `.system/`, a directory the writing source makes git ignore, so nothing it holds is part
 * of the run's subject or of a commit, and no path leaves the workspace.
 */
export const BRIEF_FILE_PATH = /^\.system\/[A-Za-z0-9][A-Za-z0-9_-]{0,58}\.[A-Za-z0-9]{1,4}$/

/** How many questions a Worker may ask instead of answering, and how long each may be (a board task's question wait holds as many). */
export const QUESTION_LIMITS = { count: 8, chars: 500 } as const

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
export function renderBrief(brief: Brief, read: ArtifactLookup, options: RenderOptions = {}): string {
  const textOf = (index: number): string => {
    const pointer = brief.artifacts[index]
    if (!pointer) throw new BriefError(`the brief's instructions place artifact ${index}, and it points at ${brief.artifacts.length}`)
    const stored = read(pointer.ref)
    if (!stored || stored.body === undefined) throw new BriefError(`the brief points at ${pointer.ref}, which is not stored here (expired, or never stored); nothing was sent`)
    return bodyText(stored.body)
  }
  const placed = new Set<number>()
  const parts: string[] = []
  if (!brief.instructions || brief.taskId !== undefined) parts.push(frame(brief, options))
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

/**
 * How a source renders a brief: `placesFiles` when it writes the brief's `files` into the run's own
 * workspace before the run (the brief then names them); a source that does not never mentions them.
 */
export interface RenderOptions { placesFiles?: boolean }

/** What a brief asks before its instructions: the task it serves, its goal, how it is accepted, what is open. */
function frame(brief: Brief, options: RenderOptions): string {
  const lines: string[] = []
  if (brief.taskId !== undefined) lines.push(`Board task ${brief.taskId} of project ${brief.projectId}${brief.attempt !== undefined ? `, attempt ${brief.attempt}` : ''}.`)
  lines.push(`Goal: ${brief.goal}`, 'Acceptance criteria:', ...brief.acceptance.map((a) => `- ${a.id}: ${a.statement}`))
  if (brief.openQuestions?.length) lines.push('Open questions:', ...brief.openQuestions.map((q) => `- ${q}`))
  if (options.placesFiles && brief.files?.length) {
    lines.push('Files in your workspace, written by system before this run (read-only; edits are never read back):', ...brief.files.map((f) => `- ${f.path}${f.note ? `: ${f.note}` : ''}`))
  }
  if (brief.ask) {
    lines.push(`If you cannot finish without an answer from a person, answer with only this JSON object and nothing else: {"questions": ["..."]}, `
      + `with 1 to ${brief.ask.maxQuestions} questions of at most ${QUESTION_LIMITS.chars} characters each. The task then waits for the answers, and its next attempt is given them.`)
  }
  return lines.join('\n')
}

/**
 * The questions a Worker's answer asks instead of a result, as a brief with `ask` offers it: the
 * whole answer (in one fenced block, or none) is one JSON object whose only key is `questions`, 1
 * to `max` non-empty strings of at most {@link QUESTION_LIMITS}`.chars` characters. Anything else
 * (an answer that mentions questions, extra keys, too many or too long) is no question: undefined,
 * and the answer is taken as a result. Bounded: a long answer is never parsed.
 */
export function questionsOf(answer: string, max: number = QUESTION_LIMITS.count): string[] | undefined {
  if (answer.length > (QUESTION_LIMITS.chars + 16) * 4 * QUESTION_LIMITS.count + 256) return undefined
  let text = answer.trim()
  // One fenced block around the whole answer (```json or ```): its body, the fence lines dropped.
  if (text.startsWith('```') && text.endsWith('```') && text.length > 6) {
    const open = text.indexOf('\n')
    const info = open < 0 ? '' : text.slice(3, open).trim()
    if (open < 0 || (info !== '' && info !== 'json')) return undefined
    text = text.slice(open + 1, -3)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const keys = Object.keys(parsed)
  const questions = (parsed as { questions?: unknown }).questions
  if (keys.length !== 1 || keys[0] !== 'questions' || !Array.isArray(questions)) return undefined
  if (questions.length < 1 || questions.length > Math.min(max, QUESTION_LIMITS.count)) return undefined
  const asked = questions.map((q) => (typeof q === 'string' ? q.trim() : ''))
  return asked.every((q) => q.length > 0 && [...q].length <= QUESTION_LIMITS.chars) ? asked : undefined
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
export function startPrompt(request: StartInput, read: ArtifactLookup, options: RenderOptions = {}): { prompt: string; classification: BriefClassification } {
  const required = request.requirement.data.classification
  if ((request.prompt === undefined) === (request.brief === undefined)) throw new BriefError('a start names its prompt or its brief, exactly one')
  if (request.prompt !== undefined) return { prompt: request.prompt, classification: required }
  const stored = read(request.brief as ContentId)
  if (!stored) throw new BriefError(`brief ${request.brief} is not stored here; nothing was sent`)
  if (!/^brief@1\.\d+$/.test(stored.bodySchema)) throw new BriefError(`artifact ${request.brief} is a ${stored.bodySchema}, not a brief`)
  return { prompt: renderBrief(stored.body as Brief, read, options), classification: required }
}
