---
"@tsuuanmi/system-web-ui": minor
---

UI/UX round 8: approval and review cards that read at a glance, the same facts (T186):
- An approval card is one line (what is asked, for which task, *Expires in 12 min · No response: denied*, and an irreversible verdict as a chip) and two buttons, **Approve** and **Deny**, each named by its effect for assistive technology (*Approve: activate project*). Who asked, what it is about, the exact subject, what approving and denying do, how it works, **Show change**, the note, and the ids are under one **Details**, closed by default and kept open through the refresh once opened. The Board card's and *Starts awaiting approval*'s buttons read **Approve** and **Deny** too.
- A review card leads with its change (*3 files +251 −1*), each required check, and each reviewer's verdict as chips, keeps the warnings in sight (a change not read whole, the checks not run or failed), and offers **Accept** and **Send back**; the diff, the findings, the report, why a check has no result, and the exact result are under its closed **Details**.
- *Since you last looked* and *Runs needing attention* show at most 5 rows, with **Show all N** (and **Show first 5**) kept through the refresh.
- Every page header is its title and one short sentence at most.
