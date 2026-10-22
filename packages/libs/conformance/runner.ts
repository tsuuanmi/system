/**
 * The conformance runner for seams defined after ADR-0037, modelled on
 * `@modelcontextprotocol/conformance`: a suite is a list of scenarios with stable ids, each
 * applying from one contract version on; a provider pins the contract version it implements,
 * and runs every scenario that applies to it. Known failures are named in a baseline, which
 * goes stale (and fails) as soon as the scenario passes. Test-only: never shipped.
 */
import { describe, it } from 'vitest'

/** A contract version, `<major>.<minor>`. */
export type ContractVersion = `${number}.${number}`

export interface Scenario<Boot> {
  /** Stable id, never reused: `<seam>.<what>`, for example `approvals.expiry-rejects`. */
  id: string
  /** The first contract version the scenario applies to. */
  since: ContractVersion
  /** What it proves, citing the invariant or requirement it covers. */
  title: string
  run: (boot: Boot) => Promise<void>
}

export interface Suite<Boot> {
  /** The ctx key of the seam. */
  seam: string
  /** The latest contract version the suite knows. */
  contract: ContractVersion
  scenarios: Array<Scenario<Boot>>
}

export interface Provider<Boot> {
  name: string
  /** The contract version the provider implements; its major must be the suite's. */
  contract: ContractVersion
  boot: Boot
  /** Scenario ids known to fail, each with the reason; a baselined scenario that passes fails the run. */
  expectedFailures?: Record<string, string>
}

const parse = (version: ContractVersion): [number, number] => version.split('.').map(Number) as [number, number]
const atOrBefore = (a: ContractVersion, b: ContractVersion): boolean => {
  const [am, an] = parse(a)
  const [bm, bn] = parse(b)
  return am < bm || (am === bm && an <= bn)
}

/** Check a suite's shape once, where it is defined: unique ids, and no scenario newer than the suite. */
export function defineSuite<Boot>(suite: Suite<Boot>): Suite<Boot> {
  const ids = new Set<string>()
  for (const scenario of suite.scenarios) {
    if (!scenario.id.startsWith(`${suite.seam}.`)) throw new Error(`scenario ${scenario.id} is not named under ${suite.seam}.`)
    if (ids.has(scenario.id)) throw new Error(`duplicate scenario ${scenario.id}`)
    if (!atOrBefore(scenario.since, suite.contract)) throw new Error(`scenario ${scenario.id} is newer (${scenario.since}) than the suite (${suite.contract})`)
    ids.add(scenario.id)
  }
  return suite
}

/** The scenarios a provider pinned at `contract` must pass. */
export function applicable<Boot>(suite: Suite<Boot>, contract: ContractVersion): Array<Scenario<Boot>> {
  if (parse(contract)[0] !== parse(suite.contract)[0]) throw new Error(`${suite.seam}: a provider of contract ${contract} cannot run suite ${suite.contract} (another major)`)
  if (!atOrBefore(contract, suite.contract)) throw new Error(`${suite.seam}: the provider pins ${contract}, newer than this suite (${suite.contract})`)
  return suite.scenarios.filter((s) => atOrBefore(s.since, contract))
}

/** Register the suite's applicable scenarios as tests of one provider. */
export function runSuite<Boot>(suite: Suite<Boot>, provider: Provider<Boot>): void {
  const scenarios = applicable(suite, provider.contract)
  const expected = provider.expectedFailures ?? {}
  for (const id of Object.keys(expected)) {
    if (!scenarios.some((s) => s.id === id)) throw new Error(`${provider.name}: the baseline names ${id}, which is not a scenario of ${suite.seam}@${provider.contract}`)
  }
  describe(`ctx.${suite.seam} conformance @${provider.contract}: ${provider.name}`, () => {
    for (const scenario of scenarios) {
      const title = `${scenario.id}: ${scenario.title}`
      // A baselined scenario must still fail; once it passes, the baseline is stale and the run fails.
      if (scenario.id in expected) it.fails(`${title} [expected to fail: ${expected[scenario.id]}]`, () => scenario.run(provider.boot))
      else it(title, () => scenario.run(provider.boot))
    }
  })
}
