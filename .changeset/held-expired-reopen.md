---
"@tsuuanmi/system-web-ui": minor
---

"Held for you" lists the results whose review expired unseen (`review-expired`), within their wait for input, after the held ones, marked expired with when they expired and until when they can be reopened; past that wait they are gone as before. **Accept** on an expired row reopens it first (`POST reviews/<taskId>/reopen`, the operator's only, on the exact result shown) and then sends the same acceptance as a held result's, each recorded as its own decision. A lead's token is shown no expired result, cannot reopen one, and still cannot accept a heavy result.
