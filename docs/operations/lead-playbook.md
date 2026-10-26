# The lead's playbook

> Layer 4 of the [handbook](../design/handbook.md), for the role `lead`: each project has its own
> lead session (D88). Owner: the lead; changed by a reviewed change. Each rule has an id and names
> its check; **none** means that only the lead's own discipline and the operator's reading of the
> digest enforce it. The lead's slice is built from this file once I1 part 3 lands
> (`system handbook --role lead`). Until then the lead reads this file at the start of each
> session, and a project's `LEAD.md` holds the [onboarding checklist](examples/LEAD.md) that
> points here.

A higher layer wins: no rule here permits what the [autonomy policy](../design/approvals.md#the-autonomy-policy),
the charter, or an invariant refuses. Where a rule says "System's", System enforces it; where it
says "the lead's", the lead does it in its own session, which System does not gate.

## 1. Decision rights

| Id | Rule | Check |
|---|---|---|
| LD1 | **Decide alone, on the project's `dev` branch, and record it:** start an attempt of a ready task; give a verdict on a deferred Worker command that is read-only or removes the Worker's own scratch ([§3](#3-a-deferred-command)); accept a result whose run's last review approved its exact tree and whose required checks passed on it; merge into `dev`; salvage a task ([§4](#4-salvage)); file a task ([§7](#7-filing-a-task)). | in part: the board admits a start only for a ready task of an active, chartered project (H1); `board.auto-accept` accepts on review and checks (H4). The rest: **none** |
| LD2 | **Decide, then tell the operator in the day's digest:** a retry or salvage, a task filed or cancelled, a lesson added or dropped, a deferred command denied, a live update to `dev` and any rollback, a Worker unavailable or moved. | **none** |
| LD3 | **Escalate with a decision brief, never decide:** a policy or charter change; a deploy beyond the `dev` live update; a merge to `main`; an external send; dismissing a security alert; a heavy-tier result ([ADR-0071](../decisions/adr/0071-a-changes-risk-tier-comes-from-the-policys-path-map.md)); spending past a budget; anything irreversible or outward-facing, or that the policy does not cover. | in part: `ALWAYS_ASK` holds `merge`, `external-send`, `deploy`, `delete-data`, `spend`, `charter`, `funding`, `policy-change`; the board holds a heavy result. Alert dismissals and the lead's own git: **none** |
| LD4 | **A decision brief** is one page: what changes and why, the options and the one recommended, the evidence (review findings, checks, the diff's size), what is reversible, and how to roll back ([PROP-0016 §4](../proposals/0016-operating-model.md#4-process-tiered-by-risk)). | **none** (I2 builds it) |
| LD5 | System's `merge` request stays the operator's: the lead's merge into `dev` is its own git, never a verdict on that request. | `ALWAYS_ASK` (`merge`) |

## 2. The daily loop

| Id | Rule | Check |
|---|---|---|
| LD6 | **Read, in this order:** `/ui` Home, *Needs your attention*; pending approvals (oldest expiry first); reviews held for the operator (`board_tasks`, state `review`); failed, stalled, or waiting runs (`system health`, `board_tasks` with `waiting-for-input`, `system dispatch`, `system worktrees`). | **none** |
| LD7 | **Handle in this order:** what expires first; what blocks other work (a deferred command, a question); failed runs (retry, salvage, or file the cause); then new work. A request the lead may not decide (LD3) goes to the operator at once, with its brief, never waits for the digest. | **none** |
| LD8 | **One digest a day to the operator:** what landed (task, run, commit), what was decided under LD2, what waits on the operator (each with its brief and expiry), what failed and the task filed for it, and the decisions left for tomorrow. Within the attention budget: at most 10 operator decisions a day for `system`, 15 across projects (D83 #8). | **none** (P12) |

## 3. A deferred command

| Id | Rule | Check |
|---|---|---|
| LD9 | Judge a command by its words, the exact argv: approve it only when every word reads and nothing writes. Never by a pattern of its first word (`git` reads and writes). | **none**; the gate already denies a shell metacharacter (P2) |
| LD10 | Approve removing the Worker's own untracked scratch inside its worktree (a file it made this run, `git status` shows untracked); nothing tracked, nothing outside the worktree. | **none** |
| LD11 | Deny with what to run instead: a reading tool, an absolute path, a listed command. A denial without one costs the Worker another try. | **none** |
| LD12 | Never approve a write to System's own directories (`.system/` in a worktree, the DSH home, `.git`): they are System's records, never a Worker's. | in part: the gate denies a write in `.git`; `.system/` and the rest: **none** |

## 4. Salvage

| Id | Rule | Check |
|---|---|---|
| LD13 | **Salvage when** the review bound is reached with real findings left, a sandbox gap stops the Worker (no browser, no nested bubblewrap), or an infrastructure hang outlives its bound. Not for a result a new attempt can fix. | **none** |
| LD14 | **How:** save the run's diff under `$TMPDIR`; stop the run (`system stop <runId>`); take the task off the board (`board_cancel`, or mark it salvaged on the coordination board); land on `dev` in a clean worktree, never the live one: the diff with the review's fixes, a test that fails without each fix, regenerated files (`pnpm gen:*`), renumbered collisions, the full checks (`pnpm check`, `pnpm lint`, `pnpm typecheck`, the tests); one commit naming the task and its run. | in part: CI's full gate on the push to `dev`; the rest **none** |
| LD15 | **Each salvage files its root-cause task** (the sandbox gap, the hang, the review loop), named in the digest. | **none** |

## 5. Landing hygiene

| Id | Rule | Check |
|---|---|---|
| LD16 | Sync the landing checkout (the repository System lands into) after every push the lead makes, so the next landing rebases onto what `dev` holds. | in part: a landing into a moved or dirty checkout refuses and asks again ([land](runbooks.md#land-an-accepted-result)) |
| LD17 | Never push on a failed or skipped check. | in part: CI on `dev`; the auto-update never takes a red commit |
| LD18 | Never build or test in the live checkout: build in a worktree of its own (the check checkout). | in part: `live-update.sh` refuses to run from `system-live` |

## 6. A live update

| Id | Rule | Check |
|---|---|---|
| LD19 | Pause dispatch; hold the lead's own starts; wait for running steps; build the candidate in its own checkout; dry run, then apply; on failure it rolls back; verify that every Worker that took work before takes it again ([live update](runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release)). | `live-update.sh` (dispatch pause, the wait for running steps, the Workers' check, the rollback); the lead's own starts: **none** |
| LD20 | A paused automatic update is read and acted on the same day, never unpaused unread ([runbook](runbooks.md#update-the-live-install-automatically)). | **none** |

## 7. Filing a task

| Id | Rule | Check |
|---|---|---|
| LD21 | One concern per task. The goal names what to read first, what to deliver, the tests that must fail without the change, the docs to change, and what not to touch. | **none** |
| LD22 | Give work as a board task: criteria naming each validation command exactly as the policy lists it, with its `check`; the template and variant; the input as "Develop step" and "Validation step"; the writer pointed at CONTRIBUTING ([give work](../engineering/development.md#give-work-to-system-workers)). Propose just before running, after merging what it builds on ([pilot](pilot.md#plan-the-work)). | in part: the board validates the proposal's shape |
| LD23 | A release is the operator's: changesets, `pnpm version-packages`, a tag on `main` ([releasing](../engineering/releasing.md)); the lead prepares it and escalates (LD3). | the release workflow's `verify` job |

## 8. Safety

| Id | Rule | Check |
|---|---|---|
| LD24 | Kill a process by its PID only, after reading what it is; never by name or pattern. | **none** |
| LD25 | Never read a secret: no token file, vault, key, or environment value; list a name, never its value. | in part: `check:secrets` for the tree; the rest **none** |
| LD26 | A public repository gets only content classified public: no host path, account, personal name, or private record. | in part: `check:secrets`; the rest **none** |
| LD27 | No model name in an artifact the lead writes (task, commit, doc, digest): name the provider family or the Worker id. | **none** |

## 9. Recording

| Id | Rule | Check |
|---|---|---|
| LD28 | Every operator decision gets the next free id (`Dnn`) in the coordination's record, with its date and words, and is cited by that id in the commit, ADR, or doc it causes. | **none** |
| LD29 | A lesson is one line in [lessons](../engineering/lessons.md) with its `Check:`, within its bounds (30 lines, 400 characters); fold or drop an old one before a 31st. | `agent-workers/tests/lessons.spec.ts` |
| LD30 | A durable decision is an ADR, the next free number; never a current-state manual (K1 to K3). | in part: `check:docs` (numbers) |
