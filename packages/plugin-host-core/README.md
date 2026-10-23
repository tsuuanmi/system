# @tsuuanmi/system-plugin-host-core

Plugin host **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[plugin host](../../docs/design/plugin-host.md)). A guarantee seam: its contract changes only by an
ADR ([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md); 1.1 by
[ADR-0048](../../docs/decisions/adr/0048-the-plugin-host-checks-the-composition-at-start.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.pluginHost` | abstract `PluginHost` with `list()` and `get(name)`; `PluginManifest`, `PluginRecord` (1.1: `findings`, `checked`), `ManifestFinding`, `Lifecycle`, `LifecycleState`, `CompositionRow`, `ManifestRead`, `RecordedLifecycle`, `RecordedCheck`, `LifecycleDecision`, `ManifestCheckDecision`; `PLUGIN_HOST_CONTRACT` (1.1), `MANIFEST_FILE`, `MANIFEST_MAX_BYTES`, `LIFECYCLE_STATES`, `UNDECLARED_SEAM_VERSION`; the pure `readManifest` (a declared manifest, or why it is absent or refused), `reconcile` (the lifecycle decisions a start records), `checkComposition` (the manifest check), `satisfies` (a caret range), `reconcileChecks` (the check decisions a start records), `pluginRecords`, `pluginsOf`, `compositionHash`, `checkHash`, `findPlugin` | [`plugin-host`](../plugins/plugin-host/README.md) (store-backed, rows from the DSH loader), the fake `FakePluginHost` |

- The types mirror `plugin-manifest@1.x`, the `lifecycle` decision of `decision@1.5`, and the
  manifest check's `gate` decision of `decision@1.0`; the schemas in `schemas/` are canonical. It
  depends on Cordis and the libraries (schema validation, canonical hashing).
- Base records the state the composition gives a plugin and automates nothing: `default` for a
  plugin a row mounts, `candidate` for one whose rows are off, `retired` for one no row names any
  more; never `shadow` or `canary`. A plugin whose manifest is absent or refused keeps its record.
- The manifest check (1.1) looks at each plugin a row mounts: a valid manifest (none only for a
  package the provider's configuration allows), and each consumed seam provided at a version its
  caret range accepts by every mounted provider, a required seam no manifest declares taken at
  contract 1.0. A plugin whose findings differ from its record records one `gate` decision
  (`plugin-host.manifest-check`): `fail` with the findings, or `pass` once they are cleared.
- The conformance suite is [`conformance/plugin-host.ts`](conformance/plugin-host.ts), run through
  the [conformance runner](../libs/conformance/runner.ts) at contract 1.1. `boot()` gives a host
  over one durable state, and `start(composition)` restarts it on a composition (its rows, each
  package's manifest text, and the packages allowed without one):
  - every plugin listed once in row order, a valid manifest carrying the host's `_meta.lifecycle`,
    a package with none `absent`;
  - one lifecycle decision per plugin at the first start, none again on a restart or a new
    version;
  - a row switched off or on recorded as one decision, chained to the one before it;
  - a plugin no row names recorded `retired` once, and brought back by a row that names it again;
  - refusals (`_meta`, not JSON, invalid, another record, an unknown major, another package's
    name), no decision for them, and a recorded plugin keeping its record when its manifest
    becomes refused;
  - a rename carried over with no decision while the state stays;
  - since 1.1: a mounted row with no manifest or a refused one found and recorded, a row that is off
    not; a package the configuration allows not found, a refused manifest still found; an
    unsatisfied range found with its provider and version, a required seam no manifest declares
    taken at 1.0, an optional one not checked; a satisfied range finding nothing and recording
    nothing; a finding recorded once, another one and a cleared one each chained to the one before.

  It also exports `FakePluginHost`, which passes it over a given composition, its records in maps
  the caller keeps across restarts, and `manifestText`, a valid declared manifest for tests.
