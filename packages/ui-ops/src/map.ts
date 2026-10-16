/**
 * Load a provider's UI map (`ui-map@1.0`, schemas/ui-map.v1.json) and merge the local
 * overlay. Overlay candidates come after the shipped ones and are tagged, so the
 * shipped map always wins when it still works (docs/design/ui-operations.md).
 */
import { type ContentId, SchemaRegistry, contentId } from '@tsuuanmi/system-libs'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensurePrivateDir, writeFileDurable } from '@tsuuanmi/system-libs'
import { parse, parseDocument } from 'yaml'

export type Localized = Record<string, string>

export type Candidate =
  | { testId: string }
  | { role: string; name?: Localized; exact?: boolean }
  | { label: Localized }
  | { text: Localized }
  | { css: string }

export type SourcedCandidate = Candidate & { source: 'shipped' | 'overlay' }

export type Condition =
  | { visible: string } | { hidden: string } | { countIncreased: string }
  | { attr: { of: string; name: string; equals?: string; present?: boolean } }
  | { url: string } | { network: string } | { state: string }
  | { stableTextMs: number; of: string }
  | { anyOf: Condition[] } | { allOf: Condition[] } | { not: Condition }

export interface Fingerprint {
  role?: string
  name?: Localized
  nearRole?: string
}

export interface ElementSpec {
  description?: string
  /** `any` searches every frame (a report rendered in an iframe); such elements take no scope. */
  frames?: 'main' | 'any'
  /** Not yet checked on the live site (`ui-map@1.2`): no irreversible action may depend on it. */
  unverified?: true
  scope?: string
  cardinality?: 'one' | 'many'
  candidates: SourcedCandidate[]
  fingerprint?: Fingerprint
}

export type SideEffect = 'none' | 'reversible' | 'irreversible'

export interface ActionSpec {
  description?: string
  do: 'click' | 'insertText' | 'press' | 'setFiles' | 'select'
  target: string
  key?: string
  require?: Array<'enabled' | 'editable'>
  fallback?: { press: string; on: string }
  verify: Condition
  sideEffect: SideEffect
  heal?: 'off' | 'deterministic' | 'model'
  timeouts?: { resolveMs?: number; verifyMs?: number }
  /** Not yet checked on the live site (`ui-map@1.2`). */
  unverified?: true
}

export interface NetworkPattern {
  url: string
  method?: string
  status?: number
  contentType?: string
  open?: boolean
  header?: { name: string; equals?: string }
}

export interface ErrorRule {
  when: Condition
  kind: 'challenge' | 'reauth_required' | 'quota_exhausted' | 'invalid_input' | 'provider_stalled' | 'network' | 'session_broken'
  message?: string
}

export interface UiMap {
  schema: 'ui-map@1.0' | 'ui-map@1.1' | 'ui-map@1.2'
  provider: string
  uiRevision: string
  locales: string[]
  elements: Record<string, ElementSpec>
  actions: Record<string, ActionSpec>
  network: Record<string, NetworkPattern>
  states: Record<string, Condition>
  errors: ErrorRule[]
  /** Content address of the merged map, recorded with heals and diagnostics. */
  hash: ContentId
}

/** The map's elements and actions under `prefix` that are not yet checked on the live site. */
export function unverifiedEntries(map: Pick<UiMap, 'elements' | 'actions'>, prefix: string): string[] {
  return [...Object.entries(map.elements), ...Object.entries(map.actions)].filter(([id, spec]) => id.startsWith(prefix) && spec.unverified).map(([id]) => id).sort()
}

let registry: SchemaRegistry | undefined

