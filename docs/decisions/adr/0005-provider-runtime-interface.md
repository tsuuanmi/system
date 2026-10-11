# ADR-0005: Provider drivers behind one interface

- **Status:** Proposed
- **Date:** 2026-10-11
- **Related:** PROP-0001, QA-9, CON-3

## Context

internet's `BrowserManager` branches on `chatgpt-web` and `gemini-web` inside one
large method. Its account catalog and team routing are hard-coded, and remote-login
ports are assigned by array index. codex-chatgpt-web concentrates ChatGPT
automation in a single 5.9k-line worker. Both systems mix the shared mechanics
(receipts, completion, scheduling) with provider-specific DOM handling. Every
change to a provider website therefore risks the shared logic.

## Options

1. Keep a single manager and branch on the provider.
2. Use a `ProviderDriver` interface for website-specific steps, with shared
   runtime mechanics wrapped around it. Accounts come from configuration.
3. Make every provider a fully independent plugin that owns its own mechanics.

## Decision

Option 2. The interface is in
[provider-turns](../../design/provider-turns.md#driver-interface). Receipts,
two-clock completion, scheduling, auth write-back, and error classification are
implemented once in the runtime. The account catalog, roles, capabilities, and
ports come from validated configuration.

## Consequences

- Adding a provider means adding a driver plus DOM fixtures. Shared reliability
  logic is not touched.
- Drivers are tested against recorded DOM fixtures. UI drift fails closed.
- Option 3 was rejected because it would duplicate the reliability-critical
  mechanics in every provider.
