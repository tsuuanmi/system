/**
 * Policy drift (T352): whether a policy of the live set equals the file the repository ships for it
 * at the live install's commit. A policy enters the live set only through an approved policy change
 * (docs/design/approvals.md#a-policy-change), so a file changed on dev reaches it only when someone
 * proposes it; this tells the two apart. Pure and import-free: the health table's policy row and
 * `scripts/live-update-check.ts` (which Node runs with its types stripped) both use it.
 */

type PolicyJson = Record<string, unknown>

/** A JSON value's text with its object keys sorted: two records written in another key order are equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as PolicyJson)[k])}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * The keys of the file whose content differs from the live record, sorted. `version` is never
 * compared (a proposal raises it by design), and a key only the live record carries is not the
 * file's to speak for, so it is not compared either: what the file says is what is held to the live set.
 */
function differingKeys(file: PolicyJson, live: PolicyJson): string[] {
  return Object.keys(file).filter((key) => key !== 'version' && canonical(file[key]) !== canonical(live[key])).sort()
}

/** The version a proposal of the file carries: the file's own, raised past the live version when it is not above it (a change must raise it). */
function proposedVersion(file: PolicyJson, live: PolicyJson | undefined): number {
  const own = typeof file['version'] === 'number' ? file['version'] : 0
  const was = typeof live?.['version'] === 'number' ? live['version'] : 0
  return live === undefined ? own : Math.max(own, was + 1)
}

/** The record to propose (`approvals_policy_propose`'s `policy`): the file's content at {@link proposedVersion}. */
function proposalOf(file: PolicyJson, live: PolicyJson | undefined): PolicyJson {
  return { ...file, version: proposedVersion(file, live) }
}

/** One policy file against the live set: what the health row and the update's notes say. */
export interface PolicyDrift {
  /** The file's path in the repository, `policies/<name>.json`. */
  path: string
  id: string
  /** The live version; undefined when no policy of that id is in force. */
  liveVersion?: number
  fileVersion?: number
  /** The keys that differ; empty when equal. */
  differing: string[]
  /** The record that would close it. */
  proposal: PolicyJson
}

/** Compare one file with the live record of its id (undefined: none in force). */
export function policyDrift(path: string, file: PolicyJson, live: PolicyJson | undefined): PolicyDrift {
  return {
    path, id: String(file['id']),
    ...(typeof live?.['version'] === 'number' ? { liveVersion: live['version'] } : {}),
    ...(typeof file['version'] === 'number' ? { fileVersion: file['version'] } : {}),
    differing: live === undefined ? [] : differingKeys(file, live), proposal: proposalOf(file, live),
  }
}

/** Whether the live set holds the file's content. */
export const drifted = (d: PolicyDrift): boolean => d.liveVersion === undefined || d.differing.length > 0

/** One line: what differs, or that it is equal. */
export function describeDrift(d: PolicyDrift): string {
  if (d.liveVersion === undefined) return `${d.path} (${d.id}${d.fileVersion !== undefined ? ` v${d.fileVersion}` : ''}) is shipped, and no policy ${d.id} is in force`
  if (!d.differing.length) return `${d.id} v${d.liveVersion} in force equals ${d.path} at the install's commit`
  return `${d.id} v${d.liveVersion} in force differs from ${d.path}${d.fileVersion !== undefined ? ` (v${d.fileVersion})` : ''} at the install's commit in ${d.differing.join(', ')}`
}
