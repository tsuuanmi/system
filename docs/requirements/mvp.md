# System MVP

- **Status:** initial normative scope
- **Host:** DSH / Cordis
- **Purpose:** prove the System control model with one useful end-to-end workflow

## Goal

The MVP must prove that System can take a user objective and coordinate multiple
forms of intelligence through explicit semantic boundaries without becoming a
monolithic super-agent or rebuilding runtime mechanics already provided by DSH.

A successful MVP demonstrates:

```text
user objective
  -> semantic workflow
      -> Worker/Team selection
          -> capability-backed execution
              -> Artifacts + Evidence
                  -> explicit acceptance
                      -> recoverable progression
```

## Primary vertical

The first vertical should be a software-development workflow because it exercises
research, implementation, validation, review, artifacts, repository state, and
authority in one concrete domain.

Representative flow:

```text
Research A -----+
                +--> Synthesis --> Implement --> Validate ----+
Research B -----+                                             |
                                                              +--> Review
Review A ------------------------------------------------------+
Review B ------------------------------------------------------+
                                                               |
                                                        accepted result
                                                               |
                                                     user-owned effect gate
```

The exact procedure may evolve. The MVP requirement is that System owns the
semantic flow while underlying runtimes own their native mechanics.

## Required MVP capabilities

### 1. Goal to semantic Workflow

System must be able to instantiate a semantic DAG whose nodes have:

- stable node identity;
- objective;
- explicit dependencies;
- executor kind or semantic requirements;
- exact correctness-bearing input identity;
- accepted output/evidence identity.

The workflow domain must not depend on provider brands.

### 2. Worker admission and deterministic routing

System must route one-shot semantic work through DSH `ctx.subagents` or the
appropriate native runtime.

Admission must:

- evaluate required current capabilities;
- reject Workers that cannot prove conformance;
- make selection deterministic under configured policy;
- preserve native cancellation;
- keep semantic acceptance separate from provider completion.

The MVP does not need an AI-based router.

### 3. Persistent Team participation

System must support persistent collaborative members through DSH
`ctx.agentTeams`.

The MVP must prove:

- member identity persists for the Team lifecycle;
- member formation admits only Team-compatible providers;
- peers can communicate directly through the native Team boundary;
- an independent-first barrier can be enforced;
- a collaboration procedure can run after the barrier;
- phase completion requires explicit semantic acceptance.

One-shot auxiliary Workers may be used by a Team Member, but must not silently
become the Team identity.

### 4. At least one reusable Team procedure

The MVP must implement at least one useful procedure composed from Team
primitives, for example:

```text
independent work
  -> peer critique/review
      -> revision or strongest-supported synthesis
          -> accepted phase result
```

The Team Core must not hard-code debate as the only collaboration model.

### 5. First-class Artifacts and Evidence

Tasks must be able to produce addressable Artifacts and Evidence separately from
mailbox/chat text.

The MVP must prove:

- a Task can consume Artifact references;
- a Task can produce Artifact references;
- Artifact identity is stable enough for downstream input receipts;
- compact Team messages can reference Artifacts instead of embedding large
  payloads;
- accepted claims can point to supporting Evidence.

The first store may be simple and local. Distributed artifact infrastructure is
not required.

### 6. Website capability

System must support a Website-capable Worker using semantics selectively adapted
from `@tsuuanmi/internet`.

The MVP must preserve the important correctness behaviors:

- logical request identity;
- semantic conversation continuity where needed;
- retained-result idempotency;
- reconcile-before-resubmit;
- bounded resubmission;
- full-result retention with bounded model-context projection;
- cancellation propagation;
- provider-specific details below `WebsiteProviderRuntime`.

The first direct DSH composition must not require MCP.

### 7. Execution attempt fencing

A logical Task/node and a concrete execution attempt must not be the same
identity.

The MVP must prevent stale attempts from committing late output after ownership
or retry has moved to a newer attempt.

### 8. Recovery of the smallest safe unit

On interruption or restart, System must prefer:

```text
reconcile exact current state
  -> recover completed exact work
      -> otherwise retry the smallest safe logical unit
```

Completed siblings and dependencies must not be replayed merely because a
downstream step failed.

### 9. Explicit acceptance

The MVP must preserve layered completion:

