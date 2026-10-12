# Artifacts and decision records

> Target state. Decision: [ADR-0013](../decisions/adr/0013-typed-artifacts-and-decision-records.md).
> Invariant: [INV-13](../architecture/invariants.md#inv-13-every-decision-is-an-artifact).
> Exact shapes: [`schemas/`](../../schemas/README.md) (canonical), with semantics in
> [reference: schemas](../reference/schemas.md).
>
> Implemented in [`artifacts`](../../packages/plugins/artifacts/README.md); differs from target:
> bodies are inline only (no large-body store); no `spec-admission` decision is recorded; the
> store does not itself reject a transition without a decision id; re-planning when a
> planner's input is superseded is planned.

An **artifact** is an immutable, typed, content-addressed record. The work that
`system` produces is artifacts, and so is the record of how `system` decided.
Workflow state (node status, leases) is mutable and points at artifacts.
Artifacts themselves never change.

## Envelope

Every artifact shares one envelope
([`artifact-envelope.v1.json`](../../schemas/artifact-envelope.v1.json)):

| Field | Meaning |
|---|---|
| `schema` | `"<name>@<major>.<minor>"` of the envelope |
| `id` | `sha256:` of the canonical JSON of `{kind, body, inputs, lineage, subject}`; equal content means an equal id |
| `kind` | one of the kinds below |
| `bodySchema` | schema of the body, e.g. `decision@1.0` |
| `body` or `blob` | inline body, or a SHA-256 ref to a large body (planned) |
| `classification` | `public`, `operator-shared`, or `local-private`; drives egress ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)) |
| `producer` | who made it: `{ type: node, worker, policy, operator, system; ref }` |
| `subject` | what it is about, when exact-subject binding applies (e.g. a git head SHA) |
| `inputs` | artifact refs it was derived from |
| `lineage` | `supersedes`, `invalidates` refs |
| `runId`, `nodeId` | where it was produced, if inside a workflow |
| `createdAt` | timestamp (not part of `id`) |

## Kinds

| Family | Kind | Produced by | Example |
|---|---|---|---|
| domain | `objective`, `criteria` | admission | the accepted goal and acceptance criteria |
| domain | `plan` | planner node | proposed nodes for graph growth ([ADR-0012](../decisions/adr/0012-dag-execution-model.md)) |
| domain | `finding`, `evidence` | research Workers | a cited claim, a source excerpt, a test log |
| domain | `assessment` | review Workers | a verdict against criteria on an exact subject |
| domain | `report`, `handoff` | synthesis, compaction | a compact, cited synthesis passed downstream |
| domain | `delivery` | implementation Workers | a PR, a patch, or a dataset output, with its subject |
| control | `decision` | routing, engine, policies, operator | see below |
| control | `receipt` | provider runtime, engine | provider turn receipt, node input and output receipts |
| control | `approval` | operator | a human approval bound to an exact subject |
| control | `message` | worker sessions | a peer message in a session mailbox ([sessions](sessions-and-messaging.md)) |

## Decision artifacts

A decision artifact records **one decision**
([`decision.v1.json`](../../schemas/decision.v1.json)):

```jsonc
{
  "decisionType": "route",                 // see table below
  "question": "Which Worker runs node research:1?",
  "inputs": ["sha256:…work-requirement", "sha256:…worker-snapshot"],
  "candidates": [
    { "option": "worker:chatgpt-thinker/deep-research", "selected": true,
      "reasons": ["capabilities proven", "tier=frontier", "quota=subscription-chat"] },
    { "option": "worker:gemini-thinker/deep-research", "selected": false,
      "reasons": ["account state: reauth-required"] }
  ],
  "decider": { "type": "policy", "id": "routing.default", "version": "3", "hash": "sha256:…" },
  "modelAnswers": [],                      // filled when a decision model contributed (PROP-0002)
  "outcome": { "option": "worker:chatgpt-thinker/deep-research" },
  "deterministic": true,
  "rationale": "lowest admissible tier, preferred quota class"
}
```

| `decisionType` | Made by | Outcome example |
|---|---|---|
| `admission` | routing | Worker admitted or rejected for the requirement, with per-capability evidence |
| `route` | routing | the selected Worker, with every rejected candidate and its reason |
| `tier` | routing or decision model | `economy`, `standard`, or `frontier` |
| `escalation` | routing policy | the next tier after an acceptance rejection |
| `egress` | egress policy | payload permitted or blocked, with the artifact refs checked |
| `acceptance` | routing | accepted or rejected against the acceptance contract |
| `gate` | engine | exact-subject gate passed or failed |
| `reconciliation` | provider runtime | WAIT, RECOVER, RESUBMIT, or AMBIGUOUS, with snapshot hashes |
| `graph-growth` | engine | `plan` artifact accepted (nodes appended) or rejected |
| `recovery` | engine | failure class and retry disposition |
| `spec-admission` | engine | the workflow spec accepted, with the provenance of each value |

Rules:

1. **Every decision that changes what runs, where, or whether it is accepted
   produces a decision artifact before its effect is committed.** The state
   transition stores the decision's id. A transition without a decision id is
   rejected by the store.
2. Rejected candidates are recorded with reasons, not only the winner.
3. A decision made by a model also records the model receipt (provider, pinned
   version, answers, confidence). Its `deterministic` flag is `false`, and reuse
   by input hash makes it reproducible.
4. Decision artifacts are `operator-shared` by default. They reference private
   inputs but never inline them.

## Lineage and invalidation

`inputs` and `lineage` form a graph over artifacts. A node's frozen **input
bundle** is the set of artifact refs it consumed. When an artifact is
superseded, every node whose bundle depends on it, directly or transitively, is
fenced and becomes re-runnable. Its replacement execution records a `recovery`
decision that points at the superseding artifact.

The operator's `supersede` on a workflow node starts this
([workflow](../../packages/plugins/workflow/README.md)).

## Explain

Because every effect points at a decision and every decision points at its
inputs, the CLI can answer "why?" by walking backwards:

```mermaid
flowchart RL
  D["delivery sha256:…"] --> N[node implement:1]
  N --> RT["route decision: selected Worker, rejected candidates"]
  N --> TR["tier decision: standard"]
  N --> H["handoff sha256:…"]
  H --> RP[report]
  RP --> RC[deep-research turn receipt]
```

`system explain <runId>` gives each step's egress, tier, route (or admission), and acceptance
or recovery decisions with their reasons; `system explain <artifact id>` walks that artifact's
inputs, within `explainDepth` and `explainBudget`.

## Storage

Envelopes and their bodies are stored in `ctx.store`, indexed by id, kind,
`runId`, `nodeId`, subject, and decision type. A store for large bodies, addressed
by the envelope's `blob` ref, is planned. Retention follows the workflow retention
rules. A decision artifact is kept for as long as any artifact or state that
references it.
