---
"@tsuuanmi/system-report": minor
---

The live policy set no longer drifts from the repository's policy files unseen (T352), read-only.
- `lead_health` gains a policy row for each `policies/*.json` the repository ships for the project: the live policy of that id against the file at the commit the install was built from (`packages/cli/lib/build-commit`), ignoring `version` and any key only the live record carries. Equal content is ok; otherwise it is degraded and names the differing keys (`commandRules`, `webAccess`, …), or says no policy of that id is in force. A stamp or file that cannot be read is unknown.
- `scripts/live-update.sh`, after a verified update, prints and records in its notes (`policy-drift.txt` too) each such drift and the `approvals_policy_propose` change it needs, with the record to propose written beside the notes at a version past the live one. It proposes nothing: the operator approves the change.
