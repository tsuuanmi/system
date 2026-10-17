---
"@tsuuanmi/system-ui-ops": minor
"@tsuuanmi/system-provider-gemini-web": patch
"@tsuuanmi/system-provider-chatgpt-web": patch
---

A turn empties the composer before it types (`clearText`, `ui-map@1.3`), so an unsent draft a site kept across page loads is never sent with a prompt; a turn that fails after typing and before sending empties it again.
