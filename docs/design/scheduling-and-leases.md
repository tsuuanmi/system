# Scheduling and leases

> Target state. Boundaries: [provider runtime](../architecture/components.md#provider-runtime),
> [kernel](../architecture/components.md#kernel).

## Per-account scheduler

There is one scheduler per account.

- **Capacity:** `maxConcurrentTurnsPerAccount` (default 2).
- **Ordering:** turns in the same conversation session run strictly in order.
  Turns from different sessions may run in parallel up to capacity.
- **Exclusive fence:** `runExclusive(job)` waits for every earlier turn to finish,
  runs `job` alone, then releases later turns (FIFO). Login, visible runs, and
  account close use it.
- **Idle close:** browser resources close after `closeAfterMs` without work.

## Lease generations

Every scheduled unit holds a lease `{ owner, generation, expiresAt, signal }`.

- `invalidate()` increments the generation, rejects queued work, and aborts active
  work through its `AbortSignal`.
- Every commit, including receipt completion, auth write-back, and node output,
  presents its generation. The kernel rejects a commit from a stale generation.
- Workflow node executions use the same lease primitive with heartbeats. On
  startup, a `RUNNING` node with an expired lease or a foreign owner moves to
  `RECOVERING`.

Fences are required only where an old execution can race a new one. They are not
added by reflex. Every fence is justified by a failing race test.

## Optimistic revisions

Durable records carry `revision`. A write states `expectedRevision` and stores
`revision + 1`. A mismatch is a typed conflict, not an overwrite. Because the
SQLite store serializes writers
([ADR-0003](../decisions/adr/0003-sqlite-durable-store.md)), this check also holds
across processes.
