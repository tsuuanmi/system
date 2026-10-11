# Architecture Decision Records

ADR numbers are never reused, and gaps in the numbering are expected. Use
[0000-template.md](0000-template.md) for new records.

Status values: `Proposed`, `Accepted`, `Rejected`, `Superseded by ADR-NNNN`,
`Superseded in part by ADR-NNNN`. Proposed ADRs are decided together with the
proposal that introduces them.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-standalone-host.md) | `system` is a standalone host; other harnesses are clients or adapters | Accepted |
| [0002](0002-typescript-on-bun.md) | TypeScript on Bun, Node-compatible core | Accepted |
| [0003](0003-sqlite-durable-store.md) | SQLite (WAL) + content-addressed blobs as the durable store | Proposed |
| [0004](0004-single-workflow-runtime.md) | One workflow runtime combining DAG, input-hash durability, and lineage | Proposed |
| [0005](0005-provider-runtime-interface.md) | Provider drivers behind one `ProviderDriver` interface | Proposed |
| [0006](0006-protocol-introduction-gates.md) | Responses + MCP now, ACP optional, A2A deferred; no mirrored protocol objects | Proposed |
