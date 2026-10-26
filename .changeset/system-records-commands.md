---
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": patch
"@tsuuanmi/system-runtime-codex-sdk": patch
"@tsuuanmi/system-agent-workers": patch
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-profile-software-development": patch
---

The System records the evidence itself, and a refusal the Worker can answer (T284; after the hotfix of 2026-10-26, when the evidence gate refused every honest Worker because Claude Code's shell tool prints no exit codes, and each refusal spent the attempt): for every command a writing step's Worker ran, the System keeps the command, its exit code as the runtime reports it (Codex's command items; for Claude Code the tool result's error flag, and the `Exit code N` of its error text), and a bounded tail of its output; a background launch or an interrupted command is recorded with no exit code, never as one that ended. A required check counts as shown when a recorded command for it ran to its end in the step, whatever the Worker wrote; the per-step bound never drops the last record that shows a check; the Worker's own evidence entry is optional prose. The first refusal continues the step's own session once, with the refusal's message; only a second fails the step ("evidence refused twice"). The dossier entries the gate writes list the recorded commands and exit codes, check commands first, split so the entry's bound never cuts one.
