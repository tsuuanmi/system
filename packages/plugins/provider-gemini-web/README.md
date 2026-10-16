# @tsuuanmi/system-provider-gemini-web

The **Gemini Web provider driver** (`gemini-web`), registered on
`ctx.providers` ([provider turns](../../../docs/design/provider-turns.md),
[UI operations](../../../docs/design/ui-operations.md)). Like the ChatGPT
driver, its operations are data: a UI map,
[`ui/gemini-web.ui.yaml`](ui/gemini-web.ui.yaml)
([ADR-0021](../../../docs/decisions/adr/0021-ui-operations-as-data.md)).

- **What it proves:** `reason` and `persistent-conversation`, plus the account
  feature `deep-research` once `probeFeatures` finds it.
- **`ask(page, prompt, { conversation, binding })`:** every turn runs on the
  **Chat** tab, never **Spark** (the agent). If Chat cannot be made active,
  nothing is sent.
  - `temporary`: a new Temporary chat. It has no pressed state, so only its
    notice ("… don't appear in recent chats …") counts as proof, checked again
    right before sending. No binding is kept.
  - `persistent`: a normal chat. It returns, and continues, the conversation id
    from `/app/<id>`. `onBinding` reports a new conversation's id as soon as the
    URL shows it, and a conversation that does not open at its URL fails.
- **Modes.** A preset names a model and a thinking level as the site names
  them. The mode menu holds both, and the chosen items are marked `selected`.
  - A model may be named without its version: `Flash` matches `3.8 Flash` and
    never `3.5 Flash-Lite`.
  - An item's note may follow its name on the same line (`Medium Balanced
    depth`) or on its own line; the name is matched either way.
  - An item in a submenu (the thinking levels, under "Thinking level", since
    2026-10-16; map element `mode.submenu`) is reached by opening it first, to
    choose and to read back. One that still cannot be reached is reported as
    drift, with evidence, and fails the turn as `ui_drift` before sending.
  - Both are read back before sending, and the read-back (with the version) is
    the turn's mode. An item the account does not offer fails closed
    (`config_error`).
  - Shipped presets: `flash-lite` (Flash-Lite, Low), `flash` (Flash, Medium;
    the default), `pro` (Pro, High), and the empty `site` for an account
    without the picker.
- **Deep research** (normal chats only; Temporary chat does not offer it):
  - It is chosen under Upload & tools → More tools, and its chip proves it.
  - A reopened Deep research conversation keeps it chosen: a plain turn there
    clears the chip first (or sends nothing), and a Deep research follow-up
    keeps it, since choosing its checkbox again would turn it off.
  - Its first reply is a plan, which already has Copy. The driver clicks
    **Start research**, which the site records as a user turn of its own.
  - The research card goes from `processing` to `completed`. The report is read
    from the report panel, followed by a `Sources:` list of the sources it used.
  - A reply without a plan is a clarifying question, returned as the answer.
- **Completion:** the answer is the last `model-response`. It is running while
  "Stop response" shows or its own Copy is missing, and done on stable text
  (two-clock `waitForStableCompletion`).
- **The answer is Markdown (REQ-PRV-5).** The answer's Copy gives Markdown with
  code indentation intact (`UiEngine.copied`). It is kept only if its words are
  the rendered answer's words (`sameWords`); otherwise the rendered text
  stands. Copy adds a blank line before each closing fence, which is dropped.
- **`snapshot(page, binding)`:** reopens `/app/<id>` for reconciliation. Only
  positive evidence counts: a conversation that does not open there, renders no
  prompt, or shows a prompt it cannot read is not observed. For Deep research,
  only research after the last prompt counts, never its plan.
- **Feature probe (REQ-PRV-7):** `probeFeatures` opens a new normal chat's tools
  and more tools, reports Deep research if offered, and sends nothing.
- **Sign-in:**
  - `checkAuth` is `signed-in` when the Google Account control is visible, and
    `signed-out` on Google's sign-in page or a visible "Sign in" entry.
  - `identity` reads the account from that control's name; only its hash is
    stored.
  - Accounts are signed in with `system account login <id>` (remote desktop),
    then saved encrypted, as for ChatGPT.
- **Readiness:** pages get 60 s to render, since the live app took over 30 s
  several times. A conversation that does not open in time fails before
  sending, or is reported as not observed.
- **No self-heal.** A drifted element fails closed until the map is updated. A
  stale element is logged as `ui.drift`, naming its region's outline, kept as
  local-private evidence
  ([drift evidence](../../../docs/design/ui-operations.md#drift-evidence)).
- **Fixtures:** [`fixtures/fake-gemini.ts`](fixtures/fake-gemini.ts) is a local
  stand-in built from the signed-in page read live on 2026-10-12, with no
  private data. It reproduces the live traps:
  - a Spark start, and a Temporary chat with no pressed state;
  - a mode menu that closes on each choice, and a prompt heading that repeats
    the prompt shortened;
  - a Deep research plan that already has Copy, and its Start research turn.

  Tests drive it in a real headed Chrome.
- **Live checks:** what was verified on the live site, and what is verified
  on the fake site only, is in the
  [release checklist](../../../docs/validation/release-checklist.md).
- **Config:** `origin`, `modes`, `defaultMode`.
- **Injects:** `providers`.
