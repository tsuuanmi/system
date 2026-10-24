# @tsuuanmi/system-plugin-host

`ctx.pluginHost`, the plugin host's record of the composition
([plugin host](../../../docs/design/plugin-host.md), REQ-HOST-7). Its bundle row, `plugin-host`, is
on.

- **Owns:** at start, the list of every row of the composition with the manifest its package
  declares; each plugin's lifecycle state, recorded in its `plugin_lifecycle` table; and the
  manifest check of each plugin a row mounts, recorded in its `plugin_check` table. Each change is
  a decision recorded before the record (a `lifecycle` decision, `decision@1.5`, or the check's
  `gate` decision, `decision@1.0`), every change in one store transaction (INV-13): a decision that
  cannot be recorded changes nothing, and the plugin does not start.
- **Does not own:** what runs. It never mounts, stops, or gates a plugin; the composition is the
  operator's configuration, and Base automates no lifecycle step. A finding of its check makes
  health down, but the row still runs: the DSH loader offers no point to refuse it
  ([ADR-0048](../../../docs/decisions/adr/0048-the-plugin-host-checks-the-composition-at-start.md)).
- **The composition:** every entry of the DSH loader (`ctx.loader`), mounted or not; a group or an
  include is not a row. It is the only `system` plugin that reads the loader
  ([ADR-0018](../../../docs/decisions/adr/0018-build-on-dsh-core.md)). A row's package is found as
  Node finds a bare name, from the profile, then from each bundle `ctx.profileContext` names; its
  `plugin-manifest.json` is read up to 64 KiB.
- **States:** `default` for a plugin a row mounts, `candidate` for one whose rows are off, `retired`
  for a recorded one no row names any more. A plugin whose manifest is absent (the DSH rows ship
  none) or refused is listed with why and keeps its record.
- **The check:** a plugin a row mounts with no valid manifest (none is allowed only for a package
  `allowWithoutManifest` names), or with a consumed seam its mounted providers' manifests do not
  satisfy, is listed with its findings; each plugin's findings are recorded once, again only when
  they change or clear.
- **Read by:** MCP `status` ([mcp-server](../mcp-server/README.md)): the plugins that need a
  look and their findings for the operator (every plugin with `plugins: true`), and the
  `manifests` health check; `system plugins`.
- **Conformance:** [`tests/conformance.spec.ts`](tests/conformance.spec.ts) runs the
  [suite](../../plugin-host-core/conformance/plugin-host.ts) at contract 1.1 over a stub of the
  loader and package directories installed under a temporary profile.
- **Config:** `allowWithoutManifest`, the packages a row may load with no manifest; the bundle
  lists its four DSH rows, and `pnpm check:manifests` holds the list to them
  ([configuration](../../../docs/reference/configuration.md#plugin-host)).
- **Injects:** `store`, `artifacts`, `loader`; `profileContext` when the dsh launcher provides it.
