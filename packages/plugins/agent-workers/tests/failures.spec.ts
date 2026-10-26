// What a failed check's result keeps of its output (T270): the failing tests' names and assertion lines, bounded.
import { describe, expect, it } from 'vitest'
import { failureLines, MAX_FAILURE_LINE_CHARS, MAX_FAILURE_LINES } from '../src/failures.ts'

const VITEST = [
  '\u001b[32m ✓ \u001b[39m packages/a/tests/a.spec.ts (3 tests) 4ms',
  ' ❯ packages/b/tests/b.spec.ts (2 tests | 1 failed) 6ms',
  '   × the sum adds up 2ms',
  '',
  ' FAIL  packages/b/tests/b.spec.ts > the sum adds up',
  'AssertionError: expected 3 to be 4 // Object.is equality',
  '- Expected',
  '+ Received',
  ' ❯ packages/b/tests/b.spec.ts:7:21',
  'mkdir: cannot create directory ‘/run/agent-home-x/.local’: Read-only file system',
  ' Test Files  1 failed | 1 passed (2)',
  '      Tests  1 failed | 4 passed (5)',
].join('\n')

describe('the failing lines of a failed check (T270)', () => {
  it('keeps the names of the failing tests, their assertion lines, and the summary, without ANSI codes or noise', () => {
    const lines = failureLines(VITEST)
    expect(lines).toContain(' FAIL  packages/b/tests/b.spec.ts > the sum adds up')
    expect(lines).toContain('AssertionError: expected 3 to be 4 // Object.is equality')
    expect(lines).toContain('   × the sum adds up 2ms')
    expect(lines).toContain(' ❯ packages/b/tests/b.spec.ts:7:21')
    expect(lines.at(-1)).toBe('      Tests  1 failed | 4 passed (5)')
    expect(lines.some((l) => l.includes('Read-only file system'))).toBe(false)
    expect(lines.some((l) => l.includes('a.spec.ts (3 tests)'))).toBe(false)
    expect(lines.join('\n')).not.toContain('\u001b')
  })

  it('is bounded in lines and in each line\'s length, a repeat counted once, the summary kept past the bound', () => {
    const many = [...Array.from({ length: 500 }, (_, i) => ` FAIL  packages/p/tests/t${i}.spec.ts > case ${i}`), ' Test Files  500 failed (500)', '      Tests  500 failed (500)'].join('\n')
    const lines = failureLines(many)
    expect(lines).toHaveLength(MAX_FAILURE_LINES)
    expect(lines[0]).toBe(' FAIL  packages/p/tests/t0.spec.ts > case 0')
    expect(lines.slice(-2)).toEqual([' Test Files  500 failed (500)', '      Tests  500 failed (500)'])
    expect(failureLines(' FAIL  x\n'.repeat(50))).toEqual([' FAIL  x'])
    expect(failureLines(`FAIL ${'y'.repeat(5000)}`)[0]).toHaveLength(MAX_FAILURE_LINE_CHARS)
  })

  it('falls back to the last lines of an output it recognises nothing in', () => {
    const lines = failureLines(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'))
    expect(lines).toHaveLength(20)
    expect(lines.at(-1)).toBe('line 99')
  })
})
