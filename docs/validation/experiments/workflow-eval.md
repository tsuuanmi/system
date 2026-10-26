# Workflow eval: golden past tasks under a process variant

> Experiment 3 (T231, from T226's recommendation and the operator's guidance of 2026-10-26: build
> evals, change one thing at a time, keep what holds up). State: **the runner, the set's format, and
> three tasks**; no eval has run. Helper:
> [`scripts/experiments/workflow-eval.ts`](../../../scripts/experiments/workflow-eval.ts). Records:
> [the golden set](records/workflow-golden-set.v1.json) and [the variants](records/workflow-variants.v1.json).

## Question

Does a change to System's own process hold up? A process variant (a change to how the
[`algorithm-development`](../../reference/workflow-templates.md#algorithm-development) template
runs a board task: a fix continued in the author's session, a run without `validate:1`, …) is kept
only when, replaying the same past tasks, it passes at least as many as the current process, at no
worse cost, and the tasks that flipped are understood. One thing changes at a time: two variants of
one eval differ in one configuration.

## Design

| Item | What |
|---|---|
| case | a past board task of 2026-10-25/26 whose accepted result is known, pinned to its base commit (the board's `git-head`), with its goal, its acceptance criteria, and a grader ([the set](#the-golden-set)) |
| variant | a named process ([the variants](records/workflow-variants.v1.json)): `current` is the template as the install runs it; `fix-in-author-session` (T232) and `no-validate-step` are named and `planned`, refused until they can be turned on by configuration |
| trial | one replay of one task under one variant: a board task in the eval's own project, served by one `algorithm-development` run (an attempt; `--attempts` allows more) |
| plan | every chosen task under every chosen variant, at least **twice** each; in each round the variants run as blocks (one configuration in force per block) in the order the seed gives, the tasks within a block in the order the seed gives |
| offline from live work | an **eval clone** of the repository, never the live checkout: its Workers' run worktrees are cut from it, and the grader's worktrees are its own; an **eval board project** (`eval-<evalId>`), so its tasks, approvals, and usage are the trials' alone; a **budget cap** of its own: no trial starts unless what the trials drew plus one trial's reserve stays within the cap, in tokens, quota points, and minutes, and an amount not exported counts as the whole reserve, never as 0 |
| grader | the task's own checks on the result's exact tree: paths the change must touch, patterns a file must match or lack, and the commands the task named (the repository's check, the affected tests, a spec), each command exiting 0; optionally hidden checks, the landed commit's tests checked out over the result |
| measured | per trial: passed, passed first time, review cycles, lead and operator touches, tokens, quota drawn, wall-clock ([measures](#measures)) |
| report | per task and variant, per variant in total, and the tasks whose outcome flipped from the first variant ([report](#the-report)) |

### Preconditions

| Id | Precondition | State |
|---|---|---|
| P1 | each task's grader **calibrated**: it fails on the task's base and passes on a known-good result (`calibrate`, below) | open: the three tasks' graders are written, not yet calibrated against the live repository |
| P2 | an eval clone of the repository, its own agent Workers on it (`worktreePerRun`), with the repository's setup and checks ([set up a run's worktree](../../operations/runbooks.md#set-up-a-runs-worktree)) | open |
| P3 | a maintenance window per block: routing does not bind a step to a repository, so while the eval's Workers are configured a live task's step could route to them, and an eval step to a live Worker. Live dispatch is paused and no other run is running for the block ([runbook](../../operations/runbooks.md#replay-the-golden-set-workflow-eval)) | open |
| P4 | a second `ready` variant: until one exists, an eval measures the current process only, as the baseline later variants are compared with | open (T232) |

## The golden set

[`workflow-golden-set.v1.json`](records/workflow-golden-set.v1.json): plain JSON, one task per
entry, and a `setup` the grader runs first in its worktree (an offline install).

| Field | What |
|---|---|
| `caseId`, `taskId`, `title` | the board task (`T187`, `task-…`) |
| `template`, `templateVariant` | `algorithm-development`, and `docs` or `tests` if its runs used that variant |
| `base` | the full commit the accepted attempt's worktree was cut from: the board's `git-head` of its result |
| `accepted` | the board's record of the accepted result: its run, attempts, result hash, acceptance decision, and the landed commit once pinned (`landed`, else `null`) |
| `goal`, `acceptance` | the task's goal (the coordination lines left out) and criteria, as the board gave them: the replay's board task gets them verbatim |
| `grader` | the checks, each with an `id`: `{ "changed": [paths] }` (each path, or directory prefix ending in `/`, changed against the base), `{ "path", "matches" }` or `{ "path", "lacks" }` (a multiline regular expression on the result's file), `{ "command" }` (a command line as the autonomy policy matches it, words split on single spaces; `{base}` is the base commit) |
| `hidden` | `null`, or `{ "commit", "paths", "commands" }`: the landed commit's paths (its tests) checked out over the result, then its commands run |

The first three tasks: **T184** (dispatch under `auto`: a large code change across the workflow
plugin, the board, the UI, and four docs), **T187** (the gate's probe commands: a small code
change with its spec), and **T188** (docs only). T190, T205-T220 are the next to add.

A grader of commands alone is refused: on a base whose checks pass it passes a replay that changed
nothing. Each task has a check about its own change, and `calibrate` proves it can tell.

### How to add a task

1. Pick a `done` board task whose accepted result is known (`board_task`): its `result` names the
   `git-head` it was cut from and the decision that accepted it. A task whose result is an artifact
   (a review, a research answer) is not replayed: its grade needs a person.
2. Add an entry with the fields above; copy the goal and the criteria from the board, leaving out
   the coordination lines (they name the live board).
3. Write its grader: the paths the goal says the change touches (`changed`), what a file must then
   say or no longer say (`matches`, `lacks`), and the commands the goal named, as the check commands
   (`corepack pnpm check`, `node --import tsx scripts/test-groups.ts affected --base {base}`, a spec
   with `corepack pnpm exec vitest run <spec>`), never a generator that writes files. Once the
   landing commit is pinned, add its tests as `hidden`.
4. `node --import tsx scripts/experiments/workflow-eval.ts check`, then
   `… calibrate <caseId> --repo <eval clone> --good <landed commit> --scratch <dir>` until it says
   `calibrated`.
5. Commit the set as its next version (`workflow-golden-set.v2.json`, `version` 2): a plan binds the
   set's hash, so an eval in progress keeps the version it planned with, and an edit refuses its
   next command.

### How to add a variant

Add an entry to [`workflow-variants.v1.json`](records/workflow-variants.v1.json) as `planned`, and
make it `ready` once it is one configuration of the install (`configuration`: the profile patch
that turns it on, kept with the eval), so a block of trials can run under it with nothing else
changed. A variant changed after a plan refuses that eval's next command.

## Procedure

Every command is `node --import tsx scripts/experiments/workflow-eval.ts <command>` from a checkout
of this repository, writing under the eval's directory on the host (`~/experiments/workflow-eval/<evalId>/`),
never into the repository. The [runbook](../../operations/runbooks.md#replay-the-golden-set-workflow-eval)
has the install's side.

| Step | Command | Does |
|---|---|---|
| plan | `plan <eval> --variants current,<v> --tasks T184,T187,T188 --repetitions 2 --seed <s> --cap <tokens>:<pp>:<minutes> --reserve <tokens>:<pp>:<minutes>` | writes `plan.json`: the trials in order, the set's and variants' hashes, the cap; refuses fewer than two repetitions, a planned variant, an unknown task, a reserve over the cap |
| next | `next <eval> --repo <eval clone>` | refuses while a prepared trial is not graded, once every trial ran, or when the cap would be passed; else checks the eval clone out at the task's base (refused with uncommitted changes), writes `trials/<trialId>/trial.json`, and prints the board task (MCP `board_propose`, `maxAttempts` the plan's) and the `system run` to start |
| export | `export <eval> <trialId> <runId>` | after each attempt: `system explain --json` and `system events --json` of the run into `runs/<runId>/`, the run added to the trial. Beside them the operator puts `usage.json` (MCP `resources_usage` with `runId`) and `draws.json` (the run's [`quota-draw`](../../reference/schemas.md#quota-draw) records), and in the trial `approvals.json` (MCP `approvals_list`, every state, the eval project's) |
| grade | `grade <eval> <trialId> --repo <eval clone> --worktree <the run's worktree>` | snapshots the run's worktree as a commit through a private index (its index and branch untouched), checks it descends from the base, checks it out in a worktree of the eval's own, runs the setup, the file checks, the commands, and the hidden checks; writes `grade.json`; removes the grading worktree unless `--keep` |
| report | `report <eval> [--json]` | writes `report.json` and `report.md` |

### Measures

| Measure | From |
|---|---|
| passed | every grader check (and hidden check) passed on the trial's last result |
| passed first time | passed, on the trial's first attempt, which completed with no remediation cycle |
| review cycles | the remediation cycles the reviews grew: fix steps (`review:<n>:fix:<m>`) in `system explain`, summed over the trial's runs |
| lead and operator touches | the approval requests whose requester is a run of the trial, every class (a command, a remediation, a merge, a policy change), answered or not, with the count per class |
| tokens | input plus output tokens of the ledger's totals per pool for each run (`usage.json`) |
| quota drawn | percentage points drawn from accounts' windows: the `clean` and `confounded` draws of the run's `quota-draw` records; excluded windows (`reset-crossing`, `no-reading`) add nothing |
| wall-clock | from each run's `workflow.run.started` to its last `workflow.run.completed` or `failed`, summed over the trial's runs |

An amount not exported is unknown, shown as `(+n unknown)`, never 0. A trial is **not counted**,
and listed with why, when its eval clone was not at the task's base, its result does not descend
from the base, it is not graded, its setup failed, a grader check did not run, a run's usage or the
approvals were not exported, a run was exported before it ended, or its records name another run.

### The report

Per task and variant: trials counted, passed, passed first time, the **outcome** (`pass`: every
counted trial passed; `fail`: none did; `mixed`: some did; `none`: none counted), review cycles,
touches, tokens, quota points, minutes. Per variant in total the same, with how many tasks were
mixed. A **flip** is a task whose outcome under a variant differs from its outcome under the first
planned variant (the baseline): `gained` (fail to pass), `lost` (pass to fail), or `changed` (to or
from mixed). The trials not run and the trials not counted are listed.

The report computes no statistic: with two or three repetitions, a flip is a fact to look at
(the trials' records say why each failed), never a verdict, and a mixed outcome is noise, never
a gain. A variant is kept when the operator, reading the report, judges it held up; once
PROP-0011's evaluation engine runs store-backed (F4), the same trials can become an experiment
with pre-registered thresholds.

## Records

The plan, each trial's files, the grades, and the report stay in the eval's directory on the host;
a finished eval's `report.md` is copied into [records](records/README.md) with the plan's hash.
