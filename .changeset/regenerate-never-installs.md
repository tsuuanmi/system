---
"@tsuuanmi/system-agent-workers": patch
---

A landing's generated files never start an install (T235 follow-up; found when two accepted results' landings were refused because `corepack pnpm gen:manifests` exited 1 with "failed to lookup address"): the commands that make a repository's declared generated files again at `rebase` and `merge` (`worktreeSetup[].generated`) now run with pnpm's verify-deps-before-run off and offline (`pnpm_config_verify_deps_before_run=false`, `pnpm_config_offline=true`, and their `npm_config_` names), the same environment a check's command runs in, so pnpm never starts an install that needs the network their confinement does not give.
