---
"@tsuuanmi/system-provider-core": minor
"@tsuuanmi/system-provider-gemini-web": patch
"@tsuuanmi/system-login": patch
---

Gemini: an account can be saved while the page hides its account button (a collapsed side panel, live 2026-10-26). `identity()` reads the account from that button, shown or hidden, by the map's own `auth.account` candidates and only from a name that starts "Google Account:". Hidden buttons are read only when no candidate shows any match: two shown buttons, or hidden ones naming more than one account, are ambiguous and name no one (a `ui.drift`, nothing saved). The masking of drift outlines reads the same buttons, hidden ones included, and masks every account any of them names, also when they are ambiguous and name no one. A Save's sign-in check (`checkAuth(page, { save: true })`, which `ctx.login.save` passes) counts the hidden, named button as signed in, also beside a "Sign in" offer. A page that names no account is still a `ui.drift` of `auth.account` and is `unknown`, and nothing is saved. A turn's check still needs the button shown.
