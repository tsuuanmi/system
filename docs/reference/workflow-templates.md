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
| Kind | optional: the kind of work the step is, a label such as `code` (a variant may change it); a Worker the operator gives kinds takes only steps of those kinds, a Worker given none takes any ([work kinds](../design/routing.md#work-kinds)). No built-in template names one |
| Conversation | `temporary`: a new one-shot conversation; `persistent`: the caller's session or a new one; `caller`: the caller's session, or a new one with `persist`; `own`: a new persistent conversation of this node alone ([conversations](../design/workflow-engine.md#conversations)) |
| Acceptance | the contract the result must pass; a rejected result may escalate one tier (`maxEscalations`, default 1) |

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
whose provider need not prove a search, so its citations gate it. `evidence:1` reads both,
labelled A and B, and records which review states each claim (`reviews`). `conclusion:1` says
where the reviews agree and differ. `research` therefore needs Workers of two provider
families: with one, `literature:2` fails admission (`same provider family (differs from node
literature:1)`), fail closed.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `frame:1` | `reason` | standard | persistent (the run's conversation) | `resultSchema: hypothesis-set@1.0`, then `acceptance.answer` |
| `literature:1` (review A) | `reason`, `web-search` | standard | temporary | `acceptance.cited` |
| `literature:2` (review B; differs from `literature:1`) | `reason` | standard | temporary | `acceptance.cited` |
| `literature:1`, `literature:2` (variant `deep`) | `reason`, `deep-research` | frontier | own (each review its own conversation) | `acceptance.cited` |
| `evidence:1` | `reason` | economy | persistent (the run's conversation) | `resultSchema: evidence-table@1.1`, then `acceptance.answer` |
| `critique:1` (differs from `evidence:1`) | `reason` | standard | temporary | `acceptance.answer` |
| `conclusion:1` | `reason` | standard | persistent (the run's conversation) | `acceptance.cited-conclusions` |

The synthesis steps (`frame:1`, `evidence:1`, `conclusion:1`) run in order in the run's one
conversation (the caller's session, if it named one), on one account (session affinity). Each
still receives its inputs inline. The two reviews and the critique each run in a conversation of
their own, so none of them sees the thread it feeds or judges. A run opens four conversations,
not six. The run's conversation is recorded, and deleted at retention like any other.

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
| `review:1` (depends on `develop:1`) | `review`, `local-data` | standard | none | temporary | `acceptance.answer` |
| `validate:1` (depends on `review:1`) | `validate`, `local-data` | economy | `validation` | temporary | `acceptance.answer` |

- **Kinds of work** ([ADR-0057](../decisions/adr/0057-route-work-by-kind.md)). With no Worker given
  kinds, every step routes as it always did. Once the operator gives Workers kinds
  ([route work by kind](../operations/runbooks.md#route-work-by-kind)), `develop:1` and its fix run
  on a writer given `code` (or, in the `docs` and `tests` variants, `docs` or `tests`), and
  `validate:1`, which runs the checks and tests and changes nothing, on one given `validation`: a
  Worker given `tests` writes tests and never runs the validation unless it is given `validation`
  too. `review:1` names none, so it needs a reviewer given no kinds. The kinds in the table are the
  shipped ones; the row's `kinds` configuration changes the kind a step names, by step (`develop`,
  `docs`, `tests`, `validate`; [configuration](configuration.md#profile-software-development)),
  never the review's. The variants are this template's docs work and test work; no other template
  carries them.
- `develop:1` states the hypothesis it tests, then changes the code toward the task; in the `docs`
  variant it changes documentation only, in the `tests` variant tests only. When the attempt before
  failed only after its `develop:1` completed (its review's session broke, say), no review having
  judged that change, this attempt's worktree already holds it, and its brief says so: it builds on
  it ([starting from the previous attempt's work](../design/workflow-engine.md#starting-from-the-previous-attempts-work)).
- `review:1` is an exact-subject review of that change: the engine appends the subject, its diff,
  and the assessment it asks for. The reviewer reads the task's goal, its criteria, and the
  change, never the developer's answer. Blocking findings grow a fix (on `develop:1`'s
  capabilities) behind the approval queue and a re-review given the review's own instructions on
  the fixed subject, as for any template
  ([remediation](../design/workflow-engine.md#remediation-on-the-approval-queue)); `validate:1`
  waits for them.
- `validate:1` runs the tests and benchmarks the task's acceptance criteria name, changing no
  file, and reports each command, its exit code, and the output lines that hold the result. It
  reads the criteria, each with what checks it, from its brief, never the caller's input (below);
  with no criteria (a run that serves no board task) it runs nothing and says none was named. Only a
  Worker whose commands are proven confined (`executes`) proves `validate`
  ([ADR-0038](../decisions/adr/0038-confined-commands-for-claude-code-workers.md)); with none, the
  step fails admission and nothing is sent. Each command passes the tool gate by its exact argv: a
  listed one runs as a workspace write, and any other is denied, since the step has no session to
  defer it on.
- `validate:1` is the final node, so the run's result is the validation's report on the subject
  the task writes, after any fix: the task keeps it, its digest cites it, and the next attempt's
  brief points at it. The engine reports the `review` check on that subject, never `tests` from the
  validation's report: a model's account of a command is not a check. After `validate:1`, the run
  itself runs the checks the policy requires that are commands, on that subject, with the commands
  the operator configured for the repository, and reports those by their exit codes
  ([a run's required checks](../design/workflow-engine.md#a-runs-required-checks)); with none
  configured, under a policy that requires `tests` the board holds the result for the operator.

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
| `review:1` | the task frame; its own instructions; the exact subject the engine appends: the worktree's subject, its diff, and the caller's input as the requested change | the developer's answer or conversation |
| `review:1:fix:<n>` (remediation) | the task frame; the engine's fix prompt: the caller's input, the reviewed subject, and the review's blocking findings, quoted | — |
| `review:1:review:<n+1>` | as `review:1`, on the fixed subject | the fix's answer |
| `validate:1` | the task frame; its own instructions; the run's worktree as the review left it | the caller's input, and any step's answer |

A run of the template that serves no board task has no task frame: its validation names no
criteria and runs nothing, so start it for a board task (MCP `run` with `task`).

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
| `algorithm-development` | runs on agent Workers, as `agent-review`; `validate:1` needs one whose commands are proven confined |
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
