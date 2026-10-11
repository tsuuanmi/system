# ADR-0010: Reuse or adapt before building

- **Status:** Accepted
- **Date:** 2026-10-11
- **Related:** ADR-0007, ADR-0008

## Context

The maintainer requires that a concern already solved well by an existing tool
use that tool directly, or adapt it, rather than rebuild it. AgentOS states the
same principle as a reuse ladder. The reference repos already contain
well-tested mechanisms that `system` needs.

## Options

1. Build in-house for control and consistency.
2. Follow a reuse ladder, keep a register of decisions, and write custom code only
   for what is left over.

## Decision

Option 2. For each concern, take the first rung that preserves every invariant:

1. **an official protocol SDK or specification** (MCP, ACP, Claude Agent SDK,
   Codex SDK);
2. **a narrow, maintained library** (Cordis, patchright, tiktoken, turndown, noVNC);
3. **porting proven code** from the reference repos, with attribution and license
   compliance:
   - internet: provider receipts, scheduler, remote login;
   - codex-chatgpt-web (MIT): gateway, broker, and fence mechanics;
4. **a thin adapter** around an existing tool, which adapts behavior and not data
   models;
5. **new code**, only for the semantic remainder that no rung above provides.

Full frameworks (agent frameworks, durable-workflow servers) are not adopted as
hosts, as decided in [ADR-0001](0001-standalone-host.md) and
[ADR-0003](0003-sqlite-durable-store.md). They may still be wrapped as *providers*
behind a seam when a requirement calls for it.

Each choice, with its rung, is recorded in the
[dependency register](../../engineering/dependencies.md). Every new runtime
dependency or port updates that register in the same PR.

## Consequences

- Less code to own, and mechanisms already proven in production.
- Dependency risk is managed by pinning, `bun audit` in CI, seam conformance
  suites, and the rule that every external tool sits behind a seam, so it can be
  replaced ([ADR-0008](0008-tool-agnostic.md)).
- Ported code is restructured into small modules that fit the seams, not copied
  file by file ([code quality](../../engineering/code-quality.md)).
