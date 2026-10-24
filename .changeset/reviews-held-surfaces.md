---
"@tsuuanmi/system-report": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-web-ui": patch
---

A review held for the operator is shown with when it expires wherever the operator looks, since an unanswered one expires and its task waits for input that nothing revives (T107, T99 D6):
- The report lists the reviews held for the operator as it is made, the soonest to expire first, each with its title, its pending checks, and `expiresAt` (`mcp-report@1.3`, `attention.reviewsHeld`, at most 64, the rest counted in `reviewsHeldOmitted`); its rendering says how long each has left.
- `status` and `system health` carry a `reviews` check (with the board mounted): advice, always ok, naming the first five held for the operator with when each expires and counting the rest, from the tasks of at most 64 projects that are not closed (the rest said). A board that cannot be read makes it down. A client sees the check's name and state only.
- `/ui`: Home's "Waiting for you" and the line above the Reviews say when the first review held for you expires, marked within the hour.
