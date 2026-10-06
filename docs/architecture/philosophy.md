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

This principle applies to task completion, review, external effects, recovery,
and user authority.

## 3. Agent is not the architecture

Agent is one useful autonomous actor, not the universal abstraction for every
component.

Do not force deterministic executors, tools, persistent Team identities, Website
capabilities, or runtime protocols into an "Agent" shape when their real
semantics differ.

The architecture should model the distinctions that matter.

## 4. Capability over brand

System routes work by required guarantees, not by names such as ChatGPT, Claude,
Codex, Gemini, or DSH.

Provider identity can influence diagnostics and policy, but it must not become a
substitute for capability evidence.

A Worker is suitable because it can prove the required current composition, not
because its model or provider is assumed to be capable.

## 5. Spend intelligence where intelligence matters

LLM tokens, context, browser turns, and premium-model calls are resources.

Repeated deterministic work should become deterministic execution whenever
possible.

For example, an Agent should help discover, debug, or repair a website
automation path; it should not rediscover the same unchanged button one hundred
times when a stable automation can perform the action.

Use Agents at uncertainty boundaries. Reuse learned deterministic mechanisms
between those boundaries.

## 6. Website is a capability, not a special species of Agent

Browser-backed intelligence is useful, but "Website Agent" should not become a
permanent ontology merely because the first implementation used a browser.

The stable concept is the semantic capability:

```text
web read / interact / research / authenticated conversation
```

The implementation may later be a local browser, provider API, remote browser, or
another service.

## 7. Collaboration is a procedure over persistent participants

A Team is not synonymous with debate.

Team Core should provide persistent members, messaging, barriers, phase
semantics, and acceptance. Procedures decide whether members brainstorm,
cross-review, debate, vote, synthesize, or use another pattern.

This makes collaboration reusable across domains.

## 8. Artifacts are shared knowledge, not mailbox payload

Long-lived work should produce named, addressable Artifacts and Evidence.

Prefer:

```text
compact peer message
  + artifact/evidence reference
```

over repeatedly injecting entire reports into every participant's context.

This reduces token cost, preserves exact identity, and improves provenance.

## 9. Evidence should travel with claims

A Task result should make it possible to answer:

- what input did this result depend on?
- which Artifact or external state did it inspect?
- what Evidence supports the claim?
- which version/head/revision was accepted?
- can the result still be reused if upstream state changes?

Exact evidence prevents stale reasoning from silently satisfying a new state.

## 10. Recovery is reconciliation before repetition

External systems can complete work even when System misses the response.

Therefore:

```text
failure/interruption
  -> inspect durable/local/external evidence
      -> recover already-completed work if exact
          -> otherwise retry the smallest safe unit
```

Blind replay is a correctness bug when an operation may have side effects.

## 11. User authority is not model confidence

A high-confidence Agent recommendation does not become user authorization.

System should separate:

- reasoning;
- accepted evidence;
- policy;
- authority;
- effect execution.

Consequential external effects should carry explicit scoped authority.

## 12. Reuse before abstraction

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

Likewise, do not add a generic abstraction until two real implementations or a
real semantic boundary prove it useful.

## 13. Concrete MVP, replaceable boundaries

The MVP may intentionally choose DSH, Patchright-compatible browser execution, or
specific provider implementations.

Being concrete is not the same as coupling the semantic model to those choices.

Use narrow replacement seams where real replacement is expected, while keeping
the first implementation simple.

## 14. Fail closed on ambiguous correctness

When System cannot prove that an operation completed, that evidence matches the
current input, or authority is still valid, it should not guess.

Ambiguity is a state to surface and reconcile, not a reason to silently accept a
possibly incorrect transition.

## 15. Build behavior with TDD

Behavioral changes use strict:

```text
Red -> Green -> Refactor
```

Tests are executable specifications for boundaries, invariants, failure cases,
recovery, and regressions.

A clean architecture is valuable only if its behavioral contracts are proven.
