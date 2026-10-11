# Quality attributes

> Target state.

| Id | Attribute | Requirement |
|---|---|---|
| QA-1 | Reliability | Every external effect is idempotent or reconciled before repeating it. Nothing is replayed blindly after a restart. |
| QA-2 | Reliability | A completed node, turn, or handoff is never re-executed because a sibling failed. |
| QA-3 | Correctness | No silent fallback across providers, models, accounts, or transports. A degraded path is an explicit, reported error. |
| QA-4 | Durability | Committed state survives process crash. Writes are atomic and serialized by the store, not by process-local locks. |
| QA-5 | Security | Every listener binds to loopback by default. Every control surface, including browser debugging, requires a credential. |
| QA-6 | Security | Credentials and authenticated browser state never leave the provider runtime. Files that hold them are owner-only. |
| QA-7 | Observability | Every turn, node execution, and lease has a stable id and an append-only event trail an operator can query. |
| QA-8 | Boundedness | Concurrency per account, retries, review cycles, resubmissions, caches, and payload sizes all have configured upper bounds. |
| QA-9 | Replaceability | A provider, browser engine, store, or protocol adapter can be replaced behind its seam without changing the layers above it. |
| QA-10 | Testability | Each layer is testable without real provider accounts, using fakes at its seam. Account-bound flows have a scripted manual validation checklist. |
| QA-11 | Portability | The host runs on Linux and macOS. Remote login is Linux-first (see [constraints](constraints.md)). |
| QA-12 | Token economy | Routing places work on the lowest intelligence tier (P4) and the cheapest quota class (P1) that prove the required capabilities. Handoffs carry compact syntheses, not transcripts. Correctness always wins over cost. |
| QA-13 | Tool agnosticism | No model, vendor, agent, client, browser engine, or store is required. Each is a replaceable provider behind a seam ([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)). |
