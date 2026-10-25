/**
 * The order the suite's test files start in (docs/engineering/testing.md#test-groups): by the
 * committed duration table `scripts/test-durations.json` (repository path → seconds), which
 * `scripts/gen-test-durations.ts` writes from a vitest JSON report. vitest's own order needs its
 * duration cache, which a fresh worktree and every CI run lack; without it vitest starts the
 * largest files first, and a short file of slow tests starts among the last.
 *
 * No vitest import here: the config's sequencer and this file's test both use it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

/** Seconds per test file, by its path from the repository root with `/` separators. */
export type Durations = Readonly<Record<string, number>>

const TABLE = new URL('./test-durations.json', import.meta.url)

/** The committed table; none, or a malformed one, is an empty table (vitest's order stands). */
export function readDurations(file: URL | string = TABLE): Durations {
  if (!existsSync(file)) return {}
  try {
    const json: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!json || typeof json !== 'object' || Array.isArray(json)) return {}
    return Object.fromEntries(Object.entries(json).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]) && e[1] >= 0))
  } catch {
    return {}
  }
}

/** A file's key in the table: its path from `root`, with `/` separators. */
export const durationKey = (root: string, file: string): string => (isAbsolute(file) ? relative(root, file) : file).split(sep).join('/')

/**
 * `items` (in vitest's default order) reordered: the files the table does not hold first, in the
 * order they came, since nothing says they are short (a new file); then the rest, longest first,
 * ties in the order they came.
 */
export function order<T>(items: readonly T[], key: (item: T) => string, durations: Durations): T[] {
  const has = (item: T): boolean => Object.hasOwn(durations, key(item))
  const seconds = (item: T): number => durations[key(item)]!
  return [...items.filter((item) => !has(item)), ...items.filter(has).sort((a, b) => seconds(b) - seconds(a))]
}

/** The part of a vitest JSON report (`--reporter=json`) the table is made from. */
export interface JsonReport { testResults: ReadonlyArray<{ name: string; startTime: number; endTime: number }> }

/** The table from a report: each file's seconds, to a tenth, keyed from `root`, in key order. */
export function durationsFromReport(report: JsonReport, root: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const result of [...report.testResults].sort((a, b) => durationKey(root, a.name).localeCompare(durationKey(root, b.name)))) {
    const ms = result.endTime - result.startTime
    if (!Number.isFinite(ms)) continue
    out[durationKey(root, result.name)] = Math.round(Math.max(0, ms) / 100) / 10
  }
  return out
}
