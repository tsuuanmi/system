/**
 * Unresolved git conflict markers in any tracked text file (docs/engineering/testing.md#ci-gates),
 * run by `check:docs`. TypeScript conflicts fail `tsc`, but Markdown, YAML, shell scripts, and other
 * text files would pass every other check. The rule, per line (a trailing `\r` ignored):
 *
 * - `<<<<<<<`, `|||||||` (diff3's base), or `>>>>>>>`: exactly seven of the character, then the end
 *   of the line or a space and a label, is always a marker;
 * - `=======`: exactly seven `=` and nothing else, is a marker only when a `<<<<<<<` marker comes
 *   before it in the same file. Alone it is a Markdown setext heading underline, not a conflict.
 *
 * A finding names the file and line. A file holding a NUL byte is binary and skipped.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ConflictFinding { file: string; line: number; marker: string }

const OPENING = /^<{7}(?: .*)?$/
const ALWAYS = /^(?:<{7}|\|{7}|>{7})(?: .*)?$/
const SEPARATOR = /^={7}$/

/** The conflict markers in one text, by the rule above. */
export function findConflictMarkers(file: string, content: string): ConflictFinding[] {
  const findings: ConflictFinding[] = []
  let opened = false
  content.split('\n').forEach((raw, index) => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (ALWAYS.test(text)) {
      if (OPENING.test(text)) opened = true
      findings.push({ file, line: index + 1, marker: text.slice(0, 7) })
    } else if (opened && SEPARATOR.test(text)) {
      findings.push({ file, line: index + 1, marker: text })
    }
  })
  return findings
}

/** The conflict markers in one file's bytes; none for a binary file (one holding a NUL byte). */
export function scanFile(file: string, buffer: Buffer): ConflictFinding[] {
  return buffer.includes(0) ? [] : findConflictMarkers(file, buffer.toString('utf8'))
}

/** Every tracked file of the repository at `root`, scanned. */
export function checkConflicts(root: string): ConflictFinding[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const findings: ConflictFinding[] = []
  for (const file of files) {
    let buffer: Buffer
    try {
      buffer = readFileSync(join(root, file))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EISDIR') continue // deleted in the working tree, or a submodule
      throw error
    }
    findings.push(...scanFile(file, buffer))
  }
  return findings
}
