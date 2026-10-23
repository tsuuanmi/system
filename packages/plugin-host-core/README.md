# @tsuuanmi/system-plugin-host-core

Plugin host **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[plugin host](../../docs/design/plugin-host.md)). A guarantee seam: its contract changes only by an
ADR ([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.pluginHost` | abstract `PluginHost` with `list()` and `get(name)`; `PluginManifest`, `PluginRecord`, `Lifecycle`, `LifecycleState`, `CompositionRow`, `ManifestRead`, `RecordedLifecycle`, `LifecycleDecision`; `PLUGIN_HOST_CONTRACT` (1.0), `MANIFEST_FILE`, `MANIFEST_MAX_BYTES`, `LIFECYCLE_STATES`; the pure `readManifest` (a declared manifest, or why it is absent or refused), `reconcile` (the lifecycle decisions a start records), `pluginRecords`, `pluginsOf`, `compositionHash`, `findPlugin` | [`plugin-host`](../plugins/plugin-host/README.md) (store-backed, rows from the DSH loader), the fake `FakePluginHost` |

- The types mirror `plugin-manifest@1.x` and the `lifecycle` decision of `decision@1.5`; the
  schemas in `schemas/` are canonical. It depends on Cordis and the libraries (schema validation,
  canonical hashing).
- Base records the state the composition gives a plugin and automates nothing: `default` for a
  plugin a row mounts, `candidate` for one whose rows are off, `retired` for one no row names any
  more; never `shadow` or `canary`. A plugin whose manifest is absent or refused keeps its record.
- The conformance suite is [`conformance/plugin-host.ts`](conformance/plugin-host.ts), run through
  the [conformance runner](../libs/conformance/runner.ts) at contract 1.0. `boot()` gives a host
  over one durable state, and `start(composition)` restarts it on a composition (its rows, and each
  package's manifest text):
  - every plugin listed once in row order, a valid manifest carrying the host's `_meta.lifecycle`,
    a package with none `absent`;
  - one lifecycle decision per plugin at the first start, none again on a restart or a new
    version;
  - a row switched off or on recorded as one decision, chained to the one before it;
  - a plugin no row names recorded `retired` once, and brought back by a row that names it again;
  - refusals (`_meta`, not JSON, invalid, another record, an unknown major, another package's
    name), no decision for them, and a recorded plugin keeping its record when its manifest
    becomes refused;
  - a rename carried over with no decision while the state stays.

  It also exports `FakePluginHost`, which passes it over a given composition, its records in a map
  the caller keeps across restarts, and `manifestText`, a valid declared manifest for tests.
