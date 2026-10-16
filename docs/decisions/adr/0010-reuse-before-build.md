# ADR-0010: Reuse or adapt before building

- **Status:** Accepted; amended 2026-10-16 (the reuse check)
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
- Dependency risk is managed by pinning, `pnpm audit` in CI, seam conformance
  suites, and the rule that every external tool sits behind a seam, so it can be
  replaced ([ADR-0008](0008-tool-agnostic.md)).
- Ported code is restructured into small modules that fit the seams, not copied
  file by file ([code quality](../../engineering/code-quality.md)).

## Amendment (2026-10-16): the reuse check, step by step

The ladder stands. Each new plugin or substantial integration records these
steps where it is decided, in its proposal or PR:

1. **The missing capability.** What the system cannot do today, and the
   requirement that asks for it.
2. **The search.**
   - official SDKs and protocols;
   - existing DSH/Cordis plugins (see the
     [community plugin review](../../research/dsh-community-plugins-review.md));
   - maintained open-source alternatives.
3. **The comparison.** Capabilities, compatibility, security, durability,
   maintainability, and license.
4. **The decision:** reuse, adapt, build, or defer.
5. **A check.** A conformance case or a small compatibility spike, where the
   choice depends on behavior.
6. **The way out.** For anything built or adapted, its replacement path: what
   would replace it, and what would trigger that.

Rules that follow from the ladder:

- A vendor-specific plugin is not written when an existing protocol adapter can
  meet the same contract through configuration.
- Reuse never weakens an invariant. This covers durability, idempotency,
  credential isolation, egress policy, sandbox enforcement, and exact-subject
  binding. A candidate that would weaken one is rejected or wrapped until it does
  not.
- A plugin is warranted only by one of these: an independent lifecycle, a
  replaceable implementation, a configuration boundary, or an extension point.
  Deterministic logic without one of these stays a library module.
