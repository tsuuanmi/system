# @tsuuanmi/system-store

**`ctx.store`**: `system`'s own durable records on `node:sqlite`
([ADR-0003](../../../docs/decisions/adr/0003-sqlite-durable-store.md); proven in
the [M0 spike](../../../docs/research/m0-dsh-core-spike.md)).

- **Owns:**
  - one database file (default `<DSH_HOME>/system/system.db`) in WAL mode;
  - `transaction()`: `BEGIN IMMEDIATE`, with savepoints when nested;
  - `migrate(owner, migrations)`: per-owner, recorded in `system_migrations`;
  - `updateRevision()`: optimistic revision guard that throws `RevisionConflict`.
- **Does not own:** domain tables. Each plugin migrates its own, as `artifacts`
  does.
- **Config:** `path`, `busyTimeoutMs`.
- **Lifecycle:** the database opens in a `ctx.effect` and closes when the plugin
  unloads.
