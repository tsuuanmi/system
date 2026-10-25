---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-resources-core": minor
"@tsuuanmi/system-resources": minor
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-agent-workers": patch
"@tsuuanmi/system-gateway-core": patch
"@tsuuanmi/system-mcp-server": patch
"@tsuuanmi/system-report": patch
---

A run's lower bound stays a lower bound through a crash or a failed append, and a cap of its scope stays closed (INV-2, ADR-0065 amended; review T202).

- Why: the `agents` source stored a stopped run's lower-bound `usage-record`, then appended the `not-reported` fact whose `partial` said it was one. A crash between the two, or a failed append (only logged), left a record every reader took as the run's usage: an `interrupted` fact the restart added was reconciled by it, and a cap admitted work against an incomplete count.
- `usage-record@1.1` (additive, ADR-0036): the optional `partial` (1 to 300 characters, with `runId`) says on the record itself that it is a lower bound and why. The `agents` source writes a partial report as one, so the status is in the ledger's one write of it.
- `resources` contract 1.3: `record` takes `usage-record@1.1` and keeps `partial`; a cap of the run's scope and pool is refused while the run has no whole record there, with nothing else recorded. A conformance scenario holds every provider to it; `FakeResources` passes it.
- The store-backed ledger counts a run as reconciled only by a record without `partial`, and refuses a scoped cap on a run whose only records in a capped pool are lower bounds, fact or none, naming the run, its Worker, and why (at most 100 runs named, INV-9).
- `countedWhole` in libs: one rule for health, the roster, the report, and the ledger. A fact that cannot be appended is logged, saying the record still keeps its caps closed.
