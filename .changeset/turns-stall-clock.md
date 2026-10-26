---
"@tsuuanmi/system-turns": patch
"@tsuuanmi/system-provider-core": patch
---

Turns: a turn's deadlines read an injectable clock (`Turns.stallClock`, passed as `deadlines.now` to the drivers' completion wait), so the sign-out-on-a-stall test no longer races a wall-clock stall against a browser reload.
