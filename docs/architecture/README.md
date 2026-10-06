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

- Workflow and Task state;
- exact task inputs and outputs;
- Artifact and Evidence identity when those are used;
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

## Dynamic Workflow Profiles

Workflow/Profile composition is **data**, not production code.

System Core should expose a small stable vocabulary of execution and
collaboration primitives. A named Profile composes those primitives at runtime.

```text
Profile data
   |
   | validate + snapshot
   v
Procedure plan
   |
   +--> Team/runtime primitives
   +--> Worker/capability requirements
   `--> bounded parameters
```

A Profile may own:

- participant/member declarations;
- semantic capability requirements;
- prompts or role guidance;
- procedure steps;
- ordering/dependencies expressible by the supported vocabulary;
- bounded values such as debate rounds;
- synthesis policy.

System code owns:

- Profile schema/version validation;
- primitive semantics;
- safety and admission invariants;
- execution/recovery mechanics;
- fail-closed handling of unknown primitives.

Therefore changing a supported workflow shape should normally be a Profile edit,
not a source-code edit.

Each run snapshots the resolved Profile before execution. Later Profile changes
apply to future runs and must not mutate already-started run semantics.

The MVP does not need an unrestricted programmable workflow language. Start with
the smallest primitives proven by real Profiles and extend the vocabulary only
when a new procedure cannot be expressed cleanly.

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

For the MVP, only the primitives required by the two-researcher, two-round
research/debate Profile need to exist.

## Task graph and Artifact graph are different

As System grows, work state and produced knowledge should remain conceptually
distinct.

```text
Task graph
  -> what may execute next

Artifact/Evidence graph
  -> what exact knowledge/result was produced and consumed
```

The MVP does not need a general Artifact graph. Stable exact result references are
sufficient until richer cross-step knowledge management proves the need.

Team messages should prefer compact conclusions and result references over
repeatedly copying large payloads.

## Authority

Authority is explicit and belongs to the appropriate owner.

Initial rule:

> **User owns consequential external authority. System brokers and enforces it.**

The research-only MVP performs no consequential external mutation, so the first
implementation does not need a merge/publish authority gate. The boundary remains
architectural truth for later Profiles.

## Runtime and protocol placement

For the MVP:

```text
DSH ctx.subagents
  = bounded auxiliary Worker execution when needed

DSH ctx.agentTeams
  = persistent Team-member lifecycle + direct peer messaging

System Profile loader
  = declarative dynamic workflow composition

System procedure runner
  = semantic collaboration/control primitives

ACP
  = optional external Agent/Worker runtime control

MCP
  = optional reusable tool/resource/capability interoperability

A2A
  = deferred until a real cross-runtime persistent peer need exists
```

Do not introduce a protocol for architectural symmetry.

DSH `ctx.workflowEngine` is not required for the small MVP. It remains a
candidate execution backend for future Profiles that benefit from model-authored
or larger fan-out orchestration.

## Website capability

Website remains a Capability rather than a permanent standalone Agent type.

For the MVP, System should **reuse an external ChatGPT-Web bridge** instead of
owning the ChatGPT DOM/browser implementation.

```text
System procedure
  -> DSH Team Member
      -> ChatGPT Web adapter
          -> external Responses-compatible bridge
              -> authenticated ChatGPT browser runtime
                  -> chatgpt.com
```

The strongest current upstream/reference implementation is
[`miuuyy/codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web).
It already owns difficult provider/runtime mechanics such as authenticated browser
state, task-bound browser tabs, response binding, cancellation, retained
conversation lifecycle, and bounded concurrent turns.

Because its public product surface is Codex-oriented, System should consume those
semantics through a thin DSH adapter/plugin boundary rather than couple System Core
to Codex integration details. A DSH-native project such as
[`WLV-ZEDD/dsh-chatgpt-web`](https://github.com/WLV-ZEDD/dsh-chatgpt-web)
is a candidate adapter/reference surface.

System-owned Website semantics should therefore be limited to what remains above
the bridge:

- semantic capability declaration;
- exact request/result ownership needed by the current procedure;
- acceptance;
- reconciliation before repeat;
- bounded projection/result references.

Provider auth, cookies, DOM selectors, model-picker behavior, native ChatGPT
conversation IDs, browser process/tab lifecycle, and page-state recovery stay
below the adapter boundary.

The MVP uses ordinary ChatGPT Web turns only. Native Deep Research, multiple
authenticated accounts, and account scheduling are deferred future capabilities.

MCP is not required for this browser-only MVP.

## Dependency direction

```text
Goal
  |
  v
Profile registry
  |
  v
validated Profile snapshot
  |
  v
procedure runner
  |
  +--> Team policy/runtime
  |
  +--> Worker/capability admission
              |
              v
         native runtime
              |
              v
      concrete execution
```

## Ownership statement

A compact ownership rule:

> **User owns authority. System owns goal state and orchestration. Profile owns
> declarative workflow composition. Procedure owns collaboration semantics.
> Worker owns execution acceptance. Capability owns domain behavior. Runtime
> owns lifecycle and transport. Provider owns implementation details.**

## Cross-cutting invariants

1. System is the center of orchestration; Agent is not the universal center.
2. Models reason; deterministic state transitions require System acceptance.
3. Worker is opaque externally and selected by semantic conformance.
4. Provider/model names do not define generic procedure semantics.
5. Workflow/Profile composition is data whenever existing primitives are
   sufficient.
6. A run snapshots its resolved Profile before execution.
7. Unknown or invalid Profile semantics fail before work starts.
8. Team Member identity is persistent for the Team lifecycle.
9. Direct Team collaboration should not require the Lead to relay every message.
10. Message delivery is not equivalent to semantic collaboration completion.
11. Capability matching reflects current composition and state.
12. Reuse native DSH/runtime/protocol mechanics before rebuilding them.
13. MCP, ACP, A2A, and DSH Workflow are introduced only for real boundaries they
    solve.
14. Provider-specific Website/browser details stay below the external bridge /
    adapter boundary.
15. System does not reimplement ChatGPT browser mechanics already provided by a
    suitable reusable bridge.
16. Multiple ChatGPT accounts and native Deep Research are future capabilities,
    not MVP requirements.
17. Recovery targets the smallest correctness-bearing unit possible.
18. Behavioral implementation changes use Red -> Green -> Refactor TDD.

See [Philosophy](philosophy.md) for the principles behind these constraints.
