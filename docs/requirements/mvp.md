# System MVP

- **Status:** initial normative scope
- **Host:** DSH / Cordis
- **Purpose:** prove a minimal cognitive-control loop with two research agents and a configurable collaboration profile

## Goal

The MVP should be intentionally small.

It does **not** need a complete software-development lifecycle, implementation
workers, review gates, merge authority, or a general workflow engine.

It needs to prove one core thesis:

> **System can load a declarative Profile, create the required participants,
> let them research independently, coordinate a bounded multi-round exchange,
> and synthesize one result without encoding that workflow topology in
> production code.**

The first end-to-end path is:

```text
User question / research objective
            |
            v
      load Profile
            |
            v
   +----------------+
   | Researcher A   |
   | Researcher B   |
   +----------------+
        |       |
        | independent research
        v       v
      Result A  Result B
           \     /
            \   /
        Debate round 1
            |
        Debate round 2
            |
            v
         Synthesis
            |
            v
       Final answer
```

## MVP Profile

The first shipped Profile should express the workflow as data, not TypeScript.

Illustrative shape:

```yaml
id: research-debate
description: Two independent researchers debate before synthesis

members:
  - id: researcher-a
    requires: [research, web-research]
  - id: researcher-b
    requires: [research, web-research]

steps:
  - type: parallel
    action: research
    participants: [researcher-a, researcher-b]

  - type: debate
    participants: [researcher-a, researcher-b]
    rounds: 2

  - type: synthesize
    actor: lead
```

The exact file schema may evolve during implementation, but the ownership rule is
normative:

> **Code owns stable execution primitives and validation. Profiles own workflow
> composition, participant configuration, prompts/policy, ordering, and bounded
> parameters such as debate rounds.**

Changing the workflow from two to three researchers, two to four rounds, a
different synthesis actor, or a different capability requirement should not
require a production-code change when the existing primitive vocabulary is
sufficient.

## Dynamic Profile requirements

Profiles are runtime data.

The MVP must provide a Profile registry/loader that:

- loads named Profiles from an external configuration location;
- validates them against a versioned schema before execution;
- resolves a Profile by id for each run;
- does not compile workflow topology into source code;
- lets the next run use an updated Profile without rebuilding System;
- fails closed on unknown primitives, invalid participants, invalid references,
  or unsupported parameters.

Hot-reloading a Profile during an already-running workflow is **not** required.
A run should snapshot the resolved Profile at start so later edits cannot mutate
its semantics underneath it.

The MVP may use YAML or JSON. The important boundary is data-driven composition,
not the serialization format.

## Minimal procedure vocabulary

The MVP should start with the smallest useful vocabulary.

### `parallel`

Run the same semantic action independently for the listed participants.

For the initial Profile:

```text
researcher-a ---- independent research
researcher-b ---- independent research
```

Neither participant should see the other's initial result before both complete.

### `debate`

Run a bounded exchange between already-created participants.

For the initial Profile:

```text
round 1:
  A receives B's independent result and responds
  B receives A's independent result and responds

round 2:
  A receives the latest B position and responds
  B receives the latest A position and responds
```

The exact speaking order may be chosen deterministically by the procedure
implementation, but the Profile owns the configured round count.

A round is a semantic boundary: failure in round 2 must not require rerunning
independent research or round 1 when the earlier outputs remain exact and valid.

### `synthesize`

Produce one final result from the accepted participant outputs and debate state.

The MVP can use the Lead/local System agent as synthesizer.

## Participants

The initial implementation uses exactly two research participants.

They should be persistent Team Members when the selected DSH runtime supports the
required continuable lifecycle:

```text
System
  -> DSH ctx.agentTeams
      -> researcher-a
      -> researcher-b
```

System owns the collaboration procedure. DSH owns native member lifecycle,
durable peer messages, and Team mechanics.

If a bounded one-shot research executor is used underneath a Team Member, that
executor is auxiliary evidence production and does not replace the persistent
member identity.

## Research capability

Each researcher must be able to gather evidence rather than only reason from
model memory.

The Profile should request semantic capability such as:

```text
research
web-research
```

The exact provider is below the routing boundary.

