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
- **`checkAuth`:** `signed-in` (composer present), `signed-out` (positive
  evidence: login URL or surface), or `unknown`.
- **Fixtures:** [`fixtures/fake-chatgpt.ts`](fixtures/fake-chatgpt.ts) is a
  local stand-in built from the live accessibility tree of 2026-10-11, with no
  private data. It reproduces the live traps: a Work default, an open stream,
  and two composer forms. Tests drive it in a real headed Chrome.
- **Live-verified on 2026-10-11:**
  - a Temporary chat answer through this driver;
  - every primary candidate resolving without drift.
- **Not yet:**
  - Markdown extraction (the answer is returned as text);
  - model and effort selection, Deep Research, and attachments;
  - registration on the `ctx.providers` seam.
