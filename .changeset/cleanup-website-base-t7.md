---
"@tsuuanmi/system-ui-ops": patch
"@tsuuanmi/system-provider-chatgpt-web": patch
"@tsuuanmi/system-provider-gemini-web": patch
---

Clean-up (PROP-0018 T7): the website drivers share their map loading, the deletion's map entries, the page-idle wait, and the conversation inspection, which `ui-ops` now holds (`shippedMapOf`, `deletionUnverified`, `pageIdle`, `inspectConversationMenu`). No behaviour changes.
