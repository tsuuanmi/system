# @tsuuanmi/system-runtime-codex-sdk

Agent runtime `codex-sdk`: **Codex as a Worker** (REQ-WRK-5)
([agent runtimes](../../../docs/design/agent-runtimes.md)). It runs the
operator's installed `codex` through the official Codex TypeScript SDK.

- **Policy, exactly or refused (REQ-WRK-6):**
  - the sandbox (`read-only`, or `workspace-write` with writes confined to the
    workspace) and the working directory come from the Worker's configuration;
  - approvals are `never`, so whatever the sandbox refuses fails instead of
    waiting for a person;
  - network access and web search are off;
  - the `codex` process starts without the daemon's credentials (INV-8):
    always with `childEnvironment` (agent-runtime-core), so credential-shaped
    and `DSH_*` variables are scrubbed;
  - Codex has no tool allow-list and no turn limit, so a configured `tools` or
    `maxTurns` is refused, not ignored.
- **Probe:** `codex --version`. Both sandboxes are supported, threads resume,
  and commands run inside the sandbox (`executes`), so a writable Codex Worker
  proves `validate`.
- **Runs:** a thread starts, or resumes by its native handle, the thread id
  reported as soon as the thread starts. The final agent message is the result.
  A failed turn is `session_broken`, or `quota_exhausted` for a usage limit.
- **Configuration:**
  - `executable` (default: `codex` on PATH);
  - `config`: Codex `--config` overrides, such as its model provider;
  - `forwardEnv`: daemon variables passed to the process by name;
  - `env`: explicit values for the process, never a secret.
  To run Codex on website Workers, point its model provider at the system
  Responses gateway. Put the gateway token into the daemon's environment as the
  variable the provider's `env_key` names (for example `SYSTEM_MCP_TOKEN`), never
  into a config file, and name that variable in `forwardEnv`: without it, the
  scrub removes the token and Codex cannot reach the gateway.
- **Dependencies:** `@openai/codex-sdk`. Its per-platform Codex builds are
  ignored optional dependencies.
- **Verified live on 2026-10-12:** a `review` ran on a read-only Codex Worker
  with ChatGPT Web, through the gateway, as its model.
