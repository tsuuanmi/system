# Web UI API

> Hand-written from [`web-ui`](../../packages/plugins/web-ui/README.md) (`src/index.ts`). The
> page at `/ui` is its only client; `system ui` prints its link.

Every route is under `/ui/api` and passes the shared request guard first
([gateway-core](../../packages/gateway-core/README.md#the-request-guard)): a loopback `Host`
(else `421`), no `Origin` but the UI's own (else `403`), and the operator token as
`Authorization: Bearer` (else `401`). A `POST` takes a JSON object only
(`content-type: application/json`, else `415`), of at most 16 KiB (else `413`; 128 KiB for
`policy/propose`). Errors are `{error}`.

A project's **lead token** (`system lead-token issue <project>`,
[ADR-0076](../decisions/adr/0076-the-lead-is-a-principal-of-its-own-with-a-closed-list-of-rights.md))
is accepted in place of the operator's, and reaches `approvals` (listing that project's requests only)
and `approvals/decide`, `reviews` (that project's reviews) and `reviews/<taskId>/decide`; every other
route answers `403` with the reason. Its verdicts are held to the lead's closed list of rights (commands
and dispatch starts of its project; merges into, and results accepted on, the project's listed dev
branches): one outside it answers `403` with the reason and decides nothing. What it decides is recorded
as the `client` decider `lead:<project>`, and the accepted-result cards say who accepted it and who
approved its merge (`acceptedBy`, `approvedBy`: operator, lead, or System; "before the lead principal"
for an older record). A revoked token is `401` at once.

## Home

One navigation on every page, **Home**, **Board**, **Workers**, **Autonomy policy**, and **Help**, the
current one marked (`aria-current`) and named in the window's title, which counts first what
waits for the operator and they can act on: *(3) system — Home*; a run's page counts as Home's.
Every page reads the count from one route, `GET waiting` ([below](#what-waits-for-you)), and
Home's *Needs your attention* lists the same: the requests open for a verdict, the reviews held for
the operator, and the runs that need a look. A count that could not be read whole reads *(3+)*, or
*(?)* with nothing known.
Each page opens with its title, and one short sentence of what it is for only where the title does
not say it (*Control which actions need approval.*); the design rules, the bound on the words of each
first screen, and the screenshots are in [the web UI at a glance](../design/web-ui.md) (T239). On a
narrow screen (600 px) no page is wider than the screen: the navigation keeps whole links on one row
under the name and the refresh line (*policy* for *Autonomy policy* on a phone), the header stays at
the top, the Board's columns stack, each card the screen's width with its buttons sharing it, and,
below 600 px, a table is a card per row, each cell named by its column. On the operator's iPhone
(T240) the page lays itself under the Dynamic Island and the home indicator and keeps clear of both,
every target is at least 44 by 44 px, every field 16 px (Safari never zooms on focus), a row of
buttons has a **?** that shows on a tap what each does, and a run's primary action is a bar at the
bottom of the screen.

### Shared building blocks and production states

Every page is built from one implementation each (T172): a **status chip**, a word with a colour
and a symbol of its own shape (● ok, ▲ needs you or waits, ■ failed or blocked, ◆ info, ○ other),
never the colour alone; a **number with its unit** (*3 tasks*, *1/2 slots*, *2/3 steps*); a
**relative time** (*12 min ago*, *in 2 h*) with its exact time as its title on hover and after it
on keyboard focus; a **fold**, a `details` closed by default, for every explanation, mechanism, and
technical fact (*Details*, *Technical details*, *Record IDs*, *How it works*); and a **copy button**
(*Copy run ID*, *Copy request ID*, …) for a run, request, batch, project, plan, or policy-change id,
the value behind it (copied on a press; shown and selected where no clipboard is), never the first
thing in a row. One wording per concept across pages: *Needs your attention* (*Approval needed*,
*Review needed*, *Input needed*, *Run failed*); *Approve / Deny* for an approval, *Accept / Send
back* for a review; *Running*, *Completed*, *Failed* for a run; *Free*, *Working*, *Resting until
14:20*, *Unavailable — why*, *Quarantined — why* for a Worker; *Automatic*, *Notify*, *Ask
approval*, *Blocked* for a mode; *action type* for an action class. A fact is folded, never
deleted; current failures, blocking reasons, incomplete counts, expiries with what no response
means, irreversible consequences, and failed results stay in sight.

Every button that decides something is labelled by its concept's one wording, the same on every
page (T191): **Approve** and **Deny** on every approval (a request's card on Home and on the policy
page, a Board card, a start awaiting approval, a run's plan; a batch's **Approve all N** and **Deny
all N**), **Accept** and **Send back** on every review, **Confirm** and **Cancel** in every
confirmation (stopping a run, a project's **Pause…**, **Resume…**, and **Close…**, a ready task's
**Start…**), and **Stop run**, **Retry failed step**, **Show change**, and **Propose**. What the
button does is never in its label: it is the button's accessible description (`aria-describedby`)
and its tooltip, shown on hover and on keyboard focus and hidden by Escape, never text beside it
(*Approve*: *merges the change*, *Deny*: *keeps the branch only*, *Accept*: *marks it done*, *Send
back*: *sends it back for another attempt, if it has one left*; T239), one implementation for every
page.

The page shows *Loading…* (`aria-busy`) while a page first loads, and *updated 12 s ago* in the
header after each refresh (not announced each second). A refresh that fails over a page already
shown keeps it and puts a **stale** banner above it (*Stale: the last refresh failed (why).
Showing what was read at 14:05:12; trying again every 5 s.*), gone once a refresh succeeds; a
page that never loaded shows *This page could not be loaded: why.* with **Try again**. Only a
destructive move asks first (**Stop run**, a project's **Close**; **Pause** and **Start…** keep
their confirmations, which say what they do). **Skip to content** is first in the keyboard order,
every control shows its focus, nothing moves under `prefers-reduced-motion`, and prose is capped at
80 characters a line on a full-width page.

**Home** is a dashboard (T239): *Needs your attention*, a tile each (*Approvals · 3*, *Reviews · 2* and
*first expires in 3 h*, *Runs needing attention · 1*), each linking to its section,
then named one by one under its count, folded under *Names*, at most 5 a group with how many more: each request by what it
asks, each review by its task and project, each with when it expires, and each run by its task's title
(else its template) with why (*Plan awaiting approval*, *Team vote tied*, *Run failed — why*), each linked to its card; and what of it could not be read;
*You’re all caught up.* when nothing does), beside it the Workers' availability as chips (*● 2 free*, *◆ 1 working*,
*▲ 1 resting*; free always, the others when there are any); then the approval cards, the reviews,
*Runs needing attention*, the starts awaiting approval, *Since you last looked*, and the Workers at a
glance (each account's capacity in one line, its 5 h bar beside it: *Claude Code · science: 5 h used 42 %, resets 03:08*, with *resting
until 02:38 (in 2 h)* first when it rests, or *5 h no reading yet*; then **Right now**, the same
section the Workers page shows, by the same function from the same roster read, so both name the
same free, stalled, and no-quota Workers, T160; the counts are the chips at the top, said once).
The reviews are cards, under a line saying how many are held for you and when the first expires,
in sight within the hour and else folded under *When they expire*, since an unanswered one expires and its task waits for input that nothing
revives (each [a review card](#what-a-review-shows): one line, the change, the checks, and the
reviewers' verdicts as chips, **Accept** (*marks it done*) and **Send back** (*sends it back for
another attempt, if it has one left*), every long text under its closed **Details**), *Runs needing
attention* (waiting for a plan approval or a deciding vote, or outside the board and failed since
you last marked Home as seen), each by its title with why as a chip, **Open run**, and its id
behind **Copy run ID**, at most 5 with **Show all N** for the rest; and, last, the 15 most recent runs, 5 rows with **Show all N**,
each by its task's title (else its
template), its state as a chip, its progress and current Worker (*1/2 steps · waiting: … · Claude
Code · science · develop*), and, folded under *Steps*, each step with its Worker's roster `name`,
its template, and its id. No run yet reads *No runs yet · Open Board*.

