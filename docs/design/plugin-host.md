# Plugin host

> Target state. Boundary: [host](../architecture/components.md#host), core component *plugin host*
> ([ADR-0036](../decisions/adr/0036-guarantee-core-and-capability-plugins.md)). Proposals:
> [PROP-0010](../proposals/0010-base-version.md),
> [PROP-0008](../proposals/0008-studio-operating-model.md) (the lifecycle). Records:
> [`plugin-manifest@1.x`](../reference/schemas.md#plugin-manifest),
> [`decision@1.5`](../reference/schemas.md#decision) (`lifecycle`). Requirement: REQ-HOST-7.
>
> Defined in [`plugin-host-core`](../../packages/plugin-host-core/README.md); provided by
> [`plugin-host`](../../packages/plugins/plugin-host/README.md) on `ctx.store`, its bundle row on.
> Differs from target: Base records the lifecycle and automates nothing (no shadow run, no canary
> split, no promotion); a plugin with no manifest, or one whose consumed seam versions its
> providers do not satisfy, still runs; a row turned on or off while the host runs is recorded at
> its next start.

Every plugin package says what it is in a manifest: the seams it provides and consumes, at which
contract versions, and which core component or plugin family it belongs to. The plugin host reads
those manifests for every row of the composition and records each plugin's lifecycle state, so a
later plugin can be introduced, compared, and retired on the record. In Base the state follows the
operator's configuration alone.

## Manifests

Each plugin package (`packages/plugins/*`) and each seam definition package (the `*-core`
packages) ships `plugin-manifest.json` at its root, listed in its `package.json` `files`. Every
fact in it has one source:

| Field | Source |
|---|---|
| `name`, `version`, `description`, `license` | the package's `package.json` (`UNLICENSED` while it declares no license) |
| `class` | the [seam catalog](../architecture/plugin-model.md#seam-catalog): the Class of the seams the package provides or defines; a package that provides none is named in the [family table](../architecture/plugin-model.md#core-and-plugin-classes) |
| `provides` | the services the code registers, each at the contract its provider pins in its own conformance run (`runSuite(<suite>, { contract })` in its tests) |
| `defines` (`@1.1`) | the abstract definitions a definition package owns, each at its suite's `contract` |
| `consumes` | the `inject` list, and `ctx.get` and `ctx.inject` for the optional ones, each accepting `^` the version of the seam's provider in this workspace (else its definition's) |
| `renames`, `config`, `egress`, `cacheStable` | the manifest itself: the code cannot tell them; no plugin declares one yet |

A seam whose conformance suite predates the [conformance runner](../../packages/libs/conformance/runner.ts),
or that has none (a DSH seam, a service of the dsh launcher), is at contract 1.0.

`pnpm gen:manifests` writes them; `pnpm check:manifests`, part of `pnpm check`, reads each one as
the host would (`readManifest`) and names every disagreement:

- a package with no manifest, or one its `files` does not ship;
- a manifest the host refuses (see below);
- a seam the code consumes that the manifest does not declare, one it declares that the code does
  not inject, or one optional in one and required in the other;
- a seam provided or defined in one and not the other;
- a provided version other than the contract its conformance run pins, a defined version other than
  its suite's, and a consumed range that the seam's version in the workspace does not satisfy;
- a class other than the catalog's (or the family table's);
- a name, version, description, or license other than `package.json`'s;
- anything else the generator would write differently.

`pnpm version-packages` regenerates them with each release, so a manifest's version is its
package's.

## Seam

`ctx.pluginHost` (`PluginHost` in `@tsuuanmi/system-plugin-host-core`), contract 1.0, a guarantee
seam of the plugin host:

| Method | Does |
|---|---|
| `list()` | every plugin of the composition, in the order of its first row, then each retired one by name: its rows, whether a row mounts it, its manifest's state (`valid`, `absent`, `refused`, with why), the manifest it declares with the host's `_meta.lifecycle`, and its lifecycle as last recorded |
| `get(name)` | one plugin, by its name or a name its manifest renames |

The definition also holds what every provider applies the same way: reading a declared manifest
(`readManifest`), and the reconciliation of the composition with the record (`reconcile`,
`pluginRecords`).

## Reading the composition

When it starts, the provider reads every entry of the DSH loader (`ctx.loader`), mounted or not, in
the loader's order; a group or an include is a carrier of rows, not a row. It finds each row's
package as Node finds a bare name: from the profile, then from each bundle composed into it
(`ctx.profileContext`), and reads `plugin-manifest.json` there, at most 64 KiB.

A manifest is **absent** when the package cannot be found or ships none (the DSH rows), and
**refused**, never repaired (INV-14), when it is larger than the bound, is not a JSON object,
declares `_meta` (the host's), is not a valid `plugin-manifest@1.x` (an unknown major included),
or names another package than the row loads. A plugin whose manifest is absent or refused still
runs as composed; nothing is recorded from it.

## Lifecycle states

```mermaid
stateDiagram-v2
  [*] --> default: first start, a row mounts it
  [*] --> candidate: first start, its rows are off
  candidate --> default: a row turned on
  default --> candidate: every row turned off
  default --> retired: no row names it any more
  candidate --> retired: no row names it any more
  retired --> default: a row names it again, on
  retired --> candidate: a row names it again, off
```

| The composition at a start | Recorded state | Decision |
|---|---|---|
| a row of the composition mounts the plugin | `default`: it serves every eligible job | one, when its record says otherwise |
| every row of it is off (`disabled`) | `candidate`: installed with a valid manifest, not run | one, when its record says otherwise |
| no row names a plugin that has a record, and no plugin of the composition renames it | `retired` | one, once |
| its manifest is absent or refused | its record unchanged | none |
| its manifest's `renames` names a record and no row names that name | the record, carried to its new name (to the first plugin that renames it only) | none while its state stays |
| — | `shadow`, `canary` | never in Base: nothing runs a plugin beside another or gives it a share of the jobs |

## A start

| Step | Records | On failure |
|---|---|---|
| read the rows | — | no `ctx.loader`: the host waits on its inject and is not mounted (health `plugins`: pending) |
| read the manifests | — | absent or refused: listed with why; a refused one makes health `manifests` degraded |
| reconcile | for each change, a `lifecycle` decision and then the plugin's record (state, since, decision, version, rows), every change in one store transaction | a decision that cannot be recorded rolls the transaction back: no record changes, and the host does not start (health `plugins`: down). It fails closed (INV-2) |
| list | — | — |

A lifecycle decision (`decision@1.5`, decider rule `plugin-host.composition` version 1, its hash
the sha256 of the composition as read) names the plugin, its version, its rows, the state it
leaves, and its manifest's digest. All five states are candidates, each with why (INV-13). Its
input is the plugin's previous lifecycle decision, so the record names the latest decision and
each decision the one before it: the artifacts' retention keeps the whole history. Example:
[`decision.lifecycle.json`](../../schemas/examples/decision.lifecycle.json).

**Restart is reconciliation** (INV-4). A start compares the composition with the record and records
only what differs, so the same composition records nothing, and a crash before the transaction
commits leaves nothing half-recorded: the next start records it.

## Boundaries

- `plugin-host` is the only `system` plugin that reads the DSH loader: an adapter from the host to a
  `system` seam ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)).
- It records; it never mounts, stops, or gates a plugin. A row is turned on or off by the operator's
  configuration ([runbook](../operations/runbooks.md#turn-an-off-row-back-on)).
- Surfaces: MCP `status` lists the plugins to the operator (a client sees none) and checks the
  manifests in its health; `system plugins` prints the list.

## Conformance

[`plugin-host-core/conformance/plugin-host.ts`](../../packages/plugin-host-core/conformance/plugin-host.ts),
6 scenarios at contract 1.0, run against the fake provider and against the store-backed provider
reading a stub of the loader over installed package directories. The profile end-to-end test
boots the shipped composition through the real loader.
