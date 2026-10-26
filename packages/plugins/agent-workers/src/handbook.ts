/**
 * The source's half of a step's handbook slice (docs/design/handbook.md#where-the-slice-is-rendered):
 * the gate view (layer 2) and the repository's lessons (layer 5), which only the Worker source can
 * render, because only it knows the Worker's sandbox, runtime, and repository. The engine records in
 * the brief who the slice was selected for (`brief@1.6` `handbook.selection`); this source gives the
 * run the lessons of that role and those paths, and records what it rendered of its half, each part's
 * version, sha256, and estimated tokens, as a {@link HANDBOOK_SOURCE_EVENT} event of the workflow run,
 * which the run's explain shows beside the brief's record.
 */

/** The event a source records its half of a step's slice by (one per execution it prepares); the workflow engine reads the same name. */
export const HANDBOOK_SOURCE_EVENT = 'agent-workers.handbook'

/** The handbook's roles a brief may name. */
const ROLES = new Set(['develop', 'review', 'validate', 'research', 'lead'])
/** Touched paths a selection carries at most (the engine sends none past it: unknown, every path). */
const MAX_TOUCHED = 200

/** Who a brief's handbook slice was selected for: its role and, when they were read, the paths the change touches. */
export interface HandbookSelection { role: string; touched?: string[] }

/** One part of the source's half as rendered for a run: its layer and id, the version of its home, its text's sha256, and its estimated tokens. */
export interface SourcePart { layer: 2 | 5; part: 'L2.gate-view' | 'L5.lessons'; version: string; sha256?: string; tokens: number; lessons?: number }

/** A brief's `handbook` (brief@1.6) as this source reads it: its selection's role and touched paths, or undefined when it has none it can read. */
export function handbookSelection(value: unknown): HandbookSelection | undefined {
  const selection = (value as { selection?: { role?: unknown; touched?: unknown } } | undefined)?.selection
  if (typeof selection?.role !== 'string' || !ROLES.has(selection.role)) return undefined
  const touched = Array.isArray(selection.touched) && selection.touched.length <= MAX_TOUCHED && selection.touched.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 1024)
    ? selection.touched as string[] : undefined
  return { role: selection.role, ...(touched ? { touched } : {}) }
}
