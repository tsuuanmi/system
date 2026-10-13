# ADR-0025: An `api-first` preset; website Workers and model gateways are opt-in there

- **Status:** Proposed
- **Date:** 2026-10-14
- **Related:** [PROP-0003](../../proposals/0003-production-readiness.md#m6e-api-first-composition),
  REQ-WRK-8, REQ-HOST-4, CON-3, [purpose](../../requirements/purpose.md),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in),
  [INV-12](../../architecture/invariants.md#inv-12-data-egress-is-explicit)

## Context

The default composition is built around website Workers: P1 (spend the website
chat quota) and P2 (use website capabilities such as Deep Research). Those
Workers drive consumer websites. Their terms may forbid automated use (CON-3),
and their UI changes without notice.

Some organizations cannot accept that, but still want P3 (the right Worker for the
job, private data kept local) and P4 (cheap models for low-level work). They need
API models, local models, and agent Workers, with nothing that drives a website.

The pieces exist or are planned:

- `ctx.models`, the planned seam for API and local models over the DSH `llm`,
  `llm-pi-ai`, and `llm-retry` rows ([seam catalog](../../architecture/plugin-model.md#seam-catalog));
- the `workers` row's `quotaPreference`, which orders quota classes;
- the `egress` row's `workerClasses`, which maps Worker classes to permitted
  classifications;
- profiles and patches, which compose every feature (REQ-HOST-4).

## Options

1. Keep one composition and let each operator turn website rows off by hand.
2. Ship a separate build without website Workers.
3. **One bundle with a named preset overlay**, `api-first`, chosen at `system init`.

## Decision

Option 3.

- `packages/system-bundle` ships an `api-first` overlay. It disables the website
  rows (display, browser, providers, website drivers, login, accounts, turns, turn
  receipts) and both model gateways, and sets
  `quotaPreference: [local, metered, agent-plan, subscription-chat]`.
- `system init --preset api-first` writes the overlay into the operator's profile
  and skips the Chrome and display checks when no browser row is mounted.
- Models reach routing as a `models` Worker source through `ctx.models`. A new
  egress Worker class, `model`, receives `public` and `operator-shared` by default.
- The overlay names no vendor, model, or tool. Model references live only in the
  operator's model catalog (INV-11).
- Work that needs a website-only capability (`web-search`, `deep-research`) fails
  admission under this preset with an explicit reason. There is no silent
  fallback (INV-2).
- The composition e2e test asserts the exact row set of each preset.

## Consequences

- One implementation serves both kinds of deployment (INV-1); the preset is data.
- P1 and P2 are unavailable under `api-first`; the purpose document notes which
  purposes each preset serves.
- REQ-WRK-8 is reworded so the quota order is configuration and the default
  composition still prefers subscription-chat quota.
- Gateway requirements (REQ-GW-1, REQ-GW-5) are met by the default composition.
  The release checklist records results per preset.
- API usage costs money. Bounded retries, token budgets, and `metered` usage
  records make the cost visible and limited (INV-9).
