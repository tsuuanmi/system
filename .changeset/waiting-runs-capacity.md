---
"@tsuuanmi/system-workflow": minor
---

A run that only waits on an approval or a tie's vote no longer counts against `maxActiveRuns`, so it cannot keep unrelated work out. Such runs have their own bound, `maxWaitingRuns` (default 16); a refusal says which bound was hit.
