/**
 * Browser tests that did not run, said loudly (T247): a vitest reporter beside the default one that
 * counts the tests skipped with a note starting `browser tests did not run` (the note
 * `headlessIt` gives, packages/plugins/browser-patchright/tests/support.ts) and, at the end of the
 * run, prints one line naming how many and why, after everything else, so the end of the output a
 * check keeps holds it. When the run is a check's (`SYSTEM_CHECK_REPORT_PATH` names its report file,
 * which reaches the suite through any runner, docs/design/agent-runtimes.md#a-runs-checks), it
 * appends `browser-tests-not-run: <detail>` there too, so the check's answer, and the review, say that
 * a pass does not cover them. A report that cannot be written fails the run, loudly: a check must
 * never read the skipped tests' silence as a pass.
 */
import { appendFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Reporter, TestCase } from 'vitest/node'

/** The words every browser test's skip note starts with (support.ts `BROWSER_SKIP`). */
export const BROWSER_SKIP = 'browser tests did not run'
/** The word of the line in a check's report file (agent-workers `BROWSER_TESTS_NOT_RUN`). */
export const REPORT_WORD = 'browser-tests-not-run'
/** The variable that names a check's report file (agent-workers `REPORT_PATH`). */
export const REPORT_PATH = 'SYSTEM_CHECK_REPORT_PATH'

/** What the skipped browser tests come to: their count and each distinct reason, or undefined when none was skipped. */
export function summary(notes: readonly string[]): string | undefined {
  const skipped = notes.filter((note) => note.startsWith(BROWSER_SKIP))
  if (!skipped.length) return undefined
  const why = [...new Set(skipped.map((note) => note.slice(BROWSER_SKIP.length).replace(/^:\s*/, '').trim()).filter(Boolean))]
  return `${skipped.length} browser test${skipped.length === 1 ? '' : 's'} skipped${why.length ? `: ${why.join('; ')}` : ''}`
}

export class BrowserSkips implements Reporter {
  private readonly notes: string[] = []
  private readonly options: { path?: string; print?: (line: string) => void; fail?: () => void }

  /**
   * `path`: the check's report file (default: the one `SYSTEM_CHECK_REPORT_PATH` names, if any);
   * `print`: where the lines go; `fail`: how a report that cannot be written fails the run.
   */
  constructor(options: { path?: string; print?: (line: string) => void; fail?: () => void } = {}) {
    this.options = options
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result()
    if (result.state === 'skipped' && result.note) this.notes.push(result.note)
  }

  onTestRunEnd(): void {
    const said = summary(this.notes)
    this.notes.length = 0
    if (!said) return
    const print = this.options.print ?? ((line: string) => void process.stderr.write(`${line}\n`))
    print(`\n!!! ${BROWSER_SKIP.toUpperCase()}: ${said}. A pass of this run says nothing of them.`)
    const path = this.options.path ?? process.env[REPORT_PATH]
    if (!path) return
    try {
      if (!isAbsolute(path)) throw new Error('not an absolute path')
      appendFileSync(path, `${REPORT_WORD}: ${said.slice(0, 280)}\n`)
    } catch (error) {
      print(`!!! THE CHECK WAS NOT TOLD: its report file ${path} cannot be written (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); this run fails, so its pass is never read as covering the browser tests.`)
      ;(this.options.fail ?? (() => void (process.exitCode = 1)))()
    }
  }
}
