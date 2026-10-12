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

Provided by [`workflow`](../../packages/plugins/workflow/README.md).

### `ask`

One answer from one Worker. `system ask` and the MCP tool `ask` run it.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `ask:1` | `reason` | standard (caller) | caller | `acceptance.answer` |

### `investigate`

A planner adds research steps (graph growth), then a synthesis answers from their findings.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `plan:1` | `reason` | standard | temporary | `acceptance.answer`; its JSON plan may add at most 4 steps, each `reason` only, at the tier the plan names |
| `synthesis:1` (after `plan:1` and its steps) | `reason` | standard | temporary | `acceptance.answer` |

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

### `review`

A review on this machine, by a read-only local agent Worker; never a website account.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `review:1` | `review`, `local-data` | standard (caller) | caller | `acceptance.answer` |

### `deep-research`

Deep research alone, then a compaction for a downstream agent.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `research:1` | `reason`, `deep-research` | frontier | persistent | `acceptance.answer` |
| `compact:1` (after `research:1`) | `reason` | economy | temporary | `acceptance.answer` |

## Profile templates

### `develop`

Provided by [`profile-software-development`](../../packages/plugins/profile-software-development/README.md).

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `plan:1` | `reason` | standard | temporary | `acceptance.answer`; its plan may add at most 4 steps using `develop`, `review`, `local-data`; `develop` steps wait for the operator's approval of the exact plan |
| `report:1` (after `plan:1` and its steps) | `reason` | standard | temporary | `acceptance.answer` |

The engine binds a `review` step to the exact subject of the change and, on blocking findings,
appends a fix and a re-review, up to `maxReviewCycles` reviews (engine config, default 3).

### `research` and `research-deep`

Provided by
[`profile-scientific-research`](../../packages/plugins/profile-scientific-research/README.md).
`system research` and the MCP tool `research` run `research`.

| Node | Capabilities | Tier | Conversation | Acceptance |
|---|---|---|---|---|
| `frame:1` | `reason` | standard | temporary | `resultSchema: hypothesis-set@1.0`, then `acceptance.answer` |
| `literature:1` (`research`) | `reason`, `web-search` | standard | temporary | `acceptance.cited` |
| `literature:1` (`research-deep`) | `reason`, `deep-research` | frontier | persistent | `acceptance.cited` |
| `evidence:1` | `reason` | economy | temporary | `resultSchema: evidence-table@1.0`, then `acceptance.answer` |
| `critique:1` | `reason` | standard | temporary | `acceptance.answer` |
| `conclusion:1` | `reason` | standard | temporary | `acceptance.cited-conclusions` |

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
