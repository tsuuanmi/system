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
- **Input limit:** the Workers declare `maxPromptChars` (default 30,000
  characters) as their `maxInputChars`, so admission routes a longer prompt
  elsewhere or fails it unsent
  ([ADR-0032](../../../docs/decisions/adr/0032-admission-refuses-input-longer-than-a-worker-takes.md)).
  The driver still refuses one as `invalid_input` before anything is sent, counting characters
  (code points) as admission does, so the two never disagree. The site publishes no
  limit; it drops a longer paste without an error (observed live on
  2026-10-16): the bound is the site's, not the code's, and raising it only turns a refusal into
  a dropped prompt. A prompt the site empties from the composer without asking is
  `input_dropped`, not UI drift; its message says to lower `maxPromptChars` when the prompt was
  near it ([runbook](../../../docs/operations/runbooks.md#a-review-member-fails-on-a-website)).
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
  - The turn's own preset never applies (live on 2026-10-18 three runs that
    chose Pro and High with it got the site's own error at once). Only the
    plugin's `researchMode` does, when set: that preset is chosen after the tool,
    so the read-back is what is sent, and is the turn's mode. A thinking level
    the menu does not show with Deep research chosen is skipped, with no drift,
    and the mode has no level. Unset (the shipped default), the picker is left
    as the site has it, as a user who picks the tool does, and the mode is
    recorded as the site's (no model or thinking level).
  - A reopened Deep research conversation keeps it chosen: a plain turn there
    clears the chip first (or sends nothing), and a Deep research follow-up
    keeps it, since choosing its checkbox again would turn it off.
  - Its first reply is a plan, which already has Copy. The driver clicks
    **Start research**, which the site records as a user turn of its own.
  - The site can leave the plan unrendered in the page that sent it (live
    2026-10-19: a few words for 30 min, the plan there after a reload). A first
    reply that stands still for `planHangMs` (3 min) with no plan is outlined
    (`provider.stall`, phase `research-plan`), its conversation is loaded once
    more, which resends nothing (event `provider.reload`), and the reply is then
    waited for as any reply, within what is left of the turn.
  - The research card goes from `processing` to `completed`. The report is read
    from the report panel, followed by a `Sources:` list of the sources it used.
  - While it works, the panel's thinking (`research.activity`) grows; that growth
    is progress, so a run that keeps working past the stall deadline is not
    taken for a stall (live 2026-10-18). The turn's hard deadline still bounds it.
    Each poll reads it at once and never waits for it: a panel gone since it was
    found (its report took its place) is no activity for that poll.
  - A reply without a plan is a clarifying question, returned as the answer.
- **Completion:** the answer is the last `model-response`. It is running while
  "Stop response" shows or its own Copy is missing, and done on stable text
  (two-clock `waitForStableCompletion`).
  - A thinking mode shows its thinking in the answer before any answer text (a
    summary that changes as it thinks). Any change of what the whole answer shows
    (read at once each poll, as a digest; a failed read keeps the last one) is
    progress, so a long think past the stall deadline is not taken for a stall
    (live 2026-10-23: a review member's answer on the standard tier failed
    `provider_stalled` at five minutes). Its digits are left out of the digest,
    so a count that only goes up (a timer, "Thinking for 12s") is no progress; the
    answer's text is read apart, digits and all. The whole answer is read, not
    a named part of it, since the live thinking summary's element is not known.
    A think whose answer shows nothing new but numbers still stalls, and the
    turn's hard deadline bounds every answer. Verified on
    the fake site only: whether the live thinking summary changes while
    collapsed is a [release check](../../../docs/validation/release-checklist.md).
- **The answer is Markdown (REQ-PRV-5).** The answer's Copy gives Markdown with
  code indentation intact (`UiEngine.copied`). It is kept only if its words are
  the rendered answer's words (`sameWords`); otherwise the rendered text
  stands, and the refused Copy is logged as counts only (event
  `provider.copy-refused`). Copy adds a blank line before each closing fence, which is dropped.
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
  one that already shows it, on two loads in a row, is `gone`, with nothing clicked. While it runs, from the first click on, no RPC request leaves the page if any of its calls names a chat but this one, or its calls cannot be read (`namesOnly`), `beforeConfirm` lets the ledger record the confirm first, and `confirmed` only checks a chat whose confirm was recorded. The map entries
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
    Google's traffic check and a terms notice come first: each is `challenge`
    whether or not the account shows (Readiness, below).
  - `identity` reads the account from that control's name; only its hash is
    stored.
  - Accounts are signed in with `system account login <id>` (remote desktop),
    then saved encrypted, as for ChatGPT.
- **Readiness:** pages get 60 s to render, since the live app took over 30 s
  several times.
  - The wait ends at the first thing the page shows of itself: the account, a
    sign-in page, Google's unusual-traffic check, a terms notice, or the app (its
    composer or a conversation's turns, map state `page.rendered`). Once the app
    has rendered, the account gets `accountMs` more (15 s), never the whole 60 s:
    the Google bar that holds it comes before the app in the page (live
    2026-10-24, a new chat that rendered and never showed its account was waited
    on for 60 s).
  - A conversation that does not open in time fails before sending, or is
    reported as not observed.
  - A page that shows neither the signed-in account nor a sign-in page in time is
    outlined as a `ui.drift` of `auth.account`, with the page's path and what
    each candidate found (`matches`: the button on the page but hidden, or gone),
    so `system evidence` and the event show what it showed instead. It fails the
    turn as `ui_drift` once (never three retries of 60 s on the same account),
    saying whether the app rendered, whether the account's button is there but
    hidden, whether a dialog or menu is open, and where a bound conversation's
    page went instead.
  - Google's unusual-traffic check (a form holding a reCAPTCHA, `auth.challenge`,
    seen live on 2026-10-16) is `challenge`: the turn stops at once, and the turn
    runtime marks the account `challenge`.
  - So is a notice of updated terms over the input (`site.terms-notice`: "Keep in
    mind", with its own "Got it", seen live on 2026-10-16, 2026-10-17, and twice
    on 2026-10-24), which covers the textbox and the mode switcher: it is never
    clicked, and the operator acknowledges it in the login profile. It is looked
    for before the account, so a notice that shows while the account does not
    resolve (live 2026-10-16) is the operator's at once, never drift after 60 s.
    One that appears mid-session (on a kept page, or under a turn that failed
    there, which the turn runtime checks again) is the same `challenge`.
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
  - a terms notice over the input (`termsNotice`, "Keep in mind", from the live
    outlines of 2026-10-16 and 2026-10-17); its markup is exported
    (`TERMS_NOTICE`), so a test shows it on a page already open, as mid-session;
  - an account button in the page but hidden (`accountHidden`), as the live
    page's did not resolve on 2026-10-24.
  - a thinking answer (`thinkMs`): Stop shown and the `model-response` there with
    no text, its thinking summary (`model-thoughts`) changing its words every
    400 ms, or, with `thoughts: false`, nothing in it changing; with
    `thinkTimer`, a "Thinking for Ns" count beside it either way.

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
- **Config:** `origin`, `modes`, `defaultMode`, `researchMode`, `maxPromptChars`, `pageGapMs`.
- **Injects:** `providers`. It uses `eventLog` and `artifacts` when present, for
  its `ui.drift`, `provider.stall`, `provider.reload`, and `provider.copy-refused`
  events and their evidence.
