---
"@tsuuanmi/system-workflow": patch
---

A review or verification whose answer lacks its JSON assessment (no JSON, no verdict, no votes) is asked once more for exactly that block, and a second miss fails as `assessment_missing`, no longer `stale_subject`, which stays for a JSON naming another subject or a tree that moved. The scheduled review's two reviewers bind to no git subject, so `verify:1`'s votes are no longer judged as an assessment, and they get the same one re-ask; the verify and scheduled prompts say the JSON block comes last.
