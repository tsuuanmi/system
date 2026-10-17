---
id: PROP-0006
type: proposal
status: accepted
owners: [operator]
created: 2026-10-17
related-requirements: [REQ-WRK-10, REQ-WRK-7, REQ-TEAM-4, REQ-PRV-8]
related-decisions: [ADR-0015, ADR-0025, ADR-0027, ADR-0029, ADR-0031]
implementation: []
---

# Proposal: Model Workers keep sessions by replaying their transcript

## Problem

The operator wants API Workers as a third kind of Worker, beside the website accounts and the
agent Workers, reached provider-agnostically. Stage 1 needs only configuration: the `models` row
over DSH `llm` and `llm-pi-ai` serves any OpenAI-compatible, Anthropic, Google, Responses,
Bedrock, or Azure route ([models](../design/models.md)).

A model Worker keeps no conversation, though, so it proves only `reason`. That leaves it out of
the core workflows:

- a team member works in one session across its proposal, ballot, and debate (Model A,
  [ADR-0015](../decisions/adr/0015-worker-sessions-and-peer-messaging.md));
- `research`'s synthesis steps share the run's conversation;
- an `ask` with `--session` or `--persist` continues one.

All of these need `persistent-conversation`, and under the `api-first` preset they fail admission.

## Goals

1. A model Worker serves a session: each turn sees the session's earlier turns, so it can be a
   team member, carry research's synthesis thread, and continue an `ask`.
2. No vendor is named: the history is a provider-neutral field of `ctx.models` (INV-11).
3. Bounded (INV-9), durable, idempotent after a restart (INV-4), and egress-checked like
   everything sent.

## Non-goals

- A provider's own server-side threads (a Responses `previous_response_id`, an assistants
  thread). They are one vendor's feature, and replay works on every route.
- Tools, files, or images in the history: text turns only, as today.
- Summarizing or truncating a long history. A session over its bound fails, and is never
  silently cut.

## Evidence and research

- DSH `llm` takes a request's `messages` as a list of user and assistant turns (its README:
  "history"). The `models` row sends one user message today (`attempt()` in
  `packages/plugins/models/src/llm.ts`).
- A website session is a native conversation. An agent Worker's session is a resumable native
  run. A model has no native session, so the source holds the transcript itself, the same way the
  website ledger records conversations (REQ-PRV-8).

## Proposed design

- **Seam (`models-core`).** `ModelRequest` gains
  `history?: Array<{ role: 'user' | 'assistant'; text: string }>`, the earlier turns in order. The
  provider sends them before the prompt. The conformance suite checks that the history reaches the
  provider in order and counts toward input usage.
- **The `models` Worker source keeps sessions.**
  - A session's turns live in a new table, `model_session_turns`: session id, sequence number,
    prompt, the answer's artifact, and the call that made it.
  - A turn is appended in the same transaction that completes its call.
  - A session turn's call records the history it was accepted with: the turns up to sequence N,
    and their hash. A re-send after a restart replays exactly that history. Reusing a key with
    another history is `invalid_input`.
  - One turn in flight per session: turn N+1 is accepted only after turn N has completed or
    failed. Two turns never replay the same history and both append.
- **Bounds (INV-9), validated `Config`:**
  - `maxSessionTurns` (default 12);
  - `maxHistoryChars` (default 48,000). Characters, not tokens: the source cannot count a
    provider's tokens before the call.

  The row gives the defaults, and each catalog entry may lower or raise its own, so a small local
  model with a short context window is not sent 48,000 characters. A turn whose history would pass
  its entry's bound fails as `invalid_input`, naming the bound. Nothing is cut.
- **Capability.** Every available model Worker proves `persistent-conversation`, with evidence of
  kind `conformance`: it is the source's behavior, not the model's.
- **Affinity.**
  - A session stays on the model Worker that served its first turn.
  - Escalation to a higher tier moves to another model Worker of the same family, which inherits
    the history.
  - That other entry is checked before anything is sent: its own bounds (a history over them
    fails as `invalid_input`, never cut), and egress for its destination (below).
- **Egress.**
  - The egress decision covers exactly the bytes sent: the prompt, and the history serialized as
    it is sent, for the call's destination.
  - The history's classification is the highest of its turns', and both the prompts' and the
    answers' classifications count. A `local-private` session stays on `local` Workers
    (REQ-WRK-7).
- **Ends.**
  - A transcript is deleted only when its session ends: released (its run deleted, or expired by
    retention), or reset.
  - A call's own retention (`retainDays`) never removes a turn that a live session still replays.
    A long-lived session keeps its whole history until it ends, within its bounds.
- **Team members.**
  - Two members on one model entry share one "account", in REQ-TEAM-4's sense, so they fall
    under [ADR-0029](../decisions/adr/0029-opt-in-same-family-fallback.md), as two members on one
    website account do.
  - Distinct entries of one family are distinct accounts of one family: what ADR-0027 compares is
    the family.

On acceptance, an ADR records model sessions by replay, and the models design, the
`models-core` seam catalog row, and its conformance suite change with the code.

## Alternatives considered

1. **Server-side threads per provider.** Vendor-specific, unavailable on many routes, and harder
   to make idempotent after a restart.
2. **Keep model Workers stateless, and let the workflow inline everything.** Prompts already
   carry their inputs. But a member's ballot and debate need its own earlier reasoning, which the
   prompts do not repeat. Inlining it would rebuild replay in each template.
3. **Summarize long sessions.** A summary is a model's output standing in for evidence. Failing
   at the bound is honest; summarizing can come later, as its own step.

## Validation plan

- Seam conformance: history order, usage, and a `max-tokens` finish with history.
- A fake provider that echoes the number of history messages it received.
- The source:
  - three turns of one session send histories of 0, 1, and 2 turns;
  - a second turn of a session is not accepted while the first is in flight;
  - a restart mid-session re-sends the same history once, with the same hash (crash suite);
  - a bound exceeded fails with nothing sent, under the row's default and under an entry's own;
  - escalation to an entry with a smaller bound fails before sending;
  - release and reset delete the transcript, and a call's retention leaves a live session's turns;
  - a `local-private` session never reaches a remote entry.
- End to end on fakes:
  - a brainstorm with model Workers as both members (same-family, recorded);
  - research's synthesis thread on a model Worker;
  - under `api-first`, `brainstorm` and `review` now run.
- Live, with a real route once the operator supplies a key: one short brainstorm with an API
  member.

## Rollout and rollback

On by default once merged: a model Worker simply admits sessions. Rollback reverts the source's
`persistent-conversation` proof, and sessions fail admission again as today. Transcripts are
deleted with their runs.

## Observability and operations

`system usage` shows each session turn's input tokens, which grow with history. The models
runbook gains the two bounds and what a "session too long" failure means.

## Security and privacy

Transcripts are prompts and answers, already stored for each call. They get the same owner-only
store, retention, and classification rules. A history re-sent to a new destination on escalation
passes egress for that destination.

## Compatibility and migration

A new table, and a schema version of the call record if it gains the history reference
(versioned per [schemas](../reference/schemas.md)). No migration of existing calls: they have no
session.

## Decision

Accepted on 2026-10-17 by the operator, in Researcher's session, after Researcher's review.
Recorded as [ADR-0031](../decisions/adr/0031-model-worker-sessions-by-replay.md).

## Implementation

None yet.
