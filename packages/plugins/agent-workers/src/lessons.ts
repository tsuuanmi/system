/**
 * Reading a repository's lessons for a run (T220): the lessons file as its repository has it
 * committed at HEAD (an uncommitted edit, a Worker's included, is never read), rendered as libs'
 * `lessonsSection` renders it (`@tsuuanmi/system-libs`, the one implementation the workflow engine
 * counts by too), with what the handbook records of it.
 */
import { LESSONS_LIMITS, LESSONS_PATH, type LessonsFor, lessonsSectionOf, lessonsText, sha256 } from '@tsuuanmi/system-libs'
import { committedBlob, committedText } from './worktrees.ts'

/** The lessons a run was given, as its source records them: the file's version, the section's sha256 and estimated tokens, and how many lessons it holds. */
export interface LessonsRecord { section?: string; version: string; sha256?: string; tokens: number; lessons: number }

/**
 * The lessons section for a run in the repository at `repository`, from its lessons file as it is
 * committed at HEAD (an uncommitted edit, a Worker's included, is never read). Undefined when there
 * is no such file, or no repository.
 */
export async function repositoryLessons(repository: string, who?: LessonsFor): Promise<string | undefined> {
  return (await repositoryLessonsFor(repository, who))?.section
}

/**
 * The lessons a run in `repository` is given, with what the handbook records of them: the file's
 * version (`git:<blob>` at HEAD), and the section's sha256, estimated tokens, and lessons. Undefined
 * when no lessons file is committed there.
 */
export async function repositoryLessonsFor(repository: string, who?: LessonsFor): Promise<LessonsRecord | undefined> {
  const read = await committedText(repository, LESSONS_PATH, LESSONS_LIMITS.fileChars)
  if (!read) return undefined
  const blob = await committedBlob(repository, LESSONS_PATH)
  const built = lessonsSectionOf(lessonsText(read.text, read.cut), who)
  const version = `git:${blob ?? 'unread'}`
  if (!built) return { version, tokens: 0, lessons: 0 }
  return { section: built.section, version, sha256: sha256(built.section).slice('sha256:'.length), tokens: Math.ceil(Buffer.byteLength(built.section, 'utf8') / 4), lessons: built.shown }
}
