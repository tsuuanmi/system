# AgentOS analysis

Non-normative. Source: [tsuuanmi/AgentOS](https://github.com/tsuuanmi/AgentOS),
analysed on 2026-10-11.

## What it is

AgentOS is a documentation-only design for "a lightweight DSH-native plugin
composition layer for capability-driven Worker execution and collaborative
workflows". Its motto is "Right Worker, right job. Spend intelligence where
intelligence matters." The host is DeepSeek Harness (DSH) on Cordis. There is no
source in the repository. An unmerged PR implements an earlier version of the
design.

## Key concepts

- **Worker:** an opaque assignable executable unit with proven current
  capabilities. Its internals (core, runtime, environment, tools, state) are a
  mental model, not a normalized interface. A Worker answers three questions: can
  it accept the work now, how is it invoked or cancelled, and what result and
  evidence did it produce.
- **Admission predicate:** a fail-closed check over the Worker's *current
  complete composition*, covering semantic ability, access, runtime state, and
  conformance. A provider or model name is never sufficient proof.
- **Routing kept apart from identity:** configured, deterministic static-priority
  selection. There is no "opaque AI router".
- **Completion-boundary ladder:** provider terminal ≠ Worker accepted ≠ phase
  accepted ≠ workflow complete ≠ effect verified.
- **Team Model A:** the persistent collaboration identity is also the logical
  Worker. Proxy members are banned. Auxiliary Workers provide evidence and are
  never peers. There is an independent-first barrier.
- **Protocol placement:** host seams for execution and teams, ACP optional, MCP
  for tools, A2A deferred behind a five-condition gate. Native objects cross
  boundaries without mirrors.
- **Workflow:** a semantic DAG (`nodeId`, `objective`, `executor`, `dependsOn`)
  plus a node router. Scheduling and persistence are delegated to the host.
- **Restart is reconciliation, not replay:** three policy classes, and "authority
  granted ≠ effect completed". Fences are added only where an old execution can race.
- **Reuse ladder and semantic-delta test:** "Can the host, a standard protocol, or
  a reusable capability already provide this without losing an invariant?"
- **Profiles:** `software-development` and `scientific-research`. A second domain
  is the test of the architecture.

## Weaknesses observed

- The canonical docs contradict each other: stale A2A and ACP placement in
  `AGENTS.md` and the skill.
- There is no code or schemas, so no claim has been tested.
- Team Model A depends on DSH's experimental `prepareContinuable`. Only in-process
  providers pass it, so multi-provider teams are outside the MVP.
- The DAG cannot express loops, conditionals, or runtime growth.
- The same diagrams are repeated in more than ten files.

## Adopted

| Idea | Where in `system` |
|---|---|
| Opaque Worker, three-question contract | [components: routing](../architecture/components.md#routing) |
| Fail-closed admission, deterministic routing | INV-2, REQ-WRK-1..2 |
| Completion-boundary ladder | [INV-3](../architecture/invariants.md#inv-3-completion-boundaries-are-distinct) |
| Team Model A, barrier, auxiliary Workers | [teams](../design/teams.md) |
| No mirrored protocol objects; protocol gates | INV-7, [ADR-0006](../decisions/adr/0006-protocol-introduction-gates.md) |
| Restart is reconciliation; three effect classes | [INV-4](../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay) |
| Semantic DAG + node router; profiles; second domain as test | [workflow-engine](../design/workflow-engine.md), REQ-WF-9 |
| Website Core / `WebsiteProviderRuntime` split | [components: capabilities](../architecture/components.md#capabilities) |

## Not adopted

- DSH as host ([ADR-0001](../decisions/adr/0001-standalone-host.md)).
- Delegating workflow durability to the host. `system` owns it
  ([ADR-0004](../decisions/adr/0004-single-workflow-runtime.md)).
