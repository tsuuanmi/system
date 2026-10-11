# UI operations: maps, engine, and self-healing

> Target state. Decision: [ADR-0021](../decisions/adr/0021-ui-operations-as-data.md).
> Shape: [`ui-map.v1.json`](../../schemas/ui-map.v1.json). Evidence:
> [research](../research/browser-interaction-and-self-healing.md). Used by the
> provider drivers on [`ctx.browser`](browser-runtime.md).

## How a driver uses a website

A driver procedure is a short sequence of **operation ids**. The engine turns each
id into an element on the page by using the provider's UI map:

```text
driver: submitPrompt(text)                     engine                          UI map (data)
  guard   auth.signed-in                ─▶  evaluate state             ◀─  states.auth.signed-in
  ensure  composer.input                ─▶  resolve → unique element   ◀─  elements.composer.input
  insert  composer.input  text          ─▶  insertText + readback      ◀─  actions.composer.insert
  act     composer.send                 ─▶  resolve, click, verify     ◀─  actions.composer.send
  wait    turn.complete                 ─▶  state machine + network    ◀─  states.turn.complete
  read    turn.assistant.last           ─▶  DOM → Markdown             ◀─  elements.turn.assistant.last
```

The ChatGPT driver's procedures are `checkAuth`, `identity`, `open` (new or bound
conversation, Chat mode, Temporary chat), `selectMode` (model and Power, read
back), `ask` (Deep research tool, insert, send, wait, read), `snapshot`, and
`binding` (URL `/c/<id>`). They hold no selectors. Attachments are not built yet.

## UI map (`ui-map@1.0`)

One YAML file per provider, shipped with the driver package (for example,
`packages/plugins/provider-chatgpt-web/ui/chatgpt-web.ui.yaml`). It is validated
against the JSON Schema at load.

```yaml
schema: ui-map@1.0
provider: chatgpt-web
uiRevision: '2026-10-09'          # when the map was last checked against the live site
locales: [en, vi]                  # localized names are listed per locale
elements:
  composer.form:
    candidates:
      - { css: 'form[data-type="unified-composer"]' }
      - { role: form, name: { en: '^Chat with ChatGPT$' } }
  composer.input:
    scope: composer.form
    candidates:
      - { testId: prompt-textarea }
      - { role: textbox }
    fingerprint: { role: textbox }
  composer.send:
    scope: composer.form
    candidates:
      - { testId: send-button }
      - { role: button, name: { en: '^Send prompt$', vi: '^Gửi lời nhắc$' } }
    fingerprint: { role: button, name: { en: 'send' } }
actions:
  composer.send:
    do: click
    target: composer.send
    require: [enabled]
    fallback: { press: Enter, on: composer.input }
    verify: { anyOf: [{ network: conversation.post }, { countIncreased: turn.user }] }
    sideEffect: irreversible
    heal: deterministic
    timeouts: { resolveMs: 5000, verifyMs: 20000 }
network:
  conversation.post: { method: POST, url: '/backend-api/(f/)?conversation$' }
  challenge: { header: { name: cf-mitigated, equals: challenge } }
states:
  turn.running: { visible: composer.stop }          # the action slot shows Stop
  turn.idle: { allOf: [{ hidden: composer.stop }, { anyOf: [{ visible: composer.send }, { visible: composer.voice }] }] }
  turn.complete:
    allOf: [{ state: turn.idle }, { visible: turn.assistant.last.actions }, { stableTextMs: 1500, of: turn.assistant.last }]
```

| Field | Meaning |
|---|---|
| `candidates` | ordered locators. Kinds: `testId`, `role` + `name` (a regex per locale), `label`, `text`, and `css`, which comes last. Every kind compiles to a Playwright locator |
| `scope` | another element that must resolve first; the search runs inside it |
| `cardinality` | `one` (default: zero or several matches is a failure, never a guess) or `many` (lists such as turns) |
| `fingerprint` | what the element *is* (role, name keywords, nearby role), used only by the heal matcher |
| `require` | preconditions checked on the resolved element: `visible` (always), `enabled`, `editable` |
| `verify` | the postcondition that proves the action worked. Conditions: `visible`, `hidden`, `countIncreased`, `attr`, `url`, `network`, `anyOf`, `allOf`, `not`, `stableTextMs` |
| `sideEffect` | `none` (reads), `reversible` (opening a menu, choosing a mode: undone by a fresh context), `irreversible` (sending a prompt) |
| `heal` | `off`, `deterministic`, or `model`; capped by the side-effect class (below) |
| `fallback` | a non-locator alternative, such as pressing Enter in the composer |

`uiRevision` and the map's content hash (after the overlay is merged) are recorded
in every heal decision and diagnostic bundle, so a drift can be traced to the
exact map in use.

## Resolution engine

For an element:

1. Check **guards** first: the login surface and challenge states. If either is
   showing, the turn fails as `USER_ACTION`, and no healing is attempted.
2. Resolve the scope, then try the candidates in order on each poll tick, until
   one has **exactly one** visible match or `resolveMs` expires. Shipped
   candidates come before overlay candidates.
