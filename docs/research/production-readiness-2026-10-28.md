# Production readiness: what System should change next (2026-10-28)

Non-normative. Research for T339 on the incidents and work of 2026-10-26..28, ranked by value over cost, ahead of
the pilot on a second repository (DNA). It draws only on the lead's records quoted in the task; nothing here was
re-measured, and each cost is an estimate to be checked when the task is taken.

## Summary

The core loop works: 11 tasks went from dispatch to merge overnight with no lead hand. What stops it from being
production-ready is not the loop but its **edges**: results that stop (held, refused, never retried), checks that
disagree between the landing and dev, and the lead's own hand patching around gaps. Four themes carry nearly all
the incidents:

1. **Held and refused results have no way forward** (stale `pendingChecks`, refused landings never retried, heavy
   results waiting overnight, misleading refusal text).
2. **The landing's checks differ from dev's** (dev red twice after green landings; fixed in part by running the whole
   `pnpm check`).
3. **The Worker's own loop is noisy** (tool gate asks for its own tests, `related` rejects options, offline setup
   fails on a lockfile change, a flaky 5 s timeout).
4. **The host is not watched** (disk at 99 %, a stale `index.lock`, `lead_health` reads sinks and worktrees as
   unknown, three Workers unavailable).

## Ranking

Value: how many incidents or lead interventions it removes, and whether it blocks the DNA pilot. Cost: S (a file or
two, one task), M (a few files plus tests and docs), L (a design or a new seam). Rank is value over cost.

| # | Change | Value | Cost | Why this rank |
|---|---|---|---|---|
| 1 | A policy-required check missing from a held result's `waiting.pendingChecks` is listed, run by `checkHeld`, and noted in the web UI (the v3 typecheck stall) | High: five results stalled, nobody could accept | S–M | A deadlock with no operator exit; every policy change can trigger it again, and DNA will have its own policy |
| 2 | Retry of refused landings (bounded, with the reason kept), and clearing a stale `index.lock` only when no git process holds it | High: 13 lead-landed results, refused landings never retried | M | The largest single source of lead hands; INV-4 says restart reconciles, a refusal should too |
| 3 | Landing checks equal dev's checks: the landing runs the whole `pnpm check` on the rebased tree (done), and a post-merge check on dev opens a task on red | High: dev red twice | S (post-merge) | Closes the loop on the cause of the two reds; the credential-shaped URL (T333) shows the cost of the old gap is paid once, in the Worker's tests |
| 4 | A review whose blocking findings were all rejected by verification reads as approve (T330) | Medium–high: autoaccept blocked on a settled review | S | Small and local to the workflow review summary; removes a wrongly held result |
| 5 | Name the hold's real reason in `accept()` (heavy, auto-accept rule, or checks) | Medium: operator misled (T326) | S | A message fix in `board/src/index.ts`; do it with item 1 |
| 6 | Worker tool gate allows a run's own tests by policy (D109), and `test-groups.ts related` takes options as `group` does | Medium: approvals opened for every own-test run; Workers fail on exit 2 again and again (T293b, T325, T327) | S | Cheap, removes noise from the operator queue; fold with PROP-0019's approval-rules task |
| 7 | Disk and host health: `lead_health` reads sinks and worktrees (not unknown), a worktree and run-output reaper with bounds, an alert before 90 % | High at 99 %: a full disk stops every run | M | Production needs it regardless of the pilot; INV-9 (everything is bounded) already demands it |
| 8 | Heavy results do not wait overnight unseen: a notification and a digest for the operator, with a stated wait bound | Medium–high | M | Heavy is by design never auto-accepted, so the wait is the cost; make it visible, not remove it |
| 9 | A result landed outside System is recorded as landed with its commit, and the later acceptance verifies (not re-lands) it; salvage is System's (T322 re-landed an ADR under a taken number; the recheck saved dev) | Medium: relies on one refusal as the only guard | M | Fold into PROP-0019's handover task |
| 10 | Offline setup: fill pnpm's metadata cache once (operator's network OK) and make the mirror complete, so a task that adds a package is not `not-run` (T328) | Medium: blocks every dependency-adding task | S once, M to keep it complete | The fill is one-time; the keeping-complete part needs a check that the mirror covers the lockfile |
| 11 | Two tasks claiming the same autonomy-policy version (1.5): a single writer or a collision check for policy versions | Medium | S–M | Like ADR numbers, caught by `check:docs` style collision spec; reuse `scripts/collisions.spec.ts` |
| 12 | A generated file not declared by its task: the landing treats a declared generator's output as allowed (or the generator declares it) | Medium | S–M | Seen once, but it will repeat with each new generated file |
| 13 | The lead's command filter: finish T326 command rules (now warn) and move to enforce once a week of warn shows no false positive | Medium: about 12 patches by hand | M | Replace patching with rules and data; the enforce switch is the whole value |
| 14 | `report/tests/lead.spec.ts` real-core tests get a timeout like other real-core specs (T329) | Low–medium: a flaky red under load | S | Trivial; mind T5 (a test's bound fits its work), never loosen the assertion |
| 15 | A heavy result's tests check needs bubblewrap: the check runs where the sandbox is present, or reports `not-run` with the reason, never a failure | Medium | M | An environment gap, not a code one; the DNA host must be checked for it before the pilot |
| 16 | Unavailable website Workers (gemini): a visible state in the roster, no assignment while down | Low–medium | S–M | Routing already requires quota known; the same for availability |

## Order of work

1. **Before anything else (small, unblocks the operator):** 1, 5, 4, 6, 14. One short sequence of tasks; 1 and 5
   share a file.
2. **The loop's resilience:** 2, 3, 7, 11, 12. These remove most of the lead's hand-landing.
3. **Operator's time:** 8, 9, 13.
4. **Environment, ahead of DNA:** 10, 15, 16 and a checklist for the second repository (below).

## Before the DNA pilot

The pilot says once the loop is stable. Treat it as stable when, over a week of normal work, the following are
true. These are exit criteria; they are proposals for the operator to set, not facts.

- No held result is un-acceptable (item 1) and no refused landing waits for a person to retry (item 2).
- Dev has not been red after a landing for a week (item 3); a red opens a task by itself.
- Disk stays under 80 % with the reaper on (item 7).
- Lead interventions per landed result fall under one in five (over the two days, 13 lead landings beside 11 merged
  with no lead hand, so about one in two; take the count from the board).
- DNA needs its own policy file, path map (which paths are heavy), check commands, toolchain, and an offline mirror;
  these must come from the repository, not from System's code (INV-10, W9). Check whether `pnpm` is DNA's package
  manager before copying item 10.

## Not recommended now

- A new framework or a second engine for the loop: the incidents are gaps in edge handling, not in the design
  (the same finding as T177 H4).
- Learned routing before the hard gates are right (see efficient-system-inputs-2026-10-25.md).
- Turning heavy results to auto-accept: ADR-0071 keeps a human on the heavy path; reduce the wait, not the gate.

## Open questions

- The truncated last item of the lead's list (the board's fix for the held check) was not in the task text; item 1's
  design is the one to confirm against it.
- The measured cost of each item is an estimate; no task was sized with the code open.
