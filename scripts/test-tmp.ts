/**
 * Vitest global setup for every lane (unit, e2e, crash): the run's temporary files go under one
 * parent of its own, so a run leaves nothing behind in the shared temporary directory. TMPDIR is
 * set before the workers start, so every `mkdtempSync(join(tmpdir(), …))`, every Chrome profile,
 * and every child process a test starts lands under it. Teardown removes it. A run that was
 * killed cannot tear down: the next run removes the parents whose run is no longer alive.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'system-test-'

/** Whether a process with this id is alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Remove the run parents under `root` whose run is gone; only `system-test-<pid>-…` names, never anything else. */
export function sweepStale(root: string, isAlive: (pid: number) => boolean = alive): string[] {
  const removed: string[] = []
  for (const name of readdirSync(root)) {
    const pid = Number(new RegExp(`^${PREFIX}(\\d+)-`).exec(name)?.[1])
    if (!pid || isAlive(pid)) continue
    rmSync(join(root, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

export default function setup(): () => void {
  const root = tmpdir()
  sweepStale(root)
  const parent = mkdtempSync(join(root, `${PREFIX}${process.pid}-`))
  process.env.TMPDIR = parent
  return () => {
    rmSync(parent, { recursive: true, force: true })
  }
}
