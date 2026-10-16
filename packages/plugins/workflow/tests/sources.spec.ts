import { describe, expect, it } from 'vitest'
import { fitSource, renderSource } from '../src/sources.ts'

const repository = { url: 'https://github.com/o/r', commit: 'a'.repeat(40), pinnedBy: 'ref' as const }
const file = (path: string, lines: number, width = 40) => ({ path, sha: 'b'.repeat(40), text: Array.from({ length: lines }, (_, i) => `${i}`.padEnd(width, 'x')).join('\n') })

describe('fitSource: what a member reads fits the smallest member input (INV-9)', () => {
  it('keeps every file when all fit, and shows the source exactly as rendered', () => {
    const files = [file('README.md', 10), file('src/a.ts', 20)]
    const fitted = fitSource(files, [{ path: 'x.lock', why: 'lockfile' }], repository, 24_000)
    expect(fitted.files).toEqual(files)
    expect(fitted.text).toBe(renderSource(files, [{ path: 'x.lock', why: 'lockfile' }], repository))
  })

  it('shows files in order while they fit, lists the rest as not shown (bounds), and stays within the budget', () => {
    const files = [file('README.md', 100), file('src/big.ts', 2000), file('src/small.ts', 50)]
    const unread = Array.from({ length: 20_000 }, (_, i) => ({ path: `pkg/m${i}/file${i}.ts`, why: 'not-selected' as const }))
    const fitted = fitSource(files, unread, repository, 24_000)
    expect(fitted.files.map((f) => f.path)).toEqual(['README.md', 'src/small.ts'])
    expect(fitted.unread[0]).toEqual({ path: 'src/big.ts', why: 'bounds' })
    expect(fitted.unread).toHaveLength(20_001)
    expect(fitted.text.length).toBeLessThanOrEqual(24_000)
    expect(fitted.text).toMatch(/### Not shown \(20001\)[\s\S]*… and \d+ more/)
  })

  it('keeps short-line files to their rendered size, not their bytes', () => {
    // 5,000 one-character lines: 10 KB of bytes, but over 40,000 characters line-numbered.
    const fitted = fitSource([file('data.txt', 5000, 1)], [], repository, 24_000)
    expect(fitted.files).toEqual([])
    expect(fitted.unread).toEqual([{ path: 'data.txt', why: 'bounds' }])
  })
})
