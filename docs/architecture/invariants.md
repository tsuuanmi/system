# System invariants

> Target state. These rules are binding on all code. Changing one requires an ADR.

### INV-1 One authoritative runtime

For each concern there is exactly one runtime: one workflow engine, one store, and
one scheduler per account. No parallel "next" runtime is kept alive next to the
current one ([ADR-0004](../decisions/adr/0004-single-workflow-runtime.md)).

### INV-2 Fail closed

Admission, provider reconciliation, model and effort selection, authentication,
and authority checks all fail closed. There is no silent fallback across
providers, models, accounts, transports, or versions. A degraded path is an
explicit error with a cause.

### INV-3 Completion boundaries are distinct

```text
provider terminal   ≠ Worker accepted
message delivered   ≠ response accepted
member accepted     ≠ phase accepted
phase accepted      ≠ workflow complete
protocol success    ≠ effect verified
authority granted   ≠ effect completed
```

Each layer accepts only its own semantic, and never infers a higher one from a
lower one.

### INV-4 Restart is reconciliation, not replay

Every external effect is classified as **safe-to-repeat**,
**reconcile-before-repeat**, or **block**. After a crash, in-flight work is
reconciled against observable state before anything is repeated. Leases carry a
generation, and a commit from a stale generation is rejected.

### INV-5 Exact-subject binding

Evidence, results, reviews, and approvals bind to the exact subject they were
produced for: an input hash, a content hash, or a VCS head SHA. Evidence about an
old subject never satisfies a gate on a new subject.

### INV-6 Authority comes from trusted envelopes

Filesystem scope, sandbox mode, approval, account choice, and control actions come
from trusted structured envelopes, such as the client protocol envelope, operator
configuration, or admitted workflow specs. They never come from model-produced or
user-pasted text. Trusted control messages travel separately from model data.

### INV-7 No mirrored protocol objects

Native protocol objects (MCP, Responses, ACP) cross their own boundaries
unchanged. Adapters translate *behavior*, not data models. There is no universal
Task, Message, or Artifact type that mirrors every protocol, and no global Worker
id ([ADR-0006](../decisions/adr/0006-protocol-introduction-gates.md)).

### INV-8 Credentials never cross upward

Account credentials, cookies, and browser storage stay inside the provider
runtime. Layers above it see account ids, states, and results, never secrets.

### INV-9 Everything is bounded

Concurrency, retries, resubmissions, review cycles, payload sizes, caches, and
waits all have explicit configured limits. An unbounded loop or queue is a defect.

### INV-10 Everything is a plugin

Every feature is a Cordis plugin, and every boundary between layers is a seam, a
service claimed by key ([plugin model](plugin-model.md)). There is no privileged
core to patch. Every registration has a disposer. Deployment-varying behavior is
validated plugin `Config`, never a hardcoded constant. Pure logic that has nothing
to swap stays a library
([ADR-0007](../decisions/adr/0007-everything-is-a-plugin.md)).

### INV-11 No tool lock-in

No model, vendor, agent, client, browser engine, or store is reachable except
through a seam or a public protocol. Routing, teams, workflows, and profiles name
capabilities, never tools. A second provider must be plausible for every seam,
and every seam's conformance suite runs against a fake
([ADR-0008](../decisions/adr/0008-tool-agnostic.md)).

### INV-12 Data egress is explicit

Local and private data never leaves the machine by default. Content is sent to a
remote Worker, such as a website, an API, or a remote runtime, only when an
explicit egress policy from a trusted envelope permits that exact content for that
Worker class. The check runs on the actual outgoing payload. Results may flow
from remote Workers to local ones freely
([routing](../design/routing.md#data-locality-policy),
[purpose P3](../requirements/purpose.md#p3-right-worker-right-job-with-local-data-staying-local)).

### INV-13 Every decision is an artifact

Every decision that changes what runs, where, with what tier, or whether a result
is accepted produces an immutable decision artifact **before** its effect is
committed. The artifact records its inputs, every candidate considered with
reasons, the decider and policy version, and the outcome. The state transition
references it. Multi-step work runs as an append-only DAG whose growth is itself
a recorded decision ([artifacts](../design/artifacts.md),
[ADR-0012](../decisions/adr/0012-dag-execution-model.md),
[ADR-0013](../decisions/adr/0013-typed-artifacts-and-decision-records.md)).

### INV-14 Every record has a versioned schema

Every persisted record and every wire payload validates against a versioned JSON
Schema in [`schemas/`](../../schemas/README.md) at each boundary. Unknown major
versions and invalid records fail closed
([ADR-0014](../decisions/adr/0014-json-schema-contracts.md)).

### INV-15 One writer per subject

At any time, at most one Worker execution holds write authority over a given
subject: a workspace, a branch or PR, or a dataset output. Parallel fan-out is
allowed only for read-only work, such as research, analysis, and review.
Additional agents contribute intelligence, not actions. A subgraph that writes
starts only after its plan is approved
([reference architectures](../research/reference-architectures.md)).
