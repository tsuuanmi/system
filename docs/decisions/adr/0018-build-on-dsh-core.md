# ADR-0018: Build `system` as our own harness on DSH core

- **Status:** Accepted
- **Date:** 2026-10-11
- **Supersedes in part:** [ADR-0001](0001-standalone-host.md) (no DSH packages),
  [ADR-0002](0002-typescript-on-bun.md) (Bun runtime)
- **Related:** ADR-0007, ADR-0008, ADR-0010, [DSH analysis](../../research/dsh-analysis.md),
  [plugin model](../../architecture/plugin-model.md#dsh-core-reuse-map)

## Context

The maintainer wants `system` built on **DSH core**, for four reasons:

- to avoid rebuilding what DSH already provides;
- to stay out of DSH lock-in;
- to remain **our own harness**;
- to reuse DSH's many existing plugins.

It must keep working with Claude Code and Codex.

What a survey of the DSH repository (`0.2.1-alpha.2`, MIT) found:

- **DSH core is the `dsh-base` bundle.** It is a Cordis patch with no code of its
  own. It mounts storage (json or sqlite, schema-validated domains), an
  event-sourced session store, attachments, spill, credentials and
  authorization, approvals and user questions, exec (shell, fs, sandbox,
  subprocess), LLM adapters, compaction, skills, MCP **client**, jobs, web
  search and fetch, and the agent loop. Nothing in it is hard-mandatory, so a
  profile can disable rows.
- **A third party ships its own harness** as a **bundle**: an npm package whose
  `dsh.bundle` field points at a Cordis patch. A **profile** layers that bundle
  over `dsh-base`, and it is launched with `dsh --profile <name>`. A thin wrapper
  CLI that runs `dsh --profile system` is the supported pattern. Embedding
  app-boot directly is not supported.
- **DSH does not provide** a durable workflow engine (`dsh-workflow-ptc` has no
  journaling or resume), cross-process leases or mailboxes, artifacts with
  lineage, capability routing, resumable Claude Code or Codex Workers (its
  providers are one-shot), an **MCP server**, browser or website providers
  beyond experimental ones, or multi-account provider vaults.
- **Constraints:** DSH runs on **Node `^22.19 || >=24` only** (it patches
  Node's ESM loader and uses `node:sqlite` and a native addon), so **Bun is not
  supported**. It is a developer preview with breaking changes about weekly.
  All packages move in lockstep, and plugins peer-depend on exact versions.
  Telemetry is on by default and goes to a DeepSeek endpoint. Its `latest`
  dist-tags are stale.

## Options

1. Stay fully standalone on bare Cordis, as decided in ADR-0001 and ADR-0007.
2. Become plugins inside a stock DSH profile, as AgentOS and internet did.
3. **Ship `system` as our own DSH distribution:** a `system` bundle and profile
   layered on `dsh-base`, reusing DSH packages *behind our seams*, with our
   domain semantics in our own plugins and our own `system` CLI wrapper.

## Decision

Option 3.

- **Distribution.** The package `@tsuuanmi/system-bundle` (a `dsh.bundle` patch)
  plus a `system` profile. The `system` CLI is a thin wrapper that runs
  `dsh --profile system …` and parses its own arguments through the DSH cmdline
  handoff.
- **Reuse map.** DSH packages are reused where the
  [reuse map](../../architecture/plugin-model.md#dsh-core-reuse-map) says so:
  storage, attachments, credentials and authorization, approvals and user
  questions, exec, LLM adapters (including economy-tier API models), compaction,
  skills, MCP client, the webserver, and later the Web UI. `system`'s own
  plugins provide everything DSH lacks: provider runtime, browser and accounts,
  Worker routing, the durable DAG engine, artifacts and decision records, leases,
  Worker sessions and mailbox, resumable agent runtimes, and the MCP server.
- **No lock-in safeguards:**
  1. Domain semantics live in `system` seams. DSH services are consumed only
     through `system` seam definitions or thin adapter plugins
     (`system-dsh-*`), never imported directly by domain plugins.
  2. Experimental DSH packages (`packages/experimental`, such as agent teams,
     hook bridges, and browser-use providers) are not depended on in the MVP.
  3. One exact DSH version is pinned across everything. Every DSH bump runs the
     seam conformance suites and a composition test before it is adopted. The
     stale `latest` tags are never used.
  4. **Telemetry is disabled** in the `system` profile, and DeepSeek-specific
     defaults (models, account platform) are disabled unless configured.
  5. **Exit path.** Every seam is ours and the runtime is Cordis, so moving off
     DSH means replacing the adapter plugins and the composition root. Domain
     plugins do not change.
- **Runtime.** TypeScript on **Node** (`^22.19 || >=24`, as DSH requires) with
  pnpm. Bun is dropped (supersedes ADR-0002's runtime choice; TypeScript
  stays).
- **Naming.** DSH owns `ctx.sessions` (agent conversation sessions). `system`'s
  Worker-session seam is renamed **`ctx.workerSessions`**
  ([ADR-0015](0015-worker-sessions-and-peer-messaging.md)).

## Consequences

- Large parts of the planned kernel and host are not rebuilt: storage, blobs,
  credentials, approvals, exec, LLM adapters, compaction, the webserver, the
  config editor, and the plugin manager. Those milestones shrink.
- **Claude Code and Codex still work:**
  - as clients, through `system`'s own MCP server plugin (DSH has none), served
    over Streamable HTTP on DSH's loopback webserver or over stdio;
  - as Workers, through `system`'s resumable runtime plugins. DSH's one-shot
    `dsh-subagent-claude-code` and `dsh-subagent-codex` remain usable for
    one-shot jobs;
  - DSH's ACP server additionally exposes the harness to ACP editors.
- DSH's own agent loop and tools come for free. A DSH agent can act as a local
  Worker or as an interactive operator console.
- There is a cost: DSH's breaking-change cadence means regular upgrade work, and
  developer-preview APIs can change under us. The safeguards above contain it.
- **To verify in the M0 spike:**
  1. a profile without `web-app` stays resident as a daemon;
  2. an MCP Streamable HTTP endpoint can be served on `ctx.webServer` with a
     bearer token;
  3. `node:sqlite` storage meets our transaction and revision needs, or our own
     store runs on `node:sqlite` beside it;
  4. `dsh-credentials-local` encrypts at rest. If it does not, we add a provider
     that does.

## Follow-up (2026-10-11): M0 spike results

[Spike evidence](../../research/m0-dsh-core-spike.md):

1. A profile without `web-app` stays resident: **yes**.
2. An MCP Streamable HTTP endpoint on `ctx.webServer` with loopback, a token, and
   Origin rejection: **yes**.
3. `node:sqlite`: **yes, for `system`-owned tables**. `dsh-storage-sqlite` is only
   a key-value facet.
4. `dsh-credentials-local` encrypts at rest: **no**. A provider that encrypts is
   required.

Telemetry is disabled by bundle patch. The decision stands.

