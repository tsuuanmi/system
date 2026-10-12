# Scheduling and leases

> Target state. Boundaries: [provider runtime](../architecture/components.md#provider-runtime),
> [kernel](../architecture/components.md#kernel).
>
> Implemented in [`provider-core`](../../packages/provider-core/README.md) (`ProviderScheduler`),
> [`leases`](../../packages/plugins/leases/README.md), and
> [`store`](../../packages/plugins/store/README.md); differs from target: `runExclusive` has no
> caller yet; the workflow engine leases a whole run (`run:<id>`), not each node execution;
> `RECOVERING` is not used; plugins check revisions in their own writes, not through the
> store's `updateRevision`.

## Per-account scheduler

There is one scheduler per account (and one per agent Worker, with capacity 1).

- **Capacity:** `maxConcurrentTurnsPerAccount` (default 2).
- **Ordering:** turns in the same conversation session run strictly in order.
  Turns from different sessions may run in parallel up to capacity. The order is
  decided from durable state, so it holds across processes and restarts: a later
  website turn waits while an earlier turn of its session is unfinished, even one
  whose lease a crashed process still holds.
- **Exclusive fence:** `runExclusive(job)` waits for every earlier turn to finish,
  runs `job` alone, then releases later turns (FIFO). It is meant for visible
  runs and account close; nothing calls it yet. Login does not take it: a
  relogin runs inside a turn that already holds a slot, so the fence would wait
  on itself. A sign-in that races a turn is settled by the account revision
  instead ([browser runtime](browser-runtime.md): the turn's write-back is
  skipped).
- **Invalidation:** `invalidate()` increments the scheduler's generation, rejects
  queued work, and aborts active work through its `AbortSignal`.
- **Idle close:** browser resources close after `closeAfterMs` without work. The
  browser plugin owns this timer, not the scheduler.

## Lease generations

Every scheduled unit holds a lease `{ owner, generation, expiresAt, signal }`.

- `ctx.leases.invalidate()` fences every holder of a resource at once.
- Every commit, including receipt completion, auth write-back, and node output,
  calls `ctx.leases.fence(lease)` **inside** the committing store transaction. The
  fence passes only if that exact lease (token **and** generation) still holds the
  resource and has not expired. Because it runs under the transaction's write lock, no
  successor can take over before the commit lands.
- Website turns (`ctx.turns`) hold a `turn:<id>` lease with a heartbeat. The
  receipt written before the send, the routing, and the completion are fenced, so
  two processes sharing one home never send the same turn twice. This is covered
  by a two-process test.
- Agent runs (`agent-workers`) hold an `agent-run:<id>` lease. A run whose lease
  another process holds, or whose lease was lost, is looked at again once the
  lease can be taken, so it is never stranded until the next start.
- Workflow executions use the same lease primitive with heartbeats. Target: on
  startup, a `RUNNING` node with an expired lease or a foreign owner moves to
  `RECOVERING`. Today a run advances under a `run:<id>` lease; a lost lease re-arms
  the run, and on start unfinished runs resume while the turn runtime reconciles
  their turns.

Fences are required only where an old execution can race a new one. They are not
added by reflex. Every fence is justified by a failing race test.

## Optimistic revisions

Durable records carry `revision`. A write states `expectedRevision` and stores
`revision + 1`. A mismatch is a typed conflict, not an overwrite. Because the
SQLite store serializes writers
([ADR-0003](../decisions/adr/0003-sqlite-durable-store.md)), this check also holds
across processes.

The store offers this as `updateRevision()`, which throws `RevisionConflict`. The
plugins that keep revisioned records (such as `accounts`) check and bump the
revision in their own write instead.
