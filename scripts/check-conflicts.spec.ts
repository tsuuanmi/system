import { describe, expect, it } from 'vitest'
import { findConflictMarkers, scanFile } from './check-conflicts.ts'

// Markers are built at run time, so this file holds none for `check:docs` to find.
const open = `${'<'.repeat(7)} ours`
const base = `${'|'.repeat(7)} base`
const sep = '='.repeat(7)
const close = `${'>'.repeat(7)} theirs`

describe('conflict marker check', () => {
  it('names the file and line of every marker of an unresolved conflict, diff3 base included', () => {
    const text = ['# Notes', '', open, 'ours', base, 'base', sep, 'theirs', close, 'after'].join('\n')
    expect(findConflictMarkers('docs/notes.md', text)).toEqual([
      { file: 'docs/notes.md', line: 3, marker: '<'.repeat(7) },
      { file: 'docs/notes.md', line: 5, marker: '|'.repeat(7) },
      { file: 'docs/notes.md', line: 7, marker: sep },
      { file: 'docs/notes.md', line: 9, marker: '>'.repeat(7) },
    ])
  })

  it('finds markers in CRLF text and bare markers without a label', () => {
    const text = [`${'<'.repeat(7)}`, 'a', sep, 'b', `${'>'.repeat(7)}`, ''].join('\r\n')
    expect(findConflictMarkers('run.sh', text).map((f) => f.line)).toEqual([1, 3, 5])
  })

  it('does not flag a Markdown setext heading, or a line that only starts like a marker', () => {
    const text = ['Title', sep, '', 'Section', '-------', '', `${'<'.repeat(8)} not a marker`, `${'='.repeat(8)}`, `${sep} x`, `x ${'<'.repeat(7)} y`].join('\n')
    expect(findConflictMarkers('README.md', text)).toEqual([])
  })

  it('flags a separator only after an opening marker in the same file', () => {
    const text = ['Title', sep, open, 'a', sep, 'b', close].join('\n')
    expect(findConflictMarkers('a.md', text).map((f) => f.line)).toEqual([3, 5, 7])
  })

  it('skips a binary file: one holding a NUL byte', () => {
    const bytes = Buffer.concat([Buffer.from(`${open}\n${sep}\n${close}\n`), Buffer.from([0, 1, 2])])
    expect(scanFile('image.png', bytes)).toEqual([])
    expect(scanFile('notes.txt', Buffer.from(`${open}\n`))).toEqual([{ file: 'notes.txt', line: 1, marker: '<'.repeat(7) }])
  })
})
