# @tsuuanmi/system-ui-ops

The **UI engine** for website drivers
([UI operations](../../docs/design/ui-operations.md),
[ADR-0021](../../docs/decisions/adr/0021-ui-operations-as-data.md)). A library,
not a plugin: provider drivers create one `UiEngine` per turn page.

- **`loadUiMap(text, overlay?)`:**
  - validates a provider's `ui-map@1.0` (YAML or JSON) and checks that every
    reference resolves;
  - appends the local overlay's candidates after the shipped ones;
  - returns the merged map with its content `hash`.
- **`UiEngine`:**
  - `resolve`: ordered candidates, exactly one visible match, within `scope`;
  - `act`: guards from the map's `errors`, then resolve, then a bounded heal,
    then the fallback, then `require`, the action, and the `verify` postcondition;
  - `state`, `waitFor`, `count`, and `text`;
  - `network`: a passive `NetworkObserver`.
- **Events:**
  - `onDrift` fires when a non-primary candidate wins.
  - `onHeal` fires with `healed`, `rejected`, or `failed`, the scores, the
    snapshot hash, and the durable candidate for the overlay.
  - `beforeHealedAction` receives a chosen heal **before** the element is acted
    on, so the caller records the decision first (INV-13). A throw aborts the
    action. `heal: false` turns healing off.
  - `appendOverlay(path, element, candidate, note)` adds a verified candidate to
    the owner-only local overlay. The engine never writes the shipped map.
- **Heal:** a deterministic matcher over `ariaSnapshot({ mode: 'ai' })`, with a
  threshold of 0.8 and a margin of 0.15, scoped to the element's scope.
  `aria-ref=` resolves the chosen node, and `normalize()` turns it into a durable
  locator. Model proposals arrive with the `ctx.models` seam.
- **Depends on:** `patchright-core` (peer), `yaml`, `@tsuuanmi/system-libs`
  (schema registry), and `@tsuuanmi/system-provider-core` (typed failures).
