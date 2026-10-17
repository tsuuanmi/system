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
| Capabilities | what routing admits Workers by ([capability vocabulary](../design/routing.md#capability-vocabulary)); a node in a session also requires `persistent-conversation` |
| Tier | the minimum tier; *caller* means the caller's `tier` replaces it |
| Conversation | `temporary`: a new one-shot conversation; `persistent`: the caller's session or a new one; `caller`: the caller's session, or a new one with `persist`; `own`: a new persistent conversation of this node alone ([conversations](../design/workflow-engine.md#conversations)) |
| Acceptance | the contract the result must pass; a rejected result may escalate one tier (`maxEscalations`, default 1) |

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
followed by the source. The options are `pass` and `changes`, over the members' findings merged
by quoted line; a confirmed blocking finding decides `changes`. The MCP tool `review` and
`system review` run it.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `source` (a repository at one commit, or the caller's text) | none (`effect` executor: the engine reads it) | — | — | — (records an `acceptance` decision `workflow.source-snapshot`) |
| `review:m<k>:propose` (independent findings; member k differs from members 1..k-1) | `reason` | standard | the member's own session | `acceptance.team-findings` |
| `review:m<k>:ballot:1` (sealed) | `reason` | standard | the member's own session | `acceptance.team-ballot-review` |
| `review:tally:1` | none (`team` executor) | — | — | — |
| `review` (decision) | none (`team` executor) | — | — | — |

Debate steps are appended as for `brainstorm`, with `acceptance.team-ballot-review`.

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
which is mounted only with the agent Worker rows, off in the default composition
([turn them on](../operations/runbooks.md#turn-an-off-row-back-on)). A review on this machine,
by a read-only local agent Worker; never a website account.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `review:1` | `review`, `local-data` | standard (caller) | caller | `acceptance.answer` |

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
| `brainstorm`, `review` | run on model Workers, each member in its own session by replay; members of one family need `allowSameFamily` ([ADR-0029](../decisions/adr/0029-opt-in-same-family-fallback.md)) |
| `agent-review` | runs on agent Workers (the preset turns their rows and the software-development profile on) |
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

Config `templates` on the `workflow` plugin adds templates or replaces a built-in one of the
same name ([configuration](configuration.md#workflow)).
