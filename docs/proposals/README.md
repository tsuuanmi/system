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
  **proposed**. A standalone host that unifies AgentOS routing and teams, internet
  provider durability and workflows, and codex-chatgpt-web gateways.

Use [0000-template.md](0000-template.md) for new proposals. The
[roadmap](roadmap.md) is a non-normative queue of milestones, not a substitute for
a reviewed proposal.
