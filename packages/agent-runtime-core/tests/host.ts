/**
 * What this environment can do, decided by doing it (T174): the one place a test asks whether it
 * runs where real bubblewrap can confine a command, and what mode a file it creates gets. The suite
 * runs on an operator's host and inside a run's check (ADR-0063: bubblewrap, the host read-only
 * but the worktree, a private `/tmp`, no network, its own PID namespace, the daemon's umask), and
 * gives the same verdict in both: a test that needs what the environment cannot do skips with the
 * reason, and one whose expectation follows from the environment asserts what the code does there.
 * Nothing here is decided from an environment variable a test could set by accident; only
 * `SYSTEM_REQUIRE_BWRAP=1` (CI) makes a bubblewrap that cannot confine fail the tests instead of
 * skipping them, never the other way round.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { beforeEach } from 'vitest'

/** CI requires a bubblewrap that confines: one that cannot fails the run instead of skipping. */
export const REQUIRE_BWRAP = process.env.SYSTEM_REQUIRE_BWRAP === '1'

/** `bwrap` on PATH as an absolute path, if any. */
function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      return join(dir, name)
    } catch {
      // not here
    }
  }
  return undefined
}

/**
 * The bubblewrap features the code relies on, each probed with a command line written out here by
 * hand, never one `confinedCommand` builds: a probe built by the code under test would turn a
 * regression in it (a wrong argument, a bad mount) into "this host cannot confine" and skip the very
 * tests that should catch it. Once these run, a production command line that fails is a test failure.
 */
export const PROBES: ReadonlyArray<{ what: string; args: readonly string[] }> = [
  // An agent child's: the host as is, its own PID namespace, /proc and session, a tmpfs over a path.
  { what: 'a PID namespace with its own /proc', args: ['--die-with-parent', '--unshare-pid', '--new-session', '--dev-bind', '/', '/', '--proc', '/proc', '--tmpfs', '/tmp'] },
  // A check's: the host read-only with its own /dev, no network, a file hidden and a directory bound back.
  {
    what: 'a read-only host without network',
    args: ['--die-with-parent', '--unshare-pid', '--unshare-net', '--new-session', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--ro-bind', '/dev/null', '/tmp/hidden', '--bind', tmpdir(), '/tmp/bound'],
  },
]

/** Runs a probe's command line to its end; throws (with its `stderr`) when it fails. */
export type ProbeRun = (bwrap: string, args: string[]) => void

const runProbe: ProbeRun = (bwrap, args) => {
  execFileSync(bwrap, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000 })
}

/**
 * Why `bwrap` cannot confine a command here, undefined when it can: it runs `true` under each of
 * {@link PROBES} (with `run`, by default for real), once per test file, and names the first that
 * fails, with the first line of what bubblewrap said. Inside a run's check this is a nested
 * bubblewrap, which a host can refuse.
 */
export function refusal(bwrap: string | undefined, run: ProbeRun = runProbe): string | undefined {
  if (!bwrap) return 'no bwrap on PATH'
  for (const probe of PROBES) {
    try {
      run(bwrap, [...probe.args, '--', 'true'])
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n')[0]
      return `${bwrap} cannot run ${probe.what} here${stderr ? ` (${stderr.slice(0, 160)})` : ''}`
    }
  }
  return undefined
}

/** The bubblewrap on PATH (an absolute path), whether or not it can confine here. */
export const BWRAP: string | undefined = onPath('bwrap')
/** Why real bubblewrap cannot confine a command in this environment; undefined when it can. */
export const BWRAP_REFUSED: string | undefined = refusal(BWRAP)
/** Real bubblewrap confines commands here (nested inside a run's check too, when the host lets it). */
export const CAN_CONFINE = BWRAP_REFUSED === undefined
/** Whether the tests that need real bubblewrap run: here it can confine, or CI requires it. */
export const RUNS_CONFINED = CAN_CONFINE || REQUIRE_BWRAP

/**
 * Call inside a `describe` whose tests run commands under real bubblewrap: each of its tests skips,
 * with the reason, where bubblewrap cannot confine (unless CI requires it, when they run and fail).
 */
export function needsBubblewrap(): void {
  beforeEach((context) => {
    if (!RUNS_CONFINED) context.skip(`needs real bubblewrap: ${BWRAP_REFUSED}`)
  })
}

/**
 * Why this process cannot make a directory in `dir` (made with its parents if missing), undefined
 * when it can: inside a run's check the host, the worktree among it, is read-only but for the
 * check's scratch paths and the hidden directories' tmpfs. Decided by making one, then removing it.
 */
export function cannotWrite(dir: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true })
    rmSync(mkdtempSync(join(dir, 'system-writable-')), { recursive: true, force: true })
    return undefined
  } catch (error) {
    return `${dir} cannot be written here (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`
  }
}

/**
 * The mode a file this process creates with `mode` gets in the temporary directory: `mode` less
 * the process's umask (a daemon started by scripts/live-update.sh runs, and runs its checks, with
 * umask 077), as the file system applies it. Read by creating one, never by changing the umask.
 */
export function createdMode(mode: number): number {
  const dir = mkdtempSync(join(tmpdir(), 'system-mode-'))
  try {
    const fd = openSync(join(dir, 'probe'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode)
    try {
      return fstatSync(fd).mode & 0o777
    } finally {
      closeSync(fd)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
