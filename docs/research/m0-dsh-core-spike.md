# M0 spike: verifying DSH core as the host

Non-normative evidence for the verification points in
[ADR-0018](../decisions/adr/0018-build-on-dsh-core.md). Run on 2026-10-11 on
Linux x64 with Node 22.23.2 and `@deepseek-ai/dsh@0.2.1-alpha.2` (563 packages
installed). Reproducible code is in [`spikes/m0-dsh-core/`](../../spikes/m0-dsh-core/README.md).

## Results

| # | Question | Result | Evidence |
|---|---|---|---|
| 1 | Does a profile without `web-app` stay resident as a daemon? | **Yes.** It stays resident with only `dsh-base` plus our bundle, with or without a webserver row | `dsh --profile system-probe` stayed up until it was stopped. With the webserver disabled through `--patch`, it was still running when the 40 s timeout killed it |
| 2 | Can an MCP Streamable HTTP endpoint be served on `ctx.webServer`, loopback only, with a token? | **Yes** | `@deepseek-ai/dsh-host-webserver` (`host: 127.0.0.1`, `port: 0`) plus a 40-line plugin using the official `@modelcontextprotocol/sdk` (`StreamableHTTPServerTransport`, stateless). Missing token → `401`. Non-GET with `Origin` → `403`. `initialize` → protocol `2025-06-18`. `tools/call ping` → `pong`. The webserver rejects non-loopback wildcard binds by design |
| 3 | Does `node:sqlite` meet our transaction and revision needs? | **Yes, for our own tables** | WAL mode, `BEGIN IMMEDIATE`, and an optimistic `revision` check. A stale revision is rejected. Four processes racing 100 updates each on one row: `ok + conflict = 400` and `final revision = ok`, so no update was lost (`sqlite.spec.ts`) |
| 4 | Does `dsh-credentials-local` encrypt at rest? | **No** | Its README: secrets are kept "in a private file", which is YAML at mode `0600`. It also says the store "cannot isolate secrets from the agent" |
| — | Can telemetry be disabled from our bundle? | **Yes** | Patching `otel` and `session-telemetry-otel` with `disabled: true` shows in `--dump-config`. The launcher also honors `DSH_TELEMETRY_DISABLED` |

## Minimal core composition

A second profile listed **no `dsh-base`**. Its bundle inserted only
`cordis-plugin-timer`, `dsh-credentials-local`, `dsh-host-webserver`, and the MCP
probe, with `--dump-config` showing exactly those 4 rows. It stayed resident and
served `initialize`. It used **about 91 MB RSS, against about 153 MB** for the
`dsh-base`-layered profile. This led to
[ADR-0019](../decisions/adr/0019-explicit-minimal-dsh-core.md).

## Consequences for the design

- **Host:** confirmed. `system` runs as a resident DSH profile. A webserver row is
  needed only for HTTP surfaces (MCP, admin).
- **MCP server:** a thin plugin on `ctx.webServer` using the official MCP SDK
  works. Before building the real one, existing community plugins are being
  evaluated ([research-before-build rule](../engineering/dependencies.md)).
- **Store:** `dsh-storage-sqlite` is only a key-value facet. `system`'s records
  (nodes, receipts, sessions, artifacts index, leases) live in **`system`-owned
  tables on `node:sqlite`**, in their own database file. `node:sqlite` still
  prints an `ExperimentalWarning` on Node 22. DSH depends on it too, and the
  pinned Node range is the same.
- **Credentials:** a `ctx.credentials` provider that **encrypts at rest** is
  required for passwords and TOTP secrets (ADR-0017). Candidates are being
  evaluated before we build one.
- **Install footprint:** about 560 packages and about 2 minutes on a cold install.
  CI caches the pnpm store.

## Reproduce

```sh
cd spikes/m0-dsh-core/bundle && npm i            # MCP SDK for the probe plugin
export DSH_HOME=$(mktemp -d) DSH_TELEMETRY_DISABLED=1
npx -y @deepseek-ai/dsh@0.2.1-alpha.2 plugin --profile system-probe add ./
# remove "@deepseek-ai/dsh-base" from $DSH_HOME/profiles/system-probe/package.json → dsh.profile.bundles
npx -y @deepseek-ai/dsh@0.2.1-alpha.2 --profile system-probe   # then curl /mcp (see spike README)
pnpm test spikes/m0-dsh-core                     # node:sqlite probe
```
