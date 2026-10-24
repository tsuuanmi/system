# @tsuuanmi/system-web-ui

The **operator's web UI**, on the DSH webserver under `/ui` (loopback only):

- **Home**, a dashboard: what waits for the operator (approvals, reviews, runs that need a look,
  each linked), the Workers at a glance, then those decisions and the recent runs;

- runs, each with its steps in one line (how many completed, and those failed, waiting, or
  running, by name) and when it started; the run's page has every step;
- each step's Worker, tier, quota class, and decision chain (egress, tier,
  route, acceptance, recovery);
- the answer;
- the operator's **Approve / Reject plan**, **Vote** on a team's tie, **Stop run**, and **Continue run**;
  a remediation fix whose plan is on the approval queue shows its request instead of the plan
  buttons, and is decided in the queue;
- when `ctx.approvals` is present, the **approval queue**
  ([approvals](../../../docs/design/approvals.md)) above the runs: open requests by batch, each
  in plain words (what is asked, who asked, what approving and denying change, when it expires,
  the exact subject behind **Exact subject**), and the operator's **Approve / Deny**, labelled by
  their effect, for one request or a whole batch, each with an optional note. What a verdict did
  (recorded, with its ids and what happens next, or not recorded and why) stays above the page
  until dismissed ([the page](../../../docs/reference/web-ui.md#approval-queue)); a `policy-change`
  request shows the change it asks for (**Show change**: the effective modes it moves and the
  record's diff, and, for a change the queue proposed itself, that it did and why). Without it the page shows the runs alone and the queue routes answer `503`;
- when `ctx.approvals` is present, the **autonomy policy** page (`?view=policy`): the set in force
  (its hash, and whether it is the configuration or a change the operator approved), the
  effective mode of every action class for the studio and each project, the policies, the latest
  changes with their diffs, and **Propose a change**: the operator edits one policy record (the
  next version, or a new project's policy), sees its diff, and proposes it. The proposal is asked
  in the queue as a `policy-change` request on the exact hash of the set it makes, and applies only
  when the operator approves it there ([a policy change](../../../docs/design/approvals.md#a-policy-change)).
  An asked change's card, with its **Approve** and **Deny**, is at the top of the page, and its
  history row links to it; every other pending decision (a charter or a task's approval on the
  Board, a run's fix) links to its card on Home (`?request=<id>`).
  A queue at contract 1.0 takes no proposal (`501`);
- when `ctx.board` is present, the **reviews**: every board task in review, those the board
  holds for the operator first ([board](../../../docs/design/board.md#required-checks-bind-at-acceptance)),
  each with its project, exact subject, result artifacts, the checks still pending, its run, and
  until when it waits, and the operator's **Accept / Reject**. Without it the reviews routes
  answer `503`;
- when `ctx.board` is present, the **board** page (`?view=board`): every project, the closed ones
  last, with its state, charter version, a pending amendment, and its open tasks per state, and
  the operator's **Pause**, **Resume**, and **Close** (achieved or stopped)
  ([the operator's project moves](../../../docs/design/board.md#the-operators-project-moves)).
  Each opens a confirmation that says what the move does to this project (what goes on, what is
  cancelled and released, which approval requests are withdrawn, or why a close is refused), and
  moves nothing until **Confirm**; **Cancel** closes it. The page does not refresh while a
  confirmation is open. Without the board the projects routes answer `503`;
- the **Workers** tab (`?view=workers`, next to Board; REQ-HOST-8): the counts (working, idle, at a
  limit and when the first is back, unavailable), then one card per Worker grouped by status, read
  through `readRoster` in [`gateway-core`](../../gateway-core/README.md#the-roster) from the services
  mounted (`workers`, `accounts`, `agentWorkers`, `resources`, `eventLog`, the engine, `board`):
  what it is for (the operator's `description`, else its derived line, marked *derived*); its
  status and why in plain words; what it does now, one sentence per step with for how long, each
  a link to its run; its account, with the account's label and its enrolled, ready, signed-out, or
  quarantined state; what it serves (tier, quota class, locality, provider, family, role); its
  limits, with each reset relative and on the clock; and its load
  ([roster](../../../docs/design/roster.md)). A fact a source could not give shows as
  `unknown (why)`, and a Worker source that did not answer is named above the cards.

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
  the workflow engine as operator decisions. Approve and Reject send the plan
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
`mcp-roster@1.1`, labels shown, unknown without a Worker registry), and, with a browser, the runs,
the queue (labels by effect, a batch verdict, a refused one as an alert), a press a refresh lands
on that still counts, a verdict not recorded that stays as an alert through refreshes until
dismissed, and the Workers tab (counts, cards by status, a description or a derived line marked,
the step in one sentence).
[`tests/store-backed.ts`](tests/store-backed.ts) boots the UI over the store-backed board,
approval queue, and engine under the bundle's own default studio policy, for three suites.
[`tests/policy.spec.ts`](tests/policy.spec.ts): a proposed version asked in the queue on its
exact hash and applied only on approval, with its `policy-change` decision, a waiting board task
re-gated by the board's next sweep; a rejection that changes nothing; a restart that keeps the
applied set, a changed configuration that refuses the queue until it supersedes the stored set; a
client token refused; proposals the load-time or version rules refuse; a change the queue proposed
itself, shown with its origin and applied only on the operator's approval; and, with a browser,
the policy page's diff, a proposal, its queue entry, and its approval, and a queue entry that says
the queue proposed the change, and why.
[`tests/reviews.spec.ts`](tests/reviews.spec.ts) runs the UI over the same composition: a workspace-write task's
review held for the operator past its run's lease, listed with its pending checks, refused to a
client token, bound to the subject shown, accepted to done; a rejection as another attempt; and a
review that expires `review-expired`.
[`tests/projects.spec.ts`](tests/projects.spec.ts): the projects listed with their open tasks; a
pause and a close refused to a client token, bound to the revision shown; a paused project whose
ready task the engine does not run and whose proposed task is not gated, resumed and run to done;
a close refused while a task is in review, then cancelling the open tasks, releasing a claim, and
withdrawing the requests a waiting task and a pending amendment were on, in the store-backed queue;
and, with a browser, a charter founded from the queue (what approving and denying do, with the
project's task counts; the approval recorded and reported with its ids; the project active after
the board's sweep), a pause and a close each made only after its confirmation, and a Cancel that
moves nothing. [`tests/web-ui.spec.ts`](tests/web-ui.spec.ts) also checks the projects routes
answer `503` without a board.
