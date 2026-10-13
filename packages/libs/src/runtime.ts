/**
 * The Node runtime `system` supports (CON-2). `node:sqlite` must read stored text back byte
 * for byte (QA-4): Node 22, and 24 and 26 before 24.16.0 and 26.1.0, cut text at an
 * embedded NUL; 24.18.1 and 26.5.1 also carry the fix for CVE-2026-58041. The store checks
 * this before it opens, and the CLI before it starts or initializes a profile.
 */
import { DatabaseSync } from 'node:sqlite'

export const SUPPORTED_NODE = '^24.18.1 || >=26.5.1'

/** Text with an embedded NUL: some `node:sqlite` releases read it back cut at the NUL. */
const NUL_PROBE = 'before\u0000after'

const atLeast = (version: string, floor: [number, number, number]): boolean => {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10))
  for (let i = 0; i < 3; i++) {
    const part = parts[i] ?? 0
    if (part !== floor[i]) return part > floor[i]!
  }
  return true
}

/** Why `version` is outside {@link SUPPORTED_NODE}, or `undefined` when it is inside. */
export function nodeVersionProblem(version: string = process.versions.node): string | undefined {
  const major = Number.parseInt(version, 10)
  const ok = major === 24 ? atLeast(version, [24, 18, 1]) : major === 26 ? atLeast(version, [26, 5, 1]) : major > 26
  return ok ? undefined : `Node ${version} is not supported; system needs Node ${SUPPORTED_NODE} (docs/requirements/constraints.md, CON-2)`
}

/**
 * Why this runtime cannot hold `system` records, or `undefined` when it can: the version
 * range, then the behavior itself, a NUL round trip through `node:sqlite`.
 */
export function sqliteRuntimeProblem(roundTrip: (text: string) => unknown = selectText, version: string = process.versions.node): string | undefined {
  const outside = nodeVersionProblem(version)
  if (outside) return outside
  if (roundTrip(NUL_PROBE) === NUL_PROBE) return undefined
  return `node:sqlite in Node ${version} does not read back text containing a NUL character intact; `
    + `system needs Node ${SUPPORTED_NODE} (docs/requirements/constraints.md, CON-2)`
}

function selectText(text: string): unknown {
  const db = new DatabaseSync(':memory:')
  try {
    return (db.prepare('SELECT ? AS v').get(text) as { v: unknown }).v
  } finally {
    db.close()
  }
}
