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

There is one scheduler per account: a website account's, and an agent account's, which runs its
Workers' runs one per Worker ([agent runtimes](agent-runtimes.md#workers--account--role)). A
hand-named agent Worker has one of its own, with capacity 1.

- **Capacity:** `maxConcurrentTurnsPerAccount` for a website account (default 2);
  `maxConcurrentRunsPerAccount` for an agent account (default 1).
- **Ordering:** turns in the same conversation session run strictly in order.
  Turns from different sessions may run in parallel up to capacity. The order is
  decided from durable state, so it holds across processes and restarts: a later
  website turn waits while an earlier turn of its session is unfinished, even one
  whose lease a crashed process still holds.
- **Exclusive fence:** `runExclusive(job)` waits for every earlier turn to finish,
  runs `job` alone, then releases later turns (FIFO). It is meant for visible
  runs and account close. Login does not take it: a
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
- Every durable runner holds its lease through one loop, `ctx.leases.hold`:
  acquire, a heartbeat at a third of the TTL, `lost` on a positive loss, and
  release. Each runner decides what a lost lease means and when to look again.
  A positive loss is a renewal that finds the lease expired, taken over, or
  invalidated (`LeaseLost`), or the lease's own expiry passing with no renewal. A
  renewal that fails otherwise (the store busy or failing) is not a loss: it is
  tried again at the next beat, and never later than the expiry. Fencing is the
  same either way, so a holder whose lease lapsed commits nothing
  ([ADR-0056](../decisions/adr/0056-a-failed-lease-renewal-is-not-a-lost-lease-and-death-needs-a-verdict.md),
  leases contract 1.1).
- Website turns (`ctx.turns`) hold a `turn:<id>` lease with a heartbeat. The
  receipt written before the send, the routing, and the completion are fenced, so
  two processes sharing one home never send the same turn twice. This is covered
  by a two-process test.
- Agent runs (`agent-workers`) hold an `agent-run:<id>` lease. A run whose lease
  another process holds, or whose lease was lost, is looked at again once the
  lease can be taken, so it is never stranded until the next start. A lease that
  can be taken does not make a started run gone: it is reconciled only on a
  [liveness verdict](#liveness-verdict) of `dead`.
- Workflow executions use the same lease primitive with heartbeats. Target: on
  startup, a `RUNNING` node with an expired lease or a foreign owner moves to
  `RECOVERING`. Today a run advances under a `run:<id>` lease. A lost lease re-arms
  the run, whether a fenced write throws or the `lost` signal ends a node's wait
  for its execution. On start unfinished runs resume while the turn runtime reconciles
  their turns.

Fences are required only where an old execution can race a new one. They are not
added by reflex. Every fence is justified by a failing race test.

## Liveness verdict

Whether a run that another process held, or held before a restart, is gone is a
verdict, never an assumption
([ADR-0056](../decisions/adr/0056-a-failed-lease-renewal-is-not-a-lost-lease-and-death-needs-a-verdict.md),
PROP-0013). `livenessOf` in [`libs`](../../packages/libs/README.md) is a pure rule,
pinned as `liveness@1`, over three signals and two configured bounds:

| Signal | What is recorded | Probed |
|---|---|---|
| holder | the process that held the run (host, boot, pid, start time), and its lease | the lease: lapsed when it could be taken; the process: from this host's `/proc` |
| runtime | the agent process the runtime started, when it reports one (`RunObserver.onProcess`) | from this host's `/proc` |
| activity | the submission, then the runtime's activity (`onActivity`), written at most once per heartbeat | the latest time recorded |

| Verdict | When |
|---|---|
| `alive` | the holder's lease is live and the agent process present, with activity within `stallSeconds` |
| `stalled` | the agent process is present, with no activity for `stallSeconds` or more |
| `unknown` | any probe failed, a signal was never reported, or anything else |
| `dead` | the holder's lease lapsed and its process is gone, the agent process is gone, and no activity was seen within `deadAfterSeconds` |

Only `dead` is death. A process is gone only on positive evidence: no process has
its pid, the one that has it started at another time, it has exited, or the host
booted again. A process recorded on another host is `unknown`. What each verdict
does to an agent run is the `agents` source's
([restart and liveness](agent-runtimes.md#restart-and-liveness)), as are what the operator
sees of a run whose liveness needs a look and how they free one held for want of a verdict
([what the operator sees](agent-runtimes.md#what-the-operator-sees),
[freeing what a run holds](agent-runtimes.md#freeing-what-a-run-holds)). Website turns keep
their receipts; the verdict does not apply to them.

## Optimistic revisions

Durable records carry `revision`. A write states `expectedRevision` and stores
`revision + 1`. A mismatch is a typed conflict, not an overwrite. Because the
SQLite store serializes writers
([ADR-0003](../decisions/adr/0003-sqlite-durable-store.md)), this check also holds
across processes.

The store offers this as `updateRevision()`, which throws `RevisionConflict`. The
plugins that keep revisioned records (such as `accounts`) check and bump the
revision in their own write instead.
