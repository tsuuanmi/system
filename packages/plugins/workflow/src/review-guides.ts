/**
 * Review guides (docs/design/handbook.md#review-guides-reviewmd, T267): one file per area of the
 * repository, written by the area's owner, that tells a reviewer what failure looks like there, what
 * to check first, what to skip, how many nits to raise, what evidence a finding needs, and how its
 * summary opens. A review step's brief is given the guides of the areas the change touches, and only
 * those. They are read from `docs/review/*.REVIEW.md` of the repository the run's worktree was cut
 * from (its checked-out branch), never from the worktree: the change under review cannot rewrite the
 * rules it is reviewed by.
 */
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { matchesPath, patternProblem } from '@tsuuanmi/system-approvals-core'

/** Where a repository keeps its guides, and what a guide may hold (INV-9). */
export const GUIDE_DIR = 'docs/review'
export const GUIDE_SUFFIX = '.REVIEW.md'
export const GUIDE_LIMITS = { files: 32, chars: 6000, paths: 32 } as const
/** The most characters of a rendered text (the schema's bound): more guides than fit are cut at the end, with a mark. */
const TEXT_MAX = 60_000

/** The sections every guide has. */
export const GUIDE_SECTIONS = ['What failure looks like here', 'What to check first', 'Paths to skip', 'Nit cap', 'Evidence rule', 'Summary rule'] as const

export interface ReviewGuide {
  /** Repository-relative path of the guide. */
  file: string
  /** The area: path patterns as the policy's path map reads them ({@link matchesPath}). */
  paths: string[]
  owner: string
  version: number
  /** The guide's text as read, front matter included. */
  text: string
  sha256: string
}

export type GuideRead = { ok: true; guide: ReviewGuide } | { ok: false; file: string; problem: string }

/**
 * Parse one guide: front matter (`paths`, a list; `owner`; `version`, a positive integer) between
 * `---` lines, then the six sections of {@link GUIDE_SECTIONS}, each a `## ` heading.
 */
export function parseGuide(file: string, text: string): GuideRead {
  const bad = (problem: string): GuideRead => ({ ok: false, file, problem })
  if (text.length > GUIDE_LIMITS.chars) return bad(`longer than ${GUIDE_LIMITS.chars} characters`)
  const lines = text.split('\n')
  if (lines[0] !== '---') return bad('no front matter (it opens with a --- line)')
  const end = lines.indexOf('---', 1)
  if (end < 0) return bad('the front matter is never closed')
  const paths: string[] = []
  let owner: string | undefined
  let version: number | undefined
  let inPaths = false
  for (const line of lines.slice(1, end)) {
    const item = /^\s+-\s+(\S+)\s*$/.exec(line)
    if (inPaths && item) {
      paths.push(item[1]!)
      continue
    }
    inPaths = false
    const [, key, value] = /^(\w+):\s*(.*)$/.exec(line) ?? []
    if (key === 'paths' && !value) inPaths = true
    else if (key === 'owner' && value) owner = value.trim()
    else if (key === 'version') {
      if (!/^[1-9]\d{0,5}$/.test(value ?? '')) return bad('the version is a positive integer')
      version = Number(value)
    } else if (line.trim()) return bad(`front matter line ${JSON.stringify(line.slice(0, 60))} is not paths, owner, or version`)
  }
  if (!paths.length) return bad('front matter names no paths')
  if (paths.length > GUIDE_LIMITS.paths) return bad(`front matter names more than ${GUIDE_LIMITS.paths} paths`)
  for (const p of paths) {
    const why = patternProblem(p)
    if (why) return bad(why)
  }
  if (!owner) return bad('front matter names no owner')
  if (version === undefined) return bad('front matter names no version (a positive integer)')
  const headings = lines.slice(end + 1).filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim())
  const missing = GUIDE_SECTIONS.filter((s) => !headings.includes(s))
  if (missing.length) return bad(`missing section${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`)
  return { ok: true, guide: { file, paths, owner, version, text, sha256: createHash('sha256').update(text).digest('hex') } }
}

