# Constraints

> Target state.

| Id | Constraint |
|---|---|
| CON-1 | `system` is a standalone host process. It is not a plugin of another agent harness. Other harnesses integrate as clients through gateways, or by mounting `system` plugins as a bundle ([ADR-0001](../decisions/adr/0001-standalone-host.md)). |
| CON-2 | It is implemented in TypeScript on Bun, and core packages stay Node-compatible ([ADR-0002](../decisions/adr/0002-typescript-on-bun.md)). |
| CON-3 | Web providers are consumer websites with no API contract. Their UI can change without notice, and automated use may conflict with provider terms. Operators are responsible for compliance. The system must make breakage loud, not silent. It drives a genuine browser as the operator would: no fingerprint spoofing, no automatic CAPTCHA or challenge solving, and no circumvention of rate limits. |
| CON-4 | Provider usage limits are enforced by the provider and only partially observable. Local accounting is an estimate. |
| CON-5 | The invisible `virtual` display and remote login rely on Xvfb, x11vnc, and noVNC, which are available on Linux. On macOS and Windows, provider turns use an off-screen window, which may appear in the Dock or taskbar, and login uses a visible local window. |
| CON-6 | The default deployment is a single user on a single machine. Multi-user or networked deployment is out of scope until a requirement exists. |
| CON-7 | A system Chrome or Chromium install is required for browser-backed providers. |
| CON-8 | The plugin runtime is `@deepseek-ai/cordis`, whose upstream is a release candidate. It is pinned exactly, and only its stable primitives are used ([ADR-0007](../decisions/adr/0007-everything-is-a-plugin.md)). |
| CON-9 | Agent-runtime Workers require the agent to be installed and authenticated by the operator. Each agent's own terms and usage limits apply. |
