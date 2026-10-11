/**
 * Deterministic self-heal matcher (docs/design/ui-operations.md#self-heal): score the
 * nodes of an AI-mode ARIA snapshot against an element's fingerprint. A match is
 * accepted only above a threshold and with a clear margin over the runner-up.
 */
import type { Fingerprint } from './map.ts'

export interface SnapshotNode {
  ref: string
  role: string
  name: string
  depth: number
  parent: number | undefined
}

export interface Scored {
  ref: string
  role: string
  name: string
  score: number
}

const LINE = /^(\s*)- ([a-z][a-z-]*)(?: "((?:[^"\\]|\\.)*)")?[^\n]*?\[ref=(e\d+)\]/

/** Parse `ariaSnapshot({ mode: 'ai' })` output into nodes with refs and parents. */
export function parseAiSnapshot(snapshot: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = []
  const stack: number[] = []
  for (const line of snapshot.split('\n')) {
    const m = LINE.exec(line)
    if (!m) continue
    const depth = m[1]!.length / 2
    while (stack.length && nodes[stack.at(-1)!]!.depth >= depth) stack.pop()
    nodes.push({ ref: m[4]!, role: m[2]!, name: (m[3] ?? '').replace(/\\(.)/g, '$1'), depth, parent: stack.at(-1) })
    stack.push(nodes.length - 1)
  }
  return nodes
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = current
    }
  }
  return row[b.length]!
}

/** Best similarity of `keyword` to any word (or the whole) of `name`, in [0, 1]. */
function nameSimilarity(keyword: string, name: string): number {
  const k = keyword.toLowerCase()
  const words = [name.toLowerCase(), ...name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)]
  let best = 0
  for (const w of words) {
    if (w === k) return 1
    best = Math.max(best, 1 - levenshtein(k, w) / Math.max(k.length, w.length))
  }
  return best
}

function nameScore(fingerprint: Fingerprint, name: string, locales: readonly string[]): number {
  if (!fingerprint.name) return 1
  let best = 0
  for (const locale of locales) {
    const pattern = fingerprint.name[locale]
    if (pattern === undefined) continue
    try {
      if (new RegExp(pattern, 'i').test(name)) return 1
    } catch { /* not a regex: compare as a keyword */ }
    best = Math.max(best, nameSimilarity(pattern, name))
  }
  // Short words are close by edit distance by chance ("send" vs "mode"); only near-misses count.
  return best >= 0.75 ? best : 0
}

/** Role decides eligibility; name carries most of the score; a nearby role breaks ties. */
export function scoreNodes(nodes: SnapshotNode[], fingerprint: Fingerprint, locales: readonly string[]): Scored[] {
  const near = (index: number): boolean => {
    if (!fingerprint.nearRole) return false
    const parent = nodes[index]!.parent
    return nodes.some((n, i) => i !== index && n.parent === parent && n.role === fingerprint.nearRole)
  }
  return nodes
    .map((node, index) => {
      if (fingerprint.role && node.role !== fingerprint.role) return { ...pick(node), score: 0 }
      const score = 0.5 + 0.4 * nameScore(fingerprint, node.name, locales) + (fingerprint.nearRole ? (near(index) ? 0.1 : 0) : 0.1)
      return { ...pick(node), score: Math.round(score * 1000) / 1000 }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
}

const pick = (n: SnapshotNode): Omit<Scored, 'score'> => ({ ref: n.ref, role: n.role, name: n.name })

export interface HealThresholds {
  /** Minimum score (default 0.8). */
  threshold?: number
  /** Minimum lead over the runner-up (default 0.15). */
  margin?: number
}

/** The accepted node, or undefined when no node is confidently best. */
export function choose(scored: Scored[], thresholds: HealThresholds = {}): Scored | undefined {
  const [best, second] = scored
  if (!best || best.score < (thresholds.threshold ?? 0.8)) return undefined
  if (second && best.score - second.score < (thresholds.margin ?? 0.15)) return undefined
  return best
}
