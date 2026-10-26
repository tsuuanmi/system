/**
 * Generates docs/validation/traceability.md: every requirement (REQ), quality attribute (QA), and
 * invariant (INV), with the tests whose titles cite it. Gaps are listed, not hidden: the
 * production-ready exit criterion is that none remain. A requirement marked `*(retired …)*` needs no
 * test, and no test may cite it. `--check` fails when the page is stale.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(root, 'docs', 'validation', 'traceability.md')

interface Item { id: string; area: string; statement: string; source: string; retired?: boolean }
export interface Evidence { file: string; line: number; title: string }

const clip = (text: string): string => {
  const plain = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
  const first = plain.split(/(?<=\.)\s/)[0]!
  // A table cell: a backslash is escaped too, or one before a `|` would leave the pipe a cell break.
  return (first.length > 140 ? `${first.slice(0, 137)}…` : first).replace(/[\\|]/g, '\\$&')
}

/** Requirements, quality attributes, and invariants, from their canonical documents. */
export function items(): Item[] {
  const out: Item[] = []
  // A trailing blank line, so the last requirement in the file is read like every other.
  const srs = `${readFileSync(join(root, 'docs', 'requirements', 'SRS.md'), 'utf8')}\n\n`
  for (const m of srs.matchAll(/^- \*\*(REQ-[A-Z]+-\d+)\*\*\s+([\s\S]*?)(?=\n- \*\*REQ-|\n#|\n\n)/gm)) {
    out.push({ id: m[1]!, area: 'Requirements', statement: clip(m[2]!), source: 'requirements/SRS.md', ...(m[2]!.startsWith('*(retired ') ? { retired: true } : {}) })
  }
  const qa = readFileSync(join(root, 'docs', 'requirements', 'quality-attributes.md'), 'utf8')
  for (const m of qa.matchAll(/^\| (QA-\d+) \| ([^|]+) \| ([^|]+) \|/gm)) out.push({ id: m[1]!, area: 'Quality attributes', statement: `${m[2]!.trim()}: ${clip(m[3]!)}`, source: 'requirements/quality-attributes.md' })
  const inv = readFileSync(join(root, 'docs', 'architecture', 'invariants.md'), 'utf8')
  for (const m of inv.matchAll(/^### (INV-\d+) (.+)$/gm)) out.push({ id: m[1]!, area: 'Invariants', statement: clip(m[2]!), source: 'architecture/invariants.md' })
  return out
}

/** Ids a title cites, with ranges (`REQ-TEAM-1..4`) and lists (`REQ-WF-3, 4`) expanded. */
export function cited(title: string): string[] {
  const ids = new Set<string>()
  for (const m of title.matchAll(/\b(REQ-[A-Z]+|QA|INV)-(\d+)(?:\.\.(\d+))?/g)) {
    const from = Number(m[2])
    const to = m[3] ? Number(m[3]) : from
    for (let n = from; n <= to && n - from < 50; n++) ids.add(`${m[1]}-${n}`)
  }
  return [...ids]
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) testFiles(path, out)
    // Conformance suites are tests too: every provider of the seam runs them.
    else if (/\.(spec|e2e|crash)\.ts$/.test(entry) || (entry.endsWith('.ts') && dir.endsWith('conformance'))) out.push(path)
  }
  return out
}

/** The title of a test on this line: `it(…)`, `it.skip(…)`, and `describe.runIf(cond)(…)` alike. */
export const testTitle = (text: string): string | undefined => /\b(?:it|describe|test)(?:\.\w+(?:\([^()]*\))?)*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(text)?.[2]

/**
 * The title of a conformance scenario on this line (packages/libs/conformance/runner.ts): the
 * second argument of a `scenario('<id>', '<title>', …)` helper, or a `title: '…'` field.
 */
export const scenarioTitle = (text: string): string | undefined =>
  /\bscenario\(\s*(['"`])(?:\\.|(?!\1).)*\1\s*,\s*(['"`])((?:\\.|(?!\2).)*)\2/.exec(text)?.[3] ?? /\btitle:\s*(['"`])((?:\\.|(?!\1).)+)\1/.exec(text)?.[2]

/** Test and suite titles that cite an id, with where they are. */
export function evidence(): Map<string, Evidence[]> {
  const found = new Map<string, Evidence[]>()
  for (const file of [...testFiles(join(root, 'packages')), ...testFiles(join(root, 'scripts'))].sort()) {
    const suite = file.includes(`${sep}conformance${sep}`)
    readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
      const title = testTitle(text) ?? (suite ? scenarioTitle(text) : undefined)
      if (!title) return
      for (const id of cited(title)) {
        const list = found.get(id) ?? []
        list.push({ file: relative(root, file), line: index + 1, title: title.replace(/\\'/g, "'") })
        found.set(id, list)
      }
    })
  }
  return found
}

/** Ids a test cites that no canonical document defines: a typo, or a requirement not written yet. */
export function undefinedCitations(): string[] {
  const known = new Set(items().map((i) => i.id))
  return [...evidence().entries()].filter(([id]) => !known.has(id)).map(([id, list]) => `${id} (${list[0]!.file}:${list[0]!.line})`)
}

/** Retired requirements a test still cites: the test checks behavior that was replaced. */
export function retiredCitations(): string[] {
  const found = evidence()
  return items().filter((i) => i.retired && found.has(i.id)).map((i) => `${i.id} (${found.get(i.id)![0]!.file}:${found.get(i.id)![0]!.line})`)
}

export function render(): string {
  const all = items()
  const found = evidence()
  const live = all.filter((i) => !i.retired)
  const covered = live.filter((i) => found.has(i.id))
  const sections = ['Requirements', 'Quality attributes', 'Invariants'].map((area) => {
    const rows = all.filter((i) => i.area === area).map((i) => {
      const tests = (found.get(i.id) ?? []).map((e) => `[${e.file.split('/').slice(-1)[0]}:${e.line}](../../${e.file}#L${e.line})`)
      return `| ${i.id} | ${i.statement} | ${tests.length ? tests.join(', ') : i.retired ? 'retired' : '**none yet**'} |`
    })
    return `## ${area}\n\n| Id | Statement | Tests that cite it |\n|---|---|---|\n${rows.join('\n')}`
  })
  const gaps = live.filter((i) => !found.has(i.id)).map((i) => i.id)
  return [
    '# Traceability',
    '',
    '> Generated by `pnpm gen:traceability` from the requirements, quality attributes, and',
    '> invariants, and from the titles of the tests that cite them; do not edit by hand. CI fails',
    '> when it is stale. A test cites an id in its title, for example `... (REQ-WF-7)`. A retired',
    '> requirement needs no test, and no test may cite it.',
    '',
    `**${covered.length} of ${live.length}** ids have at least one test that cites them.`,
    gaps.length ? `Not yet cited by a test: ${gaps.join(', ')}. Some are covered by live or manual checks in the [release checklist](release-checklist.md).` : 'Every id is cited by a test.',
    '',
    ...sections.flatMap((s) => [s, '']),
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const unknown = undefinedCitations()
  if (unknown.length) {
    console.error(`tests cite ids no requirement, quality attribute, or invariant defines: ${unknown.join(', ')}`)
    process.exit(1)
  }
  const retired = retiredCitations()
  if (retired.length) {
    console.error(`tests cite retired requirements: ${retired.join(', ')}`)
    process.exit(1)
  }
  const text = render()
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== text) {
      console.error('docs/validation/traceability.md is out of date: run `pnpm gen:traceability`')
      process.exit(1)
    }
    console.log('traceability: up to date')
  } else {
    writeFileSync(OUT, text)
    console.log(`wrote ${OUT}`)
  }
}
