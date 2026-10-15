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
| Conversation | `temporary`: a new one-shot conversation; `persistent`: the caller's session or a new one; `caller`: the caller's session, or a new one with `persist` |
| Acceptance | the contract the result must pass; a rejected result may escalate one tier (`maxEscalations`, default 1) |

## Built-in templates

Provided by [`workflow`](../../packages/plugins/workflow/README.md): `ask`, and `panel` until a
team `brainstorm` replaces it (PROP-0004).

### `ask`

One answer from one Worker. `system ask` and the MCP tool `ask` run it.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `ask:1` | `reason` | standard (caller) | caller | `acceptance.answer` |

### `panel`

A [team](../design/teams.md) of 2 members over 2 rounds, on distinct accounts, then a
synthesis that cites the members.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `panel:m<k>:r1` (round 1, independent) | `reason` | standard | the member's own session | `acceptance.answer` |
| `panel:m<k>:r2` (critique, after the barrier) | `reason` | standard | the member's own session | `acceptance.answer` |
| `panel` (synthesis) | `reason` | standard | temporary | `acceptance.team-synthesis` |

A template with `team.lead` adds `panel:lead:<round>` nodes (`reason`, economy by default,
temporary, `acceptance.team-lead`) after each round but the last.

## Profile templates

### `research`

Provided by
[`profile-scientific-research`](../../packages/plugins/profile-scientific-research/README.md).
`system research` and the MCP tool `research` run it. Its `deep` variant
([variants](../design/workflow-engine.md#variants)) changes only `literature:1`; start it with
`system research --deep`, MCP `research` with `deep: true`, or `run` with `variant: deep`.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `frame:1` | `reason` | standard | temporary | `resultSchema: hypothesis-set@1.0`, then `acceptance.answer` |
| `literature:1` | `reason`, `web-search` | standard | temporary | `acceptance.cited` |
| `literature:1` (variant `deep`) | `reason`, `deep-research` | frontier | persistent | `acceptance.cited` |
| `evidence:1` | `reason` | economy | temporary | `resultSchema: evidence-table@1.0`, then `acceptance.answer` |
| `critique:1` | `reason` | standard | temporary | `acceptance.answer` |
| `conclusion:1` | `reason` | standard | temporary | `acceptance.cited-conclusions` |

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

PROP-0004 removed `investigate`, `deep-research`, and `develop`, and replaced `research-deep`
with the `deep` variant of `research` and the built-in `review` with `agent-review`. A new run of
a removed template is refused (`unknown workflow template`). Runs started before keep their
resolved spec and records, so `explain` and `result` still answer for them.

## Presets

Under the `api-first` preset ([ADR-0025](../decisions/adr/0025-api-first-composition.md)) no
Worker drives a website, so no Worker proves `web-search` or `deep-research`. A node that needs
one fails admission, fail closed, with the capability named:
`no Worker can take this work: no Worker proves deep-research (…)`. Nothing is sent.

| Template | Under `api-first` |
|---|---|
| `ask` | runs on model Workers; an `ask` in a session (`--persist`, `--session`) fails: no model Worker proves `persistent-conversation` |
| `panel` | fails: its members keep sessions, and no model Worker proves `persistent-conversation` |
| `agent-review` | runs on agent Workers (the preset turns their rows and the software-development profile on) |
| `research` | `frame:1` runs; `literature:1` fails: no Worker proves `web-search` (variant `deep`: `deep-research`) |

## Acceptance contracts

| Contract | Registered by | Accepts when |
|---|---|---|
| `acceptance.answer` | `workers` | the answer has text |
| `acceptance.cited` | `workers` | the answer has text and cites at least one http(s) source link |
| `acceptance.team-synthesis` | `workflow` | the synthesis has text and cites members as `[m<k>]` |
| `acceptance.team-lead` | `workflow` | the lead's answer carries a `{"converged": …}` decision |
| `acceptance.cited-conclusions` | `profile-scientific-research` | the conclusion names a hypothesis (`H1`, …) and cites evidence (`[E1]`, …) |

Config `templates` on the `workflow` plugin adds templates or replaces a built-in one of the
same name ([configuration](configuration.md#workflow)).
