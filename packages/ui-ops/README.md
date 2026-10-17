# @tsuuanmi/system-ui-ops

The **UI engine** for website drivers
([UI operations](../../docs/design/ui-operations.md),
[ADR-0021](../../docs/decisions/adr/0021-ui-operations-as-data.md)). A library,
not a plugin: provider drivers create one `UiEngine` per turn page.

- **`loadUiMap(text, overlay?)`:**
  - validates a provider's map, `ui-map@1.0` to `ui-map@1.2` (YAML or JSON),
    and checks that every reference resolves;
  - appends the local overlay's candidates after the shipped ones;
  - returns the merged map with its content `hash`.
- **`unverifiedEntries(map, ids)`:** which of the named elements and actions are
  marked `unverified: true` (`ui-map@1.2`) or missing: not yet checked on the live
  site, so no irreversible job may depend on them.
- **Frames:** an element with `frames: any` (`ui-map@1.1`) is searched in every
  frame, for content rendered in iframes such as a research report.
- **`UiEngine`:**
  - `resolve`: ordered candidates, exactly one visible match, within `scope`;
  - `act`: guards from the map's `errors`, then resolve, then a bounded heal,
    then the fallback, then `require`, the action, and the `verify` postcondition;
  - `state`, `waitFor`, `count`, and `text`;
  - `copied`: what a copy control puts on the clipboard (cleared first, so an
    earlier copy never counts);
  - `network`: a passive `NetworkObserver`.
- **Reading answers** (shared by every website driver, REQ-PRV-5):
  `preWrapText` reads an element under `white-space: pre-wrap`, so code
  indentation survives; `copiedMarkdown` takes the answer's Markdown from its
  Copy control and keeps it only when `sameWords` matches the rendered text,
  then applies the site's own clean-up and drops tracking parameters from its
  link targets (the rendered text otherwise). Either way, the answer's off-site links (`linksIn`) that the text lacks follow it as
  a `Sources:` list, so a cited answer keeps its URLs.
- **Events:**
  - `onDrift` fires when a non-primary candidate wins (`fallback`), when an
    action's target resolves through nothing (`unresolved`), and when an action
    misses its postcondition (`postcondition`), once per element and kind per
    page. It carries `outlineOf`'s structural outline of the region
    ([drift evidence](../../docs/design/ui-operations.md#drift-evidence));
    `driftData` turns a report into the `ui.drift` event's data, keeping the
    outline as a local-private `evidence` artifact. `drift(element, kind)`
    reports a stale element a driver found itself, with the same evidence.
  - `stall(phase)` describes the page as it stands, for a turn whose answer
    stalled or ran out of time: the same redacted outline of the page, with its
    `visibilityState`, focus, and path. `evidenceData` keeps any such event's
    outline as evidence, the way `driftData` does.
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
  locator. Any `heal` other than `off` heals deterministically: `model` is
  parsed, and model proposals wait for a `ctx.models` seam (planned). The
  action's `sideEffect` class is parsed but does not yet cap healing.
- **Depends on:** `patchright-core` (peer), `yaml`, `@tsuuanmi/system-libs`
  (schema registry), and `@tsuuanmi/system-provider-core` (typed failures).