```text
provider/runtime finished
  != Worker result accepted

Worker result accepted
  != Team phase accepted

Team phase accepted
  != Workflow complete

Workflow success
  != consequential user authority
```

### 10. Explicit user authority boundary

At least one representative consequential external effect must require explicit
user authority scoped to the exact target state.

The software-development vertical may use merge/publish as the first example.

### 11. Observability

The MVP must expose enough state to answer:

- what Workflow is running?
- which Tasks are READY/RUNNING/BLOCKED/COMPLETED?
- which execution attempt owns active work?
- what dependency blocks progress?
- what Artifact/Evidence was produced?
- what failure/recovery action is current?
- what user action or authority is required?

Diagnostic events must not become a second correctness state machine.

### 12. TDD for behavioral implementation

Behavioral implementation follows strict Red -> Green -> Refactor.

Every bug fix requires a reproducing regression test before the production fix.
Refactors must preserve behavior under existing or added characterization tests.

## Concrete MVP runtime choices

The first implementation intentionally uses:

```text
DSH / Cordis
  -> host and plugin composition

DSH ctx.subagents
  -> one-shot/multi-provider Worker execution

DSH ctx.agentTeams
  -> persistent Team lifecycle and native peer messaging

Website Core + WebsiteProviderRuntime
  -> Website capability

existing DSH storage/credentials/jobs/workflow facilities
  -> reused where their semantics are sufficient
```

Concrete implementation choices are replaceable below semantic boundaries; they
do not redefine the domain model.

## Protocol scope

### ACP

Optional in the MVP.

Use ACP when a real external Worker/runtime should be controlled through an ACP
boundary. Do not require ACP for ordinary in-process DSH execution.

### MCP

Optional in the MVP.

Use MCP when a real second consumer needs a reusable tool/resource/capability
surface. Do not force the first Website integration through MCP.

### A2A

Deferred.

Native DSH Team messaging is sufficient for the first persistent Team. Add A2A
only when independently addressable Workers across runtimes require persistent
direct-peer interoperability.

## Non-goals

The MVP does not require:

- a universal normalized Worker anatomy;
- a second Team runtime;
- a custom MCP registry or transport;
- custom ACP lifecycle wrappers;
- A2A-based Team communication;
- heterogeneous Codex/Claude/etc. persistent Team membership unless the runtime
  actually satisfies continuation semantics;
- an opaque AI Worker router;
- arbitrary user-defined distributed DAGs;
- multi-host consensus;
- a globally distributed Artifact store;
- a general-purpose UI platform;
- autonomous consequential effects without user authority;
- compatibility with every `internet` or AgentOS public API;
- preserving obsolete standalone Website-Agent abstractions merely for migration.

## What should be selectively inherited

### From `@tsuuanmi/internet`

Retain proven semantics and lessons around:

- browser/provider account isolation;
- conversation binding;
- turn receipts;
- reconcile-before-resubmit;
- exact retained results;
- execution attempts;
- workflow recovery;
- evidence bound to exact external state;
- explicit user authority.

Do not copy the entire application/workflow stack when System owns that layer.

### From AgentOS

Retain:

- Worker as opaque assignable execution unit;
- capability-driven admission;
- Worker routing separate from Worker identity;
- Team Member Model A;
- DSH-native Team and Worker runtime reuse;
- Website as composable capability;
- protocol placement based on proven need;
- replaceability through narrow semantic seams.

System extends this model by making goal state, planning, Artifact/Evidence
graphs, authority, and durable control first-class parts of the brain/control
plane.

## MVP completion criteria

The MVP is complete when one end-to-end software-development workflow can
demonstrate all of the following in tests and a controlled real run:

1. a semantic Workflow is instantiated from a goal/Profile;
2. independent Team work executes behind a barrier;
3. Worker routing is capability-driven and deterministic;
4. Website capability can participate without leaking provider details upward;
5. Tasks exchange exact Artifact/Evidence references;
6. implementation and validation produce accepted evidence;
7. independent review is bound to the exact implementation state;
8. interrupted work can reconcile and resume without broad replay;
9. stale execution attempts cannot commit;
10. consequential final effect requires explicit scoped user authority;
11. state/diagnostics clearly explain current progress and blockers;
12. higher layers contain no provider-specific branches that violate the
    architecture.
