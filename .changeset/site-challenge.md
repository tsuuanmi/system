---
"@tsuuanmi/system-provider-gemini-web": patch
"@tsuuanmi/system-turns": patch
---

Google's unusual-traffic check (a reCAPTCHA) is recognised as a challenge: the turn stops at once and the account is marked `challenge`, so nothing loads the site again until the operator passes it; a Gemini page that is neither signed in nor signed out fails once instead of three times.
