# patches

Minimal fixes to pinned dependencies, applied by pnpm (`patchedDependencies`
in [pnpm-workspace.yaml](../pnpm-workspace.yaml)) on every install.

- `@deepseek-ai__dsh-storage-sqlite@0.2.2-rc.1.patch` — sets
  `PRAGMA busy_timeout = 5000` on DSH's SQLite connection. Without it, every
  `system` command boots a host that opens and writes the same store, and a
  second writer fails at once with "database is locked": a concurrent
  `system doctor` could kill a host running Work (tests/concurrency.test.ts;
  the M6 takeover anomaly in the [MVP-0 plan](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md)).
  The same patch fixes two races when several processes find the store
  missing and create it together: the switch to WAL is retried (SQLite
  answers it "database is locked" without consulting the busy timeout), and a
  unit's version row is inserted with `INSERT OR IGNORE` and read back instead
  of failing with `UNIQUE constraint failed: units.name`. Drop the patch when
  DSH fixes these itself (upstream discussion deepseek-ai/deepseek-harness#718).
- `@deepseek-ai__dsh@0.2.2-rc.1.patch` — every DSH boot rewrote
  `profiles/<name>/cordis.yml` (truncate, then write), so a host booting
  alongside could read it empty and fail ("config file must be a top-level
  array"; seen once in `tests/concurrency.test.ts`). It is now written only
  when it differs, and then atomically. The test that a boot leaves the file
  untouched was red before. Drop the patch when DSH does the same.

## Overrides

Transitive dependencies pinned by DSH at a vulnerable version are raised with
`overrides` in [pnpm-workspace.yaml](../pnpm-workspace.yaml), each scoped to
the vulnerable range so a newer resolution is never downgraded.

- `undici` `>=8.0.0 <8.12.2` → `8.12.2` — DoS, TLS validation bypass and cache
  poisoning (Dependabot).
- `@modelcontextprotocol/client` `>=2.0.0 <2.3.0` → `2.3.0` — medium alert
  (Dependabot).
- `zod` `<4.6.6` → `4.6.6` — memory exhaustion validating oversized collections
  (Dependabot). The packages depend on 4.6.6 directly; DSH's own zod 4.4.3 would
  otherwise be a second copy, and `tsc` runs out of memory comparing the two
  versions' types in `domainTable(recordSchema)`.
- `fflate` `>=0.8.0 <0.8.3` → `0.8.3` — `unzipSync` loops forever on a
  malformed ZIP64 archive (GHSA-px8p-9vwx-vf98, moderate; `pnpm audit`, not yet
  a Dependabot alert). It comes in through DSH's office skills, which the
  `system` profile does not mount.

Drop an override when DSH depends on a patched version itself.
