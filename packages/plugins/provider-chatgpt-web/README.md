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
- **The answer is Markdown (REQ-PRV-5).**
  - The finished answer's own Copy button gives the Markdown. It is read from
    the clipboard and kept only if its words are the rendered answer's words,
    since the clipboard may be shared. Otherwise the rendered text stands, read
    under `white-space: pre-wrap`.
  - Copy rebuilds code blocks from the page and loses their line breaks, so
    each fenced block's text comes from its rendered element (`answer.code`).
  - Verified live on 2026-10-12: headings, lists, links, inline code, and code
    blocks with their indentation came back. Emphasis and a fence's language
    did not, which matches the rendered answer.
- **`snapshot(page, binding)`:** reopens `/c/<id>` and returns the last answer
  and whether it is still running, for reconciliation. `onBinding` reports a new
  conversation's id as soon as the URL shows it.
- **`signIn(page, credentials, code)`:** the credential sign-in state machine,
  driven by the map's `login.*` elements. The email page was verified live; the
  password, code, and method-choice steps follow the reference repositories and
  are **not yet verified live**. A challenge stops it, and so does a third code.
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
  - The model menu has two views (checked live on 2026-10-12): Power first,
    then the model list behind the view toggle. The driver steps the Power
    slider, switches to the model list, picks the radio, and reads both back. It fails before sending if a preset, model or level is unknown,
    or if a model is locked.
  - Models seen on 2026-10-12: Latest, GPT-6, GPT-5.6 Sol, GPT-5.5. Power
    levels: Instant, Medium, High.
- **Deep research** (`feature: 'deep-research'`, persistent only):
  - "+" → "Deep research" → the mention chip is checked → the prompt goes after
    the chip;
  - the acknowledgement is skipped. The driver reads only the run of this
    prompt: the last `research.host` (the embedded app frame) after the last
    user turn, and the frames nested in it. A session can hold several runs;
  - `research.running` / `research.completed` are resolved inside those frames.
    The report is the container of the report's title (`research.report-title`,
    the live layout of 2026-10-12);
  - citation links are appended as a `Sources:` list (label and URL), because
    rendered text keeps only the link labels;
  - a completed report that stays unreadable for `reportReadMs` (30 s) fails as
    `ui_drift`, not by waiting out the stall deadline;
  - a reply with no frame within `researchStartMs` is a clarifying question.
  - Live-verified on 2026-10-12, including the layout change found that day.
- **Snapshot** (reconciliation) needs positive evidence. A page that has not
  rendered a user turn within `snapshotMs` (20 s) is not observed. The last
  user turn is reported as `lastPrompt`, so a prompt the page already shows is
  never resent. For Deep research only the run after the last prompt counts.
- **Not yet:**
  - Markdown extraction (the answer is returned as text);
  - attachments;
  - Deep research options (sources, apps) beyond the default run.
