# Constraints

> Target state.

| Id | Constraint |
|---|---|
| CON-1 | `system` is its own harness, distributed as a DSH bundle and profile on DSH core (only allow-listed DSH rows, no `dsh-base`) and launched through the `system` CLI wrapper. Claude Code, Codex, and other clients integrate through protocols ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)). |
| CON-2 | It is implemented in TypeScript on **Node `^22.19 \|\| >=24`** with pnpm, because DSH requires Node. Bun is not supported ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)). |
| CON-3 | Web providers are consumer websites with no API contract. Their UI can change without notice, and automated use may conflict with provider terms. Operators are responsible for compliance. The system must make breakage loud, not silent. It drives a genuine browser as the operator would: no fingerprint spoofing, no automatic CAPTCHA or challenge solving, and no circumvention of rate limits. |
| CON-4 | Provider usage limits are enforced by the provider and only partially observable. Local accounting is an estimate. |
| CON-5 | The invisible `virtual` display and remote login rely on Xvfb, x11vnc, and noVNC, which are available on Linux. On macOS and Windows, provider turns use an off-screen window, which may appear in the Dock or taskbar, and login uses a visible local window. |
| CON-6 | The default deployment is a single user on a single machine. Multi-user or networked deployment is out of scope until a requirement exists. |
| CON-7 | A system Chrome or Chromium install is required for browser-backed providers. |
| CON-8 | DSH and its vendored Cordis are a developer preview. Breaking changes arrive about weekly, packages move in lockstep, and the `latest` dist-tags are stale. One exact DSH version is pinned. Each upgrade passes the seam conformance and composition suites. Experimental DSH packages are not used in the MVP. Telemetry is disabled ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)). |
| CON-9 | Agent-runtime Workers require the agent to be installed and authenticated by the operator. Each agent's own terms and usage limits apply. |
