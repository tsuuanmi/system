---
"@tsuuanmi/system-web-ui": minor
---

The operator's `/ui`, round 5 (T124):
- Home says what happened **since you last looked**: runs finished or failed, tasks that moved (accepted, merged, waiting for you, cancelled), requests that expired unanswered, and Workers that started resting or came back. Each is one line with a link, newest first. It runs until **Mark as seen**, and is kept in the browser only (`localStorage`); it reads the new `GET /ui/api/activity?since=`.
- The window's title counts what waits for you: `(3) system — Home`.
- A start's confirmation names who would likely take each step, with its account's 5 h quota ("Likely: Claude Code · science · develop — 5 h used 42 %"), or "None free: it waits for …". The preview's steps carry `workers`; the UI makes no routing decision.
- A running run's page says where it is **now**: each running step on its Worker and for how long, and its last event. A stall its Worker's source told is flagged. Its Board card says the same in one line (`GET /ui/api/runs/live`).
- Recent runs are listed by their task's title, each step with its Worker's display name.
