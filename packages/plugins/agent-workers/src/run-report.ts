/**
 * A writing run's report file (T265, docs/design/agent-runtimes.md#credentials-and-egress): what a
 * test run its agent started in its own tool call says it did not run, as a check's command says it on
 * its report file (./setup.ts `reportChannel`, T247). The run's runtime binds the file into the
 * agent's confinement writable and names it in `SYSTEM_CHECK_REPORT_PATH` to its commands
 * (`RunSpec.reportFile`); the repository's test reporter appends `browser-tests-not-run: <why>`
 * there when browser tests were skipped (scripts/browser-skips.ts). Once the run ended the source
 * reads it, and the run's result says so (`agent-result@1.5` `notRun`), so the review is told its
 * browser tests did not run where the Worker ran them. A report file that could not be made, or
 * cannot be read once the run ended, is said as such (`reportUnread`): never taken for a report
 * that names no skipped test.
 * @module @tsuuanmi/system-agent-workers/run-report
 */
import { closeSync, constants, mkdtempSync, openSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ensurePrivateDir } from '@tsuuanmi/system-libs'
import { BROWSER_TESTS_NOT_RUN, readReport } from './setup.ts'

/**
 * What a writing run's report file came to: `notRun`, what its commands reported they did not run
 * (`its browser tests (<why>)`); `unread`, why what they reported is not known (the file could not be
 * made, or read). Neither: it was read, and names nothing that did not run.
 */
export interface RunReported {
  notRun?: string
  unread?: string
}

/** A writing run's report file: its path, and how it is read and removed once the run ended. */
export interface RunReport {
  path: string
  /** What the run's commands reported, read once the run ended. */
  read(): RunReported
  dispose(): void
}

/**
 * A fresh, empty, owner-only report file for one writing run, in its own owner-only directory under
 * `parent` (the source's private directory, outside every worktree, hidden from agents and bound
 * back only as this one file). Throws when it cannot be made.
 */
export function runReport(parent: string): RunReport {
  ensurePrivateDir(parent)
  const dir = mkdtempSync(join(parent, 'run-report-'))
  const path = join(dir, 'report')
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600))
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return { path, read: () => reportedIn(readReport(path)), dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** What a read of the report file came to: its unread reason kept, else what its lines say. */
export function reportedIn(read: { report?: string; reportUnread?: string }): RunReported {
  if (read.reportUnread !== undefined) return { unread: `its report file cannot be read: ${read.reportUnread}`.slice(0, 300) }
  const notRun = notRunIn(read.report)
  return notRun !== undefined ? { notRun } : {}
}

/**
 * What a report says did not run: `its browser tests (<why>)` for its first `browser-tests-not-run`
 * line, as a check's `notRun` says it; undefined when it says nothing of them.
 */
export function notRunIn(report: string | undefined): string | undefined {
  for (const line of (report ?? '').split('\n')) {
    const text = line.trim()
    if (text === BROWSER_TESTS_NOT_RUN) return 'its browser tests'
    if (text.startsWith(`${BROWSER_TESTS_NOT_RUN}:`)) {
      const why = text.slice(BROWSER_TESTS_NOT_RUN.length + 1).trim().slice(0, 280)
      return `its browser tests${why ? ` (${why})` : ''}`
    }
  }
  return undefined
}
