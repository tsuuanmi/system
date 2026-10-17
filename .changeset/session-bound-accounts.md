---
"@tsuuanmi/system-provider-core": minor
"@tsuuanmi/system-browser-patchright": minor
"@tsuuanmi/system-turns": minor
"@tsuuanmi/system-login": minor
"@tsuuanmi/system-provider-gemini-web": minor
"@tsuuanmi/system-mcp-server": minor
---

Session-bound accounts (ADR-0030): a driver may declare `sessionBound`, and its account then does all its work as pages of one persistent context on its own login profile, never from a copied state. Gemini declares it, with its page loads spaced by `pageGapMs` (default 10 s). A remote login reserves the profile, and the account's operations back off as `overloaded` until the login ends. A closed profile's browser must exit (it is stopped after a bound); a browser a crash left on a profile is stopped; health shows a profile that cannot be freed (`login-profiles`).
