# Pilot

How the operator runs Base's pilot ([PROP-0010](../proposals/0010-base-version.md) B8): one
algorithm-development project, chosen by the operator, run from its charter over at least five
working days, through at least one restart, with Claude Code Workers writing every change (other
agent Workers may validate and review), and measured against the baseline
([Base exit criteria](../requirements/release-scope.md#base-exit-criteria) 3, 4, 5, and 7). The code it uses: the [`algorithm-development`](../reference/workflow-templates.md#algorithm-development)
template, the board, the approval queue, the resource ledger, digests, and the
[baseline report](../design/reports.md). Routine procedures it leans on are in the
[runbooks](runbooks.md).

Roles: you are the investor (the operator): you approve the charter, answer the queue, accept or
reject results, merge them, and pause or close the project. The lead is your own Claude Code session connected to `system`
over MCP (`system mcp-config claude`): it proposes tasks and starts their runs with the client
tools. The Workers are agent Workers that `system` runs, each in a run's own worktree: Claude Code
Workers write every change; a Codex Worker may run the validation and review.

## The pilot: project `system`

From 2026-10-25 the pilot is the project `system`, on the system repository itself. Its charter is
version 2 of the project (proposed 2026-10-25); the board holds it, so read it there. The roles
are the live install's split ([route work by kind](runbooks.md#route-work-by-kind)): a Claude Code
Worker develops, with `kinds: [code, docs, tests]`; a Codex Worker takes the validation
(`kinds: [validation]`) and reviews. Read its progress on `/ui`'s **Board** (the project's header and its
tasks by state, [web UI](../reference/web-ui.md)) and **Home** (what waits for you), and in `system report --project <its id>`
([a working day](#a-working-day)). The sections below are the procedure for any pilot, with an
example repository.

## Before you start

1. **The host.** Claude Code installed, bubblewrap and `socat` installed, and the Workers' home
   signed in ([agent Workers](runbooks.md#agent-workers)). Its commands must be proven confined
   on this host (`executes`): where they cannot be, a writing Worker is unavailable ("commands
   cannot be confined"), nothing proves `develop` or `validate`, and an attempt fails at its first
   step with nothing sent.
2. **The repository.** Its top level is a git repository with a commit, outside `~/.dsh`. Commands
   in a Worker have no network: install the dependencies the tests and benchmarks need in the
   repository first.
3. **The validation commands.** The exact command lines that test and measure the work, from the
   repository's top level: `npm test`, `python -m pytest -q`, `cargo bench --bench align`. Each is
   matched word for word, never through a shell: no quotes, pipes, redirections, globs, or `~`
   ([exact argv](../design/approvals.md#the-autonomy-policy)). Write each one the same way in the
   policy and in the tasks' acceptance criteria.
4. **The attention budget.** How many interruptions (approval requests and reviews held for you)
   and batches a day you will take. It goes into the charter, and the report checks every day
   against it.

## Name the repository and the Workers

Edit your profile patch, `~/.dsh/profiles/system/cordis.patch.yml`. A patch that targets a row
replaces its whole configuration, so each row below is complete. One row the pilot needs is off by
default: `profile-software-development`, which contributes the `algorithm-development` template;
its first two lines below turn it on. Every other row the pilot uses is on by default. Base ships
that row off, as you decided on 2026-10-24, so this patch stays the switch
([rows the pilot turns on](../requirements/release-scope.md#rows-the-pilot-turns-on)). For a
repository at `/home/me/src/align`:

```yaml
# The template's profile, off by default.
- id: profile-software-development
  disabled: false
# One pool for the Workers' plan, so every run is metered (runbooks: a resource pool is limited).
- id: resources
  config:
    pools:
      - pool: max.agents
        account: max
        kind: programmatic
        unknown: available
        windows:
          - { id: five-hour, kind: rolling, seconds: 18000 }
          - { id: seven-day, kind: rolling, seconds: 604800 }
# Three Workers on the repository, each run of a workflow run in that run's own worktree.
- id: agent-workers
  config:
    workers:
      # Writes and runs the confined commands: develop, and validate.
      - { id: developer, runtime: claude-agent-sdk, workspace: /home/me/src/align, sandbox: workspace-write, tier: standard,
          worktreePerRun: true, pool: max.agents, account: max, windows: { five_hour: five-hour, seven_day: seven-day } }
      # Reads only: the exact-subject review.
      - { id: reviewer, runtime: claude-agent-sdk, workspace: /home/me/src/align, sandbox: read-only, tier: standard,
          worktreePerRun: true, pool: max.agents, account: max, windows: { five_hour: five-hour, seven_day: seven-day } }
      # Reads only, on the economy tier: the digests of the results.
      - { id: digester, runtime: claude-agent-sdk, workspace: /home/me/src/align, sandbox: read-only, tier: economy,
          worktreePerRun: true, pool: max.agents, account: max, windows: { five_hour: five-hour, seven_day: seven-day } }
# The bundle's studio policy, with the validation commands listed: a listed command runs as the
# workspace write it is judged as; any other command asks, and a validation step cannot wait, so
# it is denied and reported not run.
- id: approvals
  config:
    policies:
      - schema: 'autonomy-policy@1.0'
        id: studio-default
        version: 2
        scope: studio
        rules:
          - { actionClass: read, mode: auto }
          - { actionClass: workspace-write, mode: auto, requires: [tests, lint] }
          - { actionClass: merge, mode: ask }
          - { actionClass: command, mode: ask }
          - { actionClass: external-send, mode: ask }
          - { actionClass: deploy, mode: ask }
          - { actionClass: delete-data, mode: ask }
          - { actionClass: spend, mode: ask }
          - { actionClass: charter, mode: ask }
          - { actionClass: funding, mode: ask }
          - { actionClass: remediation, mode: ask }
          - { actionClass: policy-change, mode: ask }
        default: ask
        commands: ['npm test', 'npm run lint', 'npm run bench']
        expiry: { defaultSeconds: 86400, maxSeconds: 1209600 }
        batch: { maxSize: 10, maxWaitSeconds: 3600 }
```

Then `system check` until it says `ok`, `system shutdown`, `system start`, and `system health`:
the three Workers `ready`. The developer proves `develop` and `validate`, the reviewer and the
digester `review`. Keep `workspace-write`'s required checks: the engine never takes `tests` from a
model's account of a command. It runs them itself on the result's exact tree when the
repository's checks are configured, and a result whose checks pass no longer waits for you to run
them ([ADR-0063](../decisions/adr/0063-a-runs-required-checks-run-on-its-exact-result.md),
[let a run pass the required checks](runbooks.md#let-a-run-pass-the-required-checks)); otherwise
every result waits for your acceptance, which is where the checks bind
([accept or reject a review](runbooks.md#accept-or-reject-a-review)).

On an install where other Workers are on too, such as the live install with its website and
reviewer Workers, also put the pilot's Workers first in the `workers` row's
`priority`, keeping the row's other options (the patch replaces the whole row). Routing reads that
list after tier, quota, and load, so it decides between Workers those leave equal
([routing](../design/routing.md)).

## Charter the project

Ask the lead to found the project with `board_charter`
([example](../../schemas/examples/mcp-board.charter.json)):

- `title`, `template: algorithm-development`, `classification: operator-shared` (an agent's model
  is remote, so `local-private` work never reaches it);
- the charter: the `intent` in words; `criteria` tied to accepted results and measurements (a
  `benchmark` target, `tests`); `constraints` (a `deadline`); `stopRules` set before work starts
  (`pivot`, `pause`, or `stop`); the `budget` per pool, and its `attention`:
  `{ maxBatchesPerDay, maxInterruptionsPerDay }` from your attention budget;
- the `milestones`, each `planned`.

The call opens a `charter` request: approve it on `/ui` (`system ui`). The project is `active` on
the board's next sweep (a minute), and nothing starts before.

## Plan the work

For each milestone, the lead proposes tasks with `board_propose`, one hypothesis-sized step each:

```json
{
  "projectId": "proj-align", "milestone": "m1", "title": "Band the inner loop",
  "goal": "Restrict the alignment's inner loop to the band, with identical scores",
  "acceptance": [
    { "id": "tests", "statement": "npm test passes", "check": "tests" },
    { "id": "speed", "statement": "npm run bench reports a median speed-up of at least 1.5x" }
  ],
  "actionClass": "workspace-write", "template": "algorithm-development",
  "writes": { "type": "git-head", "ref": "<the repository's HEAD commit>" }
}
```

- Name each validation command in the criteria exactly as the policy lists it: the validation step
  runs what the criteria name, and nothing else.
- `writes` binds the task's result to the exact tree its run leaves on that commit (INV-5), so the
  engine reports the review of that tree. One open task writes a commit at a time (INV-15):
  propose the next task on a commit once the one before it is done or cancelled.
- A task's worktree is cut from the repository's HEAD when its run starts, so propose a task just
  before running it, after merging the work it builds on. A HEAD that moved in between fails the
  run as `stale_subject`, with nothing accepted.

## A working day

1. **The lead starts each ready task**: MCP `run` with `template: algorithm-development`, an
   `input` with what this attempt should try, and `task: { taskId }`. The input is the develop
   step's alone: the review and the validation read the task's goal and criteria, never it
   ([which inputs reach which step](../reference/workflow-templates.md#which-inputs-reach-which-step)).
   The run claims the task, and the board records it before anything runs. Then, in the run's own
   worktree:
   - the developer states a hypothesis and changes the code (`develop:1`);
   - the reviewer reviews that exact change (`review:1`); blocking findings put a fix to the queue,
     and the fix and a re-review run once you approve it
     ([remediation](runbooks.md#a-remediation-fix-waits-on-the-queue));
   - the validation runs the criteria's commands, confined, and reports each command, its exit
     code, and what it measured (`validate:1`). That report is the attempt's result;
   - when the repository's checks are configured, the run then runs `tests` and `lint` itself on
     the result's exact tree, confined ([let a run pass the required checks](runbooks.md#let-a-run-pass-the-required-checks)).
2. **The result waits for you** in `review` (`tests` and `lint` pending) unless the run passed both
   (then it is accepted, and only its merge waits for you; a failed one is another attempt), and its
   digest is set on the task within minutes: the lead reads the digest, not the transcript
   (`board_task`, `board_brief`).
3. **You decide, in batches**, on `/ui`: the queue's requests (charters, remediation fixes), and the
   reviews held for you. For a review: read the digest and the validation's report, run the pending
   checks in the run's worktree yourself ([worktree](runbooks.md#a-runs-worktree)), then Accept or
   Reject. A rejection makes another attempt, which resumes the developer's session from a brief
   pointing at this attempt's result and your decision; tell the lead your reason.
4. **Merge what you accepted**: once you accept, the system commits the result on its run's branch
   and asks you to merge it; approve the `merge` request (the Board's **Accepted — waiting to
   merge: approve**), and it is merged into the repository's checked-out branch. Nothing is pushed
   ([land an accepted result](runbooks.md#land-an-accepted-result)).
5. **End the day with the report**: `system report --project <id> --days 1`. Check the attention
   line against the charter, and the ledger's usage against the pool.

An attempt that failed only after its develop step (its review's session broke, a limit, a
timeout) leaves its change to the next attempt: the Lead starts the task again as usual, and that
run's worktree starts from the change, recorded with why
([runbook](runbooks.md#a-tasks-next-attempt-starts-from-the-previous-attempts-work)). A review that
asked for changes, or a result you rejected, is never carried: the next attempt starts from HEAD.

A task that waits for input, an expired request, or a run that failed each have a runbook:
[a waiting task](runbooks.md#a-board-task-is-blocked-or-waiting-for-input),
[an expired request](runbooks.md#an-approval-request-expired),
[a limited pool](runbooks.md#a-resource-pool-is-limited), and usage the ledger could not count
(the report's `Not counted` lines, `system health`'s `usage`):
[usage the ledger could not count](runbooks.md#usage-the-ledger-could-not-count).

## A restart

Exit criterion 3 asks for at least one restart during the pilot. Do it with work in flight:
`system shutdown` (it drains, then stops), then `system start`. Runs resume; an agent run that had
started is never run again (`reconciliation_failed`), and its task's next attempt goes through the
gate; a request answered while the host was down still applies. Then check that nothing ran twice:
`system explain <runId>` for the runs in flight, the queue on `/ui`, and the day's report (an
attempt reported once, one usage record per agent run; an agent run the restart stopped before its
runtime reported anything has none, and is counted once as a run whose usage the ledger could not
count).

## Five working days, then close

Run at least five working days, the restart among them. Each week, `system report --project <id>`
is the investor report: progress per milestone, accepted results, what asked for you, usage, and
cost per accepted result; amend the charter (`board_charter` with the next version) when the
evidence says pivot, as its stop rules do. When one says pause, or you are away, pause the project
on the **Board** page of `/ui` and resume it there later
([pause, resume, or close](runbooks.md#pause-resume-or-close-a-project)).

Then close the project, on `/ui`:

1. **Let nothing be in flight.** A close is refused while a task of the project is `running` or in
   `review`; the **Board** page counts them. Let a running attempt finish, or stop its run
   (`system stop <runId>`: the task is ready again or waits, and the close cancels it); decide
   every review held for you (Accept or Reject).
2. **Take what you accepted.** Approve each accepted result's merge request, or merge its branch
   by hand ([land an accepted result](runbooks.md#land-an-accepted-result)), before you close: the
   close removes no worktree or result, but it cancels every open task, so no further attempt runs.
3. **Close it.** On the **Board** page, press **Close** on the project and pick the outcome:
   `achieved` when its criteria are met, `stopped` when it ends without them (a stop rule fired,
   or you stop it). The confirmation says how many open tasks it cancels and claims it releases,
   and whose approval requests it withdraws (the tasks waiting for approval, a pending
   amendment); **Confirm** closes it. MCP `board_close` (operator scope) does the same with
   `{projectId, outcome}`. The close is recorded as a `board` decision, the project's
   `closure.decision`.
4. **Check:** the project shows `closed (<outcome>)`, last on the page, and the queue on `/ui` no
   longer lists its requests. The closed project stays on the board: its report reads it.

## Read the baseline

PROP-0008's test of whether `system` deserves to exist compares the same kind of task done by a
well-configured Claude Code session alone and through `system`
([validation plan](../proposals/0008-studio-operating-model.md#validation-plan)).

1. **`system`'s side:** `system report --project <id> --since <the charter's approval>` covers
   the whole pilot, the tasks the close cancelled and the requests it withdrew included. Its
   baseline section gives the accepted results, the interruptions (every
   approval request and every review held for you), the attempts, and, per accepted result, the
   tokens, cost, turns, attempts, and interruptions; `--json` gives the same as data
   ([what each figure counts](../design/reports.md#what-it-counts)). Its notes say what it could
   not count.
2. **Claude Code alone:** do tasks of the same kind (the same repository, steps of the same size)
   in your own Claude Code session, with your usual setup. Count them the same way: an accepted
   result is a change you accepted; an interruption is each time the session needed you (a
   permission prompt, a question, a correction, a review); take the tokens and cost from the
   session's own usage report. Record the dates and the counts.
3. **Before the pilot:** the runs of `system` on its own code are recorded in
   [self-build](../validation/self-build.md); the pilot is the measured version.
4. **Compare:** accepted results per interruption must be clearly better through `system`, and
   tokens per accepted result no worse. Quota lost at reset is not reported yet. Record both sides
   in the [release checklist](../validation/release-checklist.md).
