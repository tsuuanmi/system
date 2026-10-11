# ADR-0019: Compose only the DSH core rows we use, not `dsh-base`

- **Status:** Accepted
- **Date:** 2026-10-11
- **Supersedes in part:** [ADR-0018](0018-build-on-dsh-core.md) (layering on `dsh-base`)
- **Related:** [M0 spike](../../research/m0-dsh-core-spike.md#minimal-core-composition),
  [DSH core reuse map](../../architecture/plugin-model.md#dsh-core-reuse-map)

## Context

The maintainer asked for **only DSH core**. `dsh-base` mounts 94 rows, and most of
them `system` does not use: the agent loop, session log, tools, compaction,
goals, skills, web search, DeepSeek account rows, telemetry, and more. There are
two ways to trim it:

1. Layer on `dsh-base` and disable the unused rows by id.
2. Do not use `dsh-base`. The `system` bundle **inserts exactly the DSH rows it
   needs**, the way DSH's own `dsh-sdk-minimal` bundle does.

Option 1 has a hidden cost. When DSH upgrades and adds rows to `dsh-base`, those
rows appear **enabled** unless `system` notices and disables them. The
composition drifts with every release.

The M0 spike booted a profile with **no `dsh-base`**. It contained only
`cordis-plugin-timer`, `dsh-credentials-local`, `dsh-host-webserver`, and the MCP
probe. It stayed resident, served MCP correctly, and used about **91 MB RSS,
against about 153 MB** for the `dsh-base`-layered profile.

## Decision

Option 2.

- The `system` profile's bundle list is **`["@tsuuanmi/system-bundle"]` only**.
  It contains no `dsh-base`. The `system` CLI wrapper creates that profile, since
  `dsh plugin add` would otherwise add `dsh-base` first.
- `system-bundle` **inserts every DSH row explicitly**. The
  [reuse map](../../architecture/plugin-model.md#dsh-core-reuse-map) is the
  allow-list, and each row in it states which seam it serves and from which
  stage.
- Adding a DSH row is a deliberate change. It updates the reuse map and the
  composition test, which asserts the exact row set.
- Telemetry rows are simply never inserted. `DSH_TELEMETRY_DISABLED` stays set by
  the wrapper as defense in depth.

## Consequences

- The composition is smaller, faster, and stable across DSH upgrades. Nothing
  appears implicitly.
- `system` must satisfy each inserted row's service dependencies (`inject`)
  itself. The composition test catches a missing dependency at boot.
- DSH features that only `dsh-base` wires, such as the agent loop or skills, are
  available later by inserting their rows explicitly when a requirement needs
  them.