function references(map: Omit<UiMap, 'hash'>): string[] {
  const missing: string[] = []
  const element = (id: string, where: string): void => {
    if (!map.elements[id]) missing.push(`${where}: unknown element ${id}`)
  }
  const walk = (c: Condition, where: string): void => {
    if ('visible' in c) element(c.visible, where)
    else if ('hidden' in c) element(c.hidden, where)
    else if ('countIncreased' in c) element(c.countIncreased, where)
    else if ('attr' in c) element(c.attr.of, where)
    else if ('stableTextMs' in c) element(c.of, where)
    else if ('network' in c) { if (!map.network[c.network]) missing.push(`${where}: unknown network signal ${c.network}`) }
    else if ('state' in c) { if (!map.states[c.state]) missing.push(`${where}: unknown state ${c.state}`) }
    else if ('anyOf' in c) c.anyOf.forEach((x) => walk(x, where))
    else if ('allOf' in c) c.allOf.forEach((x) => walk(x, where))
    else if ('not' in c) walk(c.not, where)
  }
  for (const [id, e] of Object.entries(map.elements)) if (e.scope) element(e.scope, `elements.${id}.scope`)
  for (const [id, a] of Object.entries(map.actions)) {
    element(a.target, `actions.${id}.target`)
    if (a.fallback) element(a.fallback.on, `actions.${id}.fallback`)
    walk(a.verify, `actions.${id}.verify`)
  }
  for (const [id, s] of Object.entries(map.states)) walk(s, `states.${id}`)
  map.errors.forEach((e, i) => walk(e.when, `errors[${i}]`))
  return missing
}

/**
 * Parse and validate a shipped map (YAML or JSON text), then append the overlay's
 * candidates. The overlay may only add candidates to elements the map defines.
 */
export function loadUiMap(text: string, overlayText?: string): UiMap {
  registry ??= new SchemaRegistry()
  const raw = parse(text) as Record<string, unknown>
  registry.assert('ui-map@1.0', raw)
  const shipped = raw as unknown as Omit<UiMap, 'hash' | 'actions' | 'network' | 'states' | 'errors'> & Partial<UiMap>
  const elements: Record<string, ElementSpec> = {}
  for (const [id, e] of Object.entries(shipped.elements)) {
    elements[id] = { ...e, candidates: e.candidates.map((c) => ({ ...c, source: 'shipped' as const })) }
  }
  if (overlayText) {
    const overlay = (parse(overlayText) ?? {}) as { elements?: Record<string, { candidates?: Candidate[] }> }
    for (const [id, e] of Object.entries(overlay.elements ?? {})) {
      const target = elements[id]
      if (!target) throw new Error(`UI overlay names an unknown element: ${id}`)
      for (const c of e.candidates ?? []) target.candidates.push({ ...c, source: 'overlay' })
    }
  }
  const map = {
    schema: shipped.schema,
    provider: shipped.provider,
    uiRevision: shipped.uiRevision,
    locales: shipped.locales,
    elements,
    actions: shipped.actions ?? {},
    network: shipped.network ?? {},
    states: shipped.states ?? {},
    errors: shipped.errors ?? [],
  }
  const missing = references(map)
  if (missing.length) throw new Error(`UI map ${map.provider} has dangling references: ${missing.join('; ')}`)
  if (overlayText) registry.assert('ui-map@1.0', { ...raw, elements: stripSources(elements) })
  return { ...map, hash: contentId(map) }
}

function stripSources(elements: Record<string, ElementSpec>): Record<string, unknown> {
  const plain = (c: SourcedCandidate): Candidate => {
    const copy: Partial<SourcedCandidate> = { ...c }
    delete copy.source
    return copy as Candidate
  }
  return Object.fromEntries(Object.entries(elements).map(([id, e]) => [id, { ...e, candidates: e.candidates.map(plain) }]))
}

/**
 * Append a verified healed candidate to a local overlay file (owner-only, durable). A
 * candidate already present is not added twice. The shipped map is never modified; the
 * comment names the decision so the change can be reviewed and promoted.
 */
export function appendOverlay(path: string, element: string, candidate: Candidate, note: string): boolean {
  ensurePrivateDir(dirname(path))
  const doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : 'elements: {}\n')
  const list = (doc.getIn(['elements', element, 'candidates']) as { toJSON(): unknown } | undefined)?.toJSON() as Candidate[] | undefined
  if (list?.some((c) => JSON.stringify(c) === JSON.stringify(candidate))) return false
  if (!list) doc.setIn(['elements', element, 'candidates'], doc.createNode([]))
  const node = doc.createNode(candidate)
  node.commentBefore = ` ${note}`
  doc.addIn(['elements', element, 'candidates'], node)
  writeFileDurable(path, doc.toString(), 0o600)
  return true
}
