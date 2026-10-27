/**
 * The lessons of a repository (T220, D82 #8; layer 5 of the handbook, docs/design/handbook.md):
 * mistakes made in it before, each one line with the check or test that now enforces it, kept in a
 * committed file of the repository ({@link LESSONS_PATH}; docs/engineering/lessons.md says how one is
 * added), and the bounded section a Worker's brief carries of the ones that apply to it. One
 * implementation, pure: the agent Worker source renders the section from the file as committed at its
 * repository's HEAD, and the workflow engine counts the same section against the handbook's bound.
 *
 * A lesson may end with an `Applies:` clause after its `Check:`, naming roles and paths
 * (`Applies: develop, review; schemas/`); one with none applies to `develop` and `review`, every path.
 * The section is bounded in UTF-8 bytes ({@link LESSONS_LIMITS}`.sectionBytes`), so its estimated
 * tokens (`ceil(bytes / 4)`, the handbook's measure) never pass layer 5's share.
 */

import { globMatches, globProblem } from './repositories.ts'

/** Where a repository keeps its lessons, relative to its top level. */
export const LESSONS_PATH = 'docs/engineering/lessons.md'

/**
 * The bounds of the lessons section (INV-9): at most `lines` lessons, each at most `lineChars`
 * characters (cut), read from at most `fileChars` characters of the file, the whole section at most
 * `sectionBytes` UTF-8 bytes (3,100 estimated tokens: layer 5's share of the handbook's bound); a
 * lesson that does not fit is counted, never cut silently.
 */
export const LESSONS_LIMITS = { lines: 30, lineChars: 400, fileChars: 32 * 1024, sectionBytes: 12_400 } as const

/** The section's first line. */
export const LESSONS_HEADING = `Lessons of this repository (${LESSONS_PATH}: mistakes made here before, each with the check or test that now enforces it; do not repeat them):`

/** The roles an `Applies:` clause may name (the handbook's roles). */
const ROLES = new Set(['develop', 'review', 'validate', 'research', 'lead'])
/** Who a lesson with no `Applies:` clause, or one naming paths only, applies to. */
const DEFAULT_ROLES = ['develop', 'review']
/** Bytes kept for the line that counts the lessons left out. */
const MORE_BYTES = 80

/** Who a lesson is shown to: the step's role (`brief@1.6` `handbook.selection`), and the paths its change touches when they are known. */
export interface LessonsFor { role: string; touched?: readonly string[] }

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/** A lesson's `Applies:` clause, after its `Check:`: the roles it names and the paths. Undefined when it has none. */
export function appliesOf(line: string): { roles: string[]; paths: string[] } | undefined {
  const match = /\bCheck:.*?\bApplies:\s*(.+)$/.exec(line)
  if (!match) return undefined
  const items = match[1]!.split(/[;,]/).map((s) => s.trim().replace(/\.$/, '')).filter(Boolean)
  return { roles: items.filter((i) => ROLES.has(i)), paths: items.filter((i) => !ROLES.has(i)) }
}

/** Whether a path matches a pattern ({@link globMatches} exact: `dir/` the directory and below, `**` any segments, `*` within one); a pattern {@link globProblem} refuses matches nothing. */
export function pathMatches(pattern: string, path: string): boolean {
  return !globProblem(pattern, true) && globMatches(pattern, path, undefined, true)
}

/** Whether a lesson applies to `who`: its roles (by default develop and review), then its paths, any path when the touched ones are unknown (INV-2). */
export function lessonApplies(line: string, who: LessonsFor): boolean {
  const applies = appliesOf(line)
  const roles = applies?.roles.length ? applies.roles : DEFAULT_ROLES
  if (!roles.includes(who.role)) return false
  if (!applies?.paths.length || who.touched === undefined) return true
  return who.touched.some((path) => applies.paths.some((pattern) => pathMatches(pattern, path)))
}

/**
 * The lessons section of a brief from the lessons file's text: its lessons are its lines that start
 * with `- ` (a heading and prose around them are the file's own), in order; with `who`, only those
 * that apply to it ({@link lessonApplies}). At most {@link LESSONS_LIMITS}`.lines` of them, each cut
 * to `lineChars`, while the section holds at most `sectionBytes` bytes; the rest counted. Undefined,
 * no section, when there is no file (`undefined`) or no lesson applies. Pure.
 */
export function lessonsSection(text: string | undefined, who?: LessonsFor): string | undefined {
  return lessonsSectionOf(text, who)?.section
}

/** The lessons section with how many lessons it shows ({@link lessonsSection}). */
export function lessonsSectionOf(text: string | undefined, who?: LessonsFor): { section: string; shown: number } | undefined {
  if (text === undefined) return undefined
  const lessons = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.startsWith('- ') && line.slice(2).trim().length > 0)
    .filter((line) => !who || lessonApplies(line, who))
  if (!lessons.length) return undefined
  const shown: string[] = []
  let used = bytes(LESSONS_HEADING)
  for (const lesson of lessons.slice(0, LESSONS_LIMITS.lines)) {
    const line = [...lesson].length > LESSONS_LIMITS.lineChars ? `${[...lesson].slice(0, LESSONS_LIMITS.lineChars - 1).join('')}…` : lesson
    if (used + 1 + bytes(line) + MORE_BYTES > LESSONS_LIMITS.sectionBytes) break
    shown.push(line)
    used += 1 + bytes(line)
  }
  const more = lessons.length - shown.length
  return { section: [LESSONS_HEADING, ...shown, ...(more > 0 ? [`- and ${more} more in ${LESSONS_PATH}`] : [])].join('\n'), shown: shown.length }
}

/**
 * A lessons file's text as read within {@link LESSONS_LIMITS}`.fileChars`: a file read only in part
 * ends mid-line, and its last, partial line is no lesson.
 */
export function lessonsText(text: string, cut: boolean): string {
  return cut ? text.slice(0, Math.max(0, text.lastIndexOf('\n'))) : text
}
