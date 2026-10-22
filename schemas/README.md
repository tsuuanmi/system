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
| [decision.v1.json](decision.v1.json) | body of a `decision` artifact ([INV-13](../docs/architecture/invariants.md#inv-13-every-decision-is-an-artifact)); 1.1 adds team votes and the `client` decider; 1.2 adds a review's quote checks and the `blocking-finding` method |
| [work-requirement.v1.json](work-requirement.v1.json) | input to routing |
| [capability-descriptor.v1.json](capability-descriptor.v1.json) | a Worker's currently proven capabilities |
| [workflow-node.v1.json](workflow-node.v1.json) | durable state of one DAG node |
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
| [agent-result.v1.json](agent-result.v1.json) | body of a `report` artifact holding one agent-runtime Worker run's final message (the prompt by hash only); 1.1 adds its workspace and exact subject |
| [hypothesis-set.v1.json](hypothesis-set.v1.json) | body of a `criteria` artifact: a research question framed as testable hypotheses (scientific-research profile) |
| [evidence-table.v1.json](evidence-table.v1.json) | body of an `evidence` artifact: cited claims and how each bears on each hypothesis (scientific-research profile) |
| [team-result.v1.json](team-result.v1.json) | body of a `report` artifact holding a team's answer, composed from its final `vote` decision; its text starts with a machine-readable outcome line; 1.1 adds the method `blocking-finding` |
| [source-snapshot.v1.json](source-snapshot.v1.json) | body of an `evidence` artifact: what a review's members read, a public repository at one pinned commit or the caller's text, with the files not read |
| [assessment.v1.json](assessment.v1.json) | body of an `assessment` artifact: an independent review's verdict and findings, bound to the exact subject reviewed |
| [ui-map.v1.json](ui-map.v1.json) | a provider website's UI operations as data: elements, actions, network signals, states ([ADR-0021](../docs/decisions/adr/0021-ui-operations-as-data.md)) |

Schemas still to come, added with their milestone: the domain artifact bodies
(`report`, `handoff`, …), MCP tool input and output, and the decision question sets.
The Base release adds, first of all, the records of its new seams (`project`,
`board-task`, `approval-request`, `autonomy-policy`, `usage-record`, `limit-state`,
`plugin-manifest`, `brief`, `digest`) and the MCP tools' input and output
([ADR-0037](../docs/decisions/adr/0037-schema-and-protocol-first.md),
[PROP-0010](../docs/proposals/0010-base-version.md)).

## Conventions

- File name `<name>.v<major>.json`; `$id` is `urn:tsuuanmi:system:schema:<name>:v<major>`.
- Every record carries `"schema": "<name>@<major>.<minor>"`.
- `additionalProperties: false` unless a field is explicitly open.
- Everything is bounded: string lengths, array sizes, retry counts (INV-9).
- The files must compile under Ajv with `strict: true`, and every file in
  `examples/` must validate. CI enforces both
  ([testing](../docs/engineering/testing.md#ci-gates)).
