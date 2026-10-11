# ADR-0004: One workflow runtime

- **Status:** Proposed
- **Date:** 2026-10-11
- **Related:** PROP-0001, INV-1, REQ-WF-*

## Context

internet ships two workflow runtimes. The production v3 graph engine has
input-hash node receipts, exact-head binding, and recovery. The vNext kernel is
exported and tested but never instantiated, and it has typed artifacts, lineage,
invalidation, and convergence. The two duplicate the driver, execution, and lease
logic, and they inflate the public API. AgentOS designs a semantic DAG with a node
router, but no durability, and its DAG cannot express runtime growth.

## Options

1. Adopt v3 as is.
2. Adopt vNext as is.
3. One engine: the AgentOS semantic DAG and node router, with v3 durability
   (input-hash receipts, leases, exact-subject gates, recovery taxonomy),
   profile-declared bounded graph growth, and vNext lineage, invalidation, and
   convergence.

## Decision

Option 3, specified in [workflow-engine](../../design/workflow-engine.md). No
second engine may exist next to it. Evolution happens inside the one engine,
behind tests.

## Consequences

- One driver, one execution manager, and one lease model.
- vNext concepts are adopted only where a profile needs them. Typed artifacts and
  invalidation arrive with the scientific-research profile, which is the second
  domain and the test of the architecture.
- The engine API must stay small. Profiles, not engine code, carry domain node
  kinds.
