# Teams

> Target state. Boundary: [orchestration](../architecture/components.md#orchestration).
> Requirements: REQ-TEAM-1..4.

## Membership: Model A

A **team member** is a persistent collaboration identity, and it is also the
logical Worker for that team's lifetime. The Worker is chosen once, at member
formation, through normal admission. Process-local activations can be recreated
without changing identity.

Proxy members, which delegate their reasoning to hidden Workers, are not allowed.
A member may use **auxiliary Workers** for one-shot help. Their output is evidence
the member cites, and they never become peers.

Members of an independence-sensitive team must be backed by distinct accounts
(REQ-TEAM-4). Admission enforces this.

## Plan

A team run follows a deterministic `TeamPlan`:

```text
round 1  : every member answers independently           ── barrier ──
round 2..n: each member sees peers' prior outputs, critiques, revises
synthesis: synthesizer produces strongest-supported result with cited member evidence
acceptance: procedure-specific phase acceptance
```

- The **independent-first barrier** guarantees no member sees a peer's output
  before every member has produced an independent result.
- Debate, critique, and plain parallel review are *procedures* that a profile
  selects. None of them is built into the core.
- Each member step is a durable workflow node, so a crash mid-round does not repeat
  completed member turns
  ([workflow-engine](workflow-engine.md#execution-loop)).

## Independent review

Reviewers are a team procedure with **no shared context** with the producer
(REQ-TEAM-5). They receive the exact subject, the acceptance criteria, and the
relevant decision artifacts, and nothing from the producer's conversation.
Findings are `assessment` artifacts, each with a severity (`blocking`,
`warning`, or `info`), bound to the subject version.

## Lead

The lead controls the procedure and observes durable state. It does not relay
content between members. Each member is a durable session with its own
`SessionId`, and peers **message each other directly** through the session
mailbox, under the group policy and barriers
([sessions and messaging](sessions-and-messaging.md)). Rounds are the
procedure's checkpoints, not the only channel.

## Built so far

The [workflow engine](../../packages/plugins/workflow/README.md) unrolls a
template's `team` node:

- independent first-round members;
- critique rounds behind the barrier;
- a synthesis that must cite members (`acceptance.team-synthesis`).

Each member is a persistent session, so it keeps one identity and one Worker.
Members can be held to distinct accounts at routing time. The `panel` template
uses this. Not built yet: a lead, direct messages between members, and
independent review with `assessment` artifacts.
