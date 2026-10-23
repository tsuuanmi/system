---
"@tsuuanmi/system-runtime-claude-agent-sdk": minor
---

Claude Code Workers run commands, confined (B3, ADR-0038):
- Claude Code now starts under the host's read confinement, as Codex and ACP agents do: bubblewrap hides the DSH home, the temporary and runtime directories, every credential store, and every coding agent's login, the operator's `~/.claude` included. Its probe proves the confinement on the host (`readsConfined`), where it used to state it.
- It runs in its own home (`CLAUDE_CONFIG_DIR`, config `home`, default `<DSH_HOME>/system/claude-home`). Sign in there once (`CLAUDE_CONFIG_DIR=<home> claude`, then `/login`), or forward an API key or OAuth token by name (`forwardEnv`). A Claude Code that is not signed in there is unavailable, and the probe names the home.
- A `workspace-write` run offers `Bash`, every command in the SDK's sandbox: writes to the run's workspace only, no network, no command outside the sandbox, and a run whose sandbox cannot start fails. A `read-only` run has no `Bash`. Each command still passes the run's tool gate by its exact argv.
- The probe reports `executes: true`, and offers `workspace-write`, only when a sandbox with no network starts inside the confinement on this host; otherwise its Workers stay read-only and the reason is named. The host needs bubblewrap and `socat`.