3. Check `require` on the match.
4. For an action, run it, then poll `verify` until `verifyMs` expires.
5. If a non-primary candidate won, emit a `system/ui-drift` event. The turn
   still succeeds; the event feeds the health view and `system ui doctor`.

Prompt text is inserted with an insert-text method that does not trigger editor
shortcuts, read back, and compared by hash before sending
([provider turns](provider-turns.md#submission)).

### Network observation

The engine subscribes to `request`, `response`, `requestfinished`, and
`requestfailed` on the turn's page and matches them against the map's `network`
patterns. It only observes; it never sends requests of its own to private
endpoints. Uses:

- **not for running:** on ChatGPT the conversation's event stream stays open
  after the answer is complete, so "running" and "complete" come from the DOM
  ([two-clock completion](provider-turns.md#two-clock-completion));
- **submission evidence:** the conversation POST proves that a send happened,
  which the turn receipt records
  ([reconciliation](provider-turns.md#reconciliation));
- **typed failures:** `cf-mitigated: challenge` is `challenge`, HTTP 413 is
  `invalid_input`, and an SSE `error_code` maps through the map's error table.

## Self-heal

The heal step runs only when every candidate fails, the guards (the map's
`errors` conditions, such as the login surface) are clear, and the operation's
heal policy allows it. An action's `fallback` (for example, Enter in the composer)
runs only when healing is not allowed or finds no confident match, so a heal
can repair the map while the fallback keeps the turn working.

1. **Snapshot.** Take `ariaSnapshot({ mode: 'ai' })` of the operation's scope (or
   the page), which yields `[ref=eN]` references.
2. **Deterministic match.** Score each node against the fingerprint: role
   equality, accessible-name similarity across the locale variants (normalized
   Levenshtein), test-id similarity, and the nearby role. Accept the best node
   only if its score is at least `τ` (default 0.8) and it beats the second best by
   a margin (default 0.15).
3. **Model proposal** (only with `heal: model`, once the `ctx.models` seam
   exists). An **economy-tier** model receives the trimmed snapshot, the
   operation description, and the fingerprint, and returns one ref. It is reached
   only through the seam; no model is named in the map or code (INV-11).
4. **Verify.** Resolve the ref, check that the match is unique, then check the
   role and `require`. Turn it into a durable locator with `normalize()`, run
   the action, and check `verify`.
5. **Record.** Before the healed element is acted on, write a `recovery`
   **decision artifact** (INV-13), decided by `ui-ops.heal.deterministic`. It
   records the operation, the map and snapshot hashes, the top candidate scores,
   and the chosen locator. If the record cannot be written, nothing is clicked.
   A rejected heal is recorded too, with `fail-closed` as its outcome. Heal and
   drift outcomes go to the event log (`ui.heal`, `ui.drift`). Without a
   decision store, healing is off.
6. **Overlay.** On success, append the normalized locator to the provider's
   local overlay with `source: healed`, the decision id, and `verifiedCount`.
   The overlay is `<DSH_HOME>/system/ui/<provider>.overlay.yaml`, owner-only and
   written durably. The shipped map is never modified at run time.

| Side-effect class | Heal allowed | On failed verification |
|---|---|---|
| `none` | deterministic or model | the turn fails with `ui_drift` (`CONFIG_FIX`) |
| `reversible` | deterministic or model | the context is discarded and the turn fails with `ui_drift` |
| `irreversible` | **deterministic only**, never a model | no retry: the receipt goes through reconciliation, since the send may have happened |

## Drift workflow

```text
turn: candidate miss ─▶ heal ok ─▶ overlay + decision + drift event ─▶ turn continues
                     └─ heal fails ─▶ diagnostic bundle + ui_drift (CONFIG_FIX) ─▶ turn fails closed
operator: system ui doctor <provider>
  ├─ opens a signed-in context; resolves every element; dry-runs reversible actions;
  │  checks that irreversible actions resolve without clicking
  ├─ reports per-candidate match counts, overlay entries, and drift events
  └─ system ui overlay export ─▶ a map diff (with fixture updates) for review and a PR
```

The **diagnostic bundle** (saved under the turn's artifacts, classified
`sensitive`) holds:
- match counts for every candidate of every operation the procedure used;
- the scoped ARIA snapshot;
- the page URL;
- the recent network events that matched the map;
- a screenshot, only when the operator opted in.

It never includes cookies or prompt text beyond the prompt's hash.

## Tests

- **Schema:** every shipped map validates against `ui-map.v1.json`.
- **Fixtures:**
  - recorded and sanitized pages under `fixtures/<provider>/*.html` drive the
    engine in a real headed browser;
  - each map edit must keep every fixture green;
  - *drifted* fixtures (renamed test ids, moved buttons, translated labels) prove
    that resolution falls back and that healing finds the right control without
    touching a decoy.
- **Conformance:** the engine features that rely on internal selectors (such as
  `aria-ref=`) are pinned by tests against the locked patchright version.
