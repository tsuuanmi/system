---
"@tsuuanmi/system-display-virtual": patch
---

Xvfb's startup holds on a loaded host (T340): the real-Xvfb specs failed about 1 run in 5 with "startup timed out".
- `startupTimeoutMs` now defaults to 30 s (was 5 s), per try.
- A startup that only timed out is tried once more before it is reported unavailable; a missing binary, an exit before ready, or a bad display number is reported at once, as before.
