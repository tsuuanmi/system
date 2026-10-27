---
'@tsuuanmi/system-web-ui': patch
---

The web UI's client sheds the lines T304b's split added: 2,881 to 2,418 (-16.1 %; -10.2 % from the 2,692 before T304b, whose target is 2,423). One `recording` helper (buttons disabled, "Recording…", restored, refresh) serves the approval and review verdicts; one `quiet` read and one `workerNames` replace the repeated try/catch reads and name maps on Home, the Board, a run, and Workers; the Workers page reads the projects once; folds, elapsed and took views, the hash shortening, the project switch, and the navigation (now `open`) are one implementation each; the unused `failed` is gone; comments that only restated the code or named a ticket are cut; and statements that declared several related constants over several lines are one line. No module is added or removed, so the package README's module list is unchanged. The page shows and does what it did (PROP-0018 T15, T304c).

| Module | Before | After |
| --- | ---: | ---: |
| app.ts | 12 | 12 |
| boot.ts | 106 | 87 |
| board.ts | 305 | 239 |
| changeview.ts | 40 | 39 |
| describe.ts | 124 | 105 |
| dispatch.ts | 113 | 100 |
| dom.ts | 215 | 175 |
| evidence.ts | 192 | 161 |
| glossary.ts | 80 | 78 |
| help.ts | 108 | 100 |
| home.ts | 194 | 159 |
| policy.ts | 188 | 154 |
| queue.ts | 177 | 140 |
| reports.ts | 22 | 22 |
| reviews.ts | 114 | 98 |
| roster.ts | 117 | 102 |
| router.ts | 53 | 53 |
| runpage.ts | 279 | 217 |
| runwords.ts | 71 | 67 |
| since.ts | 76 | 67 |
| state.ts | 113 | 98 |
| workers.ts | 182 | 145 |
| **Total** | **2,881** | **2,418** |
