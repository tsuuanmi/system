# ADR-0021: Website UI operations are data, resolved by a deterministic engine with bounded self-healing

- **Status:** Accepted
- **Date:** 2026-10-11
- **Related:** [ADR-0005](0005-provider-runtime-interface.md) (provider drivers),
  [ADR-0016](0016-invisible-headed-browser-and-portable-accounts.md),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact),
  [research](../../research/browser-interaction-and-self-healing.md),
  [design](../../design/ui-operations.md)

## Context

Provider websites such as chatgpt.com change their UI often. Every reference
implementation (internet, codex-chatgpt-web, dsh-chatgpt-web) hard-codes
selectors in TypeScript, so each UI change needs a code change and a release. The
maintainer asked for three things: core logic that stays stable, a self-debug
step that finds the right control when the UI changes, and the knowledge of
operations kept in a separate configuration file.

## Decision

1. **Three layers.**
   - The **UI engine** (`@tsuuanmi/system-ui-ops`, code, provider-agnostic):
     resolve, act, verify, wait for states, observe network signals, diagnose,
     heal.
   - **Provider drivers** (code): short procedures, such as "submit a prompt", that
     name operations by id and never contain a selector.
   - **UI maps** (data, one per provider, `ui-map@1.0`, JSON Schema validated):
     every element, action, state, and network signal the driver uses. Each
     element lists ordered locator candidates: test id, role plus localized
     accessible name, label, and text, with CSS last. Each also states its scope,
     cardinality, preconditions, postconditions, timeouts, side-effect class, and
     heal policy.
2. **The happy path is deterministic.** It uses no model and needs no debugging
   port. Candidates are tried in order, a match must be unique, visible, and
   enabled, and every action is verified by its postcondition.
3. **Passive network observation** is a second, independent signal for running,
   completion, challenges, and errors. The engine observes responses on the page
   it owns and never calls private endpoints.
4. **Bounded self-heal.** When every candidate fails and no login or challenge
   guard is showing, the engine takes an ARIA snapshot of the operation's scope.
   A deterministic matcher scores it against the operation's fingerprint. An
   economy-tier model may propose a ref once the `ctx.models` seam exists
   (planned; `heal: model` acts as `deterministic` until then). The
   result is accepted only if it is unique, scores above the threshold with a
   margin, and passes the preconditions and postconditions.
   - `irreversible` operations (send) never use a model proposal and never retry
     (planned: the side-effect class is parsed but not yet enforced).
   - Every heal is a **decision artifact**. A successful heal is written to a
     **local overlay**, never to the shipped map. Promotion to the shipped map
     is a reviewed change (`system ui doctor`, planned, then a PR).
5. **Drift is a configuration fix.** A UI drift failure carries the new
   disposition `CONFIG_FIX` instead of `CODE_FIX`.

## Consequences

- Most UI changes need only an edit to the map or an approved overlay, and no
  release.
- The engine owns the hard parts once: uniqueness, verification, timeouts,
  diagnostics, and healing. Drivers stay small.
- The map is a contract with its own schema, fixtures, and review. A bad map
  edit fails the fixture tests in CI, not production.
- The self-heal step cannot click arbitrary controls. It is bounded by guards,
  scope, a score threshold, verification, side-effect class, and a human review
  before promotion.
- Selectors built on internal engine features, such as patchright's
  `aria-ref=`, are pinned by conformance tests.
