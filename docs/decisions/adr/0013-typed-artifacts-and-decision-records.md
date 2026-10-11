# ADR-0013: Typed artifacts, with every decision recorded as an artifact

- **Status:** Accepted
- **Date:** 2026-10-11
- **Related:** INV-13, [artifacts](../../design/artifacts.md), ADR-0012

## Context

The maintainer requires decisions to have explicit artifacts. Today, decisions
are spread across code paths: admission, routing, tier choice, escalation, egress
checks, acceptance, gates, reconciliation, graph growth, and decision-model
answers. Some of their outcomes are stored as state, such as a node's `FAILED`
status. Their *reasons* (which candidates were considered, which policy version
applied, what evidence was used) are not stored anywhere. That makes "why did
this job go to that Worker?" unanswerable. It also leaves no dataset for tuning
routing, for example the shadow-mode evaluation in PROP-0002.

The reference systems point the same way. internet's receipts and vNext lineage,
and Anthropic's practice of having subagents write outputs to durable storage and
pass references instead of re-telling content, both treat durable records as the
source of truth.

## Options

1. Log decisions as free-text events.
2. Store only outcomes on the affected records.
3. Make every decision a **typed, immutable, content-addressed artifact** with
   its inputs, candidates, policy, and outcome, linked into the same lineage
   graph as domain artifacts.

## Decision

Option 3, specified in [artifacts](../../design/artifacts.md) and enforced by
[INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact).

- There are two artifact families. **Domain** artifacts (objective, plan,
  finding, evidence, report, handoff, and others) are what the work produces.
  **Control** artifacts (decision, receipt, approval) are how the system decided.
- A decision artifact always names its decision type, inputs (refs), the
  candidates considered and why each was rejected, the decider (rule, policy,
  model, or operator), the policy id and version, any model answers with
  confidence, and the outcome.
- Artifacts are immutable. A correction is a new artifact that `supersedes` the
  old one.

## Consequences

- Every state transition caused by a decision points to its decision artifact,
  so an operator can ask "explain" and follow the chain.
- Shadow-mode evaluation and threshold tuning read decision artifacts directly.
- Storage grows. Decision records are small, large evidence is stored by
  reference, and retention follows the workflow retention rules.
