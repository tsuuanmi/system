# DSH community plugins: reuse review

Non-normative. Reviewed on 2026-10-11 under the research-before-build rule
([ADR-0010](../decisions/adr/0010-reuse-before-build.md)). Candidates were taken
from the DSH community catalog (`dsh-plugin-shop-catalog`, about 14,400 plugin
versions). Packages were fetched with `npm pack --ignore-scripts` and **read
only**; none was installed or executed.

**Common caveat.** Most declared peer ranges, such as `>=0.2.0-rc.2 <0.3.0`, do
not match the prerelease `0.2.1-alpha.2` under semver. Runtime compatibility with
the pinned DSH version is **unverified for every candidate**.

## Verdicts

| Need | Candidate | Verdict | Why |
|---|---|---|---|
| MCP server in the profile | `@chushixixin/dsh-harness-mcp-server@0.1.10` | reject | Runs its own port, not `ctx.webServer`. Auth is optional and compared with `!==`. State is in memory only. Depends on stale DSH packages. Abandoned, no tests |
| | `@dfy-plugins/dsh-codex-bridge@0.1.3` | **reference** | Strong patterns, though not MCP itself: a `0600` discovery file `{origin, token, pid}`, idempotent sends keyed by `sha256(sessionId, clientRequestId)`, a 30 s long-poll with an opaque cursor, and a cancel result of `cancelled` / `no_op` / `timeout`. Packaged as a Codex marketplace plugin. 37 tests |
| | `dsh-chatgpt-bridge@0.6.0` | reject (reference) | Reversed direction: ChatGPT drives DSH. Good `timingSafeEqual` auth and session caps, but sends `CORS *`. Pinned to 0.1.7-rc.2 |
| ChatGPT Web provider | `@wlv-zedd/dsh-chatgpt-web@1.0.3` | **reference** (read only, MIT) | Uses playwright-core with **headless by default** and a spoofed user agent. One account, Temporary Chat only (no durable conversation, no receipts), no Deep Research. Its sidecar HTTP server is **unauthenticated**. Bun-first, peers `cordis ^3`. Worth borrowing: stage-timeout taxonomy, composer and attachment transactions, submission-evidence checks, DOM-to-Markdown conversion |
| | `@bananiceee/dsh-chatgpt-provider@0.1.1` | reject (possible alternate route) | Uses "Sign in with ChatGPT" OAuth against the public Responses API, not the web UI. Stores tokens cleanly through `ctx.credentials` |
| | `@beforewave/dsh-with-chatgpt@0.1.4` | reject | Reversed direction; ships install scripts |
| | `@eddyskywalker/dsh-chatgpt-subscription@0.18.0` | reject | Reuses Codex's OAuth client id and scrapes credentials of other apps. High terms-of-service and policy risk |
| | `@dsh/llm-codex` | reject | Not on npm; Codex backend, not the web UI |
| | `@anweat/dsh-browser@0.2.1` | **reference** | Supports patchright with `channel=chrome`, and notes that stealth is strongest headed. Keeps a storageState per auth profile, filtered to allowed domains (a vault pattern) |
| Encrypted credentials | `@dsh-enhanced/credentials-keychain@0.1.48` | **reference** | Read-only handle service, not the credentials seam. On headless Linux, `secret-tool` needs D-Bus and a secret service, and the fallback file is **plaintext** `0600`. Excellent file-hygiene checks: `O_NOFOLLOW`, parent dir `0700`, file `0600` owned by the uid, `nlink == 1`, a size cap. Also a lease plus a secret-free audit ledger |
| | `@xinvxueyuan/cordis-plugin-secret@0.6.1` | reject | Adds no encryption (delegates to `ctx.credentials`) and is aimed at agents using secrets |
| Durable DAG engine | `@gm-hz/agent-dag-workflow@1.0.1` | **adapt or reference (best candidate)** | Host-neutral core. An event journal with sequence numbers and an `expectedSeq` CAS, committed atomically with the checkpoint. `launch(idempotencyKey)`. An `invocationId` protocol (requested, then executed, then completed). **`needs_attention` for unknown side effects after a crash**, with no blind retry. SQLite run leases. A content-addressed artifact store. Recorded replay. **Gaps:** no input-hash reuse across runs, no append-only graph growth, leases per run rather than per node, unencrypted artifacts, heavy UI dependencies, single maintainer |
| | `@gm-hz/dsh-dag-workflow@0.2.0` | reject | Superseded by the package above |
| A2A | `@hanphone/dsh-a2a@0.3.5` | reference (adapt later) | Runs on `ctx.webServer` with v1.0 JSON-RPC methods and an Agent Card. Gaps: no push notifications, `returnImmediately` ignored, an existing `taskId` creates a new task instead of continuing, no `ListTasks` paging, no restart reconciliation, optional bearer token compared with `===` |
| Worker sessions, teams | `@contexera/dsh-agent-team@0.2.2` | reference | A SQLite ledger with revision tokens, direct messages that wake the recipient, and context-rollover checkpoints. Members are **in-process DSH agents only**. Heavily coupled to the UI. Peers exclude 0.2.1 |
| Claude Code integration | — | none found | No candidate covers Claude Code |

## Decisions taken

1. **MCP server: build our own** thin plugin on `ctx.webServer` (the route shape
   was proven in the M0 spike). It uses `timingSafeEqual` bearer auth and a
   Host/Origin allowlist, with no CORS. For `ask`, `research`, `status`, and
   `result`, it borrows codex-bridge's idempotency key, cursor long-poll, and
   cancel semantics. An optional stdio shim reads a `0600` discovery file.
2. **Credentials: build our own** `ctx.credentials` provider with **AEAD**
   (AES-256-GCM) and a key from `systemd-creds`, a `0600` key file, or a
   passphrase KDF. It borrows credentials-keychain's file-hygiene checks and its
   audit-ledger shape.
3. **ChatGPT Web provider: build our own** (M1), porting from tsuuanmi/internet.
   It reads dsh-chatgpt-web for UI-handling patterns and does not copy its
   headless default, statelessness, or unauthenticated sidecar.
4. **DAG engine: reimplement**, following agent-dag-workflow's journal, CAS,
   `invocationId`, and `needs_attention` design. It adds node-level leases,
   input-hash reuse, append-only growth, and decision artifacts. A fork remains
   possible (MIT, clean `./core` export), but the dependency weight, the single
   maintainer, and the gaps favor reimplementing.
5. **A2A and teams:** reference only for now (planned and Beta respectively).

These choices are recorded in the [dependency register](../engineering/dependencies.md).
