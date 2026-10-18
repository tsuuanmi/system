import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sweepStale } from './test-tmp.ts'

describe('test temporary parents', () => {
  it('runs this file under its run\'s own parent', () => {
    expect(tmpdir()).toMatch(/\/system-test-\d+-[^/]+$/)
  })

  it('removes only the parents of runs that are gone, and nothing else', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'))
    try {
      for (const name of ['system-test-111-aaa', 'system-test-222-bbb', 'system-other', 'system-test-x-ccc']) mkdirSync(join(root, name))
      expect(sweepStale(root, (pid) => pid === 222)).toEqual(['system-test-111-aaa'])
      expect(['system-test-111-aaa', 'system-test-222-bbb', 'system-other', 'system-test-x-ccc'].map((n) => existsSync(join(root, n)))).toEqual([false, true, true, true])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
