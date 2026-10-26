---
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-web-ui": minor
---

Auto-accept never accepts a result whose browser tests did not run (T255, a T247 follow-up; D80, ADR-0067):
- The workflow engine's acceptance keeps, with each check result it records (`outcome.detail.checkRun.results`), what the check's command reported it did not run (`notRun`).
- The board's auto-accept rule takes a passed check with `notRun` as a condition not met: the result is held for the lead or the operator, and the hold's decision says "checks passed, browser tests not run", naming the check and what did not run. A pass without `notRun` is accepted as before.
- /ui shows such a check as "Passed, browser tests not run" in warning color, with what did not run, and the review card says "Checks passed, browser tests not run".
