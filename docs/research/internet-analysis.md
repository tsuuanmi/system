# internet analysis

Non-normative. Source: [tsuuanmi/internet](https://github.com/tsuuanmi/internet)
(`@tsuuanmi/internet` v0.0.1), analysed on 2026-10-11.

## What it is

internet is a DeepSeek Harness/Cordis plugin of about 20.7k lines of TypeScript
with 79 Vitest files. It drives ChatGPT Web and Gemini Web through real Chrome
using `patchright-core`. It exposes chat, deep-research, team, browser, artifact,
and workflow tools, plus `/internet` and `/workflow` commands. `/workflow` runs a
Git-aware cycle: two research teams, then a writer account opens a PR, then two
review teams check the exact PR head, with bounded remediation.

## Strongest mechanisms

- **Provider turn receipts** that hash the prompt and the boundary of the previous
  response. On reconcile they decide WAIT, RECOVER, RESUBMIT (at most twice), or
  AMBIGUOUS (fail closed).
- **Completion with two clocks:** a hard deadline, and a stall deadline that only
  meaningful transitions reset. Completion and canonical URL binding are awaited
  together.
- **Per-account scheduler:** ordered within a session, parallel across sessions,
  with a FIFO `runExclusive` fence and generation-numbered leases that drop late
  commits.
- **Portable account state kept apart from the login profile.** Write-back is
  guarded by both revision and lease, and IndexedDB is preserved.
- **Remote login:** headed Chrome on Xvfb, plus x11vnc on localhost, plus a
  token-gated noVNC page reached over an SSH tunnel.
- **v3 graph engine:** deterministic node ids, input and output receipts, result
  reuse on `(job, node, inputHash)`, and runtime graph growth for review and
  remediation cycles.
- **Verbatim SHA-256 handoffs**, with trusted control messages
  (`START_IMPLEMENTATION`, `APPLY_REVIEWS{expectedHeadSha}`) kept separate from
  model data.
- **Exact-head binding** for reviews, and remediation must advance the head on the
  same PR.
- **Error taxonomy mapped to retry dispositions:** IMMEDIATE, BACKOFF,
  RECREATE_SESSION, USER_ACTION, CODE_FIX, NONE.
- **Admission with provenance:** draft → preflight → confirm → accept → activate,
  with a hashed accepted spec.
- **vNext (unused):** typed content-addressed artifacts with lineage, transitive
  invalidation of input bundles, and convergence reported as an explicit list of
  blockers.

## Weaknesses observed

- There is no provider interface. A single manager branches on provider name.
- Accounts, team routing, and the writer identity are hard-coded, and ports are
  assigned by array index.
- Stores are atomic JSON files whose revision checks have no locks, so they are
  correct only in a single process. Listing scans directories.
- Two workflow runtimes (v3 and vNext) duplicate logic, and the exported API is
  very large.
- The docs are ahead of the code: PR-health and merge nodes are described but not
  implemented.
- The writer performs Git mutations remotely through provider connectors, with no
  local verification.
- Remote login is Linux x64 only, and `dist/` and X11 binaries are committed.

## Adopted

| Idea | Where in `system` |
|---|---|
| Receipts + reconciliation; two clocks; resubmit cap | [provider-turns](../design/provider-turns.md) |
| Scheduler, exclusive fence, lease generations | [scheduling-and-leases](../design/scheduling-and-leases.md) |
| Portable auth state; revision-guarded write-back; remote login | [components: provider runtime](../architecture/components.md#provider-runtime), REQ-ACC |
| Input-hash durable nodes, graph growth, handoffs, exact-head, recovery taxonomy, admission provenance | [workflow-engine](../design/workflow-engine.md) |
| vNext lineage, invalidation, convergence | [workflow-engine](../design/workflow-engine.md#artifacts-lineage-invalidation) |

## Not adopted

- Branching on provider name. Replaced by drivers
  ([ADR-0005](../decisions/adr/0005-provider-runtime-interface.md)).
- JSON-file stores. Replaced by SQLite
  ([ADR-0003](../decisions/adr/0003-sqlite-durable-store.md)).
- Two runtimes. Replaced by one engine
  ([ADR-0004](../decisions/adr/0004-single-workflow-runtime.md)).
- Committing build output and vendored binaries.
