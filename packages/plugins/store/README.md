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
    No plugin calls it yet: those with revisioned records (such as `accounts`)
    check and bump the revision in their own write.
  - `afterCommit(cb)`: runs `cb` after the outermost commit and drops it on rollback.
    Callback errors are logged and never fail the write.
  - A failed COMMIT rolls back and surfaces the original error. A Promise-returning
    callback, which is also a type error, **poisons** the store.
  - `synchronous=FULL` by default (configurable).
- **Does not own:** domain tables. Each plugin migrates its own, as `artifacts`
  does.
- **Config:** `path`, `busyTimeoutMs`, `synchronous`.
- **Runtime check:** before opening, `sqliteRuntimeProblem()` round-trips text
  with an embedded NUL through `node:sqlite`. A runtime that cuts it (Node 22, and
  24 or 26 before the fix) fails the plugin's start with the supported range
  (REQ-HOST-2, [CON-2](../../../docs/requirements/constraints.md)), so stored
  prompts and answers are never silently truncated.
- **Lifecycle:** the database opens in a `ctx.effect`. On unload it closes after
  the current dispose pass, so dependents can still write from their own disposers.
