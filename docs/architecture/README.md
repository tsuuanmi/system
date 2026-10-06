# System architecture

- **Status:** canonical initial architecture
- **Scope:** semantic ownership and MVP dependency direction
- **Host:** DSH / Cordis for the MVP

## North star

> **System is the cognitive control plane that composes agents, Workers, Teams,
> Capabilities, Artifacts, Evidence, and runtime mechanisms toward a user goal.**

System is not one super-agent. It combines model-driven cognition with
deterministic control.

```text
                         User
                           |
                           v
                    +-------------+
                    |   System    |
                    +-------------+
                     /     |      \
                    /      |       \
             Cognition   Control   Execution policy
                |          |             |
                |          |             v
                |          |        Worker routing
                |          |             |
                |          |       +-----+------+
                |          |       |            |
                |          |     Workers       Teams
                |          |       |            |
                |          |       +-----+------+
                |          |             |
                |          |        Capabilities
                |          |             |
                |          |     Website / GitHub /
                |          |      tools / runtime
                |          |
                |     Task + Artifact
                |        graphs
                |
          planning/procedures
```

## Three planes

### Cognitive plane

The cognitive plane interprets intent and proposes how work should proceed.

It may own:

- goal interpretation;
- decomposition;
- planning;
- procedure/Profile selection;
- deciding when more research, critique, validation, or synthesis is useful.

Cognition proposes work. It does not get to declare deterministic state valid
merely because a model says so.

### Deterministic control plane

The control plane is the correctness authority for execution state.

It owns semantics such as:

- Workflow and Task DAG state;
- exact task inputs and outputs;
- Artifact and Evidence identity;
- acceptance;
- execution fencing;
- authority boundaries;
- recovery and retry policy;
- budgets and policy gates;
- durable state transitions.

Core invariant:

> **Model output is evidence or a proposal until the owning System boundary
> accepts it.**

A provider reporting "done" is not equivalent to a Task being accepted.

### Execution plane

Execution is delegated to opaque units chosen for proven current capabilities.

```text
semantic work
  -> Worker admission/routing
      -> owning runtime
          -> Worker execution
              -> result/evidence
                  -> semantic acceptance
```

System should not branch its domain logic on provider brands.

## Core ontology

### Agent

An autonomous reasoning/control loop.

An Agent can be part of a Worker, a persistent Team Member, or another runtime
composition. Agent identity is not the universal System abstraction.

### Worker

An opaque assignable execution unit with proven current capabilities.

Conceptually, capabilities may emerge from:

```text
Core + Runtime + Environment + Tools + Access/state
```

That anatomy is explanatory, not a required universal DTO.

System asks:

```text
Can this Worker accept the work now?
How is it executed/cancelled through its owning runtime?
What result/evidence did it produce?
```

### Capability

A semantic guarantee available from the current Worker composition.

Examples may eventually include:

```text
research
develop
review
validate
web-research
authenticated-web
writable-workspace
persistent-conversation
```

Capabilities are admission predicates, not permanent provider labels.

### Team Member

A persistent collaboration identity that is also the logical Worker identity for
that Team lifecycle.

For the MVP, DSH Agent Teams owns member lifecycle and direct peer messaging.
System owns collaboration policy, barriers, procedures, and phase acceptance.

A temporary delegated Worker does not silently become a Team Member.

### Tool

A callable primitive exposed through a native tool surface or a protocol such as
MCP.

Tools are not Workers. A tool performs a bounded operation; a Worker accepts a
semantic unit of work.

### Runtime

The mechanism that owns execution lifecycle, transport, process/session state,
cancellation, and provider-specific mechanics.

System reuses runtime-native models instead of mirroring them without a proven
semantic need.

## Workflow and Team

Workflow owns semantic task dependency and progression.

Team owns reusable collaboration semantics:

- members;
- direct peer boundary;
- independent-first barriers;
- phase transitions;
- collaboration hooks;
- acceptance.

Collaboration procedures are policy over Team, not hard-coded Team primitives.
Examples include:

