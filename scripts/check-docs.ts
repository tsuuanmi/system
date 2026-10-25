// Documentation structure and link checks, and conflict markers in any tracked text file
// (docs/engineering/testing.md#ci-gates).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkConflicts } from './check-conflicts.ts'

export interface DocProblem {
  kind: 'missing-readme' | 'duplicate-entry' | 'broken-link' | 'broken-anchor'
  file: string
  detail: string
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'lib', 'dist', 'coverage'])

function walk(dir: string, visit: (path: string, isDir: boolean) => void): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const path = join(dir, entry)
    const isDir = statSync(path).isDirectory()
    visit(path, isDir)
    if (isDir) walk(path, visit)
  }
}

/** GitHub-style heading slug. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- _]/gu, '')
    .replace(/ /g, '-')
}

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>()
  for (const match of markdown.matchAll(/^#+\s+(.*)$/gm)) slugs.add(slugify(match[1] ?? ''))
  return slugs
}

export function checkDocs(root: string): DocProblem[] {
  const problems: DocProblem[] = []
  const docs = join(root, 'docs')

  // Every docs directory has exactly one README router; no topic.md beside topic/.
  const dirs = [docs]
  walk(docs, (path, isDir) => isDir && dirs.push(path))
  for (const dir of dirs) {
    const entries = readdirSync(dir)
    if (!entries.includes('README.md')) {
      problems.push({ kind: 'missing-readme', file: relative(root, dir), detail: 'directory has no README.md' })
    }
    for (const entry of entries) {
      if (entry.endsWith('.md') && existsSync(join(dir, entry.slice(0, -3)))) {
        problems.push({ kind: 'duplicate-entry', file: relative(root, join(dir, entry)), detail: 'both topic.md and topic/ exist' })
      }
    }
  }

  // Every relative Markdown link and anchor resolves.
  walk(root, (path, isDir) => {
    if (isDir || !path.endsWith('.md')) return
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1] ?? ''
      if (/^[a-z]+:/i.test(target)) continue
      const [pathPart = '', anchor] = target.split('#', 2)
      const resolved = pathPart ? normalize(join(dirname(path), pathPart)) : path
      if (!existsSync(resolved)) {
        problems.push({ kind: 'broken-link', file: relative(root, path), detail: target })
        continue
      }
      if (anchor && resolved.endsWith('.md') && !headingSlugs(readFileSync(resolved, 'utf8')).has(anchor)) {
        problems.push({ kind: 'broken-anchor', file: relative(root, path), detail: target })
      }
    }
  })
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const problems = checkDocs(root)
  for (const p of problems) console.error(`${p.kind}: ${p.file}: ${p.detail}`)
  console.log(`docs: ${problems.length} problem(s)`)
  // Conflict markers in any tracked text file, not only docs (scripts/check-conflicts.ts).
  const conflicts = checkConflicts(root)
  for (const c of conflicts) console.error(`conflict-marker: ${c.file}:${c.line}: ${c.marker}`)
  console.log(`conflict markers: ${conflicts.length} finding(s)`)
  process.exit(problems.length || conflicts.length ? 1 : 0)
}
