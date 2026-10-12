# @tsuuanmi/system-provider-gemini-web

The **Gemini Web provider driver** (`gemini-web`), registered on
`ctx.providers` ([provider turns](../../../docs/design/provider-turns.md),
[UI operations](../../../docs/design/ui-operations.md)). Like the ChatGPT
driver, its operations are data: a UI map,
[`ui/gemini-web.ui.yaml`](ui/gemini-web.ui.yaml)
([ADR-0021](../../../docs/decisions/adr/0021-ui-operations-as-data.md)).

- **What it proves: `reason`, through Temporary-chat turns.**
  - `ask(page, prompt, { conversation: 'temporary' })` opens `/app`, makes the
    **Chat** tab the active one (never **Spark**, the agent), and turns on
    Temporary chat. Temporary chat has no pressed state, so only its notice
    ("… don't appear in recent chats …") counts as proof.
  - Chat and Temporary chat are checked again right before sending. If either
    is missing, nothing is sent.
  - Persistent conversations and site features (Deep research) are not proven:
    a persistent or feature turn is refused (`invalid_input`), there is no
    `snapshot`, and no session is routed here.
- **Modes.** A preset names a model and a thinking level as the site names
  them. The mode menu holds both, and the chosen items are marked `selected`.
  - A model may be named without its version: `Flash` matches `3.8 Flash` and
    never `3.5 Flash-Lite`.
  - Both are read back before sending, and the read-back (with the version) is
    the turn's mode. An item the account does not offer fails closed
    (`config_error`).
  - Shipped presets: `flash-lite` (Flash-Lite, Low), `flash` (Flash, Medium;
    the default), `pro` (Pro, High), and the empty `site` for an account
    without the picker.
- **Completion:** the answer is the last `model-response`. It is running while
  "Stop response" shows or its own Copy is missing, and done on stable text
  (two-clock `waitForStableCompletion`).
- **The answer is Markdown (REQ-PRV-5).** The answer's Copy gives Markdown with
  code indentation intact (`UiEngine.copied`). It is kept only if its words are
  the rendered answer's words (`sameWords`); otherwise the rendered text
  stands. Copy adds a blank line before each closing fence, which is dropped.
- **Sign-in:**
  - `checkAuth` is `signed-in` when the Google Account control is visible, and
    `signed-out` on Google's sign-in page or a visible "Sign in" entry.
  - `identity` reads the account from that control's name; only its hash is
    stored.
  - Accounts are signed in with `system account login <id>` (remote desktop),
    then saved encrypted, as for ChatGPT.
- **No self-heal.** A drifted element fails closed until the map is updated.
- **Fixtures:** [`fixtures/fake-gemini.ts`](fixtures/fake-gemini.ts) is a local
  stand-in built from the signed-in page read live on 2026-10-12, with no
  private data. It reproduces the live traps: a Spark start, a Temporary chat
  with no pressed state, and a menu that closes on each choice. Tests drive it
  in a real headed Chrome.
- **Live-verified on 2026-10-12** through `system ask`:
  - economy read back `3.5 Flash-Lite` / `Low`, and frontier `3.1 Pro` / `High`;
  - a frontier answer came back as Markdown, with a heading, bold list items,
    and an indented Python block.
