# System philosophy

- **Status:** canonical initial principles
- **Role:** durable product and architecture constraints

## 1. Intelligence is a resource; System is the organizer

System is not built around the assumption that one increasingly powerful Agent
should do everything.

Different work benefits from different actors:

- an inexpensive deterministic executor;
- a local reasoning Agent;
- an implementation-focused Worker;
- a persistent collaborative Team;
- a Website-capable Worker;
- a human authority boundary.

System exists to compose those actors toward one goal.

> **Right intelligence, right work, right time.**

## 2. Models reason; control state is deterministic

Language models are excellent at interpretation, generation, critique, and
synthesis. They are not the source of truth for whether a durable state
transition is valid.

Prefer:

```text
model proposes / reasons
    -> evidence is produced
        -> deterministic boundary validates
            -> state transitions
```

over:

```text
model says "done"
    -> workflow becomes complete
```

## 3. Agent is not the architecture

Agent is one useful autonomous actor, not the universal abstraction for every
component.

Do not force deterministic executors, tools, persistent Team identities, Website
capabilities, or runtime protocols into an "Agent" shape when their real
semantics differ.

## 4. Capability over brand

System routes work by required guarantees, not provider/model names.

Provider identity can influence diagnostics and explicit routing policy, but it
must not substitute for capability evidence.

## 5. Spend intelligence where intelligence matters

LLM tokens, context, browser turns, and premium-model calls are resources.

Repeated deterministic work should become deterministic execution whenever
possible. Use Agents at uncertainty boundaries and reuse learned mechanisms
between those boundaries.

## 6. Workflow policy should be data when possible

A supported workflow change should not require a code change merely because its
topology or parameters changed.

Prefer:

```text
stable primitive semantics in code
        +
validated declarative Profile
        =
runtime procedure
```

over encoding each named workflow as a new TypeScript function.

Profiles should own participant configuration, procedure composition, prompts,
capability requirements, and bounded parameters such as round counts. Code should
change only when the semantic primitive vocabulary itself must grow.

A running workflow snapshots its Profile so configuration remains dynamic between
runs but deterministic within one run.

## 7. Website is a capability, not a special species of Agent

Browser-backed intelligence is useful, but "Website Agent" should not become a
permanent ontology merely because the first implementation used a browser.

The stable concept is semantic web capability. The implementation may be a local
browser, provider API, remote browser, or another service.

## 8. Collaboration is a procedure over persistent participants

A Team is not synonymous with debate.

Team Core should provide persistent members, messaging, barriers, phase
semantics, and acceptance. Procedures decide whether members research
independently, debate, cross-review, vote, synthesize, or use another pattern.

## 9. Artifacts are shared knowledge, not mailbox payload

When work becomes long-lived, prefer compact peer messages plus exact
result/artifact references over repeatedly injecting entire reports into every
participant's context.

The MVP may start with simple stable result references and grow a richer Artifact
model only when real workflows require it.

## 10. Evidence should travel with claims

A result should make it possible to determine what input produced it, what
evidence supports it, and whether it is still reusable after upstream state
changes.

## 11. Recovery is reconciliation before repetition

External or model work can complete even when System misses the response.

Therefore:

```text
failure/interruption
  -> inspect exact state
      -> recover already-completed work if exact
          -> otherwise retry the smallest safe unit
```

Blind replay is a correctness bug when prior work may already be valid.

## 12. User authority is not model confidence

A high-confidence Agent recommendation does not become user authorization.

System separates reasoning, accepted evidence, policy, authority, and effect
execution.

## 13. Reuse before abstraction

Prefer, in order:

```text
native host/runtime capability
  -> standard protocol / official SDK
      -> reusable implementation
          -> thin behavioral adapter
              -> System-owned residual semantics
```

Do not recreate DSH Team state, MCP registries, ACP lifecycle, browser engines, or
other runtime mechanics merely to make System appear self-contained.

## 14. Concrete MVP, replaceable boundaries

The MVP may intentionally choose DSH and concrete provider implementations.

Being concrete is not the same as coupling the semantic model to those choices.
Use narrow replacement seams where replacement is real, while keeping the first
implementation small.

## 15. Fail closed on ambiguous correctness

When System cannot prove that work completed, that a result matches the current
input, or that a Profile is valid, it should not guess.

## 16. Build behavior with TDD

Behavioral changes use strict:

```text
Red -> Green -> Refactor
```

Tests are executable specifications for boundaries, invariants, failure cases,
recovery, and regressions.
