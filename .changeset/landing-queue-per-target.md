---
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-web-ui": minor
---

Accepted results land through one queue per repository and target branch (T318b, ADR-0077):
- A committed result takes the target's turn or waits `queued` in commit order; one landing at a time rebases, runs the full suite, asks, and merges, so a later result never moves the target under it. "dev moved again after 3 rebases" no longer ends a queued landing: only a push from outside moves the target under one, and it follows at most 8 such moves (`MAX_OUTSIDE_MOVES`).
- `landingBatch` (workflow config, default 1: no batching) lets the head land a stack of the next N at once: rebased in order (the `rebase` step's new optional `stacked`), checked once on the tip, merged by one request. A failing stack is bisected to the failing result, which goes back alone; the ones before it land, the ones after it return to the queue.
- `system explain` and `/ui` show a result's place in the queue, who holds the target, and its stack. The lead playbook advises that a salvage push wait for the queue; System cannot fence a `git push`, so that is advice with no check.
