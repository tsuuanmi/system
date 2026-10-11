# ADR-0012: All multi-step work runs as an append-only DAG

- **Status:** Accepted
- **Date:** 2026-10-11
- **Related:** ADR-0004, INV-1, INV-4, [workflow engine](../../design/workflow-engine.md)

## Context

The maintainer asked whether `system` should process work as a DAG. The options
seen in the reference and industry systems are:

- **A pure agent loop**, single-threaded, with one model deciding the next action
  each turn. Claude Code, Codex, and Devin work this way inside a session. It is
  strong for open-ended work, but its control flow lives in the model's context,
  so it cannot be reconciled step by step after a crash.
- **A cyclic state graph** (LangGraph style). Loops are edges, and state is
  mutated in place. It is flexible, but replay and "never redo completed work"
  need careful checkpoint semantics.
- **A DAG.** Each node runs once per input hash, and its dependencies are
  explicit. internet's v3 engine and AgentOS's semantic DAG both use this, and so
  do Anthropic's orchestrator-workers and parallelization patterns when they are
  made durable.

`system`'s strongest guarantees depend on the DAG properties: reuse by input hash
(REQ-WF-3), reconciliation instead of replay (INV-4), and exact-subject gates
(INV-5).

## Options

1. A pure agent loop as the orchestration model.
2. A cyclic state graph.
3. An **append-only DAG with bounded, validated growth**.

## Decision

Option 3, with the following rules.

- **Every multi-step job runs as a DAG on the single engine**, including the MVP
  research pipeline and a single MCP `research` call. A one-shot `ask` is a DAG of
  one node. There is no second execution path for "simple" work (INV-1).
- **Each graph snapshot is acyclic.** Loops are **unrolled** into new nodes with
  deterministic ids, for example `review:cycle:2`, `escalate:1`, or
  `team:round:2`. Each unrolled loop is bounded by policy (INV-9).
- **Dynamic planning is allowed through artifacts.** A planner node may emit a
  `plan` artifact that proposes new nodes. The engine validates it (acyclic,
  admissible capabilities, within bounds), records a `graph-growth` decision
  artifact, and only then appends the nodes. Orchestration can adapt to findings,
  as an orchestrator-workers lead does, without giving up durability.
- **A DAG runs between Workers, and an agent loop runs inside a Worker.** A
  Worker such as Claude Code, Codex, or a website conversation may run its own
  agent loop internally. To the engine it is one opaque node with one result
  ([components: routing](../../architecture/components.md#routing)).

## Consequences

- Every step has an input receipt, an output receipt, and decision artifacts, so
  "what ran, why, and on what inputs" is answerable after the fact.
- Work that is truly open-ended belongs inside one capable Worker, not spread over
  many tiny nodes. This also follows the context-sharing lesson that splitting a
  single line of reasoning across agents loses implicit decisions.
- The engine needs a growth API and a plan-validation step, which ADR-0004's
  engine already plans for (graph growth).
