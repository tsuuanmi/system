# ADR-0037: Schema and protocol first, for every record and every seam

- **Status:** Accepted
- **Date:** 2026-10-22 (accepted by the operator, with [PROP-0010](../../proposals/0010-base-version.md))
- **Related:** [ADR-0014](0014-json-schema-contracts.md), [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [INV-14](../../architecture/invariants.md#inv-14-every-record-has-a-versioned-schema),
  [plugin model](../../architecture/plugin-model.md#seam-definitions-and-conformance)

## Context

INV-14 already requires a versioned JSON Schema for every persisted record and wire payload.
Two gaps remain. MCP tool inputs and outputs have no schema in `schemas/` yet. And a seam with
one provider may stay a concrete service, with no abstract definition and no conformance suite,
until a second provider appears; its states and failure rules are then described only by the
code. PROP-0010 adds several seams at once (`board`, `approvals`, `resources`, plugin
manifests). They share records, and some are guarantee seams whose contracts may change only by
ADR (ADR-0036). A contract that exists only in code cannot be held to that rule.

## Options

1. **Keep the current rule.** Schemas for records; definitions and suites when a second provider
   appears.
2. **Schema first only.** Every record and payload, MCP tools included, gets a schema before
   code; seams keep the current rule.
3. **Schema and protocol first.** Option 2, and every new seam ships, with its first provider,
   an abstract definition, a written protocol, and a conformance suite.

## Decision

Option 3. For every new seam, before or with its first provider:

1. **Schema.** Every record it stores and every payload it sends or receives, MCP tool input and
   output included, is a JSON Schema in `schemas/` with valid examples (ADR-0014 conventions).
2. **Definition.** An abstract `Service` class in a `*-core` package owns its `ctx` key.
3. **Protocol.** A design document gives its state diagram and a transition table: who may make
   each transition, the decision or event it records, and what happens on failure.
4. **Conformance.** A suite that every provider passes, a fake one included.

Existing guarantee seams without a suite (`store`, `artifacts`, `eventLog`, `leases`, `egress`,
`workflow`, `workerSessions`, `turnReceipts`) get one in PROP-0010's first milestone. Existing
capability seams catch up when they next change.

## Consequences

- A guarantee seam's contract is a reviewable artifact, so the ADR-0036 rule (contract changes
  only by ADR) can be enforced in review.
- A second provider, or a replacement found through the plugin lifecycle, is tested against the
  same suite as the first.
- More work before the first line of a new mechanism. It is paid once, and it moves migrations
  from after release to before it.
- The plugin model's allowance for concrete single-provider seams no longer applies to new
  seams.
