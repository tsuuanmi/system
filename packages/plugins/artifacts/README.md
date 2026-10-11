# @tsuuanmi/system-artifacts

**`ctx.artifacts`**: immutable, content-addressed artifacts, including decision
records ([design](../../../docs/design/artifacts.md),
[INV-13](../../../docs/architecture/invariants.md#inv-13-every-decision-is-an-artifact)).

- **Owns:** `put` (id computed here, schema-validated, deduplicated, classification
  never below the strictest input), `recordDecision` (enforces that the selected
  candidate equals the outcome), `get`, `list`, and `explain` (a bounded "why"
  walk).
- **Does not own:** blob storage. Large bodies arrive later through `ctx.blobs`.
- **Injects:** `store`.
- **Config:** `explainDepth`.
