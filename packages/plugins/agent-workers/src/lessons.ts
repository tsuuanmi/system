/**
 * The lessons of a repository (T220, D82 #8): mistakes made in it before, each one line with the
 * check or test that now enforces it, kept in a committed file of the repository
 * ({@link LESSONS_PATH}; docs/engineering/lessons.md says how one is added). A writing Worker's brief
 * carries them as a short, bounded section, so the next Worker does not make them again. The lead,
 * or a review, adds a lesson by adding its line to that file and committing it: nothing else.
 */
import { committedText } from './worktrees.ts'

/** Where a repository keeps its lessons, relative to its top level. */
export const LESSONS_PATH = 'docs/engineering/lessons.md'

/**
 * The bounds of the lessons section (INV-9): at most `lines` lessons, each at most `lineChars`
 * characters (cut), read from at most `fileChars` characters of the file.
 */
export const LESSONS_LIMITS = { lines: 30, lineChars: 400, fileChars: 32 * 1024 } as const

/** The section's first line. */
export const LESSONS_HEADING = `Lessons of this repository (${LESSONS_PATH}: mistakes made here before, each with the check or test that now enforces it; do not repeat them):`

/**
 * The lessons section of a brief from the lessons file's text: its lessons are its lines that start
 * with `- ` (a heading and prose around them are the file's own), in order, the first
 * {@link LESSONS_LIMITS}`.lines` of them, each cut to `lineChars`, the rest counted. Undefined, no
 * section, when there is no file (`undefined`) or it holds no lesson. Pure.
 */
export function lessonsSection(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const lessons = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.startsWith('- ') && line.slice(2).trim().length > 0)
  if (!lessons.length) return undefined
  const shown = lessons.slice(0, LESSONS_LIMITS.lines).map((line) => ([...line].length > LESSONS_LIMITS.lineChars ? `${[...line].slice(0, LESSONS_LIMITS.lineChars - 1).join('')}…` : line))
  const more = lessons.length - shown.length
  return [LESSONS_HEADING, ...shown, ...(more > 0 ? [`- and ${more} more in ${LESSONS_PATH}`] : [])].join('\n')
}

/**
 * The lessons section for a run in the repository at `repository`, from its lessons file as it is
 * committed at HEAD (an uncommitted edit, a Worker's included, is never read). Undefined when there
 * is no such file, or no repository.
 */
export async function repositoryLessons(repository: string): Promise<string | undefined> {
  const read = await committedText(repository, LESSONS_PATH, LESSONS_LIMITS.fileChars)
  if (!read) return undefined
  // A file read only in part ends mid-line: its last, partial line is no lesson.
  const text = read.cut ? read.text.slice(0, Math.max(0, read.text.lastIndexOf('\n'))) : read.text
  return lessonsSection(text)
}
