/**
 * What a failed check printed that says why (T270): the failing tests' names and assertion lines, read
 * from the end of its output the source keeps, so the Worker that has to fix it reads them in the
 * task's dossier and never has to open an artifact it cannot. Bounded: {@link MAX_FAILURE_LINES} lines
 * of at most {@link MAX_FAILURE_LINE_CHARS} characters.
 * @module @tsuuanmi/system-agent-workers/failures
 */

/** How many lines of a failed check's output its result keeps (INV-9). */
export const MAX_FAILURE_LINES = 200
/** How long each of those lines may be. */
export const MAX_FAILURE_LINE_CHARS = 240
/** How many of its last lines say it when no line is recognised. */
const FALLBACK_LINES = 20

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** A test run's summary line (vitest's). */
const SUMMARY = /^\s*(Test Files|Tests)\s+\d/

/** A line a test runner (vitest, node:test, TAP), a type checker, or a linter prints for a failure: a name, an assertion, a location, or the summary. */
const FAILURE_LINE = [
  /^\s*(FAIL|FAILED)\b/,
  /^\s*[×✗✖]\s/,
  /^\s*not ok\b/,
  /^\s*❯\s/,
  /\b(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|Error)\b[:[]/,
  /^\s*(Expected|Received|Actual)\b/i,
  /\bexpected\b.+\bto\b/i,
  SUMMARY,
  /^\s*\d+:\d+\s+(error|warning)\b/,
  /\berror\s+TS\d+/,
]

/**
 * The error header vitest prints when a test or a hook passed its time bound (`Error: Test timed out in
 * 5000ms.`), at the start of its line: the same words anywhere else (an assertion's message, its diff, a
 * log line) are no timeout.
 */
const TIMED_OUT = /^\s*Error: (Test|Hook) timed out in \d+ms\b/

/** The longest line {@link TimeoutReader} holds while it waits for the line's end; a longer one in a failure counts as another error. */
const MAX_LINE_CHARS = 8192

/** A line of the code frame vitest prints under an error (`  12| source`, `   | ^`): the test's source, never an error of its own. */
const CODE_FRAME = /^\s*\d*\s*\|/

/**
 * Reads a test run's whole output as it is printed, in bounded state (T292), never only the end the
 * source keeps: whether every failure was a timeout and nothing else. vitest's report (4.x,
 * `printErrorsSummary`) prints a `Failed Suites N` section and a `Failed Tests N` section; in each,
 * every group of identical errors is one or more `FAIL <name>` headings, one per task that had it,
 * then their shared error once, then a `⎯⎯[i/n]⎯⎯` divider. Its summary says `Tests  N failed | …`.
 * The run qualifies only when every group's error is a `Test timed out` or `Hook timed out` and no
 * other error, nothing was unhandled, the summary was read, and its failed tests are exactly the
 * test headings read: a failure it did not read whole never passes for a timeout.
 */
export class TimeoutReader {
  /** The line not ended yet (at most {@link MAX_LINE_CHARS} characters). */
  private partial = ''
  private overlong = false
  /** The section being read: its headings are failed suites (a hook of theirs) or failed tests. */
  private section: 'suites' | 'tests' = 'tests'
  /** The headings of the group being read, by kind; none when no group is open. */
  private groupTests = 0
  private groupSuites = 0
  /** The group's error has begun: a heading after it starts the next group. */
  private groupBody = false
  private failureTimedOut = false
  private failureOther = false
  /** Failed tests, and failed suites, whose error was only a timeout. */
  private timedOut = 0
  private suitesTimedOut = 0
  /** A failure that was not only a timeout, an unhandled error, or a line too long to read. */
  private disqualified = false
  /** Whether the summary's `Tests` line was read, and how many failed tests it counts (0 when it names none). */
  private summaryRead = false
  private summaryFailed = 0

  /** Read the next piece of output. */
  feed(text: string): void {
    let from = 0
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', from)) {
      this.hold(text.slice(from, at))
      this.line()
      from = at + 1
    }
    this.hold(text.slice(from))
  }

  /**
   * How many failures timed out (failed tests, and failed suites whose hook timed out), when every
   * failure read was a timeout and the summary's failed tests are exactly those read; undefined otherwise.
   */
  result(): number | undefined {
    if (this.partial || this.overlong) this.line()
    this.close()
    const failures = this.timedOut + this.suitesTimedOut
    if (this.disqualified || failures === 0 || !this.summaryRead || this.summaryFailed !== this.timedOut) return undefined
    return failures
  }

  private hold(piece: string): void {
    const room = MAX_LINE_CHARS - this.partial.length
    if (piece.length > room) this.overlong = true
    this.partial += piece.slice(0, Math.max(0, room))
  }

  private line(): void {
    const line = this.partial.replace(ANSI, '')
    const overlong = this.overlong
    this.partial = ''
    this.overlong = false
    if (/\bUnhandled (Errors?|Rejections?)\b/.test(line)) this.disqualified = true
    if (/^\s*Tests\s+\d/.test(line)) {
      this.summaryRead = true
      this.summaryFailed = Number(/^\s*Tests\s+(\d+) failed\b/.exec(line)?.[1] ?? 0)
    }
    if (/^\s*FAIL\s/.test(line)) {
      // Headings one after another share the error that follows them; one after an error starts a new group.
      if (this.groupBody) this.close()
      if (this.section === 'suites') this.groupSuites++
      else this.groupTests++
      return
    }
    // A divider or a section's banner (its dashes are fewer on a narrow terminal), or the summary, ends the group.
    if (/⎯{3,}|^\s*⎯/.test(line) || /^\s*Failed (Suites|Tests) \d+\s*⎯*\s*$/.test(line) || SUMMARY.test(line)) {
      this.close()
      if (/\bFailed Suites \d/.test(line)) this.section = 'suites'
      else if (/\bFailed Tests \d/.test(line)) this.section = 'tests'
      return
    }
    if (!this.open() || !line.trim()) return
    this.groupBody = true
    if (CODE_FRAME.test(line) && !overlong) return
    if (TIMED_OUT.test(line)) this.failureTimedOut = true
    else if (overlong || /\b\w*Error\b[:[]/.test(line)) this.failureOther = true
  }

  /** Whether a group of headings is being read. */
  private open(): boolean {
    return this.groupTests + this.groupSuites > 0
  }

  /** End the group being read: each of its tasks counts as a timeout, or the run is disqualified. */
  private close(): void {
    if (!this.open()) return
    if (this.failureTimedOut && !this.failureOther) {
      this.timedOut += this.groupTests
      this.suitesTimedOut += this.groupSuites
    } else this.disqualified = true
    this.groupTests = 0
    this.groupSuites = 0
    this.groupBody = false
    this.failureTimedOut = false
    this.failureOther = false
  }
}

/** {@link TimeoutReader} over a whole `output` (vitest's): how many failures timed out and nothing else; undefined otherwise. */
export function timedOutTests(output: string): number | undefined {
  const reader = new TimeoutReader()
  reader.feed(output)
  return reader.result()
}

/**
 * The failing lines of `output` (a failed check's), in order and without a repeat: at most
 * {@link MAX_FAILURE_LINES}, the run's summary kept last when there are more. When it recognises
 * none, the last few lines of the output.
 */
export function failureLines(output: string): string[] {
  const lines = output.replace(ANSI, '').split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '')
  const clip = (line: string): string => (line.length > MAX_FAILURE_LINE_CHARS ? `${line.slice(0, MAX_FAILURE_LINE_CHARS - 1)}…` : line)
  const found = [...new Set(lines.filter((line) => FAILURE_LINE.some((pattern) => pattern.test(line))).map(clip))]
  if (!found.length) return lines.slice(-FALLBACK_LINES).map(clip)
  if (found.length <= MAX_FAILURE_LINES) return found
  // More than the bound: the first failures, then the summary (its last lines), so the count is never cut.
  const summary = found.filter((line) => SUMMARY.test(line)).slice(-2)
  return [...found.filter((line) => !summary.includes(line)).slice(0, MAX_FAILURE_LINES - summary.length), ...summary]
}
