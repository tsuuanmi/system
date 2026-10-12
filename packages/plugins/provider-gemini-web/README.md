# @tsuuanmi/system-provider-gemini-web

The **Gemini Web** provider driver (`gemini-web`), registered on
`ctx.providers`. Like the ChatGPT driver, its operations are data: a UI map,
[`ui/gemini-web.ui.yaml`](ui/gemini-web.ui.yaml)
([ADR-0021](../../../docs/decisions/adr/0021-ui-operations-as-data.md)).

- **Sign-in:**
  - `checkAuth` is `signed-in` when the Google Account control is visible, and
    `signed-out` on Google's sign-in page or a visible "Sign in" entry.
  - `identity` reads the account from that control's name, and only its hash
    is stored.
  - Accounts are signed in with `system account login <id>` (remote desktop),
    then saved encrypted, as for ChatGPT.
- **Not yet:** conversations. The driver proves no routing capability, so no
  Worker serves work from it, and `ask` fails closed with `config_error`.
