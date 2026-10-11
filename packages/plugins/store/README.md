# @tsuuanmi/system-store

**`ctx.store`**: `system`'s own durable records on `node:sqlite`
([ADR-0003](../../../docs/decisions/adr/0003-sqlite-durable-store.md); proven in
the [M0 spike](../../../docs/research/m0-dsh-core-spike.md)).

- **Owns:**
  - one database file (default `<DSH_HOME>/system/system.db`) in WAL mode, created
    owner-only (`0600`, as are its `-wal` and `-shm` files; it holds prompts and
    answers) in an owner-only directory;
  - `transaction()`: `BEGIN IMMEDIATE`, with savepoints when nested;
  - `migrate(owner, migrations)`: per-owner, recorded in `system_migrations`;
  - `updateRevision()`: optimistic revision guard that throws `RevisionConflict`.
  - `afterCommit(cb)`: runs `cb` after the outermost commit and drops it on rollback.
    Callback errors are logged and never fail the write.
  - A failed COMMIT rolls back and surfaces the original error. A Promise-returning
    callback, which is also a type error, **poisons** the store.
  - `synchronous=FULL` by default (configurable).
- **Does not own:** domain tables. Each plugin migrates its own, as `artifacts`
  does.
- **Config:** `path`, `busyTimeoutMs`.
- **Lifecycle:** the database opens in a `ctx.effect`. On unload it closes after
  the current dispose pass, so dependents can still write from their own disposers.
