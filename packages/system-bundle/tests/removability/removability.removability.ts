/**
 * The removability matrix (docs/engineering/testing.md#removability-matrix): every optional row of the
 * bundle, turned off alone, then smoked. `pnpm test:removability`, and daily in CI.
 * A failure is named `row <id>, step <name>`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Booted, bootBundle, bundleRows, classes, smoke } from './matrix.ts'

vi.setConfig({ testTimeout: 180_000 })

/** The template under test is contributed by a row that ships off, so the matrix turns it on beside the removal. */
const WITH = ['profile-software-development']

const booted: Booted[] = []
afterEach(async () => {
  while (booted.length) await booted.pop()!.dispose()
})

async function bootAndSmoke(off: string | undefined, baseline: readonly string[] = []): Promise<string[]> {
  const system = await bootBundle(off, WITH)
  booted.push(system)
  return (await smoke(system, off, baseline)).tools
}

describe('every optional row removed, one at a time: System still works', () => {
  const { optional } = classes()
  // Every optional row, those that ship off too: a row that ships off is turned off beside the others' state (the profile row is turned on for the baseline, so its removal is the absent template).
  const rows = bundleRows().filter((r) => optional.includes(r.id)).map((r) => r.id)
  let baseline: string[] = []

  it('baseline: the bundle as shipped, with the software-development profile on, passes the smoke scenario', async () => {
    baseline = await bootAndSmoke(undefined)
    expect(baseline.length).toBeGreaterThan(0)
  })

  it('has optional rows to remove', () => {
    expect(rows.length).toBeGreaterThan(0)
  })

  for (const id of rows) {
    it(`row ${id} off`, async () => {
      await bootAndSmoke(id, baseline)
    })
  }
})
