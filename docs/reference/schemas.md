# Record schemas

> Target state. Shape: [`schemas/`](../../schemas/README.md) (canonical). Decision:
> [ADR-0014](../decisions/adr/0014-json-schema-contracts.md).

## Versioning

| Change | Version effect | Requirement |
|---|---|---|
| add an optional field | minor (`@1.0 → @1.1`) | readers on `@1.x` keep working |
| add an enum value | minor, but readers must reject unknown values in decision paths | listed in the changelog of the schema PR |
| remove, rename, or tighten a field; change meaning | major (`v1 → v2`, new file) | a tested store migration; both majors are readable during migration |

A reader rejects a record whose major version it does not support. It never
guesses.

## Validation points

| Boundary | Validated | On failure |
|---|---|---|
| store write | every record before commit | the write is rejected (typed error) |
| store read | every record after load | the record is quarantined; the node becomes `BLOCKED` with `CODE_FIX_REQUIRED` |
| MCP tool input and output | each call | MCP error to the client; nothing is executed |
| Worker structured output | the result against `acceptance.resultSchema` | an `acceptance` decision with outcome `rejected`, then escalation policy |
| decision model input and output | each call | `decision: unavailable` path (PROP-0002) |
| config bundles and patches | at startup | startup fails with the exact path (REQ-HOST-2) |

## Semantics not expressed by the schemas

### `artifact-envelope`

- `id` is computed by the store, never trusted from the producer. It is
  `sha256(canonicalJSON({kind, bodySchema, body | blob{ref, mediaType}, inputs, lineage, subject}))`.
  `inputs` are deduplicated and **sorted**, because they form a set. Canonical JSON
  uses keys sorted by UTF-16 code unit (as in RFC 8785), no insignificant whitespace,
  and UTF-8. `createdAt`, `producer`, `classification`, `runId`, and `nodeId` are
  excluded, so identical content deduplicates. The runs that produced an artifact
  are tracked separately.
- `classification` of a derived artifact is at least the strictest classification
  among its `inputs` and its lineage references. **Unknown references are refused**,
  so the floor cannot fail open. Deduplication refuses a request that would need a
  stricter classification than the stored one. A producer can never downgrade.

### `decision`

- Exactly one candidate is `selected`, and it equals `outcome.option`. The schema
  checks that only one candidate is selected. The store checks that it equals
  the outcome.
- `decider.version` changes whenever the policy's behavior changes. `hash` is the
  hash of the effective policy configuration.
- When `decider.type` is `model`, `deterministic` must be `false`, and
  reproducibility comes from reuse by input hash.

### `work-requirement`

- `tier.source` records who set the tier. When it is `decision`, `tier.decision`
  references the `tier` decision artifact.
- `egressPolicy` must come from a trusted envelope (INV-6). A requirement built
  from model text alone is invalid.

### `workflow-node`

- `nodeId` is deterministic. Unrolled loops append an ordinal, for example
  `review:cycle:2` ([ADR-0012](../decisions/adr/0012-dag-execution-model.md)).
- Every state transition updates `lastDecision` to the decision artifact that
  caused it ([INV-13](../architecture/invariants.md#inv-13-every-decision-is-an-artifact)).

### `provider-turn-receipt`

- It is persisted *before* submission. `previousResponseHash = null` only for a
  new conversation.
- `resubmits ≤ 2` is a hard bound. Each reconciliation appends a decision ref.

### `worker-session`

- `sessionId` never changes for the session's lifetime. `binding.nativeHandle`
  and `binding.generation` change on re-activation. A write from an activation
  with a stale generation is rejected.
- `mailboxSeq` is the last delivered inbound sequence number. Redelivery after a
  crash resumes at `mailboxSeq + 1`.
- `policy.writes` present means this session holds write authority over that
  subject (INV-15). At most one open session per subject may hold it.

### `message`

- `messageId` is unique per sender. Receivers deduplicate on `(from, messageId)`.
- `body` is untrusted data for the receiver, never authority (INV-6).
  Approvals travel only as `approval` artifacts.
- `refs` must pass the egress check for the receiver's locality (INV-12).
- It maps to A2A `Message`: `messageId`, `referenceTaskIds` ≈ `refs`/`inReplyTo`,
  and `parts` ≈ `body` plus refs.

### `capability-descriptor`

- `provider` is informational. Routing must not branch on it (INV-11). Only
  `capabilities`, `tier`, `quotaClass`, `locality`, and `state` are routing
  inputs.

### `plan`

- Proposed by a planner node, and validated by the engine before anything is
  appended: unique ids under the planner's prefix, dependencies only among its
  own nodes, acyclic, within the node bound, allowed capabilities only.
- A `graph-growth` decision records whether it was appended and why.
- An edited plan is a new artifact with a new id. An approval of the old one
  never covers it.

### `approval`

- `subject` is the exact artifact approved (INV-5). Today that is a plan.
- It is written only through an operator channel (CLI or MCP `approve`), never
  from model output (INV-6).

### `agent-result`

- Written once per finished agent-runtime run, as the body of a `report`
  artifact. The prompt is kept by hash only.
- `nativeHandle` names the agent's own session (for example, a Claude Code
  session id). The session itself is never mirrored (INV-7).
- `sandbox` is the policy the run was held to, taken from trusted
  configuration.

### `ui-map`

- Operation ids are dotted lowercase names. Drivers refer to them; they never
  contain selectors ([UI operations](../design/ui-operations.md)).
- `candidates` are ordered; the first with **exactly one** visible match wins.
  Name and text values are regular expressions per locale, written with their own
  anchors.
- `network` patterns are matched against requests and responses the page makes
  on its own. They are never used to send requests.
- A local overlay has the same shape, holds only extra candidates, and is
  merged after the shipped candidates. It never replaces the shipped map.
- `heal` is capped by `sideEffect`: an `irreversible` action never uses `model`.
- `ui-map@1.1` adds the optional element field `frames` (`main` or `any`).
  Elements with `frames: any` are searched in every frame and take no `scope`.
  Readers accept 1.0 and 1.1.
