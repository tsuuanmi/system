# ADR-0045: The plugin host checks the composition at start, and a finding makes health down

- **Status:** Proposed
- **Date:** 2026-10-23
- **Related:** [ADR-0018](0018-build-on-dsh-core.md),
  [ADR-0019](0019-explicit-minimal-dsh-core.md),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [PROP-0010](../../proposals/0010-base-version.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact),
  [INV-14](../../architecture/invariants.md#inv-14-every-record-has-a-versioned-schema)

## Context

Every `system` plugin package ships a manifest that CI checks against its code, and the plugin
host reads each row's manifest at start and records each plugin's lifecycle state
([plugin host](../../design/plugin-host.md)). Two cases were caught in CI only, never at run time:
a row whose package ships no manifest (or one the host refuses) still ran, and so did a plugin
whose consumed seam range its provider's manifest does not satisfy. A composition the operator
changed (a third party's plugin, a row of an older release, a patch) runs past CI.

The plugin host is a guarantee seam (the plugin host core component). ADR-0036 makes a change to
its contract need an ADR, and the change must stay additive, so that a 1.0 consumer and the 1.0
conformance scenarios keep holding.

Fail closed (INV-2) would mean such a plugin does not run. The DSH loader offers no point where the
plugin host can refuse a row before it starts:

- the loader starts every row of a group at once (`EntryGroup.update` creates each entry in one
  `Promise.all`), and the plugin host starts only once `ctx.store` and `ctx.artifacts` do, so the
  rows are created, most of them running, before it can look;
- the one place a row's start can be held back, extending a fiber's `inject` from an
  `internal/plugin` listener as the loader does for an entry's own `inject`, runs when the fiber is
  created, before the store exists to record the decision first (INV-13);
- stopping a running fiber from outside makes the loader persist `disabled: true` into the row's
  entry tree, which an include writes back to the configuration file it came from: the host would
  rewrite the operator's configuration;
- the plugin host's own contract says it records and never mounts, stops, or gates a plugin.

## Options

1. **Detect, record, and fail health.** At start the host checks each plugin a row mounts against
   its manifest and its providers' manifests, records what it finds as a decision, lists it, and
   makes health `down`. Nothing is refused; the operator is told at once.
2. **Refuse the offending row.** Needs a veto point in DSH that runs before a row applies and that a
   plugin with the store can use, and changes what the plugin host is (a gate over the
   composition, not a record of it): a contract change beyond an additive field.
3. **Refuse the whole host when a guarantee seam is unsatisfied.** A plugin cannot end the host
   cleanly: its failing only unmounts itself, and the open M6b item (a host whose required service
   refuses to start exits non-zero) is not built.
4. **Keep it in CI.** The case the requirement names (a composition that differs from CI's) stays
   unchecked.

## Decision

Option 1. The plugin host's contract moves from 1.0 to 1.1, as a minor.

- **The check (`checkComposition`, the same for every provider).** Only a plugin a row mounts runs,
  so only it is checked, and only it provides. It must declare a valid manifest, unless its package
  ships none and the host's configuration names it in `allowWithoutManifest`; a refused manifest is
  never allowed. Each seam it consumes must be provided at a version its caret range accepts, by
  every mounted plugin whose manifest provides it. A required seam no manifest declares is taken at
  contract 1.0, as a DSH seam or a service of the launcher is; an optional one is not checked, since
  it may be absent, which an optional consumer works without. A range the host cannot read is a
  finding, never a pass.
- **The DSH rows.** Their packages ship no manifest, so the system bundle's `plugin-host` row
  allows exactly them, and `pnpm check:manifests` holds that list to the bundle's DSH rows.
- **The record (INV-13, INV-4).** What the check finds in a plugin is a `gate` decision of the rule
  `plugin-host.manifest-check` (`decision@1.0`; candidates `pass` and `fail`, each with why; the
  outcome's `detail` names the plugin, its rows, its findings, and the outcome before), recorded
  before the plugin's check record, in the store transaction of the lifecycle decisions. A plugin
  whose findings equal its record records nothing, so a restart records each finding once; another
  finding is a new `fail`, and a finding cleared (fixed, allowed, or no row mounts the plugin any
  more) one `pass`, each chained to the decision before it. A `lifecycle` decision is not used:
  the check is not a state, and the 1.0 scenarios require that a plugin whose manifest the host
  could not read gets no lifecycle record.
- **The surfaces.** `PluginRecord.findings` and `checked` (1.1, optional) list them; MCP `status`
  (operator) and `system plugins` show them; health `manifests` is `down` while any plugin a row
  mounts has a finding, since the host cannot keep that row from running and so cannot vouch for
  what runs.

## Consequences

- A composition that differs from what CI checked is caught at the start that runs it, recorded,
  and shown to the operator, who turns the row off, fixes or allows its package, and restarts
  ([runbook](../../operations/runbooks.md#the-manifest-check-found-a-plugin)).
- A plugin with a finding still runs. Refusing it stays open: it needs a supported veto point in
  the DSH loader (or a launcher preflight that can record its decision first), and a further
  change to the plugin host's contract (it would gate the composition) by its own ADR.
- A patch that targets the `plugin-host` row replaces its whole config: one that drops
  `allowWithoutManifest` makes each DSH row a finding, and health is down until it is restored.
- Revisit when DSH offers a veto point before a row applies, or when the host can exit non-zero on a
  required service that refuses to start (PROP-0003 M6b).