- independent research;
- brainstorming;
- debate;
- cross-review;
- proposer / critic / judge;
- staged handoff;
- consensus.

A Lead may coordinate and synthesize without relaying every peer message.

## Task graph and Artifact graph are different

System treats work and produced knowledge as distinct first-class graphs.

```text
Task graph

Research A ----+
               +--> Synthesis --> Implement --> Review
Research B ----+


Artifact graph

sources
  -> research report
      -> architecture plan
          -> patch
              -> test evidence
                  -> review report
```

A Task may consume and produce Artifacts:

```text
Task
  |-- consumes Artifact[]
  `-- produces Artifact[]
```

Team messages should prefer compact conclusions and Artifact/Evidence references
over repeatedly copying large payloads.

Artifact identity must not become a second hidden workflow state machine.

## Authority

Authority is explicit and belongs to the appropriate owner.

Initial rule:

> **User owns consequential external authority. System brokers and enforces it.**

System may automate bounded internal decisions under policy, but it must not turn
successful reasoning into implicit user authorization for destructive, published,
financial, security-sensitive, or otherwise consequential effects.

## Runtime and protocol placement

For the MVP:

```text
DSH ctx.subagents
  = multi-provider Worker execution seam

DSH ctx.agentTeams
  = persistent Team-member lifecycle + direct peer messaging

ACP
  = optional external Agent/Worker runtime control

MCP
  = optional reusable tool/resource/capability interoperability

A2A
  = deferred until a real cross-runtime persistent peer need exists
```

Do not introduce a protocol for architectural symmetry.

## Website capability

The useful runtime lessons from `@tsuuanmi/internet` are retained, but Website
is a Capability rather than a permanent standalone Agent type.

```text
Worker
  -> Website capability
      -> Website Core
          -> WebsiteProviderRuntime
              -> browser / provider API / remote implementation
```

Website Core should retain provider-neutral semantics such as:

- logical request identity;
- conversation continuity where required;
- retained-result idempotency;
- reconcile-before-resubmit;
- full-result retention with bounded projection;
- cancellation propagation.

Provider auth, cookies, DOM behavior, native conversation IDs, and browser process
state remain below the provider-runtime boundary.

MCP should be introduced for Website only when a real second consumer benefits
from the reusable surface.

## Dependency direction

```text
Goal / Profile
    |
    v
Workflow
    |
    +--> Team policy
    |
    +--> Worker admission/routing
              |
              v
         native runtime
              |
              v
      concrete execution

Capabilities plug into Worker composition without making higher layers depend on
provider implementation details.
```

## Ownership statement

A compact ownership rule:

> **User owns authority. System owns goal state and orchestration. Workflow owns
> task semantics. Team owns collaboration semantics. Worker owns execution
> acceptance. Capability owns domain behavior. Runtime owns lifecycle and
> transport. Provider owns implementation details.**

## Cross-cutting invariants

1. System is the center of orchestration; Agent is not the universal center.
2. Models reason; deterministic state transitions require System acceptance.
3. Worker is opaque externally and selected by semantic conformance.
4. Provider/model names do not define Workflow or Profile semantics.
5. Team Member identity is persistent for the Team lifecycle.
6. Direct Team collaboration should not require the Lead to relay every message.
7. Message delivery is not equivalent to semantic collaboration completion.
8. Task DAG and Artifact graph are distinct but linked.
9. Artifacts and Evidence should replace unnecessary long mailbox/context copies.
10. Capability matching reflects current composition and state.
11. Reuse native DSH/runtime/protocol mechanics before rebuilding them.
12. MCP, ACP, and A2A are introduced only for real boundaries they solve.
13. Provider-specific Website/browser details stay below `WebsiteProviderRuntime`.
14. Consequential user authority is explicit.
15. Recovery targets the smallest correctness-bearing unit possible.
16. Behavioral implementation changes use Red -> Green -> Refactor TDD.

See [Philosophy](philosophy.md) for the principles behind these constraints.
