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
