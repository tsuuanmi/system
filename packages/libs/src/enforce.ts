/**
 * The enforce switch of each gate-like mechanism (docs/architecture/plugin-model.md#turning-a-plugin-off;
 * operator, 2026-10-27, D108: "if something is not right, just turn it off"). A mechanism runs `on`
 * (it refuses what it refuses), `warn` (it records what it would refuse and lets it through), or `off`
 * (it does not run), as far as the mechanism takes that mode. Its owning row's configuration
 * (`enforce.<key>`) gives its start value; the plugin host holds a live override the operator sets
 * (`system enforce set`), read at each use, so a mechanism moves to warn without a restart. A
 * mechanism never takes a mode that would hand away a bound of authority: the lead-rights check
 * takes only `on` (INV-6).
 * @module
 */

export type EnforceMode = 'off' | 'warn' | 'on'
export const ENFORCE_MODES: readonly EnforceMode[] = ['off', 'warn', 'on']

export interface Mechanism {
  /** Its name, as `system enforce` and MCP `enforce_set` take it. */
  id: string
  /** The row that owns it, and the key under its row's `enforce` configuration; none when only `on` is taken. */
  row: string
  key?: string
  /** The modes it takes; any other is refused with {@link Mechanism.why}. */
  modes: readonly EnforceMode[]
  /** The mode it runs in when its row configures none and no override is set (default `on`): a new mechanism may start in `warn` (D108). */
  start?: EnforceMode
  /** What it does, and why it takes only the modes it takes. */
  what: string
}

/** Every gate-like mechanism with a switch, in one place: a new mechanism lands here, off or warn (plugin-model.md). */
export const MECHANISMS: readonly Mechanism[] = [
  {
    id: 'evidence-gate', row: 'workflow', key: 'evidenceGate', modes: ['off', 'warn', 'on'],
    what: 'the end of a writing step of a board task\'s run that shows no output of its required checks (T284): on refuses it, warn records the refusal it would make and lets the step end, off does not look',
  },
  {
    id: 'handbook-bound', row: 'workflow', key: 'handbookBound', modes: ['warn', 'on'],
    what: 'the bound of a step\'s handbook slice (docs/design/handbook.md): on refuses a slice over it after the warn period, warn always sends it whole and records it; to give no slice at all, handbook.enabled is false',
  },
  {
    id: 'red-on-base', row: 'workflow', key: 'redOnBase', modes: ['off', 'warn', 'on'],
    what: 'the check `red-on-base` (T306c, ADR-0079), required by a policy rule of a result of the normal or heavy tier: on holds the result to it (a new test that passes on the base tree sends it back), warn runs it and records what it would refuse (the result is judged as if it passed), off does not ask it; it starts in warn, and goes on only after the test profile\'s canary and days clean (D108)',
  },
  {
    id: 'review-guides', row: 'workflow', key: 'reviewGuides', modes: ['off', 'on'],
    what: 'the selection of the REVIEW.md guides of the areas a review\'s change touches (T267): off gives a review no guides; it refuses nothing, so it has no warn',
  },
  {
    id: 'lockfile-verification', row: 'agent-workers', key: 'lockfileVerification', modes: ['off', 'warn', 'on'], start: 'warn',
    what: 'the supply-chain verification of a new lockfile that a result\'s setup lacks offline (T333, D112): on opens one approval request per lockfile digest and runs the verification once on the host\'s network, none of the result\'s code run, when approved; warn records the request it would open and opens none; off does not look',
  },
  {
    id: 'lead-rights', row: 'approvals', modes: ['on'],
    what: 'the lead\'s closed list of rights (ADR-0076): every refusal is a bound of authority, so it is only on (INV-6); to stop a lead deciding, revoke its token (system lead-token revoke)',
  },
]

export function mechanismOf(id: string): Mechanism | undefined {
  return MECHANISMS.find((m) => m.id === id)
}

/** What a mechanism reads its live override from: the plugin host (`ctx.pluginHost`), when one holds it. */
export interface EnforceSource {
  enforced?(mechanism: string): EnforceMode | undefined
}

/**
 * The mode `mechanism` runs in now: the live override the plugin host holds, when the mechanism takes
 * it, else the owning row's `configured` value, when it takes it, else its start mode (`on` unless it names one). Read at each use, never
 * cached, so a change takes effect at the next decision.
 */
export function enforceMode(host: EnforceSource | undefined, mechanism: string, configured?: EnforceMode): EnforceMode {
  const m = mechanismOf(mechanism)
  if (!m) return 'on'
  const set = host?.enforced?.(mechanism)
  if (set && m.modes.includes(set)) return set
  if (configured && m.modes.includes(configured)) return configured
  return m.start ?? 'on'
}
