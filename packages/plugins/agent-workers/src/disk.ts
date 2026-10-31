/**
 * The host's disk, as the worktrees fill it (T345; docs/research/resource-capacity.md, the disk floor):
 * the free space of the filesystem a path is on, read with `statfs`, never by walking a tree (INV-9).
 * No new worktree is cut while the worktrees' filesystem has less free than a configured floor
 * (`diskFloorGb`), under the `disk-floor` mechanism's mode (ADR-0078).
 */
import { statfsSync } from 'node:fs'
import { dirname } from 'node:path'

/** One filesystem's space, read at `path` (the nearest directory that exists). */
export interface DiskSpace {
  path: string
  freeBytes: number
  totalBytes: number
}

export const GB = 1024 ** 3

/** The space of the filesystem `path` is on: read at `path`, or at its nearest parent that exists. Undefined when none can be read. */
export function diskSpace(path: string): DiskSpace | undefined {
  for (let at = path; ; at = dirname(at)) {
    try {
      const s = statfsSync(at)
      // Free to a user (`bavail`), not to root: what a run's own writes can take.
      return { path, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }
    } catch {
      if (dirname(at) === at) return undefined
    }
  }
}

/** A space as a person reads it: `12.3 GB free of 100.0 GB (12 %)`. */
export function describeSpace(space: DiskSpace): string {
  const percent = space.totalBytes ? Math.round((space.freeBytes / space.totalBytes) * 100) : 0
  return `${(space.freeBytes / GB).toFixed(1)} GB free of ${(space.totalBytes / GB).toFixed(1)} GB (${percent} %)`
}
