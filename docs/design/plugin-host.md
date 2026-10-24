# Plugin host

> Target state. Boundary: [host](../architecture/components.md#host), core component *plugin host*
> ([ADR-0036](../decisions/adr/0036-guarantee-core-and-capability-plugins.md),
> [ADR-0048](../decisions/adr/0048-the-plugin-host-checks-the-composition-at-start.md)). Proposals:
> [PROP-0010](../proposals/0010-base-version.md),
> [PROP-0008](../proposals/0008-studio-operating-model.md) (the lifecycle). Records:
> [`plugin-manifest@1.x`](../reference/schemas.md#plugin-manifest),
> [`decision@1.5`](../reference/schemas.md#decision) (`lifecycle`), `decision@1.0` (`gate`, the
> manifest check). Requirement: REQ-HOST-7.
>
> Defined in [`plugin-host-core`](../../packages/plugin-host-core/README.md); provided by
> [`plugin-host`](../../packages/plugins/plugin-host/README.md) on `ctx.store`, its bundle row on.
> Differs from target: Base records the lifecycle and automates nothing (no shadow run, no canary
> split, no promotion); a plugin the manifest check finds something in (no manifest, or a consumed
> seam version its providers do not satisfy) is recorded and makes health down, but still runs: the
> host cannot refuse a row ([ADR-0048](../decisions/adr/0048-the-plugin-host-checks-the-composition-at-start.md));
> a row turned on or off while the host runs is recorded at its next start.

Every plugin package says what it is in a manifest: the seams it provides and consumes, at which
contract versions, which core component or plugin family it belongs to, its configuration keys,
and what it may send off the machine. The plugin host reads those manifests for every row of the
composition, checks the plugins that run against them, and records each plugin's lifecycle state,
so a later plugin can be introduced, compared, and retired on the record. In Base the state follows
the operator's configuration alone.

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
| `config` | the plugin's `Config` schema, run: each top-level key, `sensitive` when it or a schema within it is marked a secret (`.role('secret')`). No plugin's configuration holds a secret: secrets are kept in the credential vault, and a configuration holds paths and references (INV-8) |
| `egress` | for a Worker source that checks egress before content leaves (`ctx.egress.check({ workerClass })`: `turns`, `agent-workers`, `models`), the strictest classification the egress plugin's default policy (`WORKER_CLASSES`) lets leave the machine for those Worker classes: `operator-shared`. The drivers and runtimes that carry a source's content to its provider host but check nothing themselves (`provider-chatgpt-web`, `provider-gemini-web`, `runtime-claude-agent-sdk`, `runtime-codex-sdk`, `runtime-acp`, `runtime-antigravity-cli`) declare it in the manifest, at their source's: the code cannot tell which source's content they carry. A plugin that sends no Worker's content off the machine declares none (the browser engine is the drivers' transport; a sign-in sends an account's own credentials to its provider, never through the gate, INV-8) |
| `renames`, `cacheStable` | the manifest itself: the code cannot tell them. No plugin was renamed, and none is a context plugin, so none declares `cacheStable` |

A seam whose conformance suite predates the [conformance runner](../../packages/libs/conformance/runner.ts),
or that has none (a DSH seam, a service of the dsh launcher), is at contract 1.0.

The egress a manifest declares is what leaves under the default policy. The operator's egress
policy (`workerClasses` of the [`egress`](../reference/configuration.md#egress) row) can widen a
Worker class; the check runs on the actual payload either way (INV-12).

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
- a configuration key its `Config` does not have, one it has that is not declared, or a `sensitive`
  flag other than its `Config`'s;
- a Worker source's `egress` other than its egress check gives; a declared `egress` on a plugin
  outside the Worker family, or at a classification no Worker class may receive by default
  (`local-private`, INV-12); `cacheStable` on a plugin outside the context family;
- a system bundle whose `plugin-host` row allows other packages without a manifest than exactly its
  DSH rows ([the manifest check](#the-manifest-check));
- anything else the generator would write differently.

`pnpm version-packages` regenerates them with each release, so a manifest's version is its
package's.

## Seam

`ctx.pluginHost` (`PluginHost` in `@tsuuanmi/system-plugin-host-core`), contract 1.1, a guarantee
seam of the plugin host:

| Method | Does |
|---|---|
| `list()` | every plugin of the composition, in the order of its first row, then each retired one by name: its rows, whether a row mounts it, its manifest's state (`valid`, `absent`, `refused`, with why), the manifest it declares with the host's `_meta.lifecycle`, its lifecycle as last recorded, and (1.1) what the manifest check found in it (`findings`) with the decision that recorded them (`checked`) |
| `get(name)` | one plugin, by its name or a name its manifest renames |

The definition also holds what every provider applies the same way: reading a declared manifest
(`readManifest`), the reconciliation of the composition with the record (`reconcile`,
`pluginRecords`), and (1.1) the manifest check and its reconciliation (`checkComposition`,
`satisfies`, `reconcileChecks`). Contract 1.1 adds only the optional `findings` and `checked`; a
1.0 consumer reads the list as before.

## Reading the composition

When it starts, the provider reads every entry of the DSH loader (`ctx.loader`), mounted or not, in
the loader's order; a group or an include is a carrier of rows, not a row. It finds each row's
package as Node finds a bare name: from the profile, then from each bundle composed into it
(`ctx.profileContext`), and reads `plugin-manifest.json` there, at most 64 KiB.

A manifest is **absent** when the package cannot be found or ships none (the DSH rows), and
**refused**, never repaired (INV-14), when it is larger than the bound, is not a JSON object,
declares `_meta` (the host's), is not a valid `plugin-manifest@1.x` (an unknown major included),
or names another package than the row loads. No lifecycle is recorded from a manifest the host
could not read; the [manifest check](#the-manifest-check) finds the plugin when a row mounts it.

## The manifest check

At each start, after reading the manifests, the host checks every plugin a row mounts (a plugin
whose rows are all off does not run, so it is neither checked nor counted as a provider). It finds:

| Finding | When |
|---|---|
| `no-manifest` (`absent`) | its package ships no manifest, or cannot be found, and the host's `allowWithoutManifest` does not name it |
| `no-manifest` (`refused`) | the host refused its manifest; no configuration allows that |
| `unsatisfied`, with the `provider` and its `version` | a seam it consumes is provided by a mounted plugin whose manifest declares a version its caret range does not accept, or a range the host cannot read (not `^major.minor.patch`, or a major of 0); each mounted provider of the seam is checked |
| `unsatisfied`, with no provider | a seam it requires is declared by no mounted plugin's manifest, so it is taken at contract 1.0 (a seam of DSH or of the launcher), which its range does not accept |

An optional seam no mounted plugin declares is not checked: it may be absent, which an optional
consumer works without. The DSH rows ship no manifest, so the system bundle's `plugin-host` row
allows exactly their packages (`allowWithoutManifest`, the [configuration](../reference/configuration.md#plugin-host)),
and `pnpm check:manifests` holds that list to the bundle's DSH rows. A patch that targets the row
replaces its whole config: one that leaves the list out makes each DSH row a finding.

What the check finds in a plugin is a decision (INV-13): `gate` (`decision@1.0`), decider rule
`plugin-host.manifest-check` version 1, its hash the sha256 of what it read (the rows, each
manifest's digest or why there is none, and the packages allowed). Its candidates are `pass` and
`fail`, each with why: `fail` gives each finding's reason. `detail` names the `plugin`, its `rows`,
its `findings`, the outcome it comes `from` (`null` the first time), and, for a valid manifest, its
`version` and `manifestDigest`. Its input is the plugin's previous check decision.

**Recorded once** (INV-4). The host keeps each plugin's last check (its findings and decision). A
start whose findings for a plugin equal its record, reasons aside, records nothing; another finding
is a new `fail`; a finding cleared, by a fix, by the allowance, or because no row mounts the plugin
any more, is one `pass`. A plugin never found records no check at all.

**Fail closed, as far as the host can.** The host cannot keep a row from running: DSH starts the
rows of a group at once, before the store the decision needs exists, and stopping a running row
from outside rewrites the operator's configuration
([ADR-0048](../decisions/adr/0048-the-plugin-host-checks-the-composition-at-start.md)). So a finding
makes health `manifests` **down**, naming each finding and what to do: the host cannot vouch for
what runs. MCP `status` and `system plugins` list each finding under its plugin
([runbook](../operations/runbooks.md#the-manifest-check-found-a-plugin)).

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
| its manifest is absent or refused | its record unchanged | none (the manifest check finds it, when a row mounts it) |
| its manifest's `renames` names a record and no row names that name | the record, carried to its new name (to the first plugin that renames it only) | none while its state stays |
| — | `shadow`, `canary` | never in Base: nothing runs a plugin beside another or gives it a share of the jobs |

## A start

| Step | Records | On failure |
|---|---|---|
| read the rows | — | no `ctx.loader`: the host waits on its inject and is not mounted (health `plugins`: pending) |
| read the manifests | — | absent or refused: listed with why; a refused one in a row that is off makes health `manifests` degraded |
| check | — | a finding in a plugin a row mounts: health `manifests` down ([the manifest check](#the-manifest-check)) |
| reconcile | for each lifecycle change, a `lifecycle` decision and then the plugin's record (state, since, decision, version, rows); for each check that differs from its record, a `gate` decision and then the check record (findings, since, decision); all in one store transaction | a decision that cannot be recorded rolls the transaction back: no record changes, and the host does not start (health `plugins`: down). It fails closed (INV-2) |
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
- It records and checks; it never mounts, stops, or gates a plugin. A row is turned on or off by
  the operator's configuration ([runbook](../operations/runbooks.md#turn-an-off-row-back-on)).
  Refusing a row the check finds something in needs a veto point in the DSH loader and a further
  change to this contract, by its own ADR
  ([ADR-0048](../decisions/adr/0048-the-plugin-host-checks-the-composition-at-start.md)).
- Surfaces: MCP `status` lists to the operator the plugins that need a look, each with its
  findings, and every plugin with `plugins: true` (a client sees none), and checks the manifests in
  its health; `system plugins` prints the whole list.

## Conformance

[`plugin-host-core/conformance/plugin-host.ts`](../../packages/plugin-host-core/conformance/plugin-host.ts),
11 scenarios at contract 1.1 (6 since 1.0; since 1.1: a row with no manifest or a refused one, the
allowance, an unsatisfied range, a satisfied one, and a finding recorded once), run against the
fake provider and against the store-backed provider reading a stub of the loader over installed
package directories. The profile end-to-end test boots the shipped composition through the real
loader, once more with a patch that drops the allowance: each DSH row is found and recorded, health
is down, and every row still runs.
