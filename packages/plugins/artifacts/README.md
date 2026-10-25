# @tsuuanmi/system-artifacts

**`ctx.artifacts`**: immutable, content-addressed artifacts, including decision
records ([design](../../../docs/design/artifacts.md),
[INV-13](../../../docs/architecture/invariants.md#inv-13-every-decision-is-an-artifact)).

- **Owns:** `put` (id computed here, schema-validated, deduplicated, classification
  never below the strictest input), `recordDecision` (enforces that the selected
  candidate equals the outcome and that every candidate gives a reason), `get`, `list`, `read` (the operator's bounded
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
- The conformance suite is [`conformance/artifacts.ts`](conformance/artifacts.ts)
  (contract 1.1: `list` takes an optional `newest`; 1.2: an optional `outcome`), run against this plugin over a real store:
  - the id is computed from the canonical content alone (a blob by its ref and
    media type), never from the producer's id or time;
  - identical content is stored once and listed under every run that produced
    it; inputs are a sorted set;
  - the body is validated against its `bodySchema` and the envelope against
    `artifact-envelope@1.0`; an invalid one, an unknown schema or major, or an
    artifact with both or neither of body and blob is refused, storing nothing;
  - the classification floor over inputs and lineage; an unknown reference is
    refused;
  - no downgrade: deduplication refuses a stricter classification and keeps the
    stored one over a laxer request;
  - a decision needs exactly one selected candidate equal to its outcome (a
    model decision is never deterministic; a later minor's type needs that
    minor), and is `operator-shared` by default;
  - every candidate of a decision, rejected or selected, gives a reason (INV-13);
  - a decision's prose is clamped to its bounds on whole characters;
  - immutability: nothing changes a stored artifact; a correction supersedes it;
  - `list` filters by kind, decision type, run, and node, within a limit; in
    stored order, or newest first with `newest` (1.1); `outcome` keeps only the
    decisions whose outcome is that option (1.2);
  - `read`: the header, a bounded window of text or JSON in whole characters,
    and only content ids;
  - `explain` walks inputs once each, within `explainDepth` and `explainBudget`;
  - `collect` takes only what no root reaches, past the grace period, of no
    remaining run; a collected artifact still named reads as `expired`;
  - an artifact that a kept artifact references through its inputs or lineage is
    never collected: an artifact in the grace period or of a live run is a root.
