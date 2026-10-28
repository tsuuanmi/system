---
"@tsuuanmi/system-decisions": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-bundle": minor
"@tsuuanmi/system-schemas": minor
---

The operator's decisions can live in System, in a new optional `decisions` row (off by default; PROP-0019 section 2.7, T328):
- A decision is an `operator-decision@1.0` record: a question, its options, recommendation and links, and later the answer, who recorded each (`operator`, `lead:<project>`, or the import), and when. Its number `D<n>` is taken by the store from one sequence for the whole studio, so two sessions never take the same one and a number is never reused. A record is never deleted, and an answered one never changes: a correction is a new decision that `--supersedes` the old one.
- `system decisions list|show|ask|answer` (and MCP `decisions_list|show|ask|answer`) read and record them. A project's lead token asks about its own project, reads its project's and the studio-wide decisions, and records an answer only for its own project, only on the operator's word (`--source`), and as the lead's, never as the operator's. Studio-wide questions are answered by the operator.
- `system decisions import <file>` reads the lead's `decisions.json` once. It refuses a gap in the numbers, a duplicated number, or an entry it cannot read exactly, and writes nothing then; a second run changes nothing.
- Turn the row on with `system plugin on decisions`; with it off, System is healthy and nothing here is reachable (docs/operations/runbooks.md#record-a-decision).