For the first implementation, Website capability may be supplied through the
browser-backed semantics selectively inherited from `@tsuuanmi/internet`, or
through another conforming DSH web capability.

Provider/model identity must not be encoded in the procedure definition unless a
specific Profile intentionally chooses an explicit route.

## Artifacts: keep the MVP small

The MVP does not need a general Artifact graph or distributed Artifact store.

It only needs stable result references sufficient to avoid copying every long
research payload through every control message.

A minimal result record may contain:

```text
result id
producer member
step id
content or content reference
content hash
created-at
```

Research results and each debate-round result should be addressable so synthesis
and recovery can reuse exact prior work.

A richer Artifact/Evidence graph remains a post-MVP evolution.

## Durability and recovery

The MVP should preserve the strongest useful invariant from
`@tsuuanmi/internet`:

> **Reconcile before repeating work.**

At minimum:

- accepted independent research must not rerun because debate round 2 failed;
- completed debate round 1 must not rerun when its exact inputs still match;
- the resolved Profile snapshot for the run must be retained;
- stale or superseded executions must not overwrite a newer accepted result.

The implementation does not need the full historical Internet workflow engine.

## Runtime choices

Prefer reuse over a new orchestration runtime.

```text
DSH / Cordis
  -> host and plugin composition

DSH ctx.agentTeams
  -> persistent participants + durable peer communication

DSH ctx.subagents
  -> optional bounded auxiliary research execution

System Profile loader
  -> dynamic declarative workflow composition

System procedure runner
  -> small stable primitive vocabulary

Website capability
  -> evidence acquisition when requested by Profile
```

## Relationship to DSH workflow

The MVP must not depend on `ctx.workflowEngine` merely because the word
"workflow" appears in System.

DSH's workflow subsystem is valuable for model-authored JavaScript orchestration,
especially larger fan-out work, but the current MVP is only two participants and
a small bounded procedure.

System's Profile is a declarative semantic policy object, not a model-written
JavaScript program.

A future System adapter may compile or lower richer Profiles into DSH workflow
execution when that becomes the simplest reusable mechanism.

## Protocol scope

### ACP

Not required for the MVP.

Use it later when an external Agent/Worker runtime is a real execution boundary.

### MCP

Not required for the MVP.

Use it when a capability needs a reusable tool/resource surface across multiple
consumer cores.

### A2A

Not required for the MVP.

Native DSH Team messaging is sufficient for the first two persistent research
members.

## Non-goals

The MVP does not require:

- software implementation or code mutation;
- validation/review/merge phases;
- a general-purpose DAG engine;
- arbitrary graph generation by a model;
- a large Worker taxonomy;
- a distributed Artifact store;
- a general Team scheduler;
- heterogeneous cross-runtime persistent Team membership;
- custom MCP, ACP, or A2A transports;
- a rich UI;
- autonomous consequential external effects;
- compatibility with every `internet` or AgentOS public API.

## What should be selectively inherited

### From `@tsuuanmi/internet`

Retain useful proven semantics around:

- Website/provider account isolation;
- conversation continuity;
- exact logical request identity;
- reconcile-before-resubmit;
- retained results;
- bounded projection of long results;
- execution-attempt fencing.

Do not copy Internet's full coding workflow into this MVP.

### From AgentOS

Retain:

- opaque capability-bearing Workers;
- capability-driven admission;
- persistent Team Member identity;
- DSH-native Team/runtime reuse;
- Website as a composable capability;
- protocol placement by proven need;
- narrow replaceable seams.

System adds the dynamic Profile/procedure layer above these primitives.

## MVP completion criteria

The MVP is complete when a controlled real run and tests demonstrate:

1. a named Profile is loaded from external declarative configuration;
2. two research members are created/admitted from that Profile;
3. both perform independent research without seeing the other's initial answer;
4. the independent-first barrier releases only after both results are accepted;
5. the same two participants complete exactly two configured debate rounds;
6. a synthesizer produces one final answer from the accepted results;
7. changing the round count, prompts, capability requirements, or member
   configuration within the supported vocabulary requires only a Profile edit,
   not a production-code change;
8. invalid Profiles fail before participant work starts;
9. completed exact steps can be reconciled and reused after interruption;
10. provider-specific Website details do not leak into the Profile/procedure
    semantic boundary.
