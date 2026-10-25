# @tsuuanmi/system-web-ui

The **operator's web UI**, on the DSH webserver under `/ui` (loopback only). Every page is built
from the same few blocks (T172), one implementation each: a **status chip** (a word, a colour, and
a symbol of its own shape, never the colour alone), a **number with its unit** (*3 tasks*, *1/2
slots*, *2/3 steps*), a **relative time** with its exact time on hover and on keyboard focus, a
**fold** (a `details`, closed by default) for every explanation, mechanism, and technical fact, and
a **copy button** for ids and hashes, which are never the first thing in a row. Each page says what
it is for in a few words; one wording per concept across pages (*Needs your attention*; *Approve /
Deny* for approvals, *Accept / Send back* for reviews; *Automatic*, *Notify*, *Ask approval*,
*Blocked* for policy modes); facts are folded, never deleted. Production states: a *Loading…*
skeleton while a page first loads, *updated 12 s ago* in the header, a **stale** banner (what was
read and when) when a refresh fails over a page already shown, an error with **Try again** when a
page never loaded, a confirmation only before a destructive move (**Stop run**, **Close**), a **Skip
to content** link first in the keyboard order, a visible focus, no motion under reduced motion, and
prose capped at a readable line length on a full-width page.

**Buttons** (T191), one implementation (`decision`) on every page: a button that decides is labelled
by its concept's one wording, never by its effect: **Approve** / **Deny** on every approval (a
request's card on Home and on the policy page, a Board card, a start awaiting approval, a run's
plan; **Approve all N** / **Deny all N** for a batch), **Accept** / **Send back** on every review,
**Confirm** / **Cancel** in every confirmation (stopping a run, a project's **Pause…**, **Resume…**,
**Close…**, a ready task's **Start…**), and **Stop run**, **Retry failed step**, **Show change**,
**Propose**. What it does (*merges the change*, *keeps the branch only*, *marks it done*, *sends it
back for another attempt, if it has one left*, *stops this run: nothing more of it runs*) is its
accessible description (`aria-describedby`), said beside it in words for every reader.

- **Home**, a dashboard: what needs the operator's attention and they can act on (open approval
  requests, reviews held for them, runs that wait for their own move or failed outside the board
  since they last looked, each a label and its count, *Approvals · 3*, linked, then named one by one
  under its count (up to 5 a group, each linked to its card, with when it expires), and counted in
  the window's title on every page from one route, `GET waiting`: *(3) system — Home*), what happened since the
  operator last looked (5 lines, then **Show all N**, as for the runs needing attention, T186;
  kept in the browser only, until **Mark as seen**; `GET activity`; a failed
  run led by the run page's own plain-words reason, by one function, its raw text folded, T160), the
  Workers at a glance (with **Right now**, the Workers page's own section, so both name the same
  Workers), then those decisions and the recent runs by their tasks' titles, each step
  with its Worker's name; a running run's page and Board card say where it is now (its step, Worker,
  last event, and a stall; `GET runs/live`), and a start names who would likely take each step.
  Both reads are bounded per request and read the newest first: the runs by state and by when
  their state changed (`ctx.workflow.usage` with a filter), however long ago they started, and the
  event log newest first (`ctx.eventLog`, contract 1.1), each part with `more` past its bound and
  `{unknown}` with why when it cannot be read (T127); and *Starts awaiting approval* (ADR-0064): each
  start the dispatch pass proposes, with its task, attempt, Worker, each window of its account
  (`5 h · used 12 % · reserve 20 % · resets 14:20`), and, folded, why that Worker, approved or
  denied there by the queue's own verdict on the request's exact subject; whether automatic starts
  are off or paused (the reason in sight, how to resume folded); the approved starts waiting for
  their Worker; and, folded, why each ready task did not start at the last look (`GET dispatch`,
  [the page](../../../docs/reference/web-ui.md#dispatch));

- **Help** (`?view=help`): how System works in plain words, each answer folded under its question
  (Workers, the task lifecycle as a flow of states, your decisions, autonomy, troubleshooting), with
  links into the pages, and a searchable glossary whose definitions are folded (a link to a term
  opens and focuses it); a **?** beside each such word on the pages opens its sentence in place by
  keyboard or touch, linked to its entry; every empty state is one short line, with a link where
  there is a next step ([help](../../../docs/reference/web-ui.md#help));
- a run's page: headed by its task's title (else its template), its project and attempt below and
  its id behind **Copy run ID**, a status chip with where it is (its step and Worker, a failure's
  reason in plain words, or what it waits on), **What happened** in a line each (*Continued from
  attempt 1*, or *Started over — why*,
  [ADR-0061](../../../docs/decisions/adr/0061-a-tasks-next-attempt-starts-from-the-work-its-previous-attempt-left.md);
  *Team member 1's answer: retried once after a service error*,
  [ADR-0062](../../../docs/decisions/adr/0062-a-team-members-first-step-is-resent-once-after-a-sites-own-error.md);
  where its accepted result stands, ADR-0060; the mechanics folded), what the operator can do, the
  answer, and its steps as a timeline in words (a team's steps by member, a failure's kind in words,
  an earlier attempt's error under *Attempt history*), ids, decisions, and spec folded;
- runs, each with its state as a chip and its progress (*1/2 steps · waiting: …*) and current
  Worker in one line, every step's Worker, its template, and its id folded, and when it started; the
  run's page has every step;
- each step's Worker, tier, quota class, and decision chain (egress, tier,
  route, acceptance, recovery);
- the answer;
- the operator's **Approve / Deny** on a plan, **Vote** on a team's tie, **Stop run** (after a
  confirmation), and **Retry failed step**;
  a remediation fix whose plan is on the approval queue shows its request instead of the plan
  buttons, and is decided in the queue;
- when `ctx.approvals` is present, the **approval queue**
  ([approvals](../../../docs/design/approvals.md)) above the runs, under *3 approvals · next expiry
  in 12 min*: open requests by batch (*2 related requests*, **Approve all 2**, its id folded), each
  a card of one line (what is asked, for which task, *Expires in 12 min · No response: denied*, an
  irreversible verdict as a chip) and two buttons, **Approve** and **Deny**, each described by its
  effect (*merges the change*, T191), with, on a `policy-change` request, **Show change** beside
  them (the effective modes it moves and the record's diff, and, for a change the queue proposed
  itself, that it did and why; never folded); everything else under the card's one closed
  **Details** (T186), kept open through the refresh once opened: the request
  in plain words (what is asked, who asked by a readable name, what approving and denying change,
  *Expires in 12 min · No response: denied*, the exact subject behind **Exact subject**, and what a
  verdict does in words, its long hashes folded behind **details**; an accepted result's merge
  names its task and *not pushed*, asked by the run of that task, says what approving and denying
  do in words, and folds the branch, both heads, and the requester's own text with its paths and
  hashes; the request id, its exact expiry, and the requester's run, session, step, and change ids),
  and an optional note for the verdict; a batch's **Approve all N** / **Deny all N** have a note
  for all. What a verdict did (what happens next,
  or not recorded and why, its record ids folded) stays above the page until dismissed
  ([the page](../../../docs/reference/web-ui.md#approval-queue)). Without it the page shows the runs alone and the queue routes answer `503`;
- when `ctx.approvals` is present, the **autonomy policy** page (`?view=policy`): the set in force
  (*Active policy · Configuration* or *Active policy · Approved change*, the change id and hash
  folded), the modes as chips (*Automatic*, *Notify*, *Ask approval*, *Blocked*; what each means
  and the stored values folded under *About modes*), the effective mode of every action type for
  the studio and each project, the policies, the latest changes (policy and version, a state chip,
  when, *3 actions changed* folded, its id behind a copy button) with their diffs, and **Propose a
  change**: the operator edits one policy record (the next version, or a new project's policy) as
  a form (a mode per action type, the types that always ask fixed at *Approval required* with why
  folded, a row saying only its required checks and expiry, the commands as lines, the expiry and
  batch numbers; the JSON folded under **Advanced**), sees the change, and proposes it. The proposal is asked
  in the queue as a `policy-change` request on the exact hash of the set it makes, and applies only
  when the operator approves it there ([a policy change](../../../docs/design/approvals.md#a-policy-change)).
  An asked change's card, with its **Approve** and **Deny**, is at the top of the page, and its
  history row links to it; every other pending decision (a charter or a task's approval on the
  Board, a run's fix) links to its card on Home (`?request=<id>`).
  A queue at contract 1.0 takes no proposal (`501`);
- when `ctx.board` is present, the **reviews**: every board task in review, those the board
  holds for the operator first ([board](../../../docs/design/board.md#required-checks-bind-at-acceptance)),
  each with its project, exact subject, result artifacts, each required check with its state (passed
  or failed with its exit code only on the run's record at acceptance, not run and why, or pending;
  [ADR-0063](../../../docs/decisions/adr/0063-a-runs-required-checks-run-on-its-exact-result.md), T160),
  the checks still pending, its run, and
  until when it waits; what it changed (each file of its worktree's change, folded, read through
  `ctx.workers.changes`), what its reviewers said, and what its checks measured (the run's report),
  with the checks still pending in warning (those recorded as failed apart from those not run); and the operator's **Accept / Send back**,
  each described by what it does. The card (T186) leads with one line, then the change (*3 files +19 −1*), each required check, and
  each reviewer's verdict as chips, the warnings, and the two buttons; every long text (the diff,
  the findings, the report, why a check has no result, the exact result) is under its closed
  **Details**; then, once accepted,
  where the result stands on its way into the repository, until it is merged or refused
  ([what a review shows](../../../docs/reference/web-ui.md#what-a-review-shows)); above them, and on Home's waiting
  line, when the first review held for the operator expires (marked within the hour), since an
  unanswered one expires and its task waits for input that nothing revives (T99 D6). Without it
  the reviews routes answer `503`;
- when `ctx.board` is present, the **board** page (`?view=board`), a Kanban: a project filter (all
  by default, kept in the address as `&project=<id>`); each project's header with its state as a
  chip and its open tasks (its id and charter version folded), its state as counts (*Needs you 3 ·
  Working 1 · Ready 1 · Proposed 0*, what needs you by kind folded), what of it needs the operator
  (*Charter approval needed*, *2 task approvals*, linked), and the moves; free Workers and ready
  tasks (how a ready task starts folded); then a column per task state (Proposed, Ready, Working,
  Review, Needs your attention, which comes first on a narrow screen, each empty one a short line;
  Done and Cancelled folded), one card per task with its title, when it changed and its action
  type, who works on it (the Worker's name, since when), its template and who its first step would
  likely go to on a ready card (*Likely Worker: …*, the others folded), what it needs as a chip
  (*Approval needed*, *Review needed*, *Input needed — why*) with its expiry, and **Open run**; a
  request a card waits on (a task's approval, an accepted result's merge) has its own **Approve**
  and **Deny** on the card, on the request's exact subject, as on Home; a done task's card says
  where its accepted result is on its way into the repository (*Merge approval needed · into main*,
  with those buttons, under Needs your attention; merged, with the commit; or not merged, and why;
  [landing](../../../docs/design/workflow-engine.md#landing-an-accepted-result)).
  A ready task's **Start…** starts its run as the lead does (MCP `run` with `task`): a
  confirmation says what runs (*solo template · attempt 1 of 3 · 1 step*, each step with a short
  requirement, *standard+ · reason*, and its likely Worker, from `ctx.workflow.templateSteps`; what
  a start does folded), the start is bound to the task revision and template shown, and a
  task that names no template is refused with why
  ([starting a ready task](../../../docs/reference/web-ui.md#starting-a-ready-task)).
  The operator's **Pause**, **Resume**, and **Close** (achieved or stopped)
  ([the operator's project moves](../../../docs/design/board.md#the-operators-project-moves)).
  Each opens a confirmation that says what the move does to this project (what goes on, what is
  cancelled and released, which approval requests are withdrawn, or why a close is refused), and
  moves nothing until **Confirm**; **Cancel** closes it. The page does not refresh while a
  confirmation is open. Without the board the projects routes answer `503`;
- the **Workers** tab (`?view=workers`, next to Board; REQ-HOST-8), read through `readRoster` in
  [`gateway-core`](../../gateway-core/README.md#the-roster) from the services mounted (`workers`,
  `accounts`, `agentWorkers`, `resources`, `eventLog`, the engine, `board`): the counts (working,
  free, resting and until when the first is, unavailable); **Right now**, rendered from the roster's
  `now` as the server made it (`readCapacity`, T152; the page computes none of it), by name: who is
  free, the quota lost soonest unused first, with what each has left, one excluded from teams said
  free for other steps, not team work (D58, T160) (and how many tasks are ready,
  linked to the Board), whose quota is unknown (never counted free), who is stalled, which accounts
  have no quota left and until when, who cannot work, and each ready task's likely Worker, each a
  count first (*No quota left: 1 — …*), past three names the rest folded; then the Workers by account, each
  account once under a small header with its name and how many Workers (`Claude Code · science · 3
  Workers`, [display names](../../../docs/design/roster.md#display-names); its roles under its
  details), what stops it (resting until when, signed out, quarantined, one person on two
  accounts), and its quota, each window of its pools as `5 h · used 42 % · resets 14:20` beside a
  small bar
  ([ADR-0059](../../../docs/decisions/adr/0059-quota-readings-from-each-accounts-own-usage-report.md):
  the window by its length, its share, and its reset, on the clock with the day when not today,
  when it was read under the account's details; `at its limit` first, and listed first, while it
  is limited; `5 h · no reading yet: <why>` before any reading, windows of one reason on one
  line); a Worker source not yet read or failed as *<source> loading — counts incomplete* (or
  *unavailable*, with its reason); the Workers of no account last. Each Worker's card is calm: its
  work (role or tier), what it is for, its status in the cross-page words (*Free*, *Working · 1/2
  slots · 1 slot free*, *Resting until 02:16*, *Unavailable — why*, *Quarantined — what its reading
  found*), what it does now (its task by title and for how long, or a team member's answer, and
  each run whose liveness needs a look, each a link to its run), the capabilities held off, and an
  **Excluded from teams** chip when the engine's `teams.excludeWorkers` leaves it out of teams
  (D58, the roster's `teams`); an account with no quota tracked says *Quota not tracked*; every unknown (`unknown (why)`),
  derived, or technical fact (its id, its derived line, its account's id, kind, and state, what it
  serves, its load) is folded under its **details**, and a reason that blocks work never is
  ([roster](../../../docs/design/roster.md)). Home's Workers box shows each account's capacity in
  one line, its 5 h bar beside it. A Worker source that did not answer is named above the cards.

When the roster was read is folded under *Roster read*; the header's *updated 12 s ago* says when
the page was.

The routes are in the [web UI API](../../../docs/reference/web-ui.md).

## Use

`system ui` prints the link: `http://127.0.0.1:<port>/ui/#token=…`, with the
operator token in the fragment. Open it on
the host, or over `ssh -L <port>:127.0.0.1:<port> host` like the login desktop.

## Security

- **Shell:** the page, script, and styles carry no data. They are served
  `no-store`, `no-referrer`, and `nosniff` under a strict content security
  policy: scripts and styles from `self` only, no frames, no forms.
- **Token:**
  - it travels in the URL **fragment**, which a browser never sends to a
    server;
  - the script moves it to session storage and removes it from the address bar;
  - it then sends it as `Authorization: Bearer` to `/ui/api`.
- **API guard**, the one every client endpoint shares
  ([`gateway-core`](../../gateway-core/README.md#the-request-guard)), in order:
  - a loopback `Host` (against DNS rebinding);
  - no `Origin` other than the UI's own (`sameOrigin`);
  - the operator token (`operator.token` under `tokenDir`), compared in
    constant time. A client or model token gets `401`.

  A page on another site cannot read the token and gets no CORS answer.
- **Bind:** on plain HTTP on a non-loopback host, `/ui` is not registered
  (`assertSafeBind`).
- **Actions** take a JSON body only (a form post cannot reach them) and go to
  the workflow engine as operator decisions. A plan's Approve and Deny send the plan
  the page shows (`plan`, a `sha256:` id), so the engine decides only that plan
  (INV-5). A vote sends the tie decision the page shows, an option or
  `inconclusive`, and a rationale; it is recorded as the operator's.
- **Policy proposals** go to `ctx.approvals.proposePolicy` from this channel and MCP
  `approvals_policy_propose` (operator scope) only (INV-6); a proposal is never applied by its
  route, only by the operator's verdict on its request in the queue.
- **Queue verdicts** go to `ctx.approvals.decide` as the operator's (INV-6), at
  the server's clock, each with the exact subject of the request the page
  shows (INV-5); a batch verdict names its batch, and a request outside it
  refuses the whole call. This is the operator's human channel for verdicts:
  MCP clients get no new path (`approvals_decide` stays operator scope).
- **Review verdicts** are `acceptance` decisions made by the operator (decider and producer
  `operator`), naming the task, the exact subject of the result the page shows (a result on
  another subject is refused, INV-5), and every result artifact, then applied with
  `ctx.board.accept`. Like the queue's, this is the operator's human channel: no MCP tool
  accepts a review.
- **Project moves** go to `ctx.board.pause`, `resume`, and `close` from this channel and the
  operator-scope MCP tools `board_pause`, `board_resume`, and `board_close` only (INV-6), at the
  server's clock. Each sends the project revision the page showed: a project changed since is
  refused (`409`) and nothing moves. The board records each move's `board` decision (INV-13).
- **Rendering:** the page is built with DOM methods and `textContent` only.
  Model output is never parsed as HTML.
- **Scope:** only the operator scope reaches `/ui`
  ([scopes](../mcp-server/README.md#scopes)).

**Injects:** `webServer`, `workflow`; `approvals`, `board`, and `artifacts` are optional
(`ctx.get`), so the UI works without the queue or the board; for the roster it reads `workers`,
`accounts`, `agentWorkers`, `resources`, and `eventLog` when present.

**Tests:** [`tests/web-ui.spec.ts`](tests/web-ui.spec.ts): the shell and its
headers, the guard, the run actions, the queue's routes (listing by batch,
verdicts bound to the subjects shown, a batch verdict bound to its batch, each
refusal, `503` without a queue or a board), the roster route (operator only, valid against
`mcp-roster@1.6`, labels shown, display names, a Worker's runs whose liveness needs a look, unknown without a
Worker registry), and, with a browser, the runs, the queue (labels by effect, a batch verdict, a
refused one as an alert), a press a refresh lands on that still counts, a verdict not recorded
that stays as an alert through refreshes until dismissed, and the Workers tab (counts in the
operator's words, the Workers by account under its header, each card calm with its unknown,
derived, and technical facts folded under its details, a reason that blocks work shown, the step
in one sentence, each pool window's share, reset, and read time or `unknown (why)`, Home's
capacity line per account, and a run held for want of a verdict with what frees it and a link to
its run), on a page whose clock stands at a fixed instant in UTC, so each time it shows is named
exactly whenever the test runs; Home's waiting items by name, each linked to its card; a run's
*What happened* (continued from the previous attempt's work, a team member's answer retried once,
its result merged, each mechanism folded; an earlier attempt's error under *Attempt history*, never
as the step's failure); **Stop run** sent only after its confirmation; and a Worker excluded from
teams, *Right now* by name, and an engine that cannot tell folded (T141); and the same free,
stalled, and no-quota names on Home as on the Workers page, a free Worker excluded from teams never
offered for team work (T160). Its building-block suite
(T172) checks, on Home, a run's page, Workers, and Help, that every chip has its symbol and word,
every relative time its exact time on hover and focus, every fold is closed at first, no row
starts with an id, a count with its unit, and the copy button; a *Loading…* skeleton still under
reduced motion, and **Skip to content** first in the keyboard order with a visible focus; and a
stale banner, with when the page was read, while a refresh fails, gone once one succeeds, and a page
that never loaded said with **Try again**. Its round 8 tests (T186) check that each approval card shows
one line and **Approve / Deny** only, every fact under its one **Details**, closed at first and
opened by keyboard; that Tab reaches every button in sight; that *Since you last looked* and *Runs
needing attention* show 5 rows and a **Show all N** that keeps every row through the refresh; and
that each page header has one short sentence at most. Its wording suite (T191) checks every
decision's label (*Approve* / *Deny* on a request's card, a batch, and a run's plan; *Accept* /
*Send back* on a review; *Confirm* / *Cancel* when stopping a run, pausing or closing a project,
and starting a task), that each button's accessible description names what it does, and that no
label still carries its effect.
[`tests/store-backed.ts`](tests/store-backed.ts) boots the UI over the store-backed board,
approval queue, and engine under the bundle's own default studio policy, for three suites.
[`tests/policy.spec.ts`](tests/policy.spec.ts): a proposed version asked in the queue on its
exact hash and applied only on approval, with its `policy-change` decision, a waiting board task
re-gated by the board's next sweep; a rejection that changes nothing; a restart that keeps the
applied set, a changed configuration that refuses the queue until it supersedes the stored set; a
client token refused; proposals the load-time or version rules refuse; a change the queue proposed
itself, shown with its origin and applied only on the operator's approval; and, with a browser,
the policy page's diff, a proposal, its queue entry, and its approval, the policy edited as a
form (each mode, the classes that always ask fixed, commands, expiry, batch, the JSON following,
the queue's refusal shown), and a queue entry that says
the queue proposed the change, and why.
[`tests/reviews.spec.ts`](tests/reviews.spec.ts) runs the UI over the same composition: a run's
change, verdicts, and report served to the operator only (a source that cannot read its own named),
and, with a browser, a review card led by its chips (the change, each check, the verdict), its
**Accept** and **Send back** then **Details** reached by Tab, and under them what changed (stat, files folded, show all), the verdict,
the report, the checks not run in warning, and after Accept where the result stands; a workspace-write task's
review held for the operator past its run's lease, listed with its pending checks, refused to a
client token, bound to the subject shown, accepted to done; a send-back as another attempt; a
review that expires `review-expired`; and each required check with its state from the run's
acceptance (passed and failed with their exit codes only on a record, not run and why, pending;
never passed without a record), listed on the card, a failed check the board still holds pending
warned as failed, never as not run (T160).
[`tests/help.spec.ts`](tests/help.spec.ts), with a browser: Help in the navigation, its sections
and links, its answers folded (the lifecycle's states, each troubleshooting symptom), the
glossary's anchors opened and focused by a link (without a token too), its search, each term's
definition folded until opened, each **?** named and controlling its note, opened and closed by
keyboard and linked to Help, and the empty states, one short line each.
[`tests/live.spec.ts`](tests/live.spec.ts): what happened since a time (runs ended, tasks moved,
requests expired) for the operator only, the Workers that could likely take a start's step, a
running run's steps, last event, and a stall; and, with a browser, Home's *Since you last looked*
until marked as seen, a failed run there led by the run page's plain-words reason with the raw
text folded (T160), the waiting count in the window's title, the start's likely Workers, and a
running run's page and Board card.
[`tests/dispatch.spec.ts`](tests/dispatch.spec.ts): `GET dispatch` for the operator only (the
settings, an ask with its Worker and windows, the bounds, the last pass); and, with a browser,
Home's *Starts awaiting approval* naming the start with its Worker and quota line, why that Worker
folded, starting it on **Approve**, and saying when automatic starts are paused, how to resume
folded (over a resource ledger the harness adds).
[`tests/projects.spec.ts`](tests/projects.spec.ts): the projects listed with their open tasks; a
pause and a close refused to a client token, bound to the revision shown; a paused project whose
ready task the engine does not run and whose proposed task is not gated, resumed and run to done;
a close refused while a task is in review, then cancelling the open tasks, releasing a claim, and
withdrawing the requests a waiting task and a pending amendment were on, in the store-backed queue;
a ready task's run started for the operator's token only, bound to the revision and template
shown, refused for a task naming no template; and, with a browser, a ready task started from its
card after its confirmation (moving to Working) and a task naming no template refused with why;
every page laid out at 600 px (none wider than the screen, the columns stacked with Needs your
attention first, whole nav links); each project's state as counts and the filter kept in the address; a
ready card's likely Worker; an accepted result's merge approved by the button on its card, its
request on Home in words (T141);
a charter founded from the queue (what approving and denying do, with the
project's task counts; the approval recorded and reported with its ids; the project active after
the board's sweep), a pause and a close each made only after its confirmation, and a Cancel that
moves nothing. [`tests/web-ui.spec.ts`](tests/web-ui.spec.ts) also checks the projects routes
answer `503` without a board.
