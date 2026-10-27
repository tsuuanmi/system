---
"@tsuuanmi/system-board-core": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-leases": minor
"@tsuuanmi/system-egress": minor
---

The leases and egress seams are defined in the definition package of their own core component, as the plugin model's core table names it (T316c, the second half of T316).
- `leases` is the work state machine (INV-15): the abstract `Leases` Service, the `Lease`, `Holding` and `Held` types, the `LeaseLost` and `StaleGeneration` errors, and its conformance suite (contract 1.1) move into the existing `@tsuuanmi/system-board-core`, beside `board`.
- `egress` is the gate (INV-12): the abstract `Egress` Service, `Config`, `DenyPattern`, `EgressRequest`, `EgressVerdict`, `Finding`, the default policy `WORKER_CLASSES`, and its conformance suite (contract 1.0) move into the existing `@tsuuanmi/system-workers-core`, beside `workers`. Its `Classification` is that package's one.
- The providers `leases` and `egress` extend the definitions and re-export nothing; the credential scan stays in `egress` (the repository secrets audit uses it). The seams' surface and the providers' behaviour are unchanged.
- Every consumer imports the definition. A package that only boots a provider in a test keeps it as a dev dependency, so no plugin depends at run time on another's package for these two seams (13 package.json edges to them before, 0 after; the bundle still mounts both).
