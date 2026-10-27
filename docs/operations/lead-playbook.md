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
| LD1 | **Decide alone, on the project's `dev` branch, and record it:** start an attempt of a ready task; approve a `remediation` that lets the run's own review's fix write (`let review:1:fix:N write a fix of the blocking findings its review found`) or retries a step its host stopped (`reconciliation-failed:host-stopped`; a lost run without that mark stays the operator's), on its project's runs only; give a verdict on a deferred Worker command that is read-only or removes the Worker's own scratch ([§3](#3-a-deferred-command)); accept a result whose run's last review approved its exact tree and whose required checks **passed** on it (never accept with a check pending or failed: a pending check is run first, in the run's worktree, and the acceptance waits for its result; a heavy-tier result is never the lead's to accept, see LD3); merge into `dev`; salvage a task ([§4](#4-salvage)); file a task ([§7](#7-filing-a-task)). | in part: the board admits a start only for a ready task of an active, chartered project (H1); `board.auto-accept` accepts on review and checks (H4). **Enforced now by the lead token** (LD5): a verdict on a command or start of its project, an acceptance or merge on a listed dev branch; anything else is refused for it. The rest (salvage, filing): **none** |
| LD2 | **Decide, then tell the operator in the day's digest:** a retry or salvage, a task filed or cancelled, a lesson added or dropped, a deferred command denied, a live update to `dev` and any rollback, a Worker unavailable or moved. | **none** |
| LD3 | **Escalate with a decision brief, never decide:** a policy or charter change; a deploy beyond the `dev` live update; a merge to `main`; an external send; dismissing a security alert; a heavy-tier result ([ADR-0071](../decisions/adr/0071-a-changes-risk-tier-comes-from-the-policys-path-map.md); the board holds it for the operator, whose acceptance alone accepts it, so the lead brings its brief and does not accept it); spending past a budget; anything irreversible or outward-facing, or that the policy does not cover. | in part: `ALWAYS_ASK` holds `merge`, `external-send`, `deploy`, `delete-data`, `spend`, `charter`, `funding`, `policy-change`; the board holds a heavy result; **the lead token refuses** every verdict, route, and tool off its closed list (policy and charter changes, `main`, deploys, external sends, tokens). Alert dismissals and the lead's own git: **none** |
| LD4 | **A decision brief** is one page: what changes and why, the options and the one recommended, the evidence (review findings, checks, the diff's size), what is reversible, and how to roll back ([PROP-0016 §4](../proposals/0016-operating-model.md#4-process-tiered-by-risk)). | **none** (I2 builds it) |
| LD5 | **The lead acts as the lead, not as the operator.** Every decision of LD1 that goes through System (a start, a deferred command, an acceptance, System's `merge` request into a listed dev branch) is made with the project's lead token (`system lead-token issue <project>`; its scripts read the file and send it as the bearer token, never the operator's), and is recorded as `lead:<project>`. A merge to `main` stays the operator's, and the lead's own git is never a verdict on a request. | **System, now** ([ADR-0076](../decisions/adr/0076-the-lead-is-a-principal-of-its-own-with-a-closed-list-of-rights.md)): the token is a client's with its project and a closed list of rights (`leadMayDecide`: commands and dispatch starts of its project; results and merges on its listed dev branches, `approvals` `devBranches`; board moves and answers to Workers), and it reaches **its own project only**: a task, run, Worker, or request of another project is refused for it with the reason, and an ask or research question it starts is tagged with its project (T285). LD3 is enforced for it: a policy or charter change, a merge or push to `main`, a deploy, an external send, and issuing tokens are refused for the token with the reason, whatever a script sends; an acceptance never skips the policy's checks or a heavy tier's hold. Until a change makes System run the checks before any acceptance (T293), the board does not stop the lead from accepting a result whose checks are pending; the rule is the lead's own (LD1), and a task whose result is a report artifact and not the run's git tree (T283) is not accepted either: it has no tree to land. `ALWAYS_ASK` (`merge`) |

## 2. The daily loop

| Id | Rule | Check |
|---|---|---|
| LD6 | **Read, in this order:** `/ui` Home, *Needs your attention*; pending approvals (oldest expiry first); reviews held for the operator (`board_tasks`, state `review`); failed, stalled, or waiting runs (`system health`, `board_tasks` with `waiting-for-input`, `system dispatch`, `system worktrees`). A review whose run's holder is gone (a host restart) still waits on `operator-review` for the policy's wait. One that expired (`review-expired`) is not only cancelled, nor landed by hand: while its result and its run's worktree exist, re-open it to review with `board_reopen_review` (a reason; recorded as a decision, no attempt counted; your own project only), then accept it as any review held for the operator. | **none** |
| LD7 | **Handle in this order:** what expires first; what blocks other work (a deferred command, a question); failed runs (retry, salvage, or file the cause); then new work. A request the lead may not decide (LD3) goes to the operator at once, with its brief, never waits for the digest. | **none** |
| LD8 | **One digest a day to the operator:** what landed (task, run, commit), what was decided under LD2, what waits on the operator (each with its brief and expiry), what failed and the task filed for it, and the decisions left for tomorrow. Within the attention budget: at most 10 operator decisions a day for `system`, 15 across projects (D83 #8). | **none** (P12) |

**Wait on the inbox, never poll** (D107): run `system lead wait --project <id>` (in the background, or a `command` or `file` sink of the project's row that wakes the session) instead of a script that polls `sysdev`. A notice names what needs you (a result or merge held, a question, spent retries, a landing that gave up, a request outside your rights or stale, idle quota) or what finished (a live update, a landing and its commit); handle it as LD6 to LD8 say, then `system lead ack <id>` (MCP `lead_inbox` with `ack`), or let its subject close it (the request decided, the task moved). See [notifications](../design/notifications.md#the-leads-inbox).

**Answering a Worker's question** (`board_update` with `answers`) spends no attempt (T291): the answer continues the attempt that asked, its count unchanged, also on the last one. Answer every question, by index from 0, and start the task's next run as usual: it is that same attempt, briefed with the answers. It keeps the steps the asking run completed, and the step that asked runs again on its session, the answers its next message; when the asking run had written to its worktree (a writing step completed, or a review bound to its tree), nothing is kept and the run starts its template again on the same attempt, in its own worktree, which holds the carried change. When the step that asked was writing, its edits are carried and it resumes on them; if they could not be carried, it starts again in a new session, told the edits are gone. Asking rather than guessing costs nothing, so never tell a Worker to guess to save an attempt. Only a step that fails or is rejected spends one.

## 3. A deferred command

| Id | Rule | Check |
|---|---|---|
| LD9 | Judge a command by its words, the exact argv: approve it only when every word reads and nothing writes. Never by a pattern of its first word (`git` reads and writes). The routine commands (the read-only programs, a run's own tests and checks, its tree edits, removing its scratch) are the policy's command rules, which the gate decides and records (T319b, [command rules](../design/approvals.md#command-rules)): they never ask, and the lead keeps no judge of its own for them. What reaches the lead is a command no rule covers. | **none**; the gate already denies a shell metacharacter (P2) |
| LD10 | Approve removing the Worker's own untracked scratch inside its worktree (a file it made this run, `git status` shows untracked); nothing tracked, nothing outside the worktree. The `scratch-rm` rule already does this for a plain path that is an untracked regular file: a command that asks is one the rule refused (a tracked file, a link, a directory). | **none** |
| LD11 | Deny with what to run instead: a reading tool, an absolute path, a listed command. A denial without one costs the Worker another try. | **none** |
| LD12 | Never approve a write to System's own directories (`.system/` in a worktree, the DSH home, `.git`): they are System's records, never a Worker's. | in part: the gate denies a write in `.git`; `.system/` and the rest: **none** |

## 4. Salvage

| Id | Rule | Check |
|---|---|---|
| LD13 | **Salvage when** the review bound is reached with real findings left, a sandbox gap stops the Worker (no browser, no nested bubblewrap), or an infrastructure hang outlives its bound. Not for a result a new attempt can fix. | **none** |
| LD14 | **How:** save the run's diff under `$TMPDIR`; stop the run (`system stop <runId>`); take the task off the board (`board_cancel`, or mark it salvaged on the coordination board); land on `dev` in a clean worktree, never the live one: the diff with the review's fixes, a test that fails without each fix, regenerated files (`pnpm gen:*`), renumbered collisions, the full checks (`pnpm check`, `pnpm lint`, `pnpm typecheck`, the tests); one commit naming the task and its run. A salvage waits for the landing queue ([ADR-0077](../decisions/adr/0077-landings-queue-per-target-branch-one-at-a-time.md)): push to `dev` only when `system explain` of the runs waiting to land shows no landing that holds the target (none `asked`, `merging`, or rebasing), or let the queue land it as a result; never while one holds it. This is advice only: System cannot fence a `git push`, so a push made anyway makes the holder rebase again (at most 8 times, then it is refused for hand-merging). | in part: CI's full gate on the push to `dev`; the rest **none** |
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
| LD19 | Pause dispatch; hold the lead's own starts; wait for running steps; build the candidate in its own checkout; dry run, then `--stage` (never a bare `--apply`: the same code and patch run on the `system-test` profile with a canary first, and a mechanism newly switched on goes the same way, T323); on failure it rolls back; verify that every Worker that took work before takes it again ([live update](runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release)). | `live-update.sh` (dispatch pause, the wait for running steps, the Workers' check, the rollback); the lead's own starts: **none** |
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
| LD25 | Never read a secret: no token file, vault, key, or environment value; list a name, never its value. The one exception is the lead's own token file (`lead-<project>.token`), which its scripts send as the bearer token and never print or log; never the operator's. | in part: `check:secrets` for the tree; the rest **none** |
| LD26 | A public repository gets only content classified public: no host path, account, personal name, or private record. | in part: `check:secrets`; the rest **none** |
| LD27 | No model name in an artifact the lead writes (task, commit, doc, digest): name the provider family or the Worker id. | **none** |

## 9. Recording

| Id | Rule | Check |
|---|---|---|
| LD28 | Every operator decision gets the next free id (`Dnn`) in the coordination's record, with its date and words, and is cited by that id in the commit, ADR, or doc it causes. | **none** |
| LD29 | A lesson is one line in [lessons](../engineering/lessons.md) with its `Check:`, within its bounds (30 lines, 400 characters); fold or drop an old one before a 31st. | `agent-workers/tests/lessons.spec.ts` |
| LD30 | A durable decision is an ADR, the next free number; never a current-state manual (K1 to K3). | in part: `check:docs` (numbers) |
