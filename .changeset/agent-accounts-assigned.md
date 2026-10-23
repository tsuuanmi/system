---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-artifacts": patch
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": patch
"@tsuuanmi/system-runtime-codex-sdk": patch
"@tsuuanmi/system-runtime-acp": patch
"@tsuuanmi/system-runtime-antigravity-cli": patch
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-accounts": minor
"@tsuuanmi/system-turns": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-web-ui": patch
"@tsuuanmi/system-mcp-server": patch
"@tsuuanmi/system-gateway-anthropic": patch
"@tsuuanmi/system-gateway-responses": patch
"@tsuuanmi/system-profile-software-development": patch
"@tsuuanmi/system-profile-scientific-research": patch
---

Accounts are assigned unless the operator records that a provider's terms allow pooling (PROP-0012 phases B and D, ADR-0051 and ADR-0052, proposed; T48):
- Each website provider (on the `accounts` row) and each agent runtime (on the `agent-workers` row) has `accounts: assigned | pooled`, `assigned` by default. `pooled` is refused at load without whole `pooledTerms` (who confirmed the provider's terms allow it, when, which terms) and is recorded as a `gate` decision at each start. Website and agent Workers name the account they run on (`capability-descriptor@1.5`).
- Under `assigned`, a limit on one account never moves its work to another account of the same provider. A step whose only possible Worker is at a known limit now waits for the reset instead of failing at once: a `recovery` decision `wait` (`decision@1.8`), no attempt spent, nothing sent, kept across a restart, at most `maxLimitWaitHours` (default 24) on the `workflow` row; `0` restores failing at once. A waiting step keeps its run open, so it counts toward `maxActiveRuns` and a drain waits for it. An unsent challenge or sign-out moves only to another provider, else fails for the operator; an unsent overload is retried on the same account. Under `pooled`, ADR-0034's failover stands. With one account per provider, as on the live host, routing chooses exactly as before.
- New, for later phases: `agent-account@1.0`, the `enrollment` decision type, and the optional `agentRuntimes` methods for several homes per runtime (`RunSpec.home`, `probe({ home })`, `identity(home, key)`, `loginCommand(home)`); every runtime refuses a run that names a home it does not run in.
- The workflow store gains migration 17. The `workflow` contract is at 1.5, with T55's team scenarios: `system plugins` shows the workflow plugin providing 1.5.0, and its consumers' manifests take `^1.5.0`.
