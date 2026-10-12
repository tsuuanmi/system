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
  - Codex runs in **its own Codex home** (`CODEX_HOME`, config `home`, default
    `<DSH_HOME>/system/codex-home`, created owner-only), never the operator's
    `~/.codex`, where `system mcp-config codex` puts the `system` MCP server.
    Codex starts MCP servers outside its sandbox, so a Worker would reach their
    tools (`approve`, the credential tools, …). The probe and every run call
    `codex mcp list --json` on that home and fail closed (`config_error`) if any
    enabled MCP server is configured; a `config` holding `mcp_servers` is
    refused. A `-c mcp_servers={}` override would not clear them, because Codex
    merges its configuration, hence the separate home;
  - Codex has no tool allow-list and no turn limit, so a configured `tools` or
    `maxTurns` is refused, not ignored.
- **Reads are not confined.** Codex's `read-only` sandbox (and `workspace-write`)
  confines writes only: the agent can still read the whole disk the operator's
  user can read. Claude Code Workers are confined for reads too
  ([threat model](../../../docs/security/threat-model.md)).
- **Probe:** `codex mcp list --json` on the Worker home (any server: unavailable),
  then `codex --version`. Both sandboxes are supported, threads resume, and
  commands run inside the sandbox (`executes`), so a writable Codex Worker
  proves `validate`.
- **Runs:** a thread starts, or resumes by its native handle, the thread id
  reported as soon as the thread starts. The final agent message is the result.
  A failed turn is `session_broken`, or `quota_exhausted` for a usage limit.
- **Configuration:**
  - `executable` (default: `codex` on PATH);
  - `config`: Codex `--config` overrides, such as its model provider;
  - `forwardEnv`: daemon variables passed to the process by name;
  - `env`: explicit values for the process, never a secret;
  - `home`: the Workers' Codex home; it must configure no MCP server.

  To run Codex on website Workers, point its model provider at the system
  Responses gateway. Put the gateway token into the daemon's environment as the
  variable the provider's `env_key` names (for example `SYSTEM_MCP_TOKEN`), never
  into a config file, and name that variable in `forwardEnv`: without it, the
  scrub removes the token and Codex cannot reach the gateway. Such a Worker needs
  no login. A Worker on an OpenAI or ChatGPT login must be signed in inside its
  own home (`CODEX_HOME=<home> codex login`); the operator's `~/.codex` login is
  not used.
- **Dependencies:** `@openai/codex-sdk`, whose per-platform Codex builds are
  ignored optional dependencies, and `system-libs` (`dshHome`,
  `ensurePrivateDir`).
- **Live checks:** the [release checklist](../../../docs/validation/release-checklist.md)
  (a Codex Worker).
