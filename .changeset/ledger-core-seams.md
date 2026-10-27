---
"@tsuuanmi/system-ledger-core": minor
"@tsuuanmi/system-store": minor
"@tsuuanmi/system-artifacts": minor
"@tsuuanmi/system-event-log": minor
---

The ledger seams are defined in a package of their own, `@tsuuanmi/system-ledger-core` (ADR-0037): the abstract `Store`, `Artifacts` and `EventLog` Services, with the types, the `RevisionConflict` error, the read bounds and the `system/event` event they name, and their three conformance suites (contracts unchanged: store 1.0, eventLog 1.1, artifacts 1.2).
- The providers `store`, `artifacts` and `event-log` extend the definitions and re-export nothing; their surface and behaviour are unchanged.
- Every consumer imports the definition. A package that only boots a provider in a test keeps it as a dev dependency, so no plugin depends at run time on another's package for these three seams (50 package.json edges to them before, 0 after).
- Leases and egress move in a follow-up (T316b).
