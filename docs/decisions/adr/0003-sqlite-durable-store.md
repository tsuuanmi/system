# ADR-0003: SQLite (WAL) with content-addressed blobs as the durable store

- **Status:** Accepted (2026-10-11, with PROP-0001); amended 2026-10-12 (no blob store until a consumer exists)
- **Date:** 2026-10-11
- **Related:** PROP-0001, QA-4, INV-4

## Context

internet persists everything as atomic private JSON files: write to a temp file,
fsync, then rename. Its revision checks are read-then-write with no file lock, so
they are correct only in a single process. Listing scans whole directories. The
durable-node and receipt semantics are sound, but the storage substrate does not
scale and cannot fence across processes. The MCP server, the CLI, and the host
will be separate processes that touch the same state.

## Options

1. Keep atomic JSON files and add advisory file locks.
2. Use SQLite in WAL mode for records, with content-addressed files for large
   blobs.
3. Use an external durable runtime (Temporal, Inngest) or a database server.

## Decision

Option 2. Records (accounts, receipts, runs, nodes, leases, events) live in
SQLite. Every write runs in a transaction that checks `expectedRevision` and the
lease generation. Large payloads (results, transcripts) are stored as files named
by their SHA-256 and referenced from records. Files that hold credentials are
owner-only (0600), and the account vault is a separate file.

## Consequences

- Serialized writers make revision and lease fences correct across processes.
  Queries replace directory scans.
- Schema migrations become an engineering obligation, as versioned and tested
  migrations.
- An external runtime (option 3) is rejected until a concrete durability gap
  appears that SQLite plus reconciliation cannot close. This follows AgentOS's
  ecosystem evaluation.

## Amendment (2026-10-12): no blob store until a consumer exists

The content-addressed file store for large payloads was built as `ctx.blobs`, but no plugin
ever wrote to it: answers and reports fit in SQLite records. It was removed so that no
speculative store is shipped. The decision stands: records live in SQLite. When a payload
outgrows a record, the first candidate is DSH's own attachment store (it already stores
files by SHA-256 and verifies them on read); it was not adopted today because
`dsh-attachment-local` depends on the native `sharp`, requires a display name, and is not an
allow-listed row. The `blob` reference in `artifact-envelope` is kept, reserved.
