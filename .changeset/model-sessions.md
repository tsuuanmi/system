---
"@tsuuanmi/system-models-core": minor
"@tsuuanmi/system-models": minor
---

Model Workers keep sessions by replaying their transcript (ADR-0031): `ModelRequest.history`, durable session turns, one turn in flight per session, bounds per row or entry (`maxSessionTurns`, `maxHistoryChars`; past one a turn fails, never cut), egress on the history as sent, and `persistent-conversation` proven by the source's conformance. Model Workers can now be team members, carry research's synthesis thread, and continue an `ask`.
