# Constraints

> Target state.

| Id | Constraint |
|---|---|
| CON-1 | `system` is a standalone host process. It is not a plugin of another agent harness. Other harnesses integrate as clients or adapters ([ADR-0001](../decisions/adr/0001-standalone-host.md)). |
| CON-2 | It is implemented in TypeScript on Bun, and core packages stay Node-compatible ([ADR-0002](../decisions/adr/0002-typescript-on-bun.md)). |
| CON-3 | Web providers are consumer websites with no API contract. Their UI can change without notice, and automated use may conflict with provider terms. Operators are responsible for compliance. The system must make breakage loud, not silent. |
| CON-4 | Provider usage limits are enforced by the provider and only partially observable. Local accounting is an estimate. |
| CON-5 | Remote login relies on Xvfb, x11vnc, and noVNC, which are available on Linux. On other platforms, login uses a visible local browser. |
| CON-6 | The default deployment is a single user on a single machine. Multi-user or networked deployment is out of scope until a requirement exists. |
| CON-7 | A system Chrome or Chromium install is required for browser-backed providers. |
