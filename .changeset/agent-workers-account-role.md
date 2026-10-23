---
"@tsuuanmi/system-resources-core": minor
"@tsuuanmi/system-resources": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-cli": minor
---

Agent Workers are account × role (PROP-0012 phase F, ADR-0051, ADR-0052):
- The `agent-workers` row can define roles once (`roles`: workspace, sandbox, tier, and per runtime `tools`, `model`, `maxTurns`, `family`) and assign each enrolled account its roles by its id (`assignments`). Each Worker is `agent:<accountId>/<role>`, derived, never named by hand; it takes work only while its account is `ready`, and runs in its account's home.
- Per account: `maxConcurrentRunsPerAccount` (on the runtime's `providers` entry, default 1) runs of an account at once across its roles; each Worker reports its account's `load`, and pending admissions are counted (`reserve`), so least-busy routing sees agent accounts. A provider's `pool` names a pool template of the resources row: each account draws on its own pool `<template>/<accountId>`, so a limit on one account never closes another's.
- The resource ledger (contract 1.1) gains `templates` and the optional `declare(source, accounts)`.
- `system account migrate` (MCP `account_migrate`, `mcp-agent-accounts@1.1`) prints the move from hand-named Workers (roles, assignments, the new row as YAML); `--apply` records it as `enrollment` decisions and moves the old Workers' sessions and runs to their new ids; `--rollback` undoes it.
- No behaviour change until you apply the move: hand-named Workers (`workers`) load and route exactly as before. Once applied, they are refused at load; put the printed row in the profile patch and restart ([runbook](docs/operations/runbooks.md#migrate-agent-workers-to-accounts--roles)).
