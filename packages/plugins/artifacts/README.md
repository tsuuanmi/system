# @tsuuanmi/system-artifacts

**`ctx.artifacts`**: immutable, content-addressed artifacts, including decision
records ([design](../../../docs/design/artifacts.md),
[INV-13](../../../docs/architecture/invariants.md#inv-13-every-decision-is-an-artifact)).

- **Owns:** `put` (id computed here, schema-validated, deduplicated, classification
  never below the strictest input), `recordDecision` (enforces that the selected
  candidate equals the outcome), `get`, `list`, `read` (the operator's bounded
  read of one artifact, [reading](../../../docs/design/artifacts.md#reading)), `explain` (a "why" walk over
  inputs, bounded by depth and by the number of artifacts visited; a collected
  input shows as `expired`), and `collect`: retention's sweep of the artifacts
  nothing retained needs ([storage](../../../docs/design/artifacts.md#storage)).
  Its roots are every content id in any store table but its own and the event
  log; it takes only unmarked artifacts past `collectGraceHours` that are linked
  to no run whose id still appears.
- **Bodies:** an artifact has exactly one of an inline `body` or a `blob` ref
  (`{ ref, bytes, mediaType }`). A store for such large bodies is planned
  ([storage](../../../docs/design/artifacts.md#storage)).
- **Injects:** `store`.
- **Config:** `explainDepth` (default 16), `explainBudget` (default 1000),
  `collectGraceHours` (default 24), `collectBatch` (default 1000: artifacts
  deleted per write transaction; the scan itself runs outside any).
