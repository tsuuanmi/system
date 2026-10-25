import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { durationKey, durationsFromReport, order, readDurations } from './test-durations.ts'

const self = (path: string): string => path

describe('test file order by the committed duration table (docs/engineering/testing.md#test-groups)', () => {
  it('starts the files the table does not hold first, in the order they came, then the rest longest first', () => {
    const table = { 'a.spec.ts': 1, 'b.spec.ts': 40, 'c.spec.ts': 7.5 }
    expect(order(['a.spec.ts', 'new-1.spec.ts', 'b.spec.ts', 'new-2.spec.ts', 'c.spec.ts'], self, table))
      .toEqual(['new-1.spec.ts', 'new-2.spec.ts', 'b.spec.ts', 'c.spec.ts', 'a.spec.ts'])
    // The unknown keep vitest's order among themselves, whichever way it came.
    expect(order(['new-2.spec.ts', 'c.spec.ts', 'new-1.spec.ts'], self, table)).toEqual(['new-2.spec.ts', 'new-1.spec.ts', 'c.spec.ts'])
  })

  it('keeps the order it was given among equal times, and keeps it whole for an empty table', () => {
    expect(order(['x', 'y', 'z'], self, { x: 3, y: 3, z: 3 })).toEqual(['x', 'y', 'z'])
    expect(order(['z', 'y', 'x'], self, { x: 3, y: 3, z: 3 })).toEqual(['z', 'y', 'x'])
    expect(order(['c', 'a', 'b'], self, {})).toEqual(['c', 'a', 'b'])
    // A file timed at 0 s is known, not new: it starts last.
    expect(order(['zero', 'new'], self, { zero: 0 })).toEqual(['new', 'zero'])
    // Neither a key the table lacks by name only (an inherited property) nor the input is touched.
    const input = ['constructor', 'b']
    expect(order(input, self, { b: 1 })).toEqual(['constructor', 'b'])
    expect(input).toEqual(['constructor', 'b'])
  })

  it('orders by the key of each item, a path from the root', () => {
    const specs = [{ moduleId: '/repo/scripts/a.spec.ts' }, { moduleId: '/repo/packages/x/tests/b.spec.ts' }]
    expect(order(specs, (s) => durationKey('/repo', s.moduleId), { 'scripts/a.spec.ts': 2, 'packages/x/tests/b.spec.ts': 9 }).map((s) => s.moduleId))
      .toEqual(['/repo/packages/x/tests/b.spec.ts', '/repo/scripts/a.spec.ts'])
    expect(durationKey('/repo', 'scripts/a.spec.ts')).toBe('scripts/a.spec.ts')
  })

  it('makes the table from a vitest JSON report: seconds to a tenth, keyed from the root, in key order', () => {
    const table = durationsFromReport({
      testResults: [
        { name: '/repo/scripts/z.spec.ts', startTime: 1_000, endTime: 13_349 },
        { name: '/repo/packages/a/tests/a.spec.ts', startTime: 5_000, endTime: 5_040 },
      ],
    }, '/repo')
    expect(table).toEqual({ 'packages/a/tests/a.spec.ts': 0, 'scripts/z.spec.ts': 12.3 })
    expect(Object.keys(table)).toEqual(['packages/a/tests/a.spec.ts', 'scripts/z.spec.ts'])
  })

  it('reads the committed table, and takes a missing or malformed one, or a bad entry, as no time', () => {
    for (const [file, seconds] of Object.entries(readDurations())) {
      expect(file).toMatch(/^(scripts|packages)\/.+\.spec\.ts$/)
      expect(seconds).toBeGreaterThanOrEqual(0)
    }
    const dir = mkdtempSync(join(tmpdir(), 'durations-'))
    try {
      expect(readDurations(join(dir, 'none.json'))).toEqual({})
      writeFileSync(join(dir, 'broken.json'), '{ not json')
      expect(readDurations(join(dir, 'broken.json'))).toEqual({})
      writeFileSync(join(dir, 'list.json'), '[1, 2]')
      expect(readDurations(join(dir, 'list.json'))).toEqual({})
      writeFileSync(join(dir, 'mixed.json'), JSON.stringify({ 'a.spec.ts': 4, 'b.spec.ts': 'slow', 'c.spec.ts': -1 }))
      expect(readDurations(join(dir, 'mixed.json'))).toEqual({ 'a.spec.ts': 4 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
