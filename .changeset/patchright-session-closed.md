---
"@tsuuanmi/system-browser-patchright": patch
---

The daemon no longer exits when a browser closes, or its display is lost, just after it opened a page. The browser library set up a new page's request interception without waiting for it, and when the page's session closed first, the rejection had no handler; the `dsh` launcher exits on any unhandled rejection. The library is patched to handle that rejection (`patches/patchright-core@1.63.0.patch`).
