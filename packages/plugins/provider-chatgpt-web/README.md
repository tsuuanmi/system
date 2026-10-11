# @tsuuanmi/system-provider-chatgpt-web

The **ChatGPT Web provider driver**
([provider turns](../../../docs/design/provider-turns.md),
[UI operations](../../../docs/design/ui-operations.md)).

- **Procedures only.** Every element, action, state, and network signal lives in
  [`ui/chatgpt-web.ui.yaml`](ui/chatgpt-web.ui.yaml), validated as `ui-map@1.0`.
  A UI change is a map change. A local overlay
  (`DriverOptions.overlay`) can add healed candidates.
- **`ask(page, prompt, { conversation, binding })`:**
  - `temporary`: Temporary chat; no binding is kept;
  - `persistent`: a normal chat; returns, and continues, the conversation id
    from `/c/<id>`.
- **Mode guard.** A new conversation starts with **Chat** selected
  (`aria-pressed=true`), never Work, which spends the Codex quota. If Chat
  cannot be selected, nothing is sent.
- **Completion:**
  - running is Stop in the composer's action slot;
  - completion needs the answer's finished marker ("Copy") and stable text, via
    the two-clock `waitForStableCompletion`;
  - the event stream stays open on the live site and is never consulted.
- **`snapshot(page, binding)`:** reopens `/c/<id>` and returns the last answer
  and whether it is still running, for reconciliation. `onBinding` reports a new
  conversation's id as soon as the URL shows it.
- **`checkAuth`:** `signed-in` (composer present), `signed-out` (positive
  evidence: login URL or surface), or `unknown`.
- **Heal audit:**
  - every chosen heal is a `recovery` decision recorded before the click;
  - verified heals are appended to `<DSH_HOME>/system/ui/chatgpt-web.overlay.yaml`
    (0600, with the decision id in a comment);
  - `ui.drift` / `ui.heal` events are logged;
  - healing is off when `ctx.artifacts` is absent.
- **Fixtures:** [`fixtures/fake-chatgpt.ts`](fixtures/fake-chatgpt.ts) is a
  local stand-in built from the live accessibility tree of 2026-10-11, with no
  private data. It reproduces the live traps: a Work default, an open stream,
  and two composer forms. Tests drive it in a real headed Chrome.
- **Live-verified on 2026-10-11:**
  - a Temporary chat answer through this driver;
  - every primary candidate resolving without drift.
- **Modes:**
  - `Config.modes` holds named presets of `{ model, effort }`. The defaults are
    `instant`, `medium` and `high` on **Latest**, and `defaultMode: instant`.
  - The driver selects the model radio and steps the Power slider, then reads
    both back. It fails before sending if a preset, model or level is unknown,
    or if a model is locked.
  - Models seen on 2026-10-12: Latest, GPT-6, GPT-5.6 Sol, GPT-5.5. Power
    levels: Instant, Medium, High.
- **Deep research** (`feature: 'deep-research'`, persistent only): "+" →
  "Deep research" → the mention chip is checked → the prompt goes after the
  chip.
- **Not yet:**
  - Markdown extraction (the answer is returned as text);
  - attachments;
  - observing a live Deep research run to completion.
