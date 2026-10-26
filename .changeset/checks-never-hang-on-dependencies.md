---
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-cli": patch
"@tsuuanmi/system-web-ui": patch
---

An acceptance check never hangs on a dependency change (T235; found on T228, whose `lint` check hung 30 minutes in a `pnpm install` with no network):
- A worktree's setup decision records its dependency files (every file named in the new `worktreeSetup[].dependencyFiles`, default `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.cjs`, at any depth, tracked or untracked, by hash). When a result changes any of them, the setup runs again on the result's tree before its checks, confined as setup is and only with commands the policy allows unasked; what it came to is a `gate` decision (rule `agent-workers.worktree-setup-again`) named among the check-run evidence's inputs, and becomes the worktree's setup decision.
- Setup commands run with pnpm offline (`pnpm_config_offline=true`, the name pnpm 11 and later read, and `npm_config_offline=true`): an install that needs a package its store lacks fails at once, and the checks are refused with the new cause `dependency_unavailable` (`CheckRefusal`), the missing packages named in the reason and in the decision's `missing`.
- Checks run with pnpm's verify-deps-before-run off (`pnpm_config_verify_deps_before_run=false`, and the `npm_config_` name) and offline: pnpm never starts an install inside a check (pnpm 12 ignores the `npm_config_` name alone).
- A check that prints nothing for `worktreeSetup[].checkStallSeconds` (default 300) is told by `agent-workers.check` events (`stalled` with its check's deadline, `resumed`, `ended`); the workflow's `explain` lists the run's checks stalled now (`stalledChecks`), `system explain` prints them under `checks`, and the web UI's run page shows them under **Checks**; a stall past its check's deadline is over (a restart that cut the check never tells its end). A check stopped at its deadline says since when it printed nothing.
