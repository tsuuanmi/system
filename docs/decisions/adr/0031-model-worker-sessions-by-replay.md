# ADR-0031: A model Worker keeps a session by replaying its transcript

- **Status:** Accepted
- **Date:** 2026-10-17 (accepted 2026-10-17, by the operator, in Researcher's session)
- **Related:** [PROP-0006](../../proposals/0006-model-worker-sessions.md),
  [ADR-0015](0015-worker-sessions-and-peer-messaging.md),
  [ADR-0025](0025-api-first-composition.md),
  [ADR-0029](0029-opt-in-same-family-fallback.md), INV-4, INV-9, INV-11, INV-12

## Context

A model Worker (an API or local model behind `ctx.models`) answers one prompt and keeps nothing.
It proves only `reason`, so it cannot hold a session:
- a team member's proposal, ballot, and debate (Model A);
- `research`'s synthesis thread;
- an `ask` that continues.

A model has no native session to bind a session to, unlike a website conversation or an agent
run.

## Options

1. Use each provider's server-side threads: vendor-specific, and missing on many routes.
2. Keep model Workers stateless, and let templates inline every earlier turn.
3. **The Worker source keeps the transcript, and each turn replays it.**

## Decision

Option 3.

- **Seam.** `ModelRequest.history` holds the earlier turns, as user and assistant text in order,
  provider-neutral. A provider sends them before the prompt.
- **The `models` source:**
  - keeps a session's turns durably, each appended with its call's completion;
  - records with each call the exact history it was accepted with, so a re-send after a restart
    replays it (INV-4);
  - runs one turn per session at a time;
  - proves `persistent-conversation`, with evidence of kind `conformance`.
- **Bounds (INV-9).** `maxSessionTurns` and `maxHistoryChars`: the `models` row gives defaults, and
  each catalog entry may set its own. Past a bound a turn fails as `invalid_input`; a history is
  never cut or summarized.
- **Affinity.** A session stays on its model Worker. Escalation moves within the family and
  replays the history, after the new entry's bounds and egress are checked.
- **Egress (INV-12).**
  - The decision covers exactly the bytes sent, the history included.
  - The history's classification is the highest of its prompts' and answers'.
- **End.** A transcript is deleted when its session ends (released or reset), never by a call's
  own retention while the session lives.

## Consequences

- Model Workers can be team members, carry research's synthesis thread, and continue an `ask`.
  Under `api-first`, `brainstorm` and `review` can run.
- Two members on one model entry count as one account (REQ-TEAM-4), so they fall under ADR-0029.
- Input tokens grow with a session's history. `system usage` shows each turn's.
- A provider-side thread could later be a provider optimization behind the same seam, never a
  second runtime.
