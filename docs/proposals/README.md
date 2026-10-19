# Proposals

Proposals describe **changes under consideration**. They are evolutionary, not
current truth.

## Lifecycle

```text
draft -> proposed -> accepted -> implementing -> implemented
                  \-> rejected
accepted/implemented -> superseded
```

- [Research](../research/README.md) provides evidence. A proposal frames a
  concrete change, its alternatives, validation, rollout, and risks.
- Accepting a proposal does not change production behavior by itself. Current
  truth changes only when requirements, design, source, and tests change.
- Architecturally significant choices are recorded as
  [ADRs](../decisions/adr/README.md).

## Active proposals

- [PROP-0001: Unified system architecture](0001-unified-system-architecture.md),
  **implementing**. Our own harness built on DSH core
  ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md), which superseded in
  part the standalone host of ADR-0001). It unifies AgentOS routing and teams,
  internet's provider durability and workflows, and the model gateways that
  codex-chatgpt-web pioneered (built anew, ADR-0022).
- [PROP-0002: Decision-assisted routing](0002-decision-assisted-routing.md),
  **draft**. A `ctx.decisions` seam, with the Jev decision model as a first
  provider, infers the tier and capability need for undeclared work. It runs in
  shadow mode first.
- [PROP-0003: Production readiness](0003-production-readiness.md), **draft**.
  Hardening for a per-user deployment: scoped control credentials, agent Workers
  confined for reads, health and drift alerts, bounded retention and tested
  upgrades, versioned releases with provenance, and an `api-first` preset.
- [PROP-0004: Claude Code as the lead (MVP)](0004-claude-code-lead-mvp.md),
  **accepted**. Claude Code delegates research, brainstorm, and review to teams of
  website Workers on two providers that debate and decide by majority vote. Only
  the core templates remain, and retention also deletes the website chats
  `system` created.
- [PROP-0005: Session-bound website accounts](0005-session-bound-website-accounts.md),
  **accepted** ([ADR-0030](../decisions/adr/0030-session-bound-accounts-use-their-login-profile.md)). An account whose site ties its session to the browser that signed in runs its
  turns as tabs of its own persistent login profile instead of fresh contexts from copied state,
  behind a driver capability. Copies died on Gemini (2026-10-16) and on ChatGPT (2026-10-17) while
  the profiles stayed signed in. Gemini goes first.

- [PROP-0006: Model Workers keep sessions](0006-model-worker-sessions.md), **accepted** ([ADR-0031](../decisions/adr/0031-model-worker-sessions-by-replay.md)). A model
  Worker (an API or local model) keeps a session by replaying its transcript, a provider-neutral
  `history` on `ctx.models`, so it can be a team member, carry research's synthesis thread, and
  continue an `ask`. Bounded, durable, idempotent, and egress-checked.

- [PROP-0007: Account pools](0007-account-pools.md), **accepted** ([ADR-0033](../decisions/adr/0033-least-busy-routing.md), [ADR-0034](../decisions/adr/0034-unsent-failover-to-a-sibling-account.md), [ADR-0035](../decisions/adr/0035-one-family-teams-keep-distinct-accounts.md)). Several accounts of one provider
  share its work: the least busy account takes the next turn, a site's usage limit puts the
  account (or one feature) in a cooldown routing respects, a node that failed before anything was
  sent moves to a sibling account, and one-provider teams keep distinct accounts before sharing
  one. Page opens are spaced per provider, background checks spread, browsers capped.

Use [0000-template.md](0000-template.md) for new proposals. The
[roadmap](roadmap.md) is a non-normative queue of milestones, not a substitute for
a reviewed proposal.
