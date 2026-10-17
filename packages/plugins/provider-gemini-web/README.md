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
- **Input limit:** a prompt over `maxPromptChars` (default 30,000 characters)
  is refused as `invalid_input` before anything is sent. The site publishes no
  limit; it drops a longer paste without an error (observed live on
  2026-10-16). A prompt the site empties from the composer without asking is
  `input_dropped`, not UI drift.
- **A bound conversation the site no longer has** (it sends the page to
  `/app`) is `conversation_lost`: reopening it cannot help, so it is not
  retried.
- **Modes.** A preset names a model and a thinking level as the site names
  them. The mode is chosen **before** the prompt is typed: a long prompt grows
  the composer around the picker (live 2026-10-17, when a review's 26,000
  characters made `mode.open` miss its postcondition). A menu or dialog left
  open is closed with Escape before the picker is clicked. The mode menu holds both, and the chosen items are marked `selected`.
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
- **`deleteConversation(page, binding)`** (PROP-0004 Phase 5; `deletes`:
  `chat`, Deep research waits for its live check): opens `/app/<id>` and
  clicks nothing unless the page is at exactly that path and shows a prompt
  (otherwise `ui_drift`, nothing deleted). The path is checked again before each
  click: the chat's own menu (in its pane, `conversation.pane`, never a history row) → **Delete** → **Delete chat?** → **Delete**. After
  the site leaves the URL, the chat is reopened and counts as `deleted` only
  when it shows that it no longer exists (map element `conversation.missing`);
  one that already shows it, on two loads in a row, is `gone`, with nothing clicked. While it runs, from the first click on, no RPC request leaves the page if any of its calls names a chat but this one (`namesOnly`), `beforeConfirm` lets the ledger record the confirm first, and `confirmed` only checks a chat whose confirm was recorded. The map entries
  are not yet verified live: they are marked `unverified`, and `deletionUnverified()` names them, so the turn runtime deletes nothing until the live check lifts them.
- **`inspectConversation(page, binding)`:** read-only evidence for those
  entries: the chat's page and its own menu outlined (structure, never text),
  the menu closed with Escape, no item chosen.
- **Feature probe (REQ-PRV-7):** `probeFeatures` opens a new normal chat's tools
  and more tools, reports Deep research if offered, and sends nothing.
- **Sign-in:**
  - `checkAuth` is `signed-in` when the Google Account control is visible, and
    `signed-out` on Google's sign-in page, or with a visible "Sign in" entry and
    no account control (a "Sign in" offer beside the account is still signed in).
  - `identity` reads the account from that control's name; only its hash is
    stored.
  - Accounts are signed in with `system account login <id>` (remote desktop),
    then saved encrypted, as for ChatGPT.
- **Readiness:** pages get 60 s to render, since the live app took over 30 s
  several times. A conversation that does not open in time fails before
  sending, or is reported as not observed. A page that shows neither the
  signed-in account nor a sign-in page in time (a dialog or interstitial, say)
  is outlined as a `ui.drift` of `auth.account`, so `system evidence` shows what
  it showed instead, and fails the turn as `ui_drift` once (never three retries
  of 60 s on the same account). Google's unusual-traffic check (a form holding a
  reCAPTCHA, `auth.challenge`, seen live on 2026-10-16) is `challenge`: the turn
  stops at once, and the turn runtime marks the account `challenge`. So is a
  notice of updated terms over the input (`site.terms-notice`, seen live on
  2026-10-17), which covers the textbox and the mode switcher: it is never
  clicked, and the operator acknowledges it in the login profile.
- **The site's own error as an answer** (`answer.site-error`, live 2026-10-17: "I seem to be
  encountering an error. Can I try something else for you?"), read only in a short answer, fails
  the turn as `overloaded` before any acceptance judges it. The prompt was sent, so it is not
  resent ([INV-4](../../../docs/architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay)).
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
  - a Deep research plan that already has Copy, and its Start research turn;
  - a chat's own menu, its "Delete chat?" dialog, and a deleted chat's
    "Unable to load" notice (`deleted` records each deletion).
  - a terms notice over the input (`termsNotice`, from the live outline of
    2026-10-17).

  Tests drive it in a real headed Chrome.
- **Live checks:** what was verified on the live site, and what is verified
  on the fake site only, is in the
  [release checklist](../../../docs/validation/release-checklist.md).
- **Session-bound** ([ADR-0030](../../../docs/decisions/adr/0030-session-bound-accounts-use-their-login-profile.md)).
  On 2026-10-16, copies of a Gemini session died within a minute while the login
  profile stayed signed in. So the driver declares `sessionBound`, and every
  operation of a Gemini account runs as a page of its own login profile.
  `pageGapMs` (default 10 s, at most 10 min) spaces the **opens** of the
  account's pages. Navigations within a page are not spaced.
- **Drafts.** The composer is emptied (`composer.clear`) before a turn chooses
  anything or types, so an unsent draft the site kept across page loads (Gemini in
  a login profile, live 2026-10-17) never goes with a prompt. A turn that fails
  after typing and before sending empties it again.
- **A stalled answer** (`provider_stalled`, or a deadline) is outlined as it
  stands: event `provider.stall`, with the page's structure as local-private
  evidence, its `visibilityState`, focus, and path. It is never retried from the
  driver.
- **Kept tabs.** A page that already shows the bound conversation is not loaded
  again, and its sign-in is checked as it is. `pageIdle` (map state `page.idle`:
  nothing generating, no `page.overlay` dialog or menu) tells the turn runtime it
  may keep the page for the session's next turn.
- **Config:** `origin`, `modes`, `defaultMode`, `maxPromptChars`, `pageGapMs`.
- **Injects:** `providers`.
