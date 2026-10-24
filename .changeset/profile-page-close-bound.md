---
"@tsuuanmi/system-browser-patchright": patch
---

Closing a page of a login profile now waits at most 5 s for the browser to confirm it. If a close lands while the page's navigation commits, Chrome acknowledges it and then drops it, and the tab stays open. The turn that ended there used to wait for that close forever. A cancelled turn held its account's slot, and a runtime stop hung until it timed out. The tab now closes with its context.
