---
id: PROP-0002
type: proposal
status: draft
owners: [tsuuanmi]
created: 2026-10-11
related-requirements: [REQ-WRK-2, REQ-WRK-8, REQ-WRK-9, REQ-PRV-6]
related-decisions: [ADR-0007, ADR-0008]
implementation: []
---

# Proposal: Decision-assisted routing (`ctx.decisions`, Jev as a first provider)

## Problem

Routing in `system` needs a tier and a capability set for every job. Profile
nodes declare both. Ad-hoc requests, such as an MCP `ask` or `research` call from
Claude Code or Codex, often declare neither. Today they would get a fixed default.
That either wastes frontier quota and Deep Research runs on simple questions
(against P1 and P4), or under-serves hard ones.

## Goals

1. Infer the **tier** (D1) and the **capability need** (D2) for work that does not
   declare them, cheaply and quickly.
2. Keep routing reproducible, tool-agnostic, and fail-closed.
3. Prove the benefit with measurements before enforcing anything.

## Non-goals

- Using a decision model for reconciliation, admission proofs, authority, egress
  permits, gates, or acceptance. These stay deterministic
  ([research](../research/jev-decision-model.md#where-a-decision-model-must-not-be-used)).
- Overriding tiers or capabilities that a profile or caller declared explicitly.
- An "AI router" that picks Workers. The decision model answers typed questions,
  and deterministic code maps the answers to requirements.

## Evidence and research

[Jev decision model research](../research/jev-decision-model.md), which covers
the model's capabilities, the jev-router prior art, the decision points D1–D8,
the invariant tensions, and the economics.

## Proposed design

1. **Seam** `ctx.decisions` ([plugin model](../architecture/plugin-model.md)):

   ```ts
   abstract class Decisions extends Service {
     abstract decide(state: DecisionState, questions: QuestionSet): Promise<DecisionReceipt>;
   }
   // QuestionSet: versioned, typed (choice | score | yes/no), with criteria
   // DecisionReceipt: { inputHash, questionSetVersion, provider, modelVersion,
   //                    answers: { choice?, score?, probability, probabilities?, confidence? } }
   ```

   Providers:
   - `decisions-rules`: deterministic heuristics; the default and the baseline.
   - `decisions-jev`: TypeSafe Jev, with a pinned version, through a direct or
     gateway endpoint chosen in config.
   - `decisions-llm`: any economy-tier model with structured output, through
     `ctx.models`.

2. **One request, several questions.** D1 work type (Choice), D2 capability need
   (Choice), and D4 high-impact (yes/no) are asked together.

3. **Mapping in code, with conservative thresholds** (configurable, starting from
   jev-router's values): `mechanical → economy` only when confidence is at least
   0.85, `routine → standard` at 0.60 or more, `complex/deep → frontier`. If the
   top answer misses its threshold, take the more capable of the top two. The
   high-impact guard can only **raise** the tier and add an approval
   requirement.

4. **Receipts make it deterministic.** Each decision is stored and keyed by input
   hash. A retry, a restart, or an escalation of the same work reuses the receipt
   (REQ-WRK-2). The tier is sticky per client conversation and only moves up,
   which keeps provider-side context warm.

5. **Egress-aware.** Before calling a remote decision provider, the state is
   checked by the egress policy (INV-12). For `local-private` work, only a
   policy-allowed feature summary is sent, or the local `decisions-rules` provider
   is used.

6. **Modes:** `off`, then `shadow` (decide and record, but route by default), then
   `enforce`. Each mode is chosen per decision point in config.

7. **Unavailability.** If the decision provider fails, routing uses the declared or
   default tier and capabilities and records `decision: unavailable`. This is a
   defined, logged path, not a silent fallback (INV-2).

## Alternatives considered

- **Rules only.** Cheap and deterministic, but brittle across phrasing and
  languages. It stays as the baseline and default provider.
- **An economy LLM with JSON output.** It works, but it is slower and costs more
  per call, and it gives no calibrated probabilities without extra work. It stays
  as an alternative provider.
- **Ask the caller every time.** It adds friction, and agents rarely know the
  right tier.
- **A trained in-house classifier.** There is no data for it yet. The receipts from
  shadow mode would become that dataset later.

## Validation plan

- A labeled evaluation set of at least 200 real requests, in **Vietnamese and
  English**, with ground-truth tier and capability-need labels. Accuracy is
  reported per language.
- Shadow mode on real traffic, comparing against outcomes: did the
  default-routed job need escalation, and was Deep Research necessary?
- Enforce a decision point only when:
  1. down-routing errors (hard work sent to `economy`) are at most a configured
     rate, for example 2%;
  2. estimated savings are positive after counting escalations;
  3. the Vietnamese accuracy is within a set margin of the English accuracy.
- A conformance suite for the seam, run against all three providers and a fake.

## Rollout and rollback

- MVP: the seam plus `decisions-rules`, and `decisions-jev` in `shadow` mode,
  behind a disabled config row.
- Beta: `enforce` for D1 and D2 if validation passes.
- Rollback means changing the mode to `off` or `shadow` in config. No code change
  is needed.

## Observability and operations

Decision receipts appear in the event log. Reports show the tier and capability
distribution, threshold misses, escalations after a decision, estimated savings,
and the provider's error rate.

## Security and privacy

- Calling a remote decision provider is data egress and is governed by INV-12.
- The decision model is not a security control. The only security-relevant use
  (D7) is deny-only.
- The API key is stored in the account vault or credential file, never passed as
  a process argument.

## Compatibility and migration

None. This is a new seam, and the default behavior is unchanged unless it is
enabled.

## Decision

Pending: review this proposal after the MVP routing core exists.

## Implementation

Not started.
