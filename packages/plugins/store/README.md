# @tsuuanmi/system-store

**`ctx.store`**: `system`'s own durable records on `node:sqlite`
([ADR-0003](../../../docs/decisions/adr/0003-sqlite-durable-store.md); proven in
the [M0 spike](../../../docs/research/m0-dsh-core-spike.md)).

- **Owns:**
  - one database file (default `<DSH_HOME>/system/system.db`) in WAL mode, created
    owner-only (`0600`, as are its `-wal` and `-shm` files; it holds prompts and
    answers) in an owner-only directory;
  - `transaction()`: `BEGIN IMMEDIATE`, with savepoints when nested;
  - `migrate(owner, migrations)`: per-owner, recorded in `system_migrations`. It
    refuses a store whose recorded version for the owner is newer than any
    migration the code knows, so an older release never opens a store a newer
    one migrated;
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
- **Runtime check:** before opening, the store refuses to start on a runtime
  outside the supported range or whose `node:sqlite` cuts text at an embedded NUL
  (`sqliteRuntimeProblem` in `system-libs`; REQ-HOST-2,
  [CON-2](../../../docs/requirements/constraints.md)), so stored prompts and
  answers are never silently truncated. `system init` and `start` check the same
  first, so a refused runtime never boots a host.
- **Hidden from agents:** the database and its `-wal` and `-shm` files are
  registered secret paths while open, wherever `path` puts them ([ADR-0024](../../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)).
- **Lifecycle:** the database opens in a `ctx.effect`. On unload it closes after
  the current dispose pass, so dependents can still write from their own disposers.
