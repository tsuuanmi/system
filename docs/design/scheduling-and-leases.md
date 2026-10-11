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
  calls `ctx.leases.fence(lease)` **inside** the committing store transaction. The
  fence passes only if that exact lease (token **and** generation) still holds the
  resource and has not expired. Because it runs under the transaction's write lock, no
  successor can take over before the commit lands.
- Website turns (`ctx.turns`) hold a `turn:<id>` lease with a heartbeat. The
  receipt written before the send, the routing, and the completion are fenced, so
  two processes sharing one home never send the same turn twice. This is covered
  by a two-process test.
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
