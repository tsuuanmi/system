# Workflow engine

> Target state. Boundary: [orchestration](../architecture/components.md#orchestration).
> Requirements: REQ-WF-1..9. Decision: [ADR-0004](../decisions/adr/0004-single-workflow-runtime.md).

There is one engine, and every multi-step job runs on it as an append-only DAG
([ADR-0012](../decisions/adr/0012-dag-execution-model.md)). It combines three
ideas: a **semantic DAG** whose nodes
declare objectives and capability requirements, **durable nodes addressed by
input hash** so completed work is never redone, and **artifact lineage** so
superseded evidence invalidates dependent work.

## Admission

Lifecycle: `draft → preflight → confirm → accepted → active`.

- Each spec value carries its provenance: `user-explicit`, `interpreted`, or
  `policy-default`. Interpreted values that matter are confirmed before acceptance.
- Preflight validates the spec: acyclic, unique node ids, known executors,
  admissible capability requirements, and bounds within limits.
- The accepted spec is canonicalized and hashed. The run binds to that hash and
  to the profile version.

## Graph model

Exact shape: [`workflow-node.v1.json`](../../schemas/workflow-node.v1.json).

```ts
WorkflowNode {
  nodeId;                      // deterministic, e.g. "review:cycle:2:B:round:1:member:2"
  objective; executor: "team" | "worker" | "effect" | "gate";
  requires: CapabilityRequirement[];
  dependsOn: NodeId[];
  state: WAITING | READY | RUNNING | RECOVERING | COMPLETED | FAILED | BLOCKED;
  inputReceipt?:  { inputHash, dependencyOutputHashes };
  outputReceipt?: { resultId, outputHash };
  execution?:     { executionId, attempt, owner, lease, generation };
}
```

`inputHash` covers the canonical node definition, the fully rendered prompt or
input bundle, and the output hashes of its dependencies.

## Execution loop

```text
reconcile → promote READY (deps COMPLETED; compute inputHash)
         → for each runnable node (bounded concurrency):
              result store hit on (run, node, inputHash) → commit, no execution
              else start execution (lease + heartbeat) → route by executor
                   → store result blob → commit outputReceipt under current generation
         → apply graph growth → evaluate convergence → sleep until next wake
```

A scheduler exception moves the run to `BLOCKED` with `CODE_FIX_REQUIRED`. It
never crash-loops.

## Graph growth

Each graph snapshot is acyclic. Loops are unrolled into new nodes with ordinal
ids. Growth comes from two sources, and both are recorded as `graph-growth`
decision artifacts:

- **Profile rules** (static).
- **`plan` artifacts** emitted by a planner node (dynamic). The engine validates
  a plan (acyclic, admissible capabilities, within bounds) before appending its
  nodes.

Profiles declare growth rules. For example, when the implementation node reports a
PR, the engine appends a review cycle bound to that PR's head SHA. When a review
gate requires changes, it appends a remediation node. Growth is bounded, for
instance at most 3 review cycles.

## Handoffs

A handoff passes an upstream result verbatim to a downstream executor, bound by
SHA-256. Delivery is at least once, and acknowledgement is idempotent. Trusted
control messages, such as `START_IMPLEMENTATION` and `APPLY_REVIEWS {
expectedHeadSha }`, are separate from the model payload
([INV-6](../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)).

## Exact-subject gates

A review must report `reviewedSubject === currentSubject`, for example
`reviewedHeadSha === pr.headSha`. Remediation must keep the subject's identity, such
as the same PR, and must advance its version, such as a new head. The next cycle
binds to the new version. Mismatches fail the gate.

## Artifacts, lineage, invalidation

Node results, receipts, and every engine decision (spec admission, gate, graph
growth, recovery) are artifacts. Their model, lineage, and invalidation rules are
canonical in [artifacts](artifacts.md). Every node state transition references
the decision artifact that caused it.

## Recovery

| Failure class | Disposition |
|---|---|
| transient provider / network | `IMMEDIATE` or `BACKOFF` |
| browser session or conversation broken | `RECREATE_SESSION` |
| auth lost, confirmation needed, quota | `USER_ACTION` |
| contract violation, scheduler exception | `CODE_FIX` |
| invalid input, rejected by acceptance | `NONE` |

Attempts are bounded (default 3). The operator command `continue` reopens exactly
one `FAILED` node.

## Convergence

A run is complete only when it has no blockers. Possible blockers are unmet
criteria, open blocking findings, missing deliverables, pending authority gates,
missing receipts, incomplete dependencies, and incomplete plan tasks. Status
reports list the blockers explicitly, not just a percentage.

## Retention

Cleanup is explicit and operator-only. A preview lists the affected runs, and
deletion is keyed on the exact `runId` and `updatedAt`.
