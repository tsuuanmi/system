---
"@tsuuanmi/system-provider-gemini-web": patch
---

Gemini: a reopened conversation's last prompt is read again until its text shows (within `snapshotMs`), so a bubble that renders before its text no longer makes reconciliation see the conversation as unobserved.
