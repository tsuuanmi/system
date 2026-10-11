# Decisions

Decision records preserve **why `system` arrived at its current direction**. They
are historical, durable artifacts. Current behavior belongs in requirements,
architecture, design, source, and tests.

- [Architecture Decision Records](adr/README.md)

## Decision rules

- Search existing decisions before creating a new record.
- Use a [proposal](../proposals/README.md) for a change that is still being
  explored or reviewed.
- Create an ADR only for a durable architectural, contract, security, or
  operational decision.
- Accepted ADRs are append-only history. A material replacement creates a
  successor that explicitly supersedes the earlier record.
- Do not use ADRs as current-state design manuals.
