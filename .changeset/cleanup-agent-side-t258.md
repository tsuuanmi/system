---
"@tsuuanmi/system-agent-runtime-core": patch
"@tsuuanmi/system-agent-runtimes": patch
"@tsuuanmi/system-agent-workers": patch
"@tsuuanmi/system-runtime-codex-sdk": patch
"@tsuuanmi/system-runtime-antigravity-cli": patch
---

Clean-up (T258), no behaviour change. These are now module-private, since nothing else imports them: `HOST_TOOL_NAME`, `HOST_TOOLS_PROTOCOLS`, `hostToolInputProblem`, `EXPORTED_FUNCTION` and `workspaceReadTools` (agent-runtime-core); `DEFAULT_READ_ONLY` (agent-runtimes); `NO_TERMINAL`, `HOOK_TIMEOUT_S`, `itemOf` and `READS_STARTUP_S` (runtime-codex-sdk, which also stops re-exporting `askRateLimits`); `READ_TOOLS`, `WRITE_TOOLS`, `CUSTOMIZATION_ROOTS` and `configDir` (runtime-antigravity-cli, which also stops re-exporting `HOOKS_JSON`, `HOOK_COMMAND`, `prepareHome` and `TOOLS`). In agent-workers: `WORKER_KINDS`, `ROLE`, `MAX_ROLES`, `MAX_DERIVED`, `MAX_KINDS`, `providerOfAccount`, `SETUP_LIMITS`, `lineProblem`, `STARTED`, `WORKTREE_GIT_FLOOR`, `SWEEP_BATCH`, `SYSTEM_AUTHOR`, `CARRIED_TRAILER`, `keptSubject`, `replayedRef`, `WorktreeError`, `DEPENDENCY_PATHS_MAX`, `branchOf`, `INSPECTIONS`, `inspectionRefusal`, `CHECK_EVENT`, `CHECK_OUTPUT_TAIL` and `UNBOUNDED_TTL_PROBE_MS`. The unused `DOSSIER_TOOLS` is removed. The accounts module now uses the roles module's `ACCOUNT_ID` pattern instead of its own identical copy.
