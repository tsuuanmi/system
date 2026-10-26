# Workflow templates

> Hand-written from `DEFAULT_TEMPLATES` in
> [`packages/plugins/workflow/src/spec.ts`](../../packages/plugins/workflow/src/spec.ts) and the
> profiles' `ctx.workflow.template` calls; no generator checks it. Update it with any template
> change. Mechanism: [workflow engine](../design/workflow-engine.md). Run one with
> `system run <template> …` or the MCP tool `run` ([CLI](cli.md), [MCP tools](mcp-tools.md)).

A template is a list of nodes. Each node names the capabilities a Worker must prove, a minimum
tier, a conversation mode, and the acceptance contract its result must pass. The engine checks
every template at load (preflight) and refuses a run whose contracts are not registered.

| Field | Meaning |
|---|---|
| Capabilities | what routing admits Workers by ([capability vocabulary](../design/routing.md#capability-vocabulary)); a node in a session also requires `persistent-conversation`; a review team member's step is also review-member work ([scoped offers](../design/routing.md#scoped-offers)) |
| Tier | the minimum tier; *caller* means the caller's `tier` replaces it |
| Kind | optional: the kind of work the step is, a label such as `code` (a variant may change it); a Worker the operator gives kinds takes only steps of those kinds, a Worker given none takes any ([work kinds](../design/routing.md#work-kinds)). Only [`research`](#research)'s two literature reviews name one (`research`), so a [research role's](../design/agent-runtimes.md#a-research-role) Worker takes them and nothing else |
| Prefers | optional: capabilities the step would like and does not need (at most 8, distinct, none already needed; not on a team or source step). Routing ranks a Worker that proves all of them first and never refuses one that does not (`work-requirement@1.3`, [research's second review](../design/routing.md#researchs-second-review)) |
| Conversation | `temporary`: a new one-shot conversation; `persistent`: the caller's session or a new one; `caller`: the caller's session, or a new one with `persist`; `own`: a new persistent conversation of this node alone ([conversations](../design/workflow-engine.md#conversations)) |
| Acceptance | the contract the result must pass; a rejected result may escalate one tier (`maxEscalations`, default 1) |
| Diversity | optional, with `differentFrom`: `required` (default) fails closed when no Worker of another provider family is admitted (unless `allowSameFamily`); `preferred` runs the step once on the family it differs from, in a conversation of its own, recorded `single-family` and stated to every later step and in the answer ([`research`](#research)) |

A node's prompt is text with placeholders the engine fills when the node is promoted
([briefs](../design/workflow-engine.md#briefs)): `{{input}}`, the caller's input;
`{{node:<id>}}`, the result of a node it depends on, by content id; `{{grown}}`, after a planner,
the steps it added with their results. Preflight refuses any other `{{` (an unknown name such as
`{{inptu}}`, another spelling such as `{{ input }}`, no closing `}}`); `{{team}}` is the engine's
own, in a team's ballot. A Worker never reads a placeholder as it is: one the engine cannot fill
fails the step as `config_error` before anything is sent. A `{{…}}` in the caller's input or in a
result is data, sent as written.

## Built-in templates

Provided by [`workflow`](../../packages/plugins/workflow/README.md): `ask`, and the teams
`brainstorm` and `review`.

### `ask`

One answer from one Worker. `system ask` and the MCP tool `ask` run it.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `ask:1` | `reason` | standard (caller) | caller | `acceptance.answer` |

### `brainstorm`

A [team](../design/teams.md) of 2 members, one per provider family, that recommends an answer to a question by
vote, as advice to the caller ([ADR-0028](../decisions/adr/0028-local-lead-final-authority.md)). Each member's recommendation is one option (`O<k>`). The MCP tool `brainstorm` and
`system brainstorm` run it.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `brainstorm:m<k>:propose` (independent; member k differs from members 1..k-1) | `reason` | standard | the member's own session | `acceptance.team-proposal` |
| `brainstorm:m<k>:ballot:1` (sealed) | `reason` | standard | the member's own session | `acceptance.team-ballot-<n>` |
| `brainstorm:tally:1` | none (`team` executor) | — | — | — |
| `brainstorm` (decision) | none (`team` executor) | — | — | — |

On a split vote with an objection open, `brainstorm:tally:<r>` appends
`brainstorm:m<k>:debate:<r>` (the member's session, `acceptance.team-ballot-<n>`) and
`brainstorm:tally:<r+1>`, at most `debateRounds` times.

### `review`

A source step, then the same team procedure over what it read: the caller's public repository
at one pinned commit, or else the caller's text as the one file `material`
([sources](../design/teams.md#sources)). Each member's proposal prompt is the caller's input
followed by the source; for the caller's text, which is the file `material` too, the input is one
line naming that file, so the text is shown once. The options are `pass` and `changes`, over the members' findings merged
by quoted line; a confirmed blocking finding decides `changes`. The MCP tool `review` and
`system review` run it.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `source` (a repository at one commit, or the caller's text) | none (`effect` executor: the engine reads it) | — | — | — (records an `acceptance` decision `workflow.source-snapshot`) |
| `review:m<k>:propose` (independent findings; member k differs from members 1..k-1) | `reason` (review-member work) | standard | the member's own session | `acceptance.team-findings` |
| `review:m<k>:ballot:1` (sealed) | `reason` (review-member work) | standard | the member's own session | `acceptance.team-ballot-review` |
| `review:tally:1` | none (`team` executor) | — | — | — |
| `review` (decision) | none (`team` executor) | — | — | — |

Debate steps are appended as for `brainstorm`, with `acceptance.team-ballot-review`.

Every member step (proposal, ballot, debate) routes as review-member work (`scope: review-member`,
[scoped offers](../design/routing.md#scoped-offers)). So a member is a website or model Worker, or
a read-only agent Worker under the enforced review-member profile
([ADR-0049](../decisions/adr/0049-read-only-agent-workers-as-review-members.md);
[agent runtimes](../design/agent-runtimes.md#review-members)): no tool call of its step runs, and
its material is its prompt alone. Its source keeps its conversation natively or, on a runtime that
cannot resume, by an exact, recorded replay; one it can do neither for fails the step unsent. Each
member is asked at least twice (its proposal, then its ballot), so a member always needs its
conversation, single-round or not.

## Profile templates

### `research`

Provided by
[`profile-scientific-research`](../../packages/plugins/profile-scientific-research/README.md).
`system research` and the MCP tool `research` run it. Its `deep` variant
([variants](../design/workflow-engine.md#variants)) changes only the two literature reviews;
start it with `system research --deep`, MCP `research` with `deep: true`, or `run` with
`variant: deep`.

The two reviews run in parallel, on two provider families
([different provider families](../design/workflow-engine.md#different-provider-families)):
review A (`literature:1`) proves web search; review B (`literature:2`) runs on another family,
which prefers a Worker that proves web search too (T262, D91: a read-only
[research role's](../design/agent-runtimes.md#a-research-role) Claude Worker, then one that only
reasons), so a provider that need not prove a search is gated by its citations. `evidence:1` reads both,
labelled A and B, and records which review states each claim (`reviews`). `conclusion:1` says
where the reviews agree and differ.

Two families are preferred, not required (`diversity: preferred` on `literature:2` and
`critique:1`; operator decision D89). When no Worker of another family can take one of them
(none admitted: unavailable, signed out, over its input bound; or the one that took it failed:
stalled after the prompt, failed on the infrastructure, answered with the site's own error),
that step runs once on the first family's provider, in a fresh conversation that never sees the
step it differs from, rather than failing, waiting, or being resent there. The prompt is never
sent again to the Worker that failed it. Never silently:
- an `admission` decision by `workflow.diversity`, outcome `single-family`, names why the other
  family could not take it (after a failure, a `recovery` decision `single-family` first);
- every later step built on it (`evidence:1`, `critique:1`, `conclusion:1`) is told in its brief
  that the two share one family (`Single family: …`) and to weigh their agreement as weaker;
- the run's answer starts with `Single family: …`, and the run's page in `/ui` shows a
  `single family` chip.

It happens once per step: a fallback that fails too fails the step as before, never retried or
resent. A run where both families answered is unchanged. The template's preference decides even
with `allowSameFamily` on (it records `single-family`, never `same-family`).

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `frame:1` | `reason` | standard | persistent (the run's conversation) | `resultSchema: hypothesis-set@1.0`, then `acceptance.answer` |
| `literature:1` (review A) | `reason`, `web-search` | standard | temporary | `acceptance.cited` |
| `literature:2` (review B; differs from `literature:1`, preferred; prefers `web-search`) | `reason` | standard | temporary | `acceptance.cited` |
| `literature:1`, `literature:2` (variant `deep`) | `reason`, `deep-research` | frontier | own (each review its own conversation) | `acceptance.cited` |
| `evidence:1` | `reason` | economy | persistent (the run's conversation) | `resultSchema: evidence-table@1.1`, then `acceptance.answer` |
| `critique:1` (differs from `evidence:1`, preferred) | `reason` | standard | temporary | `acceptance.answer` |
| `conclusion:1` | `reason` | standard | persistent (the run's conversation) | `acceptance.cited-conclusions` |

The synthesis steps (`frame:1`, `evidence:1`, `conclusion:1`) run in order in the run's one
conversation (the caller's session, if it named one), on one account (session affinity). Each
still receives its inputs inline. The two reviews and the critique each run in a conversation of
their own, so none of them sees the thread it feeds or judges. A run opens four conversations,
not six. The run's conversation is recorded, and deleted at retention like any other.

When the account the conversation is on can never take a later synthesis step (its input
bound, a capability it lacks), that step runs once off the conversation, on another Worker,
instead of failing the run: without the conversation, since each synthesis step quotes the
results it builds on (`sessionless`), and `conclusion:1` back on the conversation is handed
`evidence:1`'s result if `evidence:1` ran off it. A `route` decision by `workflow.session-move`
records it ([sessions](../design/sessions-and-messaging.md#a-step-its-sessions-worker-cannot-take)).

### `agent-review`

Provided by
[`profile-software-development`](../../packages/plugins/profile-software-development/README.md),
whose row is off in the default composition, though the Claude Code agent rows it needs are on
([turn it on](../operations/runbooks.md#turn-an-off-row-back-on)). A review on this machine,
by a read-only local agent Worker; never a website account.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `review:1` | `review`, `local-data` | standard (caller) | caller | `acceptance.answer` |

`review:1` names no kind of work, so a Worker the operator gives kinds never takes it: keep a
read-only Worker given none ([work kinds](../design/routing.md#work-kinds)).

Bound to an exact subject, the review is told by the engine's subject block to read and judge the
change and never run the project's tests or builds: a command it could not run is not a finding
about the change, and an environment limit (a read-only sandbox, a denied or failing command) is
at most an `info` finding, never a `blocking` one. A remediation cycle's re-review is told the same.

### `scheduled-review`

Provided by
[`profile-software-development`](../../packages/plugins/profile-software-development/README.md)
(row off by default, like `agent-review`), and started by the workflow engine's own scheduler, not by
a caller: once a day, when `scheduledReview.enabled` is set
([configuration](configuration.md#workflow), [the handbook](../design/handbook.md#scheduled-review)),
with one area of a repository as its input. The area is read whole at the tip of the configured
branch (never a diff), with its review guide and its files' lines numbered.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `review:1` | `review`, `local-data` | frontier | temporary | `acceptance.answer` |
| `verify:1` (depends on `review:1`; differs from it, `diversity: preferred`) | `review`, `local-data` | frontier | temporary | `acceptance.answer` |

- `review:1` reports `important` findings (a real defect in the code as it stands, with its file, line,
  and evidence) and `nit`s, in the same JSON the other reviews use, naming the subject
  `scheduled-review:<area>@<commit>`. It never uses `pre-existing`: everything it reads has landed.
- `verify:1` is a second reviewer that prefers another provider family (the one-family case is recorded
  as any `preferred` diversity is). It reads the same area and the first reviewer's answer as data, and
  votes `confirm` or `reject`, with a reason, on each important finding. **Its votes count only when it
  ran on another family than `review:1`:** the scheduler reads both Workers' families when it settles the
  review, and with one family (or one it cannot read) every important finding stays unverified and
  nothing is filed, the row saying why.
- **The scheduler, not the template, files.** Each confirmed finding whose file and line are in the
  area the reviewers were shown becomes one proposed board task (title, `file:line`, evidence, the guide
  it broke), at most `maxTasksPerRun` (default 5) a run, the rest counted as `capped`; one that
  duplicates an open task is counted as `duplicates` and not filed
  ([rules](../design/handbook.md#scheduled-review)). Both nodes name no kind of work, so a reviewer the
  operator gave kinds never takes them.

### `algorithm-development`

Provided by
[`profile-software-development`](../../packages/plugins/profile-software-development/README.md)
(row off by default, like `agent-review`). One attempt of a board task that tests one hypothesis
(PROP-0010 B8): a lead starts it with MCP `run` and `task` (and `variant: docs` or `variant: tests`
for docs or test work), and the project's charter and
milestones are the board's ([pilot](../operations/pilot.md)). Every step runs on a local agent
Worker, in the run's own git worktree when the Workers (or their role) set `worktreePerRun`.

| Node | Capabilities | Tier | Kind | Conversation | Acceptance |
|---|---|---|---|---|---|
| `develop:1` | `develop`, `local-data` | standard | `code` | persistent (the run's session; the task's next attempt resumes it) | `acceptance.answer` |
| `develop:1` (variant `docs`) | `develop`, `local-data` | standard | `docs` | persistent | `acceptance.answer` |
| `develop:1` (variant `tests`) | `develop`, `local-data` | standard | `tests` | persistent | `acceptance.answer` |
| `selfreview:1` (depends on `develop:1`) | `review`, `local-data` | standard | none | temporary (a new session) | `acceptance.answer` |
| `review:1` (depends on `selfreview:1`, `develop:1`) | `review`, `local-data` | standard | none | temporary | `acceptance.answer` |

**Template version 2** (T267; the profile package's version moves with it). Version 1 ended with a
`validate:1` step, whose median was 0.4 minutes and which caught nothing the run's required checks at
acceptance did not. It is gone: the author shows its own checks' output, a fresh session of the author
reviews the diff, and `review:1` is the final step. A row's `kinds.validate` is still accepted and
ignored, so an update never stops a row from loading; remove it.

- **Kinds of work** ([ADR-0057](../decisions/adr/0057-route-work-by-kind.md)). With no Worker given
  kinds, every step routes as it always did. Once the operator gives Workers kinds
  ([route work by kind](../operations/runbooks.md#route-work-by-kind)), `develop:1` and its fix run
  on a writer given `code` (or, in the `docs` and `tests` variants, `docs` or `tests`). `selfreview:1`
  and `review:1` name none, so they need a reviewer given no kinds. The kinds in the table are the
  shipped ones; the row's `kinds` configuration changes the kind a step names, by step (`develop`,
  `docs`, `tests`; [configuration](configuration.md#profile-software-development)), never a
  review's. The variants are this template's docs work and test work; no other template carries them.
- `develop:1` states the hypothesis it tests, then changes the code toward the task; in the `docs`
  variant it changes documentation only, in the `tests` variant tests only. When the attempt before
  failed only after its `develop:1` completed (its review's session broke, say), no review having
  judged that change, this attempt's worktree already holds it, and its brief says so: it builds on
  it ([starting from the previous attempt's work](../design/workflow-engine.md#starting-from-the-previous-attempts-work)).
- **The author verifies before anyone reviews** (T267, T284). `develop:1` ends with the author having
  run the checks the task's criteria name. The System records, for every command the Worker ran, the
  command, its exit code as the runtime reports it (Codex's command items; for Claude Code the tool
  result's error flag, and the `Exit code N` its error text names), and a bounded tail of its output.
  A required check (`tests`, `typecheck`, `lint`) counts as shown when a recorded command for it ran
  to its end in the step, whatever the Worker wrote; a background launch or an interrupted command is
  recorded with no exit code and shows nothing. The records are bounded per step (15 check commands,
  50 others), and the bound never drops the last record that shows a check. The System lists the
  recorded commands and exit codes in the dossier as its own `evidence` entries, check commands first,
  in as many entries as the entry's bound needs, so none is cut. The Worker's own `evidence` entry (`dossier_append`) is
  optional prose, read only for a check no recorded command runs (it must then say which and why it
  could not run: `evidenceProblem`). When no recorded command shows a required check, a `gate`
  decision (`workflow.evidence`, version 3) says what is missing, and the step continues its own
  session once, the refusal's message (what is missing and how to show it) its next message. A
  second refusal fails the step with `evidence_missing`, "evidence refused twice", nothing after it
  starts, and the board counts the attempt. A step that must show its evidence requires the
  `dossier` capability, which a Worker offers when its runtime gives it the dossier tools: one that
  cannot is never admitted to it, and nothing is sent. Every fix grown from it (by the self-review or
  the review) must show the checks again, for the tree it leaves, under the same gate. The
  gate reads what ran, never a check the engine reports: the run's required checks run again
  on the exact result at acceptance
  ([ADR-0063](../decisions/adr/0063-a-runs-required-checks-run-on-its-exact-result.md)).
- `selfreview:1` is **the author's own review in a fresh context** (T267): a review of the exact
  change, on the author's account (the Workers of the account `develop:1` ran on; a writer never
  proves `review`, so it is that account's read-only role), in a session of its own. It never sees
  the author's transcript: its brief is the task's goal and criteria, the exact diff (its requested
  change the task's goal, never the caller's input), and the review guides of the areas the change
  touches ([handbook](../design/handbook.md#review-guides-reviewmd)). It is given no dossier (no slice,
  no file, and `dossier_read` is refused), none of the task's pointers (earlier results and decisions),
  and no file in its worktree: an agent Worker's source leaves in a run's worktree (`.system/`) only
  the files of the brief of the run starting, so the dossier and board an earlier step was given are
  removed before the self-review's agent starts, and a later step's brief places its own again. Its
  important findings are verified as a review's are (`selfreview:1:verify`,
  [ADR-0075](../decisions/adr/0075-a-review-finding-has-a-severity-and-only-a-verified-important-one-blocks.md)),
  and the confirmed ones grow a fix that continues `develop:1`'s session, answered (a
  `response` entry) and re-reviewed before `review:1` starts, with **no approval gate**: it is the
  author answering its own review, and `review:1` keeps every gate. It is never an independent
  review: it counts for no risk tier, provider family, or acceptance (`approvals`, the board's last
  review, the `review` check), and the landing's commit message names it "the author's own review".
  With no Worker of the author's account that proves `review`, it fails admission with nothing sent
  (INV-2).
- `review:1` is an exact-subject review of that change: the engine appends the subject, its diff,
  and the assessment it asks for. The reviewer reads the task's goal, its criteria, and the
  change, never the developer's answer. It reads and judges, and never runs the project's tests or
  builds: the author showed its checks' output in the dossier, and the run's required checks at
  acceptance ([ADR-0063](../decisions/adr/0063-a-runs-required-checks-run-on-its-exact-result.md))
  run them again. A command it could not run is not a finding about the change; an environment
  limit (its read-only sandbox, a denied command) is at most a `nit`, so it never grows a
  remediation cycle that no fix could satisfy. Its instructions and the engine's subject block both
  say so. Its important findings are verified by a second reviewer (`review:1:verify`, ADR-0075), and
  only the confirmed ones grow a fix (on `develop:1`'s capabilities) behind the approval queue and a
  re-review given the review's own instructions on the fixed subject, as for any template
  ([remediation](../design/workflow-engine.md#remediation-on-the-approval-queue)). It is the final
  node, so the run's result is its report on the subject the task writes, after any fix: the task
  keeps it, its digest cites it, and the next attempt's brief points at it.
- **One task, one author session** ([review cycles](../design/workflow-engine.md#review-cycles)).
  The fix continues `develop:1`'s session on its Worker: the review's findings, the subject the
  reviewer read, and what to change are that session's next message, so the developer fixes its
  own work with its earlier turns in view. When that Worker cannot take the fix, it waits up to
  `fixSessionWaitMinutes`, or the session is handed off with its earlier turns, recorded as a
  `workflow.fix-session` or `workflow.session-move` decision
  ([sessions](../design/sessions-and-messaging.md#a-review-fix-continues-its-authors-session)).
  The re-review stays independent, in a session of its own. The run's review history (the ref
  `refs/system/reviews/<runId>` of the repository) keeps the change the review read and each fix
  as commits of their own; the worktree's HEAD stays the commit the task writes, so the task's
  result and checks bind to it as before. A re-review reads only the change since the last reviewed
  subject, with the open and answered findings
  ([severity and verification](../design/workflow-engine.md#severity-and-verification)).
- There is no validation step. The engine reports the `review` check on the subject, never `tests`
  from the author's pasted output: a model's account of a command is not a check. After `review:1`,
  the run itself runs the checks the policy requires that are commands, on that subject, with the
  commands the operator configured for the repository, and reports those by their exit codes
  ([a run's required checks](../design/workflow-engine.md#a-runs-required-checks)); with none
  configured, under a policy that requires `tests` the board holds the result for the operator.
- **Review guides** ([handbook](../design/handbook.md#review-guides-reviewmd)). A review step
  (`selfreview:1`, `review:1`, a re-review, a second review) is given the `docs/review/*.REVIEW.md`
  guides of the areas its change touches, and only those, as a `review-guides@1.0` pointer in its
  brief (every guide when the change's paths could not all be read). They are read from the
  repository the run's worktree was cut from, never from the worktree under review.
- **Tiered by risk** when the task's project policy has a path map
  ([process tiered by risk](../design/workflow-engine.md#process-tiered-by-risk), ADR-0071): once
  `review:1` (or a re-review) approves, the engine decides the change's tier. A **heavy** change gets
  `review:1:second`, a review of the same change by a Worker of another provider family; with one
  family it fails admission and the run fails. The self-review never counts toward it. A heavy
  result is never accepted without the operator.

#### Which inputs reach which step

Each step reads only what it needs, so one step's orders never become another's (T99 D4). The
caller's input (MCP `run` `input`, the lead's text for this attempt) is the writing step's: a lead
puts there the change it wants and how, and needs no labels for the other steps. Every step of a
board task's run also reads the task frame its brief states first
([a board task's brief](../design/workflow-engine.md#a-board-tasks-brief)): the project, the task
and attempt, the goal, the acceptance criteria with what checks each (`brief@1.3`), the budget left
at that step, the pointers (the results of the tasks it depends on, the previous attempt's result
and the decision behind this one, and, when its worktree starts from the previous attempt's work,
the decision that carried it), and the board's `TASKS.md` in the worktree.

| Step | Reads | Never reads |
|---|---|---|
| `develop:1` (and its variants) | the task frame; the caller's input; on a later attempt, the session of the attempt before it when it is resumed | — |
| `selfreview:1` (and its re-reviews) | the task frame's goal, criteria, and budget; its own instructions; the exact subject the engine appends (the worktree's subject, its diff, and the task's goal as the requested change); the review guides | the author's answer and conversation, the caller's input, the task's pointers, the dossier, and the worktree's files |
| `selfreview:1:fix:<n>` | as `review:1:fix:<n>`, on the author's session, told to show the checks' output again | — |
| `review:1` | the task frame; its own instructions; the exact subject the engine appends: the worktree's subject, its diff, and the caller's input as the requested change; the review guides; the task's dossier | the developer's answer or conversation |
| `review:1:fix:<n>` (remediation) | the task frame; the engine's fix prompt: the caller's input, the reviewed subject, and the review's blocking findings, quoted | — |
| `review:1:review:<n+1>` | as `review:1`, on the fixed subject | the fix's answer |

A step on a writing Worker (a `workspace-write` sandbox: `develop:1` and its fixes) also reads, after its instructions and before its Tools section, the section
**Lessons of this repository**: the lines of the repository's
[`docs/engineering/lessons.md`](../engineering/lessons.md) that start with `- `, as committed at
the HEAD of the Worker's repository (an uncommitted edit, a Worker's included, is never read), at
most 30, each at most 400 characters, the rest counted. No such file committed, or one with no
lesson, is no section; the review, on a read-only Worker, never reads it. The lead or a review adds
a lesson by committing a line to that file; nothing else changes.

## Removed templates

PROP-0004 removed `investigate`, `deep-research`, `develop`, and `panel`, and replaced
`research-deep` with the `deep` variant of `research`, and the built-in agent `review` with
`agent-review` (the name `review` now runs the team). A run of `panel` stays readable, but
`continue` refuses it. A new run of
a removed template is refused (`unknown workflow template`). Runs started before keep their
resolved spec and records, so `explain` and `result` still answer for them.

## Presets

Under the `api-first` preset ([ADR-0025](../decisions/adr/0025-api-first-composition.md)) no
Worker drives a website, so no Worker proves `web-search` or `deep-research`. A node that needs
one fails admission, fail closed, with the capability named:
`no Worker can take this work: no Worker proves deep-research (…)`. Nothing is sent.

| Template | Under `api-first` |
|---|---|
| `ask` | runs on model Workers, in a session too: a model Worker keeps it by replay ([ADR-0031](../decisions/adr/0031-model-worker-sessions-by-replay.md)) |
| `brainstorm`, `review` | run on model Workers, each member in its own session by replay; members of one family need `allowSameFamily` ([ADR-0029](../decisions/adr/0029-opt-in-same-family-fallback.md)); a `review` member may also be an agent Worker under the review-member profile |
| `agent-review` | runs on agent Workers (the preset turns their rows and the software-development profile on) |
| `algorithm-development` | runs on agent Workers, as `agent-review`; `selfreview:1` needs a Worker of the author's account that proves `review` (its read-only role) |
| `research` | `frame:1` runs on a model Worker; `literature:1` fails: no Worker proves `web-search` (variant `deep`: `deep-research`), and `literature:2` sends nothing |

## Acceptance contracts

| Contract | Registered by | Accepts when |
|---|---|---|
| `acceptance.answer` | `workers` | the answer has text |
| `acceptance.cited` | `workers` | the answer has text and cites at least one http(s) source link |
| `acceptance.team-proposal` | `workflow` | the answer ends with a JSON proposal: a `recommendation` (at most 2000 characters), a `rationale`, and optional `risks` |
| `acceptance.team-findings` | `workflow` | the answer ends with JSON `findings` (at most 50, possibly none), each with a `severity` (`blocking`, `warning`, `info`) and a `claim`, plus `evidence`, an optional `kind` (`defect`, `suggestion`), an optional `location`, and an optional `quote` (`path`, `line` from 1, `text`) |
| `acceptance.team-ballot-<n>` (n = 2..5) | `workflow` | the answer ends with a JSON ballot over `O1`..`O<n>`: one `choice`, a `ranking` of all, a `rationale`, the `strongest` point of each option not chosen, its `objections` (possibly none), and a `confidence` |
| `acceptance.team-ballot-review` | `workflow` | the same ballot over `pass` and `changes` |
| `acceptance.cited-conclusions` | `profile-scientific-research` | the conclusion names a hypothesis (`H1`, …) and cites evidence (`[E1]`, …) |

The JSON an answer ends with is its last fenced code block that holds JSON, with fences paired as
Markdown pairs them; anything there but an object is refused. With no such block, it is the object
that ends at the answer's last `}`. Code or prose quoted before it does not hide it.

Config `templates` on the `workflow` plugin adds templates or replaces a built-in one of the
same name ([configuration](configuration.md#workflow)).