*Since you last looked*, below the cards, says what happened since the operator last marked
Home as seen, one line each with a link, the latest first, at most 5 with **Show all N** for the rest (a part that holds more than it read says *More runs ended than the 50 read here.*, and one that cannot be read says so): the runs that finished or
failed (a failure led by the same plain-words reason the run page gives, from its kind and
disposition by one function: *Failed: a solo run — its account must sign in again (it needs you)*;
the system's own text folded under *What the system said*, T160), the tasks that moved (accepted, merged, waiting for a review, an approval, or
input, cancelled), the requests that expired unanswered (counted as denied), and the Workers that
started resting, came back, became unavailable, or are available again. **Mark as seen** starts it
again from now. When and each Worker's status then are kept in this browser only
(`localStorage`, `system.seen`), never on the server; a first look keeps them and says so. It reads
`GET activity` and the roster.

| Route | Body | Answer |
|---|---|---|
| `GET waiting?since=<ISO time>` | — | `{asOf, since?, requests, reviews, runs, count, partial?}`, each part `{value}` or `{unknown}` with why ([what waits for you](#what-waits-for-you)); `count` adds the known parts, and `partial` says a part is unknown or holds more than it read. An invalid `since` is `400` |
| `GET activity?since=<ISO time>` | — | `{since, asOf, runs, tasks, expired}`, each part `{value, more?}` or `{unknown}` with why when it cannot be read (never empty in its place): the runs that ended since (`runId`, `template`, `status`, `at`, `taskId`, `error`, the raw message, and `failure {kind, disposition}` beside it), read by state and by when their state changed (`ctx.workflow.usage` with a filter, contract 1.7), so a run that started long ago is there; the board tasks that moved since into done, review, waiting, or cancelled, or whose accepted result moved on its way in (`taskId`, `title`, `project`, `state`, `at`, `waiting`, `run`, `landing`); and the requests that expired unanswered (`approvals.resolved` events of cause `expired`: `requestId`, `at`, `summary`), read newest first (`ctx.eventLog`, contract 1.1), at most 5 pages of 1,000. Each part lists at most 50, the latest first; `more` says it holds more than it lists, or that a read stopped at its bound before the end. A missing or invalid `since` is `400` |

### Dispatch

*Starts awaiting approval*, after the runs needing attention, lists each start System proposes
([dispatch](../design/workflow-engine.md#dispatch-starting-ready-work-by-itself), ADR-0064): the
task's title, its attempt, the Worker's roster `name`, each window of its account as *5 h · used 12 %
· reserve 20 % · resets 14:20* with a small bar, *Why this Worker?* folded (the reason, when each
window was read, the project), *Expires in 40 min · No response: denied*, and **Approve** (*starts
it on* the Worker) and **Deny** (*does not start it, and this attempt is not asked again*, its
accessible description, here and on the request's card), which are the approval queue's verdicts on the request's exact subject (`POST
approvals/decide`, INV-5), with a short note in sight under them, *Deny is final for attempt N: it is
not asked again.* (T197); **Review request** goes to the request's full card in the queue, where it
is described as a start. It also says *Automatic starts off* (`dispatch.enabled: false`, folded) or
*Automatic starts paused · why · since when* (*How to resume*, `system dispatch resume`, folded), or
for each project paused on its own *Automatic starts paused in project … · why · since when · resume:
system dispatch resume --project …*, names the approved starts waiting for their Worker, and folds
*Why ready tasks did not start*, each ready task the last pass looked at with its reason; *No starts
awaiting approval.* when none. It reads `GET dispatch` and the queue.

*Started by itself* (PROP-0014 D2), below it, lists what dispatch started in the last 24 h, newest
first, at most 32, one line each: its run's state as a chip (*running*, *completed*, *failed*,
*cancelled*), the task's title (to its run), the Worker's roster `name`, how it was let start (*by
policy (auto)*, *by policy (notify)*, *on your approval*, *approved on the board*), and when. It is
absent when there is none. On the Workers tab, a step whose run dispatch started carries a *started
by itself* chip (the roster's `work[].startedBy`).

| Route | Body | Answer |
|---|---|---|
| `GET dispatch` | — | `ctx.workflow.dispatchStatus()` (contract 1.10): `{enabled, settings, paused?, pausedProjects, lastPass?, bounds, asks, started}`: the settings in force; the operator's pause (`since`, `reason`, `decision`), and each project's own (`projectId` too); what dispatch started in the last 24 h (`started`: `askId`, `taskId`, `title`, `projectId`, `attempt`, `worker`, `runId`, `runStatus`, `mode` `auto`, `notify`, `ask`, or `board`, `why`, `startedAt`, and `notice` under `notify`); the starts of the rolling hour (`bounds.hour`, `bounds.hourProjects`); the last pass (`at`, `state` `ran`, `off`, `paused`, or `waiting` with its `reason`, what it `took`, each ready task it looked at with its `reason`, and how many `more`); each bound with how much of it is used (`running`, `openAsks`, per `projects`, `accounts`, and `repositories`, and the `engine`'s active runs against what dispatch may fill); and each live ask (`askId`, `taskId`, `title`, `projectId`, `attempt`, `state` `asking`, `asked`, `approved`, or `starting`, `worker`, `account`, `repository`, `requestId`, `why`, `windows` of `{pool, window, name, seconds, used, headroom, reserve, resets, observedAt}`, `approvedAt`, and its `decisions`) |

### What waits for you

The one count of what waits for the operator and they can act on (T127), read by every page for
the window's title and by Home for *Needs your attention*:

- `requests`: the approval requests open for a verdict (`ctx.approvals.list()`). A tool call, a
  fix, a merge, a funding raise, or a task's approval that a run or the board waits on is one of
  them, so it is counted once, here.
- `reviews`: the board tasks in review held for the operator (`operator-review`), with
  `firstExpires`; a review a run's reviewer still holds is not the operator's yet.
- `runs`: the runs that wait for the operator's own move and ask no request (a tie's deciding vote,
  a plan's approval), whenever they started; and the runs outside the board that failed since
  `since`, when the operator last marked Home as seen (this browser's `system.seen`), which they
  may continue. A board task's failed run is not counted: the board decides its next attempt. At
  most 50 listed, each state read by state (at most 100, as the list of runs reads), `more` past them.

A run that failed before the operator last marked Home as seen is seen: it stays in the recent runs,
and no longer counts. A queue or board the composition does not mount holds nothing that waits (0,
as the page shows it not running); a read that fails is `{unknown}`.

## Help

**Help** (`?view=help`) says how System works in plain words, for an operator who is not a
developer, with links into the real pages, each answer folded under its question, the section
navigation in sight: *Workers* (who does the work, quota, resting; accounts and roles, teams and
exclusions folded), *Task lifecycle* (a flow, *Proposed → Ready → Working → Review → Accepted →
Merged*, **Start**, accepting or sending back, and the merge approval folded under their state),
*Your decisions* (*Approvals: allow or deny an action*, *Reviews: accept or send back work*, *Runs:
approve a plan, break a tie, or inspect a failure*, each with what no response does), *Autonomy* (a
table of the four modes, *Some actions always require approval*, **Open Policy**, the list
folded), and *Troubleshooting* (*Run failed*, *Task retried*, *Run stalled*, *Nothing starts*,
*Account unavailable*, *Task needs input*, *Page says stale*, each answer folded). It reads nothing
from the server and shows without a token.

Its *Glossary* lists each word the pages use, its plain sentence folded under it (Worker, account,
role, tier, kind of work, quota, window, resting, project, task, run, step, attempt, review,
checks, merge progress, merge, branch, approval request, action type, batch, autonomy policy, mode,
always requires approval, policy change, quarantined, stalled, not known to be gone, derived, team,
continued from earlier work, retried after a service error, stale), with **Search terms** keeping
the words whose word or sentence holds what is typed. Each entry is an anchor
(`?view=help#term-<word>`) that a link opens and focuses. Wherever a page shows such a word, a
**?** button beside it (named *What is <word>?*) opens its sentence in place, and closes it, by
click, tap, or keyboard, never by hover alone; the sentence links to its entry (*more in Help*).

Every empty state is one short line, with a link where there is a next step (*No runs yet · Open
Board*, an empty Board column's *None*, *No approvals needed.*); how things get there is Help's. The review
card's own (*No review waits. …*) is the reviews section's.

## Runs

A run's page (`?run=<runId>`) says with its state as a chip (*Running*, *Completed*, *Failed*,
*Needs your attention*) where it is (every step done, running which step on which Worker, or failed
at which step and why in plain words), when it started, and **Stop run** (*ends this run, after you
confirm*), asked again before it is sent with **Confirm** and **Cancel**, or **Retry failed step**
(*runs the failed step again; completed steps are kept*), in one line; then what it waits on as a
card (*Plan awaiting approval* with its **Approve** and **Deny**, the step, the plan id, and a note
under its **Details**; *Team vote tied* with the vote, *Decide within 12 min · No response:
inconclusive*; *Tool call awaiting approval* or *Fix awaiting approval* with **Review request** and
its expiry; ids and mechanics folded), the answer (a long one's first lines, then **Show all**),
and the steps as a timeline in words (done, running, failed, waiting for you, waiting for earlier
steps), each with its Worker's roster `name`; each step's tier or the tier it needs, its decisions
(*How it was decided*), and its id under its **Details**; the run's id (**Copy run ID**), template,
last change, and spec hash under *Technical details* (T239). A running run's
page says where it is *Now*, refreshed with the page: each running step on its Worker and for how
long, the run's last event in words and how long ago (*last event: a tool call ran, 40 s ago*),
and, when its Worker's source says it stalled (no activity past its own bound,
[liveness](../design/agent-runtimes.md#what-the-operator-sees)), *Stalled since 13:05* as an alert.
A running task's Board card says who runs it in one line, its last event under its *Details*, and a stall in sight.

A board task's run is headed by its task's title (*Speed up the image resize*), else its template
(*solo run*), with its project and its attempt when it carried one below (*Attempt 2 of 3*), from
`GET projects` (T141). Under **What happened** it says, a line each,
what the run view and its decisions record, each with a **?** for a new word and its mechanics
folded under *Details*:

- where its worktree started (the run view's `task.carry`,
  [ADR-0061](../decisions/adr/0061-a-tasks-next-attempt-starts-from-the-work-its-previous-attempt-left.md)):
  *Continued from attempt 1 (its run)* (folded: *That change was already in its worktree, saved as
  <commit>; its writing step built on it instead of starting over.*); or *Started over — <reason>*;
  or, while due, *Continues from attempt 1 · before its first step*;
- each step sent again after a site's own error (a step's `recovery` decision `resend` in `explain`,
  [ADR-0062](../decisions/adr/0062-a-team-members-first-step-is-resent-once-after-a-sites-own-error.md)):
  *Team member 1's answer: retried once after a service error.*, and, when it failed again, *Retry
  failed; no further automatic resend.* (folded: the site's own error, a new conversation on the
  same Worker, never a third time);
- where its accepted result stands (`task.landing`): *Accepted and merged into main as <commit> ·
  not pushed*, or waiting to merge with its request linked, or not merged and why.

A team's steps read by member (*team member 1's answer*, *team member 2's vote*, *the team's count
of the votes*), the id folded under its *Details*; a failure's kind reads in words first (*its account
must sign in again — …*); and an earlier attempt's error on a step that went on reads *An earlier
attempt failed: …* under *Attempt history*, never as the step's failure.

| Route | Body | Answer |
|---|---|---|
| `GET runs` | — | `{runs}`: the latest 100 runs |
| `GET runs/<runId>` | — | `{run, explain, timings}` ([below](#a-steps-timings)); `404` for an unknown run |
| `POST runs/<runId>/approve` | `{verdict: approved \| rejected, note?, plan?}`: `plan` the `sha256:` id of the plan the page shows (INV-5). A remediation fix's plan on the approval queue (the run's `blocked.approvalRequest`) is refused (`409`): decide its request in the queue | `{run}` |
| `POST runs/<runId>/vote` | `{decision, option, rationale}`: the tie decision the page shows, an option or `inconclusive` | `{run}`; the vote is the operator's |
| `POST runs/<runId>/stop` | `{reason?}` | `{run}` |
| `POST runs/<runId>/continue` | `{nodeId?}` | `{run}` |
| `GET runs/live` | — | `{asOf, runs}`, `runs` being `{value, more?}` or `{unknown}` with why: the running runs, read by state however long ago they started, the latest started first, at most 50 (`more` past them), each with `runId`, `template`, `startedAt`, `taskId`, its running `steps` (`nodeId`, `attempt`, `worker`, `since`: when the attempt started, the step's latest `workflow.node.started` when it is this attempt's), `lastEvent` (the run's latest event's `type` and `at`, one entry read newest first, else `{unknown}` with why: no event, or the event log not mounted, failing, or not reading newest first), and `stalled` (`{value: {since}}` when `ctx.workers.liveness` tells a stalled run of it, `{value: null}` when not, `{unknown}` when nothing tells) |
| `GET runs/<runId>/review` | — | `{runId, change, assessments, report?, landing?}`: what the operator reads before a review verdict ([below](#what-a-review-shows)); `404` for an unknown run |

A refused action is `400` (a malformed body) or `409` (the engine refused it).

### A step's timings

`GET runs/<runId>` gives, beside the engine's `run` and `explain` (T256):

- `timings`: `{value}` or `{unknown}` with why. `value` maps each step's `nodeId` to
  `{startedAt, endedAt?}`. `startedAt` is the step's latest `workflow.node.started` (its current
  attempt's start). `endedAt`, only for a `COMPLETED` or `FAILED` step, is its latest
  `workflow.node.completed` or `workflow.node.failed` at or after that start. A step with no start
  recorded is left out. The event log is read newest first, one entry per type and step, for at
  most 200 steps of the run. `{unknown}` is returned when the event log (`ctx.eventLog`) is not
  mounted ("the event log (ctx.eventLog) is not mounted") or a read throws ("the event log could
  not be read: …"); it is never an empty `value`. The run's page then says *Times unknown*, why
  under that fold, and each step only its state.
- each decision of `explain.nodes[].decisions[]` gains `at`: when it was made, its artifact's
  `createdAt`, when `ctx.artifacts` is mounted and holds it; absent otherwise.

## Reviews

Served when `ctx.board` and `ctx.artifacts` are present; without either, both routes answer `503`
([board](../design/board.md#required-checks-bind-at-acceptance)).

| Route | Body | Answer |
|---|---|---|
| `GET reviews` | — | `{reviews, accepted}`: `accepted`, the latest 20 done tasks whose accepted result is still on its way into the repository (landing `watch`, `commit`, `committed`, `asked`, `merging`), each with `taskId`, `title`, `project`, `run`, and `landing` as the Board's cards give it; `reviews`, every task in review, those held for the operator first, by expiry: `taskId`, `title`, `goal`, `actionClass`, `acceptance`, `attempts`, `project {projectId, title}`, the result's exact `subject`, `artifacts` (and `digest`, `files`), `pendingChecks`, `checks` (below), `run`, `heldFor` (`operator`, or `reviewer` while a run's lease holds it), `since`, `expiresAt`, `lastDecision` |
| `POST reviews/<taskId>/decide` | `{verdict: accept \| reject, subject, note?, checksNotRun?}` | `{task, decision}`: the task after `ctx.board.accept`, and the `acceptance` decision recorded. `checksNotRun` (operator only, with `accept`; T293): each required command check (`tests`, `typecheck`, `lint`) the operator accepts past, with why it did not run (1 to 500 characters), carried as the decision's `outcome.detail.checksNotRun`; the review card asks for it under the checks not run. A lead's, or a malformed one, is refused (400) |

- `subject` is the exact subject of the result the page showed (INV-5): a result on another
  subject is refused (`409`), and so is a task no longer in review. Nothing is decided then.
- The verdict is an `acceptance` decision made by the operator (decider `operator`, producer
  `operator`), naming the task and the result's subject in `outcome.detail`, with every result
  artifact (and the digest) among its inputs and the note as its rationale; then
  `ctx.board.accept` applies it. This is the operator's channel for it (INV-6): no MCP tool
  accepts a review.
- A malformed body is `400`, an unknown task `404`. A refusal by the board is `409`, with its
  failure (`invalid`, `invalid-transition`, …).
- `checks` (T160, [ADR-0063](../decisions/adr/0063-a-runs-required-checks-run-on-its-exact-result.md)):
  `{value, requiredUnknown?}`, each check the policy requires of the task's class (every rule for it
  in the studio's and the project's policies) and each the board holds pending, in the order tests,
  typecheck, lint, schema, quote-check, review, as `{check, state, exitCode?, why?}`, read from the
  acceptance decision the task was judged on (its last decision, or the one the board's hold names
  first among its inputs: `outcome.detail.checks` and the run's `checkRun`): `passed` or `failed`
  (with the command's `exitCode`) only on a record of it, and never `passed` while the board holds it
  pending; `not-run` with why when the run asked for it and it did not run to an exit code (no
  Worker source held the worktree, a source refused, the command errored); `pending` with why when
  nothing recorded it. When the policy cannot be read, `requiredUnknown` says why and the list holds
  the pending checks only. The card lists them under *Required checks*, each state as a status chip
  (*tests: ● Passed · exit code 0*, *lint: ■ Failed · exit code 1*, *typecheck: ▲ Not run — …*,
  *review: ▲ Pending — …*), then the checks
  the board holds pending in warning, from their recorded states: one recorded as failed under
  *Checks that failed: …*, the others under *Checks not run: …*, never a failed check as not run.

### What a review shows

`GET runs/<runId>/review` gives, read only:

- `change`: `{value: {changes, unread}}` from `ctx.workers.changes(runId)`, each worktree's change
  of the run (`WorkChange`: its repository, worktree, branch, `base {branch, sha}` it is read
  against, `head`, and `files`, each with `path`, `status`, `added`, `removed`, and its `diff`, or
  `binary` or a `note` why it is not shown, within `CHANGE_BOUNDS`; a file the bounds left unread
  has no `added` or `diff`, and `truncated`) with its `source`, and each source that could not read
  its own; `{unknown}` with why when no registry or no `changes` is mounted, or when no source read a
  change (and none failed) while the run's result is an agent's (`agent-result`) that names the
  workspace it worked in: a change no source read is never an empty one
  ([a run's change](../design/agent-runtimes.md#a-runs-change-for-the-operators-review));
- `assessments`: the run's `assessment@1.0` artifacts, the newest 20 first: each reviewer's
  `verdict` and `findings`, with its step and Worker; `more`, how many older ones are not listed,
  counted among the newest 100 (`moreAtLeast: true` when there may be more);
- `report`: the run's answer (its last step's, such as a validation's report), at most 32,000
  characters, `truncated` past them;
- `landing`: where its accepted result stands, as a card gives it (with the committed `head`).

A review card (T186) shows one line (its title, project, and *Expires in 3 h · No response: it
waits for input*), then as chips the change (*3 files +19 −1*), each required check (*tests: ▲
Pending*, *lint: ■ Failed · exit code 1*), and each reviewer's verdict (*● Approved · w:standard*,
*■ Changes requested · …*), then what must stay in sight (a change not read whole, the checks not
run or failed), then **Accept** (*marks it done*) and **Send back** (*sends it back for another
attempt, if it has one left*), each described by what it does (T191). Its closed **Details** holds
what was asked, the action type and task, the run that made the result, the exact result, each
check with its exit code or why it has none, and the long texts: *What changed* (`3 files changed +19 −1 ·
on system/run/<id>, against main at <sha>`, then each file folded, its diff in monospace lines
marked added and removed, the first 200 lines with **Show all N lines**); *What the reviewers said*
(*Approved* or *Changes requested*, each finding with its severity); *What the checks measured*
(the report in the step's own words, a line that says a criterion was not met or not measured
marked); and the checks the policy requires that nothing ran, in warning colour: *Checks not run:
tests, lint. Accepting counts them as passed — run them first.* A change that could not be read
says so (*Do not accept what you could not see*), never an empty change; a file the bounds left
unread says *not read*. Past the newest 20 verdicts, *The newest 20 verdicts are shown; N older ones
are not.* The page reads it once per run and result, a read that failed included: the 5-second
refresh never reads it again, and **Read it again** beside the failure does. After **Accept**, the result is listed under *Accepted, on their way in* with
where it stands (*Accepted and committed on system/run/<id> as <head>; its merge request comes
next*, *Accepted — waiting to merge into main: approve*, linked to its request) until it is merged
or refused. A run's page shows its change, its reviewers' verdicts, and where its result stands
under *Changes and reviews* (its report is its answer, shown above).

## Projects

Served when `ctx.board` is present; without it, every route answers `503`
([the operator's project moves](../design/board.md#the-operators-project-moves)).

| Route | Body | Answer |
|---|---|---|
| `GET projects` | — | `{projects}`: every project, in creation order with the closed ones last: `projectId`, `title`, `state`, `revision`, `charter {version, intent}`, `amendment` (a pending amendment's charter version), `open` (its tasks per open state: `proposed`, `ready`, `claimed`, `running`, `review`, `waiting-for-input`, `waiting-for-approval`), `closure`, `lastDecision`, `createdAt`, `updatedAt`; and `tasks`, its tasks as the Board's cards (`taskId`, `title`, `state`, `actionClass`, `createdAt`, `updatedAt`, `run {runId, startedAt}`, `holder {owner, leaseExpiresAt}`, `waiting {reason, approvalRequest?, since, expiresAt}`, and for a done task whose accepted result is landed `landing {state, branch?, base?, head?, requestId?, commit?, reason?}`: `watch`, `commit`, `committed`, `asked` (its `merge` request), `merging`, `merged` (the base's new head), `refused` or `rejected` (why); [landing](../design/workflow-engine.md#landing-an-accepted-result)), and its `revision`, `template` (when it names one), and `attempts {count, max}`, per state the most recently changed first, at most 50 each, `more` counting the rest per state |
| `POST projects/<projectId>/pause` | `{revision}` | `{project, decision}`: the `project@1.0` record after `ctx.board.pause`, and the `board` decision that records the move |
| `POST projects/<projectId>/resume` | `{revision}` | `{project, decision}`, after `ctx.board.resume` |
| `POST projects/<projectId>/close` | `{revision, outcome: achieved \| stopped}` | `{project, decision}`, after `ctx.board.close`; `decision` is also the closure's |

- `<projectId>` is URI-encoded (an id may hold `/`). `revision` is the project's revision the page
  showed: a project whose revision moved since (a move, a charter amended or dropped) is refused
  (`409`) and nothing moves. A malformed body is `400`, an unknown project `404`.
- The move goes to `ctx.board` as the operator's (INV-6), at the server's clock. A refusal by the
  board is `409` with its failure: `invalid-transition` for a move from another state, or a close
  while a task of the project runs or is in review.
- The **Board** page is a Kanban: a project filter (all projects by default; one project is kept
  in the address, `?view=board&project=<id>`, so a reload or a link keeps it), each shown
  project's header (title, its state as a chip, *12 open tasks*, *Amendment awaiting approval* when
  one is; its id and charter version folded; its state as counts, *Needs you 3 · Working 1 · Ready 1
  · Proposed 0*, with *What needs you* folded, *1 review, 2 merges*; what of it needs the operator,
  *Charter approval needed* or *2 task approvals*, linked to its card, past three folded; and
  **Pause**, **Resume**, **Close**), all under one *Projects (N)* fold below the columns, its
  summary saying what of them needs you (*▲ 1 charter approval*, T239); above the columns, how many
  Workers are free and tasks ready (*1 Worker free · 2 tasks ready*), then a column per state:
  *Proposed*, *Ready* (how a ready task starts behind its **?**), *Working* (claimed and running),
  *Review*, *Needs your attention* (input and approval), each empty one a short line (*None*,
  *Nothing needs you*), with *Done* and *Cancelled* folded; on a narrow screen *Needs your attention*
  comes first. Each card gives the task's title, its project (when the cards shown come from several
  projects) and when it last changed (*4 min ago*), what it needs as a chip (*Pending prerequisites*,
  *Approval needed*, *Input needed — attempts used up*) and when the wait expires, who works on it
  (the account and role that took it, the Worker's roster `name`, and for how long: *Claude Code ·
  science · develop, 4 min*, from the roster's current work), its primary action (**Start…**,
  **Approve** / **Deny**, **Review** in the Review column) and **Open run**, and, under its
  **Details**, kept open through the refresh once opened, its action type, and a running task's last
  event. A request a card waits on that the queue lists (a
  task's approval, an accepted result's merge) has that request's own buttons on the card (**Approve**,
  *merges the change*; **Deny**, *keeps the branch only*), sent on the request's exact subject as on Home (INV-5) and
  reported the same way (T141). A done task's card says where its accepted result is on its way
  into the repository: *Merge approval needed · into <base>*, with those buttons
  (**Accepted — waiting to merge into <base>: approve**, linked to its `merge` request, when the
  queue cannot be read), also shown under *Needs your attention*; **Accepted and merged into <base> as
  <commit>** (not pushed); **Accepted — not merged:** and why; or that the merge was not approved.
- A ready task's card gives, under its **Details**, its template (*solo template*; a task naming
  none says *No template: the lead starts it* in sight) and who its first step would likely go to
  (*Likely Worker: Claude Code · science · develop — 5 h used 42 %*, the others folded under *+2
  others*, from its start's preview, for at most 8 ready cards shown; *None free: it waits for …*
  when none is free), and offers **Start…**
  ([below](#starting-a-ready-task)); its confirmation is brought into sight when it opens.
- A close cancels every open task of the project (`project-closed`), releasing a claimed one's
  lease, then withdraws the approval requests those tasks and a pending amendment waited on. The
  page shows each move's consequences for that project, and sends it only on **Confirm**;
  **Cancel** moves nothing.

### Starting a ready task

Served when `ctx.board` is present; without it, both routes answer `503`. The operator starts a
ready task's run the way the lead does with MCP `run` and `task`
([board](../design/board.md)): the run claims the ready task itself, and the board records it before
any step runs.

| Route | Body | Answer |
|---|---|---|
| `GET tasks/<taskId>/start` | — | `{task {taskId, title, revision, template, attempts}, steps}`: what would run, each step's `nodeId`, `objective`, `capabilities`, least `tier`, and `kind`, `team {kind, members}`, `source`, or `plans` when it has them (`ctx.workflow.templateSteps`), and `workers`: the Workers that could likely take it now (`free`: ready, or busy with a slot free) or once one is (`busy`, resting at a limit included), at most 8 each, by id: those whose descriptor proves every capability the step needs, at its tier or above, taking its kind of work (`ctx.workers.list()`; no routing decision is made, and routing decides when the run starts), `{unknown}` when they cannot be read |
| `POST tasks/<taskId>/start` | `{revision, template}`: the task revision and template the page showed | `{run}`: the run, started with `ctx.workflow.start({template, input, task: {taskId, revision}})`, its input the task's title and goal at the revision read, which the engine refuses (`409`) when the task moved since (workflow contract 1.7), so the input and the run's briefs come from one reading; or `202` `{pending: {runId, reason}}` when the engine admitted the run and the board did not answer when asked to record it: nothing of it ran, and it starts once the board shows it recorded, or is dropped with nothing run (the engine's failure names the run, `WorkflowFailure.runId`) |

- An unknown task is `404`, a malformed body `400`. A task that is not ready, names no template
  (the lead then starts it with a template it chooses), names a template not served, changed since
  the page showed it (its revision), or names another template than the page sent is `409`, and
  nothing starts. A refusal by the engine (a paused project, a spent budget, a drained host) is
  `409` with its reason. A start the board did not answer is no refusal (`202`): the page says
  *Not started yet:* with the run linked, that it starts once the board shows it recorded and the
  task then moves to Working, or is dropped with nothing run, and that nothing more is needed (T127).
- The card's **Start…** opens a confirmation that says what runs: *solo template · attempt 1 of 3
  · 1 step*, each step with a short requirement (*Do solo: standard+ · reason*; a team's size, a kind
  of work, and a step that plans more are said too) and who would likely take it, by display name
  with its account's 5 h quota (*Likely: Claude Code · science · develop — 5 h used 42 %*, or *None
  free: it waits for …*), how many Workers are free, and, folded under *What happens on start*, that
  the run claims the task, that routing picks each Worker when the run starts, and that nothing runs
  until **Confirm** (*starts the run now*); **Cancel** (*nothing starts*) closes it. A task that names no template shows why it cannot start
  here instead. The outcome (the run, linked, or why nothing started) is reported above the page,
  and the card moves to *Working*.

## Approval queue

Served when `ctx.approvals` is present; without it, both routes answer `503`
([approvals](../design/approvals.md)).

| Route | Body | Answer |
|---|---|---|
| `GET approvals` | — | `{batches: [{batchId?, requests}]}`: the open and batched `approval-request@1.x` records, by batch then expiry, the unbatched last (no `batchId`) |
| `POST approvals/decide` | `{verdicts, note?, batchId?}` | `{results}`: one `{requestId, state, approval?, refused?}` per verdict, in order |

- `verdicts` holds 1 to 50 `{requestId, subject, verdict: approved | rejected, note?}`. `subject`
  is the exact subject the page showed for that request (INV-5): a verdict for a request whose
  subject changed since is refused (`subject-changed`) and changes nothing.
- `note` applies to every verdict that has none of its own; a note is trimmed to 2000
  characters.
- With `batchId`, every verdict must be for a request of that batch, or nothing is decided
  (`409`). The page sends it for a batch's **Approve all N** and **Deny all N** (under *N related
  requests*, the batch id folded), with one verdict for each request it shows.
- A malformed verdict refuses the whole call before any verdict applies (`400`). Otherwise
  the verdicts go to `ctx.approvals.decide` as the operator's (INV-6), at the server's clock:
  each applies or is refused on its own (`unknown-request`, `already-resolved`, `expired`,
  `subject-changed`, `failed`).

Its count is Home's tile (*Approvals · 3*); the queue says its next expiry only within the hour
(*Next expiry in 12 min*), or *No approvals needed.* Each request is a card (T186, T239): what is
asked as its title (*Allow a deploy step: …*), an irreversible verdict as its one chip (*Deny cannot
be undone*), one line of context, when it expires (*Expires in 12 min*); then **Approve** and
**Deny**, each described by its effect (*activates the project*, T191), and, on a policy change,
**Show change** beside them, with the diff it shows, never folded. Everything else below is under
the card's one **Details**, closed by default and kept open through the refresh once opened: for
which task (else project, else run), what no response does (*No response: denied*), who asked, what
it is about, the exact subject, what approving and denying do, how it works, the note, and the ids. Within it, the request reads: what is asked in plain words (a
charter as *Found project …* or *Amend the charter of …*, a board task's step, a tool call, a budget
raise, a fix, a policy change, an accepted result's merge, with its branch and both heads folded),
who asked by a readable name (the board for a task or project, *an agent run*, the run of a task,
*a run*, the queue), the request's own text, what it is about with the exact subject behind
**Exact subject**, what approving and what denying change (an irreversible one in sight: *Cannot be
undone.*); the request's id with
**Copy request ID**, its exact expiry, and the requester's run, session, step, task, and policy-change
ids, and how the board applies it under *How it works*. The consequences a requester gave are shown as given,
read first in words: a policy set's hash reads *the proposed set*, a hash in parentheses is left
out, and any other long hash is cut to its first 8 characters, with the exact text behind
**details** (a policy change's subject reads *the policy set this change would put in force*, its
hash behind **Exact subject**);
for a board charter or task request without them the page says what the board does with each
verdict ([board](../design/board.md)), counting the project's proposed and open tasks from
`GET projects` when the board runs. An accepted result's merge (T141) is asked by *the run of the
task "…"* (by its run when the board lists it), is about *the accepted change of "…" · not pushed*,
says *If you approve: the accepted change of the task "…" is merged as one merge commit. Not
pushed.* and *If you deny: not merged: the change stays on its branch; the task stays done.*, and
folds the branch with both heads, and the requester's own text with its paths and hashes, under
*How it works* and *In detail*. Each button reads **Approve** or **Deny**, described by its effect
(its `aria-describedby`, shown as its tooltip: *activates the project*, *abandons the project*,
*holds the task*, *merges the change*, *keeps the branch only*); each entry has its own *Note
(optional)* under **Details**; a batch has **Approve all N** and **Deny all N**, its *Note for all
(optional)* and its id under its own **Details**. A Board card's own **Approve** and **Deny** read
the same.

After a call the page reports, above the page until **Dismiss**, what happened: each verdict
recorded, with what happens next (*Approved: …*, a batch *2 approved*), the request and approval
record ids under *Record IDs*, or not recorded, with why in plain words (each `refused` failure, or
the call's own `{error}` and status) and that nothing was decided (*1 approved · 1 not recorded*).
The same report follows a review verdict, a project move, and a run action. While a
call is in flight its buttons are disabled. The page refreshes every 5 seconds, but never while
an element of it has focus or a pointer or key is pressed: a render that lands during a press
waits for its release, so a press is never lost to a refresh.

Every pending decision on another page links to its card: a project's charter or amendment and a
task's approval on the Board, a run's fix on the run's page, and an asked policy change in the
policy page's history. The link is `/ui/?request=<requestId>`: Home, scrolled to that card, which
takes the focus; a request that no longer waits says so in the report above the page. The policy
page shows an asked change's own card, with **Approve** and **Deny**, at its top.

## Autonomy policy

The page says what is in force in two words (*Active policy · Configuration*, or *Active policy ·
Approved change*), which change and the set's hash folded under *Exact set*; the modes as chips
(*Automatic*, *Notify*, *Ask approval*, *Blocked*), what each means and the stored values (`auto`,
`notify`, `ask`, `forbid`) folded under *About modes*; the effective mode per action type by its
name (the stored value as its title); an asked change under *Changes awaiting approval · N*; and
its history, each change by its policy and version, its state as a chip (*Approval needed*, linked
to its card, while asked), its times relative with the clock time on hover and focus, *N actions
changed* folded, and its id behind **Copy change ID**; *No policy changes yet.* when none.

**Propose a change** (*Preview your changes, then submit for approval.*) edits one policy (*Version
1 → 2*, raised for the operator, or a new project's policy) as a form: a mode per action type
(*Use default (Ask approval)* or *Use studio policy*, then the four modes; a row says only what the
select does not: *Requires: tests, lint*, *Expires: 24 h*), each type that always asks shown fixed
at *Approval required*, why folded under *Why always* (*an accepted result lands only on your
approval* for merge; a forbid set in the record is shown *Blocked*, *Blocked here; change it under
Advanced*), the *Default mode*, the *Workspace-write commands* as lines (how they match folded),
*Request expiry (h)*, *Maximum expiry (h)*, *Batch size (requests)*, and *Batch delay (min)*. The
record as JSON stays under **Advanced**, following the form (an edit there that parses shows in the
form), with what the queue validates. **Show change** gives the record's diff (*shows what your
edit changes, below; proposes nothing*), and **Propose** sends it (*asks for your approval; nothing
changes until you approve it*); the page refuses nothing the queue would take, and a refusal is shown as *Not proposed:*
with the queue's reason.

Served when `ctx.approvals` is present; without it, both routes answer `503`
([a policy change](../design/approvals.md#a-policy-change)).

| Route | Body | Answer |
|---|---|---|
| `GET policy` | — | `{set?, policies, effective, proposals, changes?}`: the set in force (`hash`, `source` `configuration` or `store`, `configHash`, `changeId`, `projects`), every policy of it (the studio's first), the effective mode per action class for the studio and each project (`[{projectId?, effective}]`), whether the queue takes proposals (contract 1.1), `alwaysAsk` (the classes that always ask, whatever a rule says: `ALWAYS_ASK` in approvals-core), and its latest 20 `policy-change@1.x` records, newest first (a change the queue proposed itself carries its `origin`, `@1.1`) |
| `POST policy/propose` | `{policy, note?}`: one `autonomy-policy@1.0` record | `{change, request}`: the `policy-change@1.0` record (`asked`) and the `policy-change` request that asks for it |

- The proposal goes to `ctx.approvals.proposePolicy` as the operator's (INV-6), at the server's
  clock. It applies nothing: the change comes into force only when the operator approves its
  request in the queue (`POST approvals/decide`, on the request's subject, the proposed set's
  hash), while the set it was proposed on is still in force.
- A proposal the queue refuses is `400` (`invalid`: the record, the version rule, or a load-time
  rule of the set it makes) or `409` (`not-asked`: the policy forbids `policy-change`), and
  nothing is stored. A queue at contract 1.0 answers `501`: its policy changes by configuration
  and a restart only.
- `note` is trimmed to 2000 characters and shown with the request.
- A change the queue proposed itself from repeated approvals
  ([approvals](../design/approvals.md#the-queue-proposes-a-policy-change)) has an `origin`: the
  queue entry's **Show change** says it was proposed by the queue, not the operator, with the
  command, the approvals counted, the window, and its decision, and the history marks it
  *(proposed by the queue)*. It is decided like any other request.

## Roster

Served always; each service it reads that is not mounted reads as unknown with why
([roster](../design/roster.md)).

| Route | Body | Answer |
|---|---|---|
| `GET roster` | — | the roster, an `mcp-roster@1.7` `roster-output` record ([record semantics](schemas.md#mcp-tool-roster)), as the operator reads it: account labels included; its `now` is capacity now ([capacity now](../design/roster.md#capacity-now)). A record its schema refuses is a defect: `500` with why |

- Any other method is `405`. The **Workers** tab (`?view=workers`, next to Board) shows the counts
  as Home's chips (*● 2 free*, and working, resting, unavailable, and quarantined when any; T239);
  **Right now**, folded there under its heading, the rows that need a look as chips on its summary
  (*▲ 1 quota unknown*), open while someone is stalled or cannot work, and rendered from the roster's `now` as the server made it
  (the page computes none of it, T152), by name, each said in words and never by colour alone, a
  count first and, past three names, the rest folded: *Free: 2 —* the Workers that take work now,
  the one whose quota would be lost unused soonest first, each with what is left (*Claude Code ·
  science · develop (90 % of 5 h left, resets 10:10)*), one the operator excludes from teams (D58,
  its roster entry's `teams`) said *excluded from teams: free for other steps, not team work*, and
  how many tasks are ready, linked to the Board; *Quota unknown:* each Worker whose account's quota
  cannot be read, why and that it is not counted free folded under *Why* (only when any); *Stalled:* each Worker with a
  stalled run (linked); *No quota left:* each account resting or at a limit and until when;
  *Cannot work:* each unavailable or quarantined Worker with why (T141); and *Ready:* each ready
  task with the Worker its start would likely go to (only when any); a part that could not be read
  is `unknown (why)`, never 0. The tasks ready the page counts are `now`'s when it read every active
  project, else the board's own count. Home's *Workers at a glance* renders this same section by the
  same function (T160); then the
  Workers by account: each account once, a card headed by its name and how many Workers
  (*Claude Code · science · 3 Workers*; its roles, *develop [code], review, review-2*, under its
  details), what stops it (its rest as a chip, *Resting until 02:16 (in 2 h)*; signed out,
  quarantined, signed in as the same person as another), its shortest window as a small bar and a
  line (*5 h used 9 %, resets 23:30*, as Home's capacity line), each of its Workers that cannot work
  or holds a capability off, and each run of theirs whose liveness needs a look, a line each by the
  Worker's work (*standard: ■ Not known to be gone · open run*, what to do folded), never folded;
  its Workers' cards under one fold, its summary their availability as chips; and, under its
  **Details**, its quota, each window as `5 h · used 9 % · resets 23:30` beside a small bar
  ([roster](../design/roster.md#surfaces); when each was read, *5 h read 22:05*), or *Quota not
  tracked* (Home's capacity line says *quota not tracked*, or *quota unknown*); the Workers of no
  account last, under their own header. Each
  Worker's card is calm: its work (its role or tier; its whole name for a Worker of no account),
  what it is for (its `description`), its status in the cross-page words (*Free*, *Working · 1/2
  slots · 1 slot free*, *Resting until 11:40 (in 2 h)*, *Unavailable — its account is signed out*,
  *Quarantined — what its reading found*), what it does now (each step by its task's title and for
  how long, *Working on "Fix the slow image build", for 4 min*, or a team member's answer, the
  roster's `summary` under its details; and each run whose liveness needs a look, with a link to its
  run), the capabilities held off until when, and, when the roster's `teams` says the engine's
  `teams.excludeWorkers` leaves it out (D58), an **Excluded from teams** chip with its **?** (its
  `summary` under its details; `unknown (why)` there when the engine could not tell). A reason that
  blocks work is never folded. Every other fact, and every fact that is unknown (shown as `unknown
  (why)`), is folded under the card's **Details** (its id, its `derived` line marked *derived* when
  no description is configured, its account's id, kind, and state, what it serves, and its load),
  and an account's own under the account's. Times read relative first, the clock time beside. A
  Worker source that was silent or failed in its last read is named above the cards, its Workers
  not listed: *<source> loading — counts incomplete* or *<source> unavailable — counts incomplete:
  why*, when folded. When the roster was read is under *Right now*. The tab refreshes every
  5 seconds like the rest of the page.
