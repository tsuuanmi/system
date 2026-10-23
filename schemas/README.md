# schemas

Machine-readable contracts for every record that `system` persists or sends
over the wire. These files are **canonical for exact shape**
([ADR-0014](../docs/decisions/adr/0014-json-schema-contracts.md)). The meaning of
each field, which a schema cannot fully express, is documented in
[docs/reference/schemas.md](../docs/reference/schemas.md).

- **Owns:** JSON Schema (draft 2020-12) files and valid examples.
- **Does not own:** plugin `Config` schemas, which use Schemastery and live with
  each plugin, or generated TypeScript types, which are build output.

| File | Record |
|---|---|
| [common.v1.json](common.v1.json) | shared value types: content address, ids, classification, tier, quota class, capability, subject |
| [artifact-envelope.v1.json](artifact-envelope.v1.json) | immutable envelope of every artifact |
| [decision.v1.json](decision.v1.json) | body of a `decision` artifact ([INV-13](../docs/architecture/invariants.md#inv-13-every-decision-is-an-artifact)); 1.1 adds team votes and the `client` decider; 1.2 adds a review's quote checks and the `blocking-finding` method; 1.3 adds `retention`; 1.4 adds `autonomy`, `approval`, `board`, and `budget`; 1.5 adds `lifecycle`; 1.6 adds `policy-change`; 1.7 adds `registration` and `verdict` |
| [work-requirement.v1.json](work-requirement.v1.json) | input to routing |
| [capability-descriptor.v1.json](capability-descriptor.v1.json) | a Worker's currently proven capabilities |
| [workflow-node.v1.json](workflow-node.v1.json) | durable state of one DAG node; 1.1 adds `RETIRED`; 1.2 adds the brief its execution was started with |
| [provider-turn-receipt.v1.json](provider-turn-receipt.v1.json) | body of a provider turn `receipt` artifact |
| [worker-session.v1.json](worker-session.v1.json) | durable Worker session with its own `SessionId` ([ADR-0015](../docs/decisions/adr/0015-worker-sessions-and-peer-messaging.md)) |
| [session-summary.v1.json](session-summary.v1.json) | body of a Worker session's `report` checkpoint or `handoff` compaction artifact |
| [ui-outline.v1.json](ui-outline.v1.json) | body of a local-private `evidence` artifact: the structure of a page region a `ui.drift` event names, never its text |
| [message.v1.json](message.v1.json) | body of a `message` artifact sent directly between sessions |
| [event.v1.json](event.v1.json) | one entry of the append-only event log (`ctx.eventLog`); event types are dotted names such as `ui.heal` |
| [lease.v1.json](lease.v1.json) | a held lease (`ctx.leases`): resource, owner, token, monotonic generation, expiry |
| [account.v1.json](account.v1.json) | provider account vault record (portable state; never leaves the provider runtime) |
| [provider-answer.v1.json](provider-answer.v1.json) | body of a `report` artifact holding one website Worker answer (the prompt by hash only) |
| [plan.v1.json](plan.v1.json) | body of a `plan` artifact: nodes a planner proposes to append to its run's DAG |
| [approval.v1.json](approval.v1.json) | body of an `approval` artifact: an operator's verdict bound to one exact subject |
| [model-answer.v1.json](model-answer.v1.json) | body of a `report` artifact holding one API or local model Worker's answer (the prompt by hash only), with its finish, output bound, and token usage |
| [agent-result.v1.json](agent-result.v1.json) | body of a `report` artifact holding one agent-runtime Worker run's final message (the prompt by hash only); 1.1 adds its workspace and exact subject; 1.2 adds the model and token usage with cache reads and writes; 1.3 adds a review member's profile and the turns it replayed |
| [hypothesis-set.v1.json](hypothesis-set.v1.json) | body of a `criteria` artifact: a research question framed as testable hypotheses (scientific-research profile) |
| [evidence-table.v1.json](evidence-table.v1.json) | body of an `evidence` artifact: cited claims and how each bears on each hypothesis (scientific-research profile) |
| [team-result.v1.json](team-result.v1.json) | body of a `report` artifact holding a team's answer, composed from its final `vote` decision; its text starts with a machine-readable outcome line; 1.1 adds the method `blocking-finding` |
| [source-snapshot.v1.json](source-snapshot.v1.json) | body of an `evidence` artifact: what a review's members read, a public repository at one pinned commit or the caller's text, with the files not read |
| [assessment.v1.json](assessment.v1.json) | body of an `assessment` artifact: an independent review's verdict and findings, bound to the exact subject reviewed |
| [ui-map.v1.json](ui-map.v1.json) | a provider website's UI operations as data: elements, actions, network signals, states ([ADR-0021](../docs/decisions/adr/0021-ui-operations-as-data.md)) |
| [project.v1.json](project.v1.json) | durable state of a project on the board: its charter (intent, measurable criteria, constraints, stop and pivot rules, budget by resource pool) and milestones |
| [board-task.v1.json](board-task.v1.json) | durable state of a board task, work that outlives a run, with its lease, run, result, and expiring waits |
| [approval-request.v1.json](approval-request.v1.json) | durable state of a request in the approval queue, bound to its exact subject; expiry rejects it; 1.1 adds the queue's own `policy-change` requests |
| [policy-change.v1.json](policy-change.v1.json) | durable state of one change of the autonomy policy set: the proposed record, the whole set it makes, its hash, base, and configuration hashes, and whether the operator's approval applied it |
| [autonomy-policy.v1.json](autonomy-policy.v1.json) | which action classes run (`auto`, `notify`) and which need a person (`ask`) or are denied (`forbid`); still `@1.0`: `remediation` always asks by a load-time rule, and `promotion` by the schema as well |
| [usage-record.v1.json](usage-record.v1.json) | body of a `receipt` artifact: what one run, call, or turn consumed, from an objective source, deduplicated by request id |
| [limit-state.v1.json](limit-state.v1.json) | body of an `evidence` artifact: one observation of one configured window of a resource pool |
| [usage-unknown.v1.json](usage-unknown.v1.json) | data of a `usage.unknown` event: one run whose usage the resource ledger could not count, and why (not reported, interrupted, the record refused, recording failed), until a record of it is counted |
| [brief.v1.json](brief.v1.json) | body of an `objective` artifact: what one Worker run is given, with artifacts by content id, never their content; 1.1 adds `instructions`, text and pointers in order; 1.2 adds `ask`, the Worker's bounded way to answer with questions instead, and `files` for the run's own workspace |
| [board-projection.v1.json](board-projection.v1.json) | body of an `evidence` artifact: one project's board as its `TASKS.md` projection, for a board task run's worktree |
| [digest.v1.json](digest.v1.json) | body of a `report` artifact: a cited summary of raw artifacts, every claim with a verbatim quote |
| [digest-extract.v1.json](digest-extract.v1.json) | body of an `evidence` artifact: verbatim spans of a digest request's sources, selected by code before the extractive provider's Worker writes, each with its source and offset |
| [plugin-manifest.v1.json](plugin-manifest.v1.json) | what a plugin declares (name and renames, seams provided and consumed, class, config keys with a sensitive flag), with the host-owned lifecycle state under `_meta`; 1.1 adds the seams a definition package `defines` |
| [objective-contract.v1.json](objective-contract.v1.json) | body of a `criteria` artifact: what "better" means for one application, versioned: hard constraints, guardrails with a margin or a floor, one primary metric, cost, and the analysis protocol; compared by constrained dominance, with no weights |
| [hypothesis.v1.json](hypothesis.v1.json) | body of a `criteria` artifact: one falsifiable claim about one target, with the fingerprint the experiment registry computes |
| [experiment.v1.json](experiment.v1.json) | body of a `plan` artifact: an immutable, pre-registered trial specification with its pins, its budget, the registry's answer, and its exact identity |
| [evaluation.v1.json](evaluation.v1.json) | body of an `evidence` artifact: the trials, measurements, analysis, cost, and integrity checks of one evaluation of one experiment |
| [lesson.v1.json](lesson.v1.json) | body of a `finding` artifact: knowledge drawn from verdicts, with the envelope it was observed in and the predicates that make it stale |
| [mcp-board.v1.json](mcp-board.v1.json), [mcp-approvals.v1.json](mcp-approvals.v1.json), [mcp-resources.v1.json](mcp-resources.v1.json), [mcp-digests.v1.json](mcp-digests.v1.json) | input and output of the `board_*`, `approvals_*`, `resources_*`, and `digests_*` MCP tools; `mcp-board` 1.1 adds the operator's `board_pause`, `board_resume`, and `board_close` |
| [mcp-report.v1.json](mcp-report.v1.json) | input and output of the `report` MCP tool: the baseline report of a period; 1.1 adds what a cap counts as 0 (records without a figure, runs whose usage the ledger could not count) |

Schemas still to come, added with their milestone: the domain artifact bodies
(`report`, `handoff`, …), the input and output of the MCP tools built before Base, and the
decision question sets.

## Conventions

- File name `<name>.v<major>.json`; `$id` is `urn:tsuuanmi:system:schema:<name>:v<major>`.
- Every record carries `"schema": "<name>@<major>.<minor>"`.
- MCP tool payloads are not records and carry no tag. One file per tool family,
  `mcp-<family>.v<major>.json`, holds each tool's input and output under
  `$defs/<tool>-input` and `$defs/<tool>-output` (the tool name with hyphens); its root
  describes one call (`tool`, `input`, `output`), which is what its examples are.
- `additionalProperties: false` unless a field is explicitly open.
- Everything is bounded: string lengths, array sizes, retry counts (INV-9).
- The files must compile under Ajv with `strict: true`, and every file in
  `examples/` must validate. CI enforces both
  ([testing](../docs/engineering/testing.md#ci-gates)).
