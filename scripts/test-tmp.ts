/**
 * Vitest global setup for every lane (unit, e2e, crash): the run's temporary files go under one
 * parent of its own, so a run leaves nothing behind in the shared temporary directory. TMPDIR is
 * set before the workers start, so every `mkdtempSync(join(tmpdir(), …))`, every Chrome profile,
 * and every child process a test starts lands under it. Teardown removes it. A run that was
 * killed cannot tear down: the next run removes the parents whose run is no longer alive.
 * Processes a run started that outlived it (an Xvfb whose suite was killed before its close, say)
 * name a path under its parent on their command line: they are stopped with it.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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

/**
 * Stop the processes whose command line names a path under `parent` (Linux `/proc`; elsewhere
 * none is found): only a run's own children carry its parent's unique name.
 */
export function stopUnder(parent: string, proc = '/proc'): number[] {
  const stopped: number[] = []
  let pids: string[]
  try {
    pids = readdirSync(proc).filter((name) => /^\d+$/.test(name))
  } catch {
    return stopped
  }
  for (const name of pids) {
    const pid = Number(name)
    if (pid === process.pid) continue
    let args: string
    try {
      args = readFileSync(join(proc, name, 'cmdline'), 'utf8')
    } catch {
      continue
    }
    if (!args.split('\0').some((arg) => arg.includes(`${parent}/`))) continue
    try {
      process.kill(pid, 'SIGKILL')
      stopped.push(pid)
    } catch {
      // Gone already, or not ours.
    }
  }
  return stopped
}

/**
 * Remove the run parents under `root` whose run is gone; only `system-test-<pid>-…` names, never
 * anything else. One that cannot be removed is left: in a nested confinement (a check's suite that
 * runs vitest under bubblewrap, T247) the outer run's parent shows as the mount points of what it
 * binds in, and its run, in another PID namespace, looks gone.
 */
export function sweepStale(
  root: string, isAlive: (pid: number) => boolean = alive, stop: (parent: string) => unknown = stopUnder,
  remove: (parent: string) => void = (parent) => rmSync(parent, { recursive: true, force: true }),
): string[] {
  const removed: string[] = []
  for (const name of readdirSync(root)) {
    const pid = Number(new RegExp(`^${PREFIX}(\\d+)-`).exec(name)?.[1])
    if (!pid || isAlive(pid)) continue
    stop(join(root, name))
    try {
      remove(join(root, name))
    } catch {
      continue
    }
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
    stopUnder(parent)
    rmSync(parent, { recursive: true, force: true })
  }
}
