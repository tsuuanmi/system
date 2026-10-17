# @tsuuanmi/system-provider-chatgpt-web

The **ChatGPT Web provider driver**
([provider turns](../../../docs/design/provider-turns.md),
[UI operations](../../../docs/design/ui-operations.md)).

- **Procedures only.** Every element, action, state, and network signal lives in
  [`ui/chatgpt-web.ui.yaml`](ui/chatgpt-web.ui.yaml), validated as `ui-map@1.1`.
  A UI change is a map change. A local overlay (`Config.overlayPath`, default
  `<DSH_HOME>/system/ui/chatgpt-web.overlay.yaml`) adds healed candidates.
- **`ask(page, prompt, { conversation, binding, mode, feature })`:**
  - `temporary`: Temporary chat; no binding is kept;
  - `persistent`: a normal chat; returns, and continues, the conversation id
    from `/c/<id>`.
- **Challenge and unreadable pages.** A challenge page ("Verify you are human", a Cloudflare
  challenge frame or path: `auth.challenge`) is `challenge`: the turn stops at once and the turn
  runtime marks the account `challenge`. A page that shows neither the composer nor a sign-in
  page in time is outlined as a `ui.drift` of `composer.input` (`system evidence`) and fails the
  turn once as `ui_drift`, never as a session to retry.
- **A stalled answer** (`provider_stalled`, or a deadline) is outlined as it
  stands: event `provider.stall`, with the page's structure as local-private
  evidence, its `visibilityState`, focus, and path. It is never retried from the
  driver.
- **Logged-out home.** When the session ends, ChatGPT may show its anonymous home instead of the
  login page: the app shell with a logged-out composer and sign-in buttons whose names vary
  (`auth.logged-out-home`). Visible, with no `composer.input`, for 3 s, it is signed out
  (`reauth_required`). The hold exists because a signed-in app may paint that shell before it
  loads its session, and a false sign-out takes the operator to undo. The login page is signed
  out at once.
- **Mode guard.** A new conversation starts with **Chat** selected
  (`aria-pressed=true`), never Work, which spends the Codex quota. If Chat
  cannot be selected, nothing is sent.
- **Completion:**
  - running is Stop in the composer's action slot;
  - completion needs the answer's finished marker ("Copy") and stable text, via
    the two-clock `waitForStableCompletion`;
  - the event stream stays open on the live site and is never consulted.
- **`deleteConversation(page, binding)`** (PROP-0004 Phase 5; `deletes`:
  `chat`, `web-search`; Deep research waits for its live check): opens
  `/c/<id>` and clicks nothing unless the page is at exactly that path and shows
  a prompt (otherwise `ui_drift`, nothing deleted). The path is checked again
  before each click: **Open conversation options** in the conversation's pane (`conversation.pane`, never a history row) → **Delete** → **Delete
  chat?** → **Delete** (the request `PATCH /backend-api/conversation/<id>` is
  the postcondition). After the site leaves the URL, the chat is reopened and
  counts as `deleted` only when it shows that it no longer exists (map element
  `conversation.missing`); one that already shows it, on two loads in a row, is
  `gone`, with nothing clicked. While it runs, no deletion request leaves the
  page unless it is `PATCH /backend-api/conversation/<id>` hiding this chat,
  `beforeConfirm` lets the ledger record the confirm first, and `confirmed` only
  checks a chat whose confirm was recorded. The map entries are not yet verified live: they are marked `unverified`, and `deletionUnverified()` names them, so the turn runtime deletes nothing until the live check lifts them.
- **`inspectConversation(page, binding)`:** read-only evidence for those
  entries: the chat's page and its own menu outlined (structure, never text),
  the menu closed with Escape, no item chosen.
- **Feature probe (REQ-PRV-7):** `probeFeatures` opens a new chat's "+" tools
  popover and reports which known entries it offers: Deep research, Web
  search, and Create image. Then it closes the popover, sending nothing. A
  `web-search` turn picks Web search, and its pill
  (`chatgpt-system-hint://search`) is verified in the composer.
- **The answer is Markdown (REQ-PRV-5).**
  - The finished answer's own Copy button gives the Markdown. It is read from
    the clipboard and kept only if its words are the rendered answer's words,
    since the clipboard may be shared. Otherwise the rendered text stands, read
    under `white-space: pre-wrap`.
  - Copy rebuilds code blocks from the page and loses their line breaks, so
    each fenced block's text comes from its rendered element (`answer.code`).
  - Emphasis and a fence's language do not come back, which matches the
    rendered answer.
- **`snapshot(page, binding)`:** reopens `/c/<id>` and returns the last answer
  and whether it is still running, for reconciliation. `onBinding` reports a new
  conversation's id as soon as the URL shows it.
- **`signIn(page, credentials, code)`:** the credential sign-in state machine,
  driven by the map's `login.*` elements. The email page was verified live; the
  password, code, and method-choice steps follow the reference repositories and
  are **not yet verified live**. A challenge stops it, and so does a third code.
- **`checkAuth`:** `signed-in` (composer present), `signed-out` (positive
  evidence: the login URL, or a login control with no composer; a "Log in"
  control beside a working composer is not), or `unknown`.
- **Heal audit:**
  - every chosen heal is a `recovery` decision recorded before the click;
  - verified heals are appended to the overlay (0600, with the decision id in a
    comment);
  - `ui.drift` / `ui.heal` events are logged; a drift event names its region's
    outline, kept as local-private evidence
    ([drift evidence](../../../docs/design/ui-operations.md#drift-evidence));
  - healing is off when `ctx.artifacts` is absent.
- **Fixtures:** [`fixtures/fake-chatgpt.ts`](fixtures/fake-chatgpt.ts) is a
  local stand-in built from the live accessibility tree of 2026-10-11, with no
  private data. It reproduces the live traps: a Work default, an open stream,
  and two composer forms. Tests drive it in a real headed Chrome.
- **Modes:**
  - `Config.modes` holds named presets of `{ model, effort }`. The defaults are
    `instant`, `medium` and `high` on **Latest**, and `defaultMode: instant`.
  - The model menu has two views: Power first, then the model list behind the
    view toggle. The driver steps the Power slider, switches to the model list,
    picks the radio, and reads both back. It fails before sending if a preset,
    model or level is unknown, or if a model is locked.
  - An account without a model picker (such as ChatGPT Free) has no preset:
    the driver fails the turn as `ui_drift` and sends nothing. PROP-0004
    removed the empty `site` preset; such an account is
    [removed](../../../docs/operations/runbooks.md#remove-the-free-chatgpt-account).
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
- **Snapshot** (reconciliation) needs positive evidence. A page that has not
  rendered a user turn within `snapshotMs` (20 s) is not observed. The last
  user turn is reported as `lastPrompt`, so a prompt the page already shows is
  never resent. For Deep research only the run after the last prompt counts.
- **Live checks:** what was verified on the live site, and when, is in the
  [release checklist](../../../docs/validation/release-checklist.md).
- **Config:** `origin`, `overlayPath`, `modes`, `defaultMode`.
- **Injects:** `providers`. It uses `artifacts` and `eventLog` when present,
  for the heal audit.
- **Not yet:**
  - attachments;
  - Deep research options (sources, apps) beyond the default run.
