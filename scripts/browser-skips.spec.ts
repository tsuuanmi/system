import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestCase } from 'vitest/node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_SKIP, BrowserSkips, REPORT_PATH, REPORT_WORD, summary } from './browser-skips.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** A finished test case as vitest hands it to a reporter: only what the reporter reads. */
const finished = (state: 'passed' | 'skipped', note?: string): TestCase => ({ result: () => ({ state, ...(note ? { note } : {}) }) }) as unknown as TestCase

const WHY = `${BROWSER_SKIP}: no usable Chrome (CHROME_PATH, a system Chrome no older than the engine, the managed build in $DSH_HOME/system/browsers, or ~/.cache/system-chrome)`

describe('browser tests that did not run are said loudly (T247)', () => {
  it('counts the tests skipped for want of a browser, each distinct reason once, and nothing else skipped', () => {
    expect(summary([])).toBeUndefined()
    expect(summary(['needs real bubblewrap: no bwrap on PATH'])).toBeUndefined()
    expect(summary([WHY])).toBe('1 browser test skipped: no usable Chrome (CHROME_PATH, a system Chrome no older than the engine, the managed build in $DSH_HOME/system/browsers, or ~/.cache/system-chrome)')
    expect(summary([WHY, WHY, `${BROWSER_SKIP}: no Xvfb on PATH`, 'other'])).toMatch(/^3 browser tests skipped: no usable Chrome \(.*\); no Xvfb on PATH$/)
    expect(summary([BROWSER_SKIP])).toBe('1 browser test skipped')
  })

  it('prints one line at the end of the run and appends browser-tests-not-run to a check\'s report file; says nothing when every browser test ran', () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-browser-skips-'))
    dirs.push(dir)
    const path = join(dir, 'report')
    writeFileSync(path, '')
    const printed: string[] = []
    const fail = vi.fn()
    const reporter = new BrowserSkips({ path, print: (line) => printed.push(line), fail })
    reporter.onTestCaseResult(finished('passed'))
    reporter.onTestCaseResult(finished('skipped'))
    reporter.onTestRunEnd()
    expect(printed).toEqual([])
    reporter.onTestCaseResult(finished('skipped', WHY))
    reporter.onTestCaseResult(finished('skipped', WHY))
    reporter.onTestRunEnd()
    expect(printed).toHaveLength(1)
    expect(printed[0]).toMatch(/^\n!!! BROWSER TESTS DID NOT RUN: 2 browser tests skipped: no usable Chrome \(.*\)\. A pass of this run says nothing of them\.$/)
    expect(readFileSync(path, 'utf8')).toMatch(new RegExp(`^${REPORT_WORD}: 2 browser tests skipped: no usable Chrome \\(.*\\)\\n$`))
    expect(fail).not.toHaveBeenCalled()
  })

  it('writes to the report file SYSTEM_CHECK_REPORT_PATH names, which reaches it through any runner (pnpm\'s passes only fds 0 to 2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-browser-skips-'))
    dirs.push(dir)
    const path = join(dir, 'report')
    writeFileSync(path, '')
    vi.stubEnv(REPORT_PATH, path)
    try {
      const reporter = new BrowserSkips({ print: () => undefined })
      reporter.onTestCaseResult(finished('skipped', WHY))
      reporter.onTestRunEnd()
    } finally {
      vi.unstubAllEnvs()
    }
    expect(readFileSync(path, 'utf8')).toMatch(new RegExp(`^${REPORT_WORD}: 1 browser test skipped: no usable Chrome \\(.*\\)\\n$`))
  })

  it('fails the run, loudly, when the check\'s report file cannot be written: the check is never left to read the skipped tests\' silence as a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-browser-skips-'))
    dirs.push(dir)
    for (const path of [join(dir, 'missing', 'report'), 'relative/report']) {
      const printed: string[] = []
      const fail = vi.fn()
      const reporter = new BrowserSkips({ path, print: (line) => printed.push(line), fail })
      reporter.onTestCaseResult(finished('skipped', WHY))
      reporter.onTestRunEnd()
      expect(fail, path).toHaveBeenCalledOnce()
      expect(printed[1], path).toMatch(new RegExp(`^!!! THE CHECK WAS NOT TOLD: its report file ${path} cannot be written \\((ENOENT|not an absolute path)\\); this run fails`))
    }
    // Outside a check (no report file named), the printed line is all: nothing fails.
    vi.stubEnv(REPORT_PATH, '')
    try {
      const fail = vi.fn()
      const reporter = new BrowserSkips({ print: () => undefined, fail })
      reporter.onTestCaseResult(finished('skipped', WHY))
      reporter.onTestRunEnd()
      expect(fail).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
