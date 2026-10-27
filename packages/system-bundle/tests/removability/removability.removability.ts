/**
 * The removability matrix (docs/engineering/testing.md#removability-matrix): every optional row of the
 * bundle, turned off alone, then smoked; and each one on in the baseline turned off and on again in the
 * running bundle, smoked after each turn (T322). `pnpm test:removability`, and daily in CI.
 * A failure is named `row <id>, step <name>`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Booted, bootBundle, bundleRows, classes, cycleShippedOff, smoke, switches, turnRow } from './matrix.ts'

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

describe('every optional row turned off and on again at runtime, one at a time, no restart: System still works (T322, ADR-0078)', () => {
  const { optional } = classes()
  // The rows on in the matrix's baseline turn off, then on; each that ships off turns on, then off (below).
  const rows = bundleRows().filter((r) => optional.includes(r.id) && (!r.disabled || WITH.includes(r.id))).map((r) => r.id)
  const shippedOff = bundleRows().filter((r) => optional.includes(r.id) && r.disabled && !WITH.includes(r.id)).map((r) => r.id)
  let baseline: string[] = []

  it('baseline', async () => {
    baseline = await bootAndSmoke(undefined)
  })

  for (const id of rows) {
    it(`row ${id}: off, smoke, on, smoke`, async () => {
      const system = await bootBundle(undefined, WITH)
      booted.push(system)
      if (id === 'mcp-server') {
        // The surface the switches are served on is never turned off at runtime (ADR-0078); its patch turns it off, above.
        await expect(switches(system).turn(id, false)).rejects.toMatchObject({ failure: 'control' })
        await smoke(system, undefined, baseline)
        return
      }
      const off = await turnRow(system, id, false)
      await smoke(off, id, baseline)
      const on = await turnRow(off, id, true)
      expect((await smoke(on, undefined, baseline)).tools).toEqual(baseline)
    })
  }

  it('has rows that ship off to turn on', () => {
    expect(shippedOff.length).toBeGreaterThan(0)
  })

  for (const id of shippedOff) {
    it(`row ${id}, shipped off: on, smoke, off, smoke`, async () => {
      const system = await bootBundle(undefined, WITH)
      booted.push(system)
      await cycleShippedOff(system, id, baseline)
    })
  }
})
