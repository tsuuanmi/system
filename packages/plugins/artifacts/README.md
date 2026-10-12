# @tsuuanmi/system-artifacts

**`ctx.artifacts`**: immutable, content-addressed artifacts, including decision
records ([design](../../../docs/design/artifacts.md),
[INV-13](../../../docs/architecture/invariants.md#inv-13-every-decision-is-an-artifact)).

- **Owns:** `put` (id computed here, schema-validated, deduplicated, classification
  never below the strictest input), `recordDecision` (enforces that the selected
  candidate equals the outcome), `get`, `list`, and `explain` (a "why" walk over
  inputs, bounded by depth and by the number of artifacts visited).
- **Bodies:** an artifact has exactly one of an inline `body` or a `blob` ref
  (`{ ref, bytes, mediaType }`). A store for such large bodies is planned
  ([storage](../../../docs/design/artifacts.md#storage)).
- **Injects:** `store`.
- **Config:** `explainDepth` (default 16), `explainBudget` (default 1000).