/** Read a regular file, never through a link, bounded. */
function readBounded(path: string): string | undefined {
  const stat = lstatSync(path)
  if (!stat.isFile()) return undefined
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(GUIDE_LIMITS.chars * 4 + 1)
    const n = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * The guides of the repository checked out at `root`: every `docs/review/*.REVIEW.md`, in name
 * order, at most {@link GUIDE_LIMITS}.files. A repository with no such directory has none (no
 * error); one that has it but cannot be read, or holds a malformed guide, says so (`problems`).
 */
export function loadGuides(root: string): { guides: ReviewGuide[]; problems: string[] } {
  const dir = join(root, GUIDE_DIR)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(GUIDE_SUFFIX)).sort()
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { guides: [], problems: [] } : { guides: [], problems: [`${GUIDE_DIR} could not be read: ${(error as Error).message.slice(0, 200)}`] }
  }
  const guides: ReviewGuide[] = []
  const problems: string[] = []
  if (names.length > GUIDE_LIMITS.files) problems.push(`${names.length} guides, at most ${GUIDE_LIMITS.files} are read`)
  for (const name of names.slice(0, GUIDE_LIMITS.files)) {
    const file = `${GUIDE_DIR}/${name}`
    try {
      const text = readBounded(join(dir, name))
      if (text === undefined) {
        problems.push(`${file} is not a regular file`)
        continue
      }
      const read = parseGuide(file, text)
      if (read.ok) guides.push(read.guide)
      else problems.push(`${read.file}: ${read.problem}`)
    } catch (error) {
      problems.push(`${file} could not be read: ${(error as Error).message.slice(0, 200)}`)
    }
  }
  return { guides, problems }
}

/**
 * The guides whose area a changed path is in. When the change's paths are unknown (none read, or some
 * part unreadable), every guide: an unknown path is no reason to leave a rule out (INV-2).
 */
export function guidesTouching(guides: readonly ReviewGuide[], change: { paths: readonly string[]; unreadable: readonly string[] }): { selected: ReviewGuide[]; left: number; all: boolean } {
  const all = !change.paths.length || change.unreadable.length > 0
  const selected = all ? [...guides] : guides.filter((g) => g.paths.some((p) => change.paths.some((path) => matchesPath(p, path))))
  return { selected, left: guides.length - selected.length, all }
}

/** What a review step's brief carries of the guides: the text, and what it holds, as a `review-guides@1.0` body. */
export function renderGuides(selected: readonly ReviewGuide[], left: number, all: boolean, problems: readonly string[]): { text: string; body: { schema: 'review-guides@1.0'; guides: Array<{ file: string; version: number; owner: string; sha256: string }>; left?: number; problems?: string[]; text: string } } | undefined {
  if (!selected.length && !problems.length) return undefined
  const head = selected.length
    ? `Review guides for the areas this change touches (${selected.length} of ${selected.length + left}${all ? ': the change\'s paths could not all be read, so every guide is given' : `; ${left} left out: no changed path is in their area`}). Each says what failure looks like in its area; follow its evidence rule, its nit cap, and its summary rule.`
    : 'No review guide applies.'
  const whole = [head, ...selected.map((g) => g.text.replace(/^---\n[\s\S]*?\n---\n/, '').trim()), ...(problems.length ? [`Guides not used: ${problems.join('; ')}`] : [])].join('\n\n')
  const text = whole.length > TEXT_MAX ? `${whole.slice(0, TEXT_MAX - 1)}…` : whole
  return {
    text,
    body: {
      schema: 'review-guides@1.0', guides: selected.map((g) => ({ file: g.file, version: g.version, owner: g.owner, sha256: g.sha256 })),
      ...(left ? { left } : {}), ...(problems.length ? { problems: problems.map((p) => p.slice(0, 300)).slice(0, 32) } : {}), text,
    },
  }
}
