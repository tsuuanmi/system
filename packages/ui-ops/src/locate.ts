/** Compile UI map candidates to engine locators, and back (for overlay entries). */
import type { Locator, Page } from 'patchright-core'
import type { Candidate, Localized } from './map.ts'

type Root = Page | Locator

/** One regex accepting any configured locale's variant. */
export function localizedRegex(names: Localized, locales: readonly string[]): RegExp {
  const sources = locales.map((l) => names[l]).filter((s): s is string => typeof s === 'string')
  const all = sources.length ? sources : Object.values(names)
  return new RegExp(all.map((s) => `(?:${s})`).join('|'), 'i')
}

type AriaRole = Parameters<Page['getByRole']>[0]

export function toLocator(root: Root, candidate: Candidate, locales: readonly string[]): Locator {
  if ('testId' in candidate) return root.getByTestId(candidate.testId)
  if ('role' in candidate) {
    const role = candidate.role as AriaRole
    return candidate.name
      ? root.getByRole(role, { name: localizedRegex(candidate.name, locales), exact: candidate.exact ?? false })
      : root.getByRole(role)
  }
  if ('label' in candidate) return root.getByLabel(localizedRegex(candidate.label, locales))
  if ('text' in candidate) return root.getByText(localizedRegex(candidate.text, locales))
  return root.locator(candidate.css)
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Turn a normalized locator (`locator.normalize()`) into a map candidate, so a healed
 * element can be written to the overlay. Only durable forms are accepted.
 */
export function candidateFromLocator(locator: Locator, locale: string): Candidate | undefined {
  const text = String(locator)
  const testId = /^getByTestId\('((?:[^'\\]|\\.)*)'\)$/.exec(text)
  if (testId) return { testId: testId[1]!.replace(/\\(.)/g, '$1') }
  const role = /^getByRole\('([a-z]+)', \{ name: '((?:[^'\\]|\\.)*)'(?:, exact: true)? \}\)$/.exec(text)
  if (role) return { role: role[1]!, name: { [locale]: `^${escapeRegex(role[2]!.replace(/\\(.)/g, '$1'))}$` } }
  return undefined
}
