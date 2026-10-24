# Record schemas

> Target state. Shape: [`schemas/`](../../schemas/README.md) (canonical). Decision:
> [ADR-0014](../decisions/adr/0014-json-schema-contracts.md).

## Versioning

| Change | Version effect | Requirement |
|---|---|---|
| add an optional field | minor (`@1.0 → @1.1`) | readers on `@1.x` keep working |
| add an enum value | minor, but readers must reject unknown values in decision paths | listed in the changelog of the schema PR |
| remove, rename, or tighten a field; change meaning | major (`v1 → v2`, new file) | a tested store migration; both majors are readable during migration |

A reader rejects a record whose major version it does not support. It never
guesses.

## Validation points

| Boundary | Validated | On failure |
|---|---|---|
| store write | every record before commit | the write is rejected (typed error) |
| store read | every record after load | the record is quarantined; the node becomes `BLOCKED` with `CODE_FIX_REQUIRED` |
| MCP tool input and output | each call; a `board_*`, `approvals_*`, or `digests_request` call that changes anything checks its output inside its store transaction, before the change commits | MCP error to the client; nothing is executed, or nothing changed |
| Worker structured output | the result against `acceptance.resultSchema` | an `acceptance` decision with outcome `rejected`, then escalation policy |
| decision model input and output | each call | `decision: unavailable` path (PROP-0002) |
| config bundles and patches | at startup | startup fails with the exact path (REQ-HOST-2) |

## Semantics not expressed by the schemas

### `artifact-envelope`

- `id` is computed by the store, never trusted from the producer. It is
  `sha256(canonicalJSON({kind, bodySchema, body | blob{ref, mediaType}, inputs, lineage, subject}))`.
  `inputs` are deduplicated and **sorted**, because they form a set. Canonical JSON
  uses keys sorted by UTF-16 code unit (as in RFC 8785), no insignificant whitespace,
  and UTF-8. `createdAt`, `producer`, `classification`, `runId`, and `nodeId` are
  excluded, so identical content deduplicates. The runs that produced an artifact
  are tracked separately.
- `classification` of a derived artifact is at least the strictest classification
  among its `inputs` and its lineage references. **Unknown references are refused**,
  so the floor cannot fail open. Deduplication refuses a request that would need a
  stricter classification than the stored one. A producer can never downgrade.

### `decision`

- Exactly one candidate is `selected`, and it equals `outcome.option`. The schema
  checks that only one candidate is selected. The store checks that it equals
  the outcome.
- Every candidate carries at least one non-blank reason: a rejected one says why
  it lost, the selected one why it won
  ([INV-13](../architecture/invariants.md#inv-13-every-decision-is-an-artifact)).
  The schema allows an empty `reasons`, so decisions stored before the rule stay
  readable; the store refuses a new decision with a candidate that gives none.
- `decider.version` changes whenever the policy's behavior changes. `hash` is the
  hash of the effective policy configuration.
- When `decider.type` is `model`, `deterministic` must be `false`, and
  reproducibility comes from reuse by input hash.
- Prose can quote model or caller text of any length. The store clamps
  `question` (500), each reason (300), and `rationale` (1000) to their bounds on
  whole characters, ending in `…`, so a long reason never fails its decision.
- `decision@1.1` adds the decision type `vote`, the decider type `client`, and
  the `vote` object ([teams](../design/teams.md#the-record)). A record with any
  of them must be `@1.1` and carry `vote`; every other decision stays `@1.0`,
  so earlier decisions keep their ids. Readers accept 1.0 through 1.8.
- `decision@1.2` adds a review's quote checks ([teams](../design/teams.md#review)):
  - the method and the round end `blocking-finding` (decider rule
    `workflow.blocking-finding`);
  - per finding: its reporters `members`, `kind` (`defect`, `suggestion`),
    `quote {path, line, text, matched}` (`matched`: the line the quote was found
    on), `class` (`confirmed`, `needs-verification`, `suggestion`), `why` it
    is not confirmed, and each member's own `reports` (claim, severity, class; one
    per member), of which the finding's own fields are the lead one's;
  - on the vote: the `repository {url, ref?, commit}` read, the number of files
    `unread`, and, for `blocking-finding`, the deciding findings `blocking`.

  A record with any of them must be `@1.2`. A review's votes, its tallies and
  its final decision, are always `@1.2`; a brainstorm's stay `@1.1`. Example:
  [`decision.review-blocking.json`](../../schemas/examples/decision.review-blocking.json).
- `decision@1.3` adds the decision type `retention`: a released session's
  website conversations are deleted on their sites (decider rule
  `turns.conversation-retention`; `outcome.detail` names the released
  `sessions` and the `conversations` it made due,
  [conversation ledger](../design/provider-turns.md#conversation-ledger)). A
  `retention` decision must be `@1.3`. Example:
  [`decision.retention.json`](../../schemas/examples/decision.retention.json).
- `decision@1.4` adds four decision types for the Base core. A decision of one of them
  must be `@1.4`; every other decision keeps its version, so earlier decisions keep their
  ids.
  - `autonomy`: the mode the autonomy policy gives one action. Candidates are `auto`, `notify`,
    `ask`, and `forbid`; the decider is the policy (`policy`, its id and version), and
    `decider.hash` is the sha256 of the canonical JSON of the effective policy set as loaded (the
    studio policy, then the project's), so an edit that keeps a version still shows; the outcome
    is the mode, and `detail` names the action class it was judged as, the effective policies,
    any `failedChecks`, and why it is `forbidden` whatever a rule says (an argv word with a shell
    metacharacter). The mode is the mode once the required checks pass: a non-empty
    `failedChecks` means the result is not yet accepted, and work in progress goes on with them
    pending ([approvals](../design/approvals.md#a-verdict-is-not-yet-a-permission)).
  - `approval`: how an approval request was resolved. Options `approved`, `rejected`,
    `denied:expired` (decider rule `approvals.expiry`), and `withdrawn`. Example:
    [`decision.approval-expired.json`](../../schemas/examples/decision.approval-expired.json).
  - `board`: a move the board makes on its own (dependencies met, a lease lost, a wait expired,
    a retry). The outcome is the target state; `detail` names the task or project and the state
    it left.
  - `budget`: a reservation before a run. Options `reserved` and `refused`; `detail` names each
    pool, the amount, and what remained.
- `decision@1.5` adds the decision type `lifecycle`: the state the plugin host records for one
  plugin ([plugin host](../design/plugin-host.md#lifecycle-states)). A `lifecycle` decision must be
  `@1.5`; every other decision keeps its version. Its candidates are the five states, `candidate`,
  `shadow`, `canary`, `default`, `retired`, each with why; the decider is the rule
  `plugin-host.composition`, its `hash` the sha256 of the composition as read (each row's id,
  package, and whether it is mounted, in order). Its input is the plugin's previous lifecycle
  decision, if any; `detail` names the `plugin`, its `version`, its `rows`, the state it comes
  `from` (`null` the first time), `renamedFrom` when it took a former name's record, and the
  `manifestDigest` (the sha256 of the manifest's canonical JSON; not an artifact). Example:
  [`decision.lifecycle.json`](../../schemas/examples/decision.lifecycle.json).
- The plugin host's manifest check (contract 1.1) records a `gate` decision, so it stays
  `@1.0`: decider rule `plugin-host.manifest-check` version 1, its `hash` the sha256 of what the
  check read (the rows, each manifest's digest or why there is none, and the packages allowed
  without one); candidates `pass` and `fail`, `fail` giving each finding's reason (at most 32,
  the last counting the rest); its input the plugin's previous check decision; `detail` names the
  `plugin`, its `rows`, its `findings` (each `kind` `no-manifest`, with `manifest` `absent` or
  `refused`, or `unsatisfied`, with the `seam`, `range`, `provider` when a manifest declares it,
  and `version`; each with its `reason`), the outcome it comes `from` (`null` the first time), and
  for a valid manifest its `version` and `manifestDigest` ([plugin host](../design/plugin-host.md#the-manifest-check)).
  Example: [`decision.manifest-check.json`](../../schemas/examples/decision.manifest-check.json).
- `decision@1.6` adds the decision type `policy-change`: which autonomy policy set is in force
  ([approvals](../design/approvals.md#a-policy-change)). A `policy-change` decision must be `@1.6`;
  every other decision keeps its version. Its two candidates are the old and the new set's
  hashes, the new one selected; the decider is the rule `approvals.policy-change` (an approved
  change, its inputs the request's `autonomy` decision, the operator's `approval` artifact, and its
  `approval` decision) or `approvals.configuration` (a configuration that names the stored set in
  `supersedes` replaced it at a start), its `hash` the new set's. `detail` names the `cause`
  (`approved` or `configuration`), the `changeId`, the `requestId` when approved, `from` and `to`,
  the `configHash`, and the proposed `policy` by id and version. Example:
  [`decision.policy-change.json`](../../schemas/examples/decision.policy-change.json). A third
  decider rule, `approvals.repeated-approvals`, records the queue's own proposal
  ([approvals](../design/approvals.md#the-queue-proposes-a-policy-change)): the question is which
  set the queue proposes, the proposed set's hash selected and the set in force kept until the
  operator approves; its inputs the `autonomy` decision that said ask and the operator's approvals
  it counted (the newest 100); `detail` names the `cause` (`repeated-approvals`), the `changeId`,
  the `requestId`, `from` and `to`, the `configHash`, the `policy`, the `shape`
  (`{actionClass: command, command}`), the approvals counted (`approved`), the `threshold`, the
  `windowSeconds`, and the counted `requests`. Example:
  [`decision.policy-change-proposed.json`](../../schemas/examples/decision.policy-change-proposed.json).
- `decision@1.7` adds the feedback loop's two decision types
  ([ADR-0045](../decisions/adr/0045-feedback-loop-guarantee-seams.md)). A decision of either must be
  `@1.7`; every other decision keeps its version.
  - `registration`: whether the experiment registry pre-registered or refused one revision of an
    experiment ([experiments](../design/experiments.md#a-registration)). Candidates `preregistered`
    and `refused`; the decider is the rule `experiments.registry`, its `hash` the sha256 of the
    vocabulary the fingerprint was normalized from (`vocabularyHash`). Its inputs are the
    experiment and hypothesis it recorded, every experiment it matched, and the revision it
    supersedes; `detail` names the `experimentId`, `revision`, `answer`, `identity`, `fingerprint`,
    the experiments it `cites`, the predicates it names as `changed`, every match with its
    `relation` and the predicates that `changed` against it, and `supersedes` (the revision). Example:
    [`decision.registration.json`](../../schemas/examples/decision.registration.json).
  - `verdict`: the classification of one evaluation against the thresholds its contract and
    experiment pre-registered ([the verdict rule](../design/evaluations.md#the-verdict-rule)).
    Candidates `supported`, `refuted`, `inconclusive`, and `invalid`, each with why; the decider is
    the rule `evaluations.verdict`, its `hash` the sha256 of the experiment's normalized protocol
    (`protocolHash`). Its inputs are the evaluation, the experiment, and the contract; `detail`
    names the `experimentId`, `revision`, `evaluationId`, `identity`, `comparison`,
    `horizonReached`, why it `ended`, each judged metric (its role, the oriented interval, the
    threshold, and whether it `clears`, is `excluded`, or is `undecided`), each hard constraint and
    whether it held, the `failedChecks`, and, when the caller gives one, the `netBenefit` bounds.
    Example: [`decision.verdict.json`](../../schemas/examples/decision.verdict.json).
- `decision@1.8` adds what agent accounts decide ([PROP-0012](../proposals/0012-agent-accounts.md)).
  A decision of either kind must be `@1.8`; every other decision keeps its version.
  - The decision type `enrollment`: what account a slot of an agent runtime holds
    ([ADR-0051](../decisions/adr/0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md)).
    A slot's first decision has the one candidate `enrolled` (the slot is taken); each later one
    has `ready`, `signed-out`, `quarantined`, and `removed` (the slot freed), the selected one with
    why. The decider is the rule `agent-accounts.enrollment`. Its inputs are the slot's previous
    `enrollment` decision, if any, never the principal; `detail` names the `provider`, the `slot`,
    its `home`, the record's `revision`, the `accountId` once a principal was read whole (and the
    `previousAccountId` when an accepted change replaced it), the quarantine `reason` (`changed`,
    `ambiguous`, `duplicate`, `unverified`), and the `reader` and `runtimeVersion` that read it;
    `rationale` says why. Recorded from PROP-0012 phase E by the `agents` source
    ([enrollment](../design/agent-runtimes.md#enrollment-and-quarantine)). Example:
    [`decision.enrollment.json`](../../schemas/examples/decision.enrollment.json).
    From phase F the same type records the move from hand-named agent Workers
    ([migration](../design/agent-runtimes.md#migration-from-hand-named-rows)), decider the rule
    `agent-workers.migration`: per hand-named Worker, candidates `migrated` and `stopped` (`detail`:
    `from`, `runtime`, `role`, and when migrated `to` and `accountId`; its input the account's latest
    enrollment decision); then the cutover, candidates `applied` and `kept` (`detail`: each Worker's
    `from` and `to`, the `roles`, the `assignments`, and how many `sessions` and `runs` moved; its
    inputs the Workers' decisions); and a rollback, candidates `rolled-back` and `applied`
    (`detail`: the `cutover` decision, and what moved back; its input the cutover's).
  - The `recovery` outcome `wait`: a node refused only because assigned accounts that could take it
    are at their limit waits for the earliest of their resets, spending no attempt
    ([ADR-0052](../decisions/adr/0052-accounts-are-assigned-unless-pooling-is-recorded.md)). Its
    candidates are `retry`, `failover`, `wait`, and `fail`; `detail` names the `kind`
    (`quota_exhausted`), the `attempt` (unchanged), `until` (the node's `not_before`), `since` (when
    the node first waited, kept across waits), and `maxLimitWaitHours`. A recovery decision with any
    other outcome keeps its version. Example:
    [`decision.recovery-wait.json`](../../schemas/examples/decision.recovery-wait.json).
- A tally's `vote` holds one round; the team's final `vote` holds every round,
  its `method`, the `dissent`, any `revisions` and `tiebreak`, and a review's
  `findings`. `threshold` is a strict majority of every member, never of the
  ballots cast.
- Members are named by opaque identity (their session ids), never by provider.
- The decider is `rule` for a tally, a majority, a confirmed blocking finding
  (`workflow.blocking-finding`), or a tie that timed out
  (`workflow.tie-timeout`), and `client` or `operator` for a deciding `vote`,
  by the caller's token scope. Example:
  [`decision.team-vote.json`](../../schemas/examples/decision.team-vote.json).

### `work-requirement`

- `tier.source` records who set the tier. When it is `decision`, `tier.decision`
  references the `tier` decision artifact.
- `egressPolicy` must come from a trusted envelope (INV-6). A requirement built
  from model text alone is invalid.
- `work-requirement@1.1` adds the optional `scope`: the kind of work this is, for capability
  offers scoped to it ([scoped offers](../design/routing.md#scoped-offers),
  [ADR-0049](../decisions/adr/0049-read-only-agent-workers-as-review-members.md)). The only value
  is `review-member`, a step of a review team's member, set by the workflow engine from the
  admitted spec. A record carrying it below `@1.1` is refused. Readers accept 1.0 and 1.1. Example:
  [`work-requirement.review-member.json`](../../schemas/examples/work-requirement.review-member.json).
- `work-requirement@1.2` adds the optional `kind`: the kind of work this is, a `workKind` label
  (`^[a-z][a-z0-9-]{0,31}$`, such as `code` or `docs`), for Workers given `kinds`
  ([work kinds](../design/routing.md#work-kinds),
  [ADR-0057](../decisions/adr/0057-route-work-by-kind.md)). The workflow engine sets it from the
  admitted spec (the step's `kind`, or its variant's), never from model text (INV-6). A record
  carrying it below `@1.2` is refused. Readers accept 1.0 to 1.2. Example:
  [`work-requirement.kind.json`](../../schemas/examples/work-requirement.kind.json).

### `workflow-node`

- `nodeId` is deterministic. Unrolled loops append an ordinal, for example
  `review:cycle:2` ([ADR-0012](../decisions/adr/0012-dag-execution-model.md)).
- Every state transition a decision causes updates `lastDecision` to that decision artifact
  ([INV-13](../architecture/invariants.md#inv-13-every-decision-is-an-artifact)): a refused plan
  names its `graph-growth` refusal, and a gate that blocks names its `gate` decision (what it
  waits for, until when). The promotion `WAITING → READY` decides nothing (it follows from its
  dependencies' completion decisions) and records none.
- `workflow-node@1.1` adds the state `RETIRED`: a node a re-plan took out of the
  graph. It stays as history, never runs again, and its `lastDecision` is the
  `graph-growth` decision that retired it.
- `workflow-node@1.2` adds `execution.brief`: the brief the execution was started with,
  recorded before it started ([briefs](../design/workflow-engine.md#briefs)). A node is written
  as 1.2 once an execution names its brief, retired or not; otherwise as 1.1 when retired, and
  1.0 before. Readers accept 1.0 to 1.2.

### `conversation`

- One row of the [conversation ledger](../design/provider-turns.md#conversation-ledger), as
  `system conversations` and MCP `conversation_list` show it.
- `state`: `live` while its session holds it; `due` once released; `deleted` when the site
  shows it gone (`reason` says so when it was already gone); `kept` with why (a temporary chat,
  a feature not yet proven deletable, no deletion on the site, a removed account); `failed`
  after three attempts, with the last error in `reason`.
- `decision` is the `retention` decision that released it. Example:
  [`conversation.deleted.json`](../../schemas/examples/conversation.deleted.json).

### `provider-turn-receipt`

- It is persisted *before* submission. `previousResponseHash = null` only for a
  new conversation.
- `resubmits ≤ 2` is a hard bound. Each reconciliation appends a decision ref.

### `worker-session`

- `sessionId` never changes for the session's lifetime. `binding.generation`
  advances on every activation (and on a compaction's rebind), and `binding.nativeHandle` may
  change with it. The activation's settle presents its generation; a stale one is refused
  and changes nothing.
- `mailboxSeq` is the last delivered inbound sequence number. Redelivery after a
  crash resumes at `mailboxSeq + 1`.
- `binding.runtime` is metadata, never a routing input: the kind of the runtime that serves the
  session (`website` for a website Worker, else the agent runtime's kind; a kind the vocabulary
  does not name is recorded as `local-tool`).
- `worker-session@1.1` adds the runtime `antigravity-cli`, which `@1.0` recorded as `local-tool`.
  A writer writes `@1.1` only for that runtime, and `@1.0` otherwise; a `@1.0` record naming it is
  refused. Readers accept 1.0 and 1.1. Example:
  [`worker-session.antigravity-member.json`](../../schemas/examples/worker-session.antigravity-member.json).
- `policy.writes` names the subject the session writes under a board task's authority. Write
  authority itself is the board's: at most one open task writes a subject
  ([board](../design/board.md), INV-15); a session never claims it on its own.

### `message`

- `messageId` is unique per sender. Receivers deduplicate on `(from, messageId)`.
- `body` is untrusted data for the receiver, never authority (INV-6).
  Approvals travel only as `approval` artifacts.
- The message artifact is at least as strict as its `refs` (they are its inputs), and the
  receiver's turn carries the strictest classification of the messages it delivers, so the
  turn's egress check refuses local-private refs to a remote Worker (INV-12).
- It maps to A2A `Message`: `messageId`, `referenceTaskIds` ≈ `refs`/`inReplyTo`,
  and `parts` ≈ `body` plus refs.

### `capability-descriptor`

- `provider` is informational. Routing must not branch on it (INV-11). Only
  `capabilities` (with each offer's `scope`), `tier`, `quotaClass`, `locality`, `state`,
  `family`, `maxInputChars`, `load`, `cooldowns`, and `account` are routing inputs.
- `capability-descriptor@1.1` adds the optional `family`: an opaque provider
  family the Worker source sets, which routing only compares for inequality
  ([provider diversity](../design/routing.md#provider-diversity),
  [ADR-0027](../decisions/adr/0027-provider-diversity-in-routing.md)). A `@1.0`
  record carrying `family` is refused. Readers accept 1.0
  and 1.1.
- `capability-descriptor@1.2` adds the optional `maxInputChars`: the longest input the Worker
  takes, in characters (code points) of what it is sent; admission refuses longer input
  ([ADR-0032](../decisions/adr/0032-admission-refuses-input-longer-than-a-worker-takes.md)). A
  record carrying it below `@1.2` is refused. Readers accept 1.0 to 1.2.
- `capability-descriptor@1.3` adds the optional `load`: the turns `running` in the Worker
  runtime's `slots`, `queued`, and routed to it but not started (`pending`). Workers that share a
  runtime (the tiers of one account) report the same numbers. Among equally ranked Workers the
  least busy is routed to, and the route decision records each one's load
  ([ADR-0033](../decisions/adr/0033-least-busy-routing.md)). A record carrying it below `@1.3` is
  refused. It also adds the optional `cooldowns`: capabilities the Worker proves but may not use
  until `until`, a site's usage limit; work that needs one is not admitted there (admission check
  `cooldown`, [ADR-0034](../decisions/adr/0034-unsent-failover-to-a-sibling-account.md)).
  Readers accept 1.0 to 1.3.
- `capability-descriptor@1.4` adds the optional `scope` on a capability offer: the capability is
  proven only for work whose requirement names that scope (`work-requirement@1.1`), never for
  other work ([scoped offers](../design/routing.md#scoped-offers),
  [ADR-0049](../decisions/adr/0049-read-only-agent-workers-as-review-members.md)). The only value
  is `review-member`. A record carrying it below `@1.4` is refused. Readers accept 1.0 to 1.4.
  Example: [`capability-descriptor.review-member.json`](../../schemas/examples/capability-descriptor.review-member.json).
- `capability-descriptor@1.5` adds the optional `account`: the account the Worker runs on, as its
  source sets it ([ADR-0052](../decisions/adr/0052-accounts-are-assigned-unless-pooling-is-recorded.md)).
  `id` names the account and `group` the accounts it is compared with (a website's provider, an
  agent runtime); routing compares both for equality only, never names one (INV-11). `mode` is the
  group's setting, `assigned` or `pooled`. `limitUntil` is when an account whose Worker reads
  `quota-exhausted` is expected back, when its source knows; a cooldown carries its own `until`.
  Under `assigned`, a Worker refused only for its limit refuses the group's other accounts the same
  work (admission check `assignment`), and the earliest reset among those limits is the
  `AdmissionFailure`'s `limitUntil` ([assigned accounts](../design/routing.md#assigned-accounts)).
  A record carrying it below `@1.5` is refused. Readers accept 1.0 to 1.5. Example:
  [`capability-descriptor.account.json`](../../schemas/examples/capability-descriptor.account.json).
- `capability-descriptor@1.6` adds the optional `kinds`: the kinds of work the operator gives the
  Worker (1 to 16 `workKind` labels), as its source sets them from configuration
  ([work kinds](../design/routing.md#work-kinds),
  [ADR-0057](../decisions/adr/0057-route-work-by-kind.md)). Such a Worker takes only work whose
  requirement names one of them (`work-requirement@1.2` `kind`), never work that names none;
  without `kinds` it takes any work. Routing compares kinds for equality only (admission check
  `capability`). A record carrying it below `@1.6` is refused. Readers accept 1.0 to 1.6. Example:
  [`capability-descriptor.kinds.json`](../../schemas/examples/capability-descriptor.kinds.json).
- `capability-descriptor@1.7` adds the optional `description`: what the Worker is for, in the
  operator's words, from the configuration row that defines it (`description` of an agent-workers
  `workers[]` or `roles[]` entry, of a `models[]` entry, or of an accounts `accounts[]` entry, which
  a website Worker carries with its tier). It is for people (the [roster](../design/roster.md))
  and never a routing input. A record carrying it below `@1.7` is refused. Readers accept 1.0 to
  1.7. Example:
  [`capability-descriptor.description.json`](../../schemas/examples/capability-descriptor.description.json).

### `plan`

- Proposed by a planner node, and validated by the engine before anything is
  appended: unique ids under the planner's prefix, dependencies only among its
  own nodes, acyclic, within the node bound, allowed capabilities only.
- A `graph-growth` decision records whether it was appended and why.
- An edited plan is a new artifact with a new id. An approval of the old one
  never covers it.

### `approval`

- `subject` is the exact subject approved (INV-5): a plan at the workflow's plan gate, or the
  subject of an approval request in the queue (a charter version, a board task's attempt, a
  Worker's tool call; [`approval-request`](#approval-request)).
- It is written only through an operator channel (the CLI, MCP `approve` or
  `approvals_decide`, or the web UI), never from model output (INV-6).

### `agent-result`

- Written once per finished agent-runtime run, as the body of a `report`
  artifact. The prompt is kept by hash only.
- `nativeHandle` names the agent's own session (for example, a Claude Code
  session id). The session itself is never mirrored (INV-7).
- `sandbox` is the policy the run was held to, taken from trusted
  configuration.
- `agent-result@1.1` adds `workspace` (from configuration) and `subject`. The
  subject is the workspace's exact git subject after the run:
  `{type: git-head, ref: HEAD, version: hash of every change on top}`. A
  review binds to it.
- `agent-result@1.2` adds `model`, `usage`, and `models`, from the Agent SDK's result
  message. `usage` is the sum of its per-model `modelUsage`, which covers subagents; the
  message's own `usage` covers the main loop only and is not used. `model` is the main
  loop's model. A Worker writes `@1.2` when its runtime reported token usage, and `@1.1`
  otherwise.
- Token counts are normalized as in [`usage-record`](#usage-record). The SDK's `modelUsage`
  uses the same field names with another meaning: its `inputTokens` excludes cached input. So
  here `inputTokens` is the SDK's `inputTokens` plus its `cacheReadInputTokens` and
  `cacheCreationInputTokens`.
- A crashed process writes no result message and so no `agent-result`; its usage is reconciled
  from the session transcript into a `usage-record`. A record carrying any of the three fields
  below `@1.2` is refused. Readers accept 1.0 to 1.3. Example:
  [`agent-result.usage.json`](../../schemas/examples/agent-result.usage.json).
- `agent-result@1.3` adds `profile` and `replay`, written for a review team member's step
  ([ADR-0049](../decisions/adr/0049-read-only-agent-workers-as-review-members.md)). `profile`
  `review-member` says the step ran under the review-member profile: its gate denied every tool
  call, so the answer rests on its prompt alone. `replay` binds an answer to the conversation it
  continued by replay, on a runtime that keeps none: the earlier runs of its session it was sent, in
  order (each its message and its answer exactly as they were), their answers (also the artifact's
  `inputs`), and `promptHash`, the hash of everything the run was sent; the top-level `promptHash`
  stays the hash of its own message. A record carrying either field below `@1.3` is refused. Example:
  [`agent-result.review-member.json`](../../schemas/examples/agent-result.review-member.json).

### `model-answer`

- Written once per completed model call, as the body of a `report` artifact
  ([models](../design/models.md)). The prompt is kept by hash only, and the
  model is named by its catalog id, never by the route's model id.
- `finish` is `max-tokens` when the answer was cut at `maxTokens`, the bound the
  call ran under (the smaller of the catalog entry's and the requirement's
  budget).
- `usage` is the provider's own token count of the request that answered. The
  usage report shows it per step; it is not priced.
- `sends` is how many times the call was sent (2 when a restart sent it once
  more, a recorded `reconciliation` decision), and `attempts` how many provider
  requests the last send took. Each request may be billed: at worst
  `sends × attempts`, six with the defaults.

### `account`

- `account@1.1` adds `features`: the website features a probe proved on the
  account, and when (REQ-PRV-7). Routing uses only these. A missing or stale
  probe is refreshed; a feature is never assumed.

### `agent-account`

- One enrollment slot of an agent runtime and the account signed in to its home
  ([PROP-0012](../proposals/0012-agent-accounts.md),
  [ADR-0051](../decisions/adr/0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md)).
  The slot is a home only: its number never names, orders, or identifies an account.
- `accountId` is `<provider>:<h>`, `h` the first 16 hex characters of `identity.hmac`, an
  HMAC-SHA256 over the provider and the principal's canonical parts keyed by a per-install key in
  the credential vault. The full `hmac` is what is compared; two different full values with one
  short form make both accounts `ambiguous`. The principal itself never leaves the runtime (INV-8).
- `status`: `enrolled` (not verified yet), `ready` (signed in as the pinned principal: the only
  status that admits a Worker), `signed-out` (the runtime's own sign-in check fails), `quarantined`
  with `quarantine.reason` `changed`, `ambiguous`, `duplicate`, or `unverified` and the
  `enrollment` decision that set it. A quarantine never clears by itself.
- `hint` is a masked hint for the operator, kept local, never sent to a Worker.
- `home` of slot 1 is its runtime's own home, adopted where it is; of a later slot,
  `<accountHomes>/<provider>/<n>`. A `changed` record keeps the pinned `accountId` and `identity`
  (the account the slot should hold), not the one now read.
- Written by the `agents` source (PROP-0012 phase E), one per slot taken, `revision` raised on
  each change; a freed slot's record is deleted, its history kept in its decisions. Examples:
  [`agent-account.ready.json`](../../schemas/examples/agent-account.ready.json),
  [`agent-account.quarantined.json`](../../schemas/examples/agent-account.quarantined.json).
- `agent-account@1.1` adds the optional `quarantine.detail`: what the reading that quarantined the
  account found, in one line of at most 300 characters, as its `enrollment` decision's reason says
  it (for `unverified`, the runtime version found and the ones its reader admits); never a
  principal. The `agents` source writes a quarantined record at 1.1 with it, and any other at 1.0.
  A record carrying it below `@1.1` is refused. Readers accept 1.0 and 1.1. Example:
  [`agent-account.unverified-version.json`](../../schemas/examples/agent-account.unverified-version.json).

### `session-summary`

- A Worker session's `report` checkpoint (every `checkpointEveryTurns` turns)
  or `handoff` compaction (past `compactAtTokens`), derived from the turn's
  result.
- `generation` is the binding generation it was written in. A compaction
  starts the next one, and the session continues from the summary in a new
  native conversation.

### `hypothesis-set` and `evidence-table`

- These are the scientific-research profile's typed artifacts: `criteria` and
  `evidence`. Each is derived from the accepted answer of its step
  (`inputs: [result]`).
- Ids are stable within one study: hypotheses are `H1`, `H2`, …, and
  evidence is `E1`, `E2`, …. Conclusions cite evidence by id, and every
  evidence `source` is a URL.
- When the step's result changes (superseded, then run again), the new
  artifact `supersedes` the last one.
- `evidence-table@1.1` adds the optional per-claim `reviews`: which of the
  run's two literature reviews state the claim (`["A"]`, `["B"]`, or
  `["A", "B"]`), so a conclusion can say where they agree and differ. A `@1.0`
  record carrying `reviews` is refused. Readers accept 1.0 and 1.1.

### `team-result`

- The body of a team's `report` artifact, composed by the engine from its final
  `vote` decision, never by a model.
- `text` starts with one machine-readable line:
  `outcome: <winner|inconclusive>; method: <team-majority|caller-tiebreak|inconclusive|blocking-finding>; winner: <option|none>; decision: <id>`.
  A review's text lists every finding, blocking ones included, whatever the
  outcome.
- `winner` is null when the method is `inconclusive`. Example:
  [`team-result.tie.json`](../../schemas/examples/team-result.tie.json).
- `team-result@1.1` adds the method `blocking-finding`, whose winner is
  `changes`. Only that method uses `@1.1`; every other result stays `@1.0`.
  Readers accept 1.0 and 1.1.

### `source-snapshot`

- The body of an `evidence` artifact: what a review's members read
  ([sources](../design/teams.md#sources)). It is written by the engine's source
  step, never by a model, with an `acceptance` decision
  `workflow.source-snapshot` that lists the files with their ids and the unread
  files.
- `repository {url, ref?, commit, pinnedBy}` is present for a public repository
  (`pinnedBy`: `sha` when the caller named the commit, `ref` when a branch or tag
  was resolved to it) and
  absent for the caller's text, which is the one file `material` (its `sha` is
  the text's sha256).
- Each file's `sha` is its git blob id at `commit`. Quotes are checked against
  each file's `text`.
- `unread` lists every file of the tree not read, with `why`: `bounds`,
  `too-large`, `binary`, `lockfile`, `path-too-long`, or `not-selected`.
- `text` is what members read: every file line-numbered between fence lines
  derived from its hash, then the unread list. Example:
  [`source-snapshot.repository.json`](../../schemas/examples/source-snapshot.repository.json).

### `assessment`

- An independent review's verdict and findings, each finding with a severity
  (`blocking`, `warning`, `info`).
- `subject` is the exact subject the reviewer was given. The engine stores an
  assessment only if the review names that subject, and the working tree is
  still that subject when the review is accepted. Either way, the outcome is a
  `gate` decision (REQ-WF-5).

### `ui-map`

- Operation ids are dotted lowercase names. Drivers refer to them; they never
  contain selectors ([UI operations](../design/ui-operations.md)).
- `candidates` are ordered; the first with **exactly one** visible match wins.
  Name and text values are regular expressions per locale, written with their own
  anchors.
- `network` patterns are matched against requests and responses the page makes
  on its own. They are never used to send requests.
- A local overlay has the same shape, holds only extra candidates, and is
  merged after the shipped candidates. It never replaces the shipped map.
- `heal` is capped by `sideEffect`: an `irreversible` action never uses `model`.
- `ui-map@1.1` adds the optional element field `frames` (`main` or `any`).
- `ui-map@1.2` adds `unverified: true` on an element or action not yet checked on
  the live site. No irreversible job may depend on one: while a delete flow's
  entries are unverified, its conversations wait, due, and nothing is clicked
  ([conversation ledger](../design/provider-turns.md#conversation-ledger)). The
  live check removes the flag entry by entry.
  Elements with `frames: any` are searched in every frame and take no `scope`.
  Readers accept 1.0 and 1.1.
- `ui-map@1.3` adds the action kind `clearText`: it empties a composer (select all,
  delete) and requires it to read back empty, so an unsent draft a site keeps across
  page loads is never sent with a prompt.
- `ui-map@1.4` adds two optional error-rule fields
  ([ADR-0034](../decisions/adr/0034-unsent-failover-to-a-sibling-account.md)): `feature`, the
  account feature a `quota_exhausted` rule's usage limit applies to (none means the whole
  account), and `on`: `act` (the default) checks the rule before every action, so the turn fails
  unsent; `answer` checks it on a turn's answer once read, so the turn fails sent. The local
  overlay may add error rules, and elements the map does not define, as well as candidates.

### `ui-outline`

- The body of a local-private `evidence` artifact that a `ui.drift` event names
  ([drift evidence](../design/ui-operations.md#drift-evidence)). Only the operator
  reads it (`system evidence`).
- Structure only: per node, the tag, role, `aria-label` (never a link's; at
  most 40 characters; `[redacted]` when it holds an email address or the
  account's name),
  `aria-*` states, test id, names of other `data-*` attributes, id, up to five
  classes, `editable`, and the visible text **length**. Never text, input values,
  or URLs.
- `depth` counts kept nodes only; `repeat` counts like siblings folded into the
  node. At most 200 nodes; `truncated` says the bound cut it short.
- `ui-outline@1.1` adds a link's `link`: its target as a kind, never the URL
  (`external`, another site over http(s); `site`; or `none`). An outline that
  holds one names `@1.1`; readers accept 1.0 and 1.1.
- Example: [ui-outline.composer.json](../../schemas/examples/ui-outline.composer.json).

### `usage-record`

- The body of a `receipt` artifact, one per accounting unit: an agent run, a model call, or a
  website turn. Numbers come from objective sources only, never from a model's self-report.
- The ledger keeps one record per `(source, requestId)`; another with the same key is a
  duplicate and is not counted. A unit is counted once across sources: a `transcript` record is
  written only for a run that has no `runtime-result` record, the case of a crashed process.
- `inputTokens` includes cached input, and `cacheReadInputTokens` and
  `cacheCreationInputTokens` are subsets of it (OpenTelemetry GenAI). So
  `inputTokens ≥ cacheReadInputTokens + cacheCreationInputTokens`, and when `models` is present
  each count of `usage` is the sum over `models`. A source that reports input without its cached
  part (the Anthropic API, the Agent SDK) is normalized before the record is written.
- `pool` must be a pool the account has in configuration; a record for an unknown pool is
  refused. A failed or aborted unit is metered like a completed one.
- `cost.basis`: `runtime-estimate` is the runtime's own client-side figure; `price-table` is
  computed from the usage with the table `priceVersion` names, so history is never repriced
  when prices change. Examples:
  [`usage-record.agent-run.json`](../../schemas/examples/usage-record.agent-run.json),
  [`usage-record.api-call.json`](../../schemas/examples/usage-record.api-call.json).
- A cap counts a record's figure for its unit (`tokens`: input plus output, `usd`: `cost`,
  `turns`, `minutes`: `durationMs`), and a figure the record does not carry counts 0. A unit with no
  counted record counts 0 as well; the Worker source records each such unit as a
  [`usage-unknown`](#usage-unknown) fact ([usage the ledger cannot count](../design/resources.md#usage-the-ledger-cannot-count)).

### `usage-unknown`

- The data of a `usage.unknown` event: one accounting unit whose usage the ledger could not count,
  appended by the Worker source that meters it (today the `agents` source). The event's own
  `runId` is the workflow run the unit belongs to, if any; the record's `runId` is the unit itself,
  as a usage record of it would name it.
- `kind`: `not-reported` (the unit ended, and its runtime reported neither tokens nor turns, so no
  record can be written), `interrupted` (the host stopped while it ran, so no result came),
  `refused` (the ledger refused its record: `failure` is the ledger's, and `record` the refused
  record kept as an `evidence` artifact when it is a valid `usage-record@1.0`), or `failed`
  (recording it failed otherwise). `failure` and `record` belong to `refused` only.
- It never carries a number for the unit's usage, and nothing estimates one. A cap counts the unit
  as 0. The unit is **reconciled** once the ledger counts a usage record of the same `runId` in
  the same `pool` (later a `transcript` record): from then on the report counts it as reconciled,
  and health no longer counts it. A reader validates the data and skips an entry that is not a
  valid record. Examples:
  [`usage-unknown.not-reported.json`](../../schemas/examples/usage-unknown.not-reported.json),
  [`usage-unknown.refused.json`](../../schemas/examples/usage-unknown.refused.json).

### `notification`

- One notice the [notify](../design/notifications.md) plugin makes from one event-log entry: the
  body of its webhook's `POST` and the text of a desktop notification. Never persisted: the store
  keeps only the window each `(kind, subject)` was last told in. Its outcome is a
  `notify.delivery` event, which names its `id`.
- `kind` and `subject` are what deduplication counts by: at most one notice per subject and kind in
  the configured window. `subject` is the request id (`approval.*`), the workflow run id
  (`run.*`), the pool id, or the agent account id (`<provider>:slot-<n>` for a slot with no id
  yet). `id` is `<kind>:<subject>:<event seq>`; an `approval.expiring` notice names the
  `approvals.requested` entry it reminds of.
- `title`, `text`, and `act` are made by code from ids, classes, kinds, and times the producer's
  event names; a value that is not an id or a word is left out, never quoted. It carries no
  secret, prompt, answer, request summary, consequences, or command a request would run, and no
  token: `link` is the `/ui` page without one. Its egress classification is `operator-shared`.
- Validated before it is queued; one that fails its schema is not sent (a defect, logged).
  Examples: [`notification.approval-opened.json`](../../schemas/examples/notification.approval-opened.json),
  [`notification.run-user-action.json`](../../schemas/examples/notification.run-user-action.json).

### `limit-state`

- The body of an `evidence` artifact: one reading of one window of a resource pool. Pools and
  their windows are the operator's configuration of the resource ledger (an account can have an
  interactive window, a programmatic credit, an API key), never a hardcoded plan; `window.id`
  names a configured window.
- Every reading field is optional, because sources omit them (the status line's `rate_limits`
  has been missing in a release). The latest reading of a `(pool, window)` is its current state;
  older ones stay as history.
- `limited` lasts until the later of `cooldownUntil` and `resetsAt`. A window with no reading yet
  counts as `unknown`, like an explicit `unknown` reading: missing telemetry is not capacity. Each
  pool's configuration says whether `unknown` leaves it available (a pool that never reports,
  such as a local model) or not, which is the default (fail closed).
- `runtime-result` readings come from what an agent runtime itself reports
  ([limit readings](../design/agent-runtimes.md#limit-readings)), never from the model's text: its
  events during a run, and the account's usage report read on request
  ([an account's usage report](../design/agent-runtimes.md#an-accounts-usage-report),
  ADR-0059), which `observedAt` dates. A report's `ok` reading never replaces a `limited` one
  before the later of its `resetsAt` and `cooldownUntil`: its Worker source does not record it.
- `history-estimate` readings are computed by code from recorded usage, conservatively. Examples:
  [`limit-state.five-hour.json`](../../schemas/examples/limit-state.five-hour.json),
  [`limit-state.limited.json`](../../schemas/examples/limit-state.limited.json).

### `autonomy-policy`

- One rule per action class, `expiry.defaultSeconds ≤ expiry.maxSeconds`, every rule's
  `expiresSeconds ≤ expiry.maxSeconds`, no rule giving a class that always asks `auto` or
  `notify`, commands-list entries of non-empty words with no shell metacharacter, and a batch
  rule whose `maxWaitSeconds` is under the shortest expiry a request it batches can get; a
  policy that breaks one is refused when loaded. A set holds at most 101 policies: the studio's
  and 100 projects'.
- The classes that always ask are the irreversible effects (`external-send`, `deploy`,
  `delete-data`, `spend`), the investor's decisions (`charter`, `funding`, `policy-change`),
  `remediation`, and `promotion`. The schema refuses `auto` and `notify` for them, except
  `remediation`, which it predates: a policy that gives `remediation` either is refused when
  loaded. `promotion` joined `common@1`'s action classes with the feedback loop
  ([ADR-0045](../decisions/adr/0045-feedback-loop-guarantee-seams.md)). No record named it
  before, so the schema refuses it `auto` and `notify` from the start without tightening
  anything, and the record stays `@1.0`.
- A project policy constrains only the classes it names. The effective mode of a class is the
  strictest of the studio's rule and the project's (`auto` < `notify` < `ask` < `forbid`), so a
  looser project rule has no effect. For a class neither names, it is the stricter of the two
  `default`s.
- `auto` and `notify` hold only while every check in `requires` passes; a failed check goes back
  to the lead as work to fix, never to the operator.
- A command whose argv equals a line of the `commands` list word for word (the line split on
  single spaces), with no further arguments, is judged as `workspace-write`; a project's list may
  only narrow the studio's. Matching is exact, never by prefix. Any other command is the
  `command` class. When the `command` class is `forbid`, listed commands are forbidden too. An
  argv word holding a shell metacharacter (`; & | $`, the backquote, `< > ( ) { } [ ] * ? ~`,
  quotes, backslash, newline, carriage return, tab, NUL) is forbidden, listed or not.
- An approval request expires at its creation plus the shortest `expiresSeconds` of the rules
  that apply to its class (the studio's and the project's), else the stricter
  `expiry.defaultSeconds`, never more than the stricter `expiry.maxSeconds`.
- A `policy-change` is never made by a Worker. While `system` runs, a new policy version takes
  effect only through the operator's approval of a `policy-change` request (proposed by the
  operator, or by the queue itself from repeated identical approvals)
  ([`policy-change`](#policy-change)), so the safety layer never changes itself; at a start, the
  configured set applies unless an applied change derived from that same configuration is
  kept in the store. Examples:
  [`autonomy-policy.studio.json`](../../schemas/examples/autonomy-policy.studio.json),
  [`autonomy-policy.project.json`](../../schemas/examples/autonomy-policy.project.json).

### `approval-request`

- Written only by a core component (`requester.component`), never from model text (INV-6). The
  summary may quote a Worker's proposal; it carries no authority.
- `subject`, `action`, `requester`, `policy`, `classification`, and `expiresAt` never change
  after the request is created, so what the operator was shown is what the verdict binds to. A
  changed proposal is a new request. `requester` names the work waiting on it (a run, session,
  project, or task), so the request is withdrawn when that work ends.
- One request, one exact subject (INV-5). Its subject names a `version`, unless it is an
  `artifact` subject whose `ref` is a `sha256:` content id; the queue refuses another (the schema
  cannot say so, as `common@1`'s subject keeps `version` optional). An operator verdict names the
  subject it saw; if the subject changed since, the verdict is refused and the request is
  unchanged, so the requester must withdraw it and ask anew.
- It is queued only on an `ask` the policies loaded now give: `policy` names the `autonomy`
  decision, which a policy made under the project's policy set as loaded, for the class the
  action is judged as again when it is queued.
- An approving verdict writes an `approval@1.x` artifact by `operator` on the same subject,
  referenced from `resolution.approval`.
- Expiry is one transaction: the state becomes `rejected`, `resolution.cause` is `expired`, and an
  `approval` decision with outcome `denied:expired` is recorded. The waiting work resumes as
  denied. A request is `withdrawn` (also `rejected`) when the work waiting on it ends first, or
  when the loaded policies no longer ask for it: its policy is not current at its version, or its
  class no longer asks (checked at load and on every sweep; the decision's decider is the rule
  `approvals.policy` and its reason says what changed).
- `approval-request@1.1` adds the queue's own requests: a `policy-change` the operator proposed,
  or the queue proposed itself, requested by `approvals` and naming its `policyChangeId`. Such a request must be `@1.1`, of
  class `policy-change`; every other request stays `@1.0`. Only the queue writes one: `request`
  refuses the requester `approvals` (`invalid`). Its subject is
  `{type: content, ref: autonomy-policy-set, version: <the proposed set's hash>}`.
  Examples: [`approval-request.batched.json`](../../schemas/examples/approval-request.batched.json),
  [`approval-request.expired.json`](../../schemas/examples/approval-request.expired.json),
  [`approval-request.policy-change.json`](../../schemas/examples/approval-request.policy-change.json).

### `policy-change`

- One change of the autonomy policy set: the operator proposes one `autonomy-policy@1.0` record
  (a policy of the set at a higher version, or a policy for a project that has none), and the
  queue keeps the whole set it makes (`policies`: the studio policy, then the project policies
  by project id), its `hash` (the sha256 of their canonical JSON), the `baseHash` of the set in
  force when proposed, the `configHash` of the configured set that base derives from, and its
  `effect`: every effective mode it moves, per project. The proposed set loads under the same
  rules as a configured one, or nothing is stored.
- `asked` → `applied` only on the operator's approval of its request, while its base is still
  the set in force, in the transaction of the verdict, with a `policy-change` decision
  (`decision@1.6`). `asked` → `declined` when its request is rejected, expires, or is withdrawn
  (its base no longer in force, or the policy no longer asks). `applied` → `retired` when a
  configuration names its hash in `supersedes` at a start.
- The set in force is the latest applied change's while it is not retired and its `configHash`
  is the configured set's hash, else the configured set
  ([approvals](../design/approvals.md#the-configuration-and-the-stored-set)).
  Example: [`policy-change.applied.json`](../../schemas/examples/policy-change.applied.json).
- `policy-change@1.1` adds the optional `origin`: the queue proposed the change itself
  ([approvals](../design/approvals.md#the-queue-proposes-a-policy-change)). It names the rule
  (`approvals.repeated-approvals`), the `shape` (`{actionClass: command, command}`: the exact argv
  as the one commands line the change adds), the operator's approvals counted (`approved`), the
  `windowSeconds`, and the `decision` that recorded the proposal. A change with an `origin` must be
  `@1.1`; the operator's own changes stay `@1.0`. It carries no authority: only the operator's
  approval of its request applies it. Example:
  [`policy-change.queue-proposed.json`](../../schemas/examples/policy-change.queue-proposed.json).

### `project`

- Its charter is approved by the operator (action class `charter`) on the subject
  `{type: content, ref: project:<projectId>:charter:<version>, version: sha256 of the canonical
  charter without approval}`. `board_charter` with an existing `projectId` amends its charter;
  otherwise it founds a project, with that id or a generated one (derived from its
  `clientRequestId` when it has one, so a retry after a crash asks about the same subject and
  adopts that request, also when it was approved meanwhile). A retry under the same key returns
  the charter version that call asked about. An amendment is held in
  `proposedCharter` with the next version
  until approved, and the project keeps its state meanwhile. A first charter that is rejected or
  expires closes the project as `abandoned` and cancels its open tasks (`project-closed`); a
  refused or expired amendment is dropped.
- A milestone is funded (action class `funding`) by an approval on its budget, a funding round.
  A founding call declares every milestone `planned`, with no `funding`: the charter's approval
  does not cover a funding round.
- Budget use is computed from the usage records of its tasks, never stored on the project.
- Stop rules are words: the lead or the operator judges them, and the action a rule names is put
  to the operator through the approval queue.
- `classification` is a floor for its tasks and briefs. Example:
  [`project.active.json`](../../schemas/examples/project.active.json).

### `board-task`

- `dependsOn` names tasks of the same project that exist when it is proposed, so it is acyclic. While a task is not terminal, no
  other task holds write authority over the same `writes` subject (INV-15).
- `holder` is the lease on resource `board-task:<taskId>`; every write presents its generation
  as a fence.
- `run` is recorded before the run starts. After a restart, a task with a run and no result is
  reconciled and its run is never started again (INV-4); one that cannot be reconciled waits for
  approval with reason `reconciliation-failed`.
- A rejected review starts another attempt while `attempts.count < attempts.max`, and otherwise
  waits for input with reason `retries-spent`; `attempts.count` never exceeds `attempts.max`.
  Every new attempt goes through the autonomy policy again, so an approval request's subject
  `board-task:<taskId>:attempt:<n>` (`n`, the attempts already made) covers one attempt only.
- Only a claimed, running, or reviewed task has a `holder`, and a review the board holds for the
  operator has none: it has `waiting` instead, with reason `operator-review`, the checks still
  pending (`pendingChecks`), and the policy's wait for the class as its expiry, after which it
  waits for input (`review-expired`). Example:
  [`board-task.operator-review.json`](../../schemas/examples/board-task.operator-review.json).
  A result always names its subject:
  the worktree's commit, or the result artifact (`{type: artifact}`) for work with no
  repository, so a task is never stuck in review for want of one. A task that `writes` a subject
  leaves its result on that subject (the same type and ref, at its new version).
- Every wait expires and never starts work: an approval wait follows its request, which expiry
  rejects, and then waits for input with reason `rejected`; an input wait that expires cancels
  the task (`input-expired`). When the queue has not resolved the request by `waiting.expiresAt`,
  or no longer knows it, the board applies the expiry itself.
- `done` needs an `acceptance` decision whose outcome is accepted; the schema checks only that
  it is named. The board takes one only on the task's exact result: its `outcome.detail` names
  the `taskId` and the result's exact `subject` (version included), and may report the `checks`
  it ran (check name → passed); its inputs hold every artifact of the result and its digest. One
  not made by the operator accepts only when the policy finds none of the class's required checks
  failed ([board](../design/board.md#required-checks-bind-at-acceptance)); otherwise the board holds the review for the
  operator. A task in review keeps its holder's lease while verification runs; if the lease
  lapses with no decision, the task waits for input (`review-expired`), which expires in turn.
- A holder lost mid-run is first reconciled by the run's owner: a completed run's result is
  applied with its `acceptance` decision, as a review's would be, a failed one counts as an
  attempt, and only an unknown outcome waits for approval to run again (`reconciliation-failed`);
  an outcome reported later withdraws that request. When the policy's verdict on `remediation`
  (or, for a spent budget, `funding`) is not `ask`, no request can be opened, and the task waits
  for input (`rejected`) instead: it is never readied or cancelled on the policy alone.
- `budget` lines cap what the task's attempts draw together, as the ledger counts them for the
  task. `board-task@1.1` adds a spent budget's funding
  ([board](../design/board.md#funding-a-spent-budget)): `waiting.funding`, only on a
  `budget-spent` wait, holds the lines its `funding` request asks to add, whose subject version is
  `budget-spent:<sha256 of their canonical JSON>`; `funding` lists each raise an approved request
  applied (the lines, the operator's `approval`, the board's `decision`, and when), oldest first,
  at most one per attempt. A record carries either only at `@1.1`; every other record stays
  `@1.0`. Example:
  [`board-task.funding.json`](../../schemas/examples/board-task.funding.json).
- `lastDecision` is the decision behind the latest move: a `board` decision for moves the board
  makes on its own, otherwise the acceptance, approval, route, or reconciliation decision that
  caused it. Examples: [`board-task.review.json`](../../schemas/examples/board-task.review.json),
  [`board-task.waiting-for-approval.json`](../../schemas/examples/board-task.waiting-for-approval.json).

### `brief`

- The body of an `objective` artifact. Every `artifacts[].ref` is also an input of its envelope,
  so unknown references are refused and the classification floor applies (INV-12); its
  `classification` is at least the strictest of them.
- It carries pointers, never content. A Worker source resolves them when it renders the brief
  into its prompt at start, and checks egress on what it rendered
  ([briefs](../design/workflow-engine.md#briefs)).
- `brief@1.1` adds `instructions`: what the Worker is told, in order, as its template words it,
  text and pointers by their index in `artifacts`. Rendered, each pointer is replaced by its
  artifact's text (the body's `text`, else its canonical JSON) and never expanded again. A brief
  for a board task, or one without instructions, first states the task and attempt, the goal,
  the acceptance criteria, and the open questions; pointers the instructions do not place follow,
  with their role and note. `instructions` before 1.1 is refused.
- `brief@1.2` adds `ask`: the Worker may answer with questions instead of a result, when it
  cannot finish without a person's answer. Rendered, the brief says how: the whole answer one
  JSON object `{"questions": [...]}`, 1 to `maxQuestions` (at most 8) questions of at most 500
  characters, the bounds of a board task's question wait. Anything else is a result. The workflow
  engine offers it on every brief of a board task's run
  ([a question from a run](../design/workflow-engine.md#a-question-from-a-run)); `ask` before
  1.2 is refused. Example: [`brief.task-attempt.json`](../../schemas/examples/brief.task-attempt.json).
- `brief@1.2` adds `files`: at most 4 files a Worker source with a workspace of the run's own
  writes there before the run, each the text of the artifact it points at, at a path of one name
  under `.system/` (a directory the source makes git ignore). Every `files[].ref` is an input of
  the envelope too, under the same classification floor. A source with no such workspace writes
  none and never mentions them; `files` before 1.2 is refused
  ([TASKS.md in a run's workspace](../design/workflow-engine.md#tasksmd-in-a-runs-workspace)).
- `sandbox` comes from trusted configuration (the Worker source's), never from model text, and
  `budget.remaining` is computed from the ledger when the brief is written. `resume` names the
  native session the brief continues, when the Worker keeps one. Examples:
  [`brief.task.json`](../../schemas/examples/brief.task.json),
  [`brief.node.json`](../../schemas/examples/brief.node.json).

### `board-projection`

- The body of an `evidence` artifact: a project's board as the board's `TASKS.md` projection
  renders it (`format: tasks-md`), when a board task's run was admitted, for the run's worktree.
  A projection of the store, never read back: it decides nothing.
- `tasks` counts the project's tasks, listed or not; the text lists at most the engine's
  `tasksFile.maxTasks` and holds at most `tasksFile.maxChars` characters, `truncated` when it was
  cut (a note at its end says so). Its classification is the run's. Example:
  [`board-projection.tasks-md.json`](../../schemas/examples/board-projection.tasks-md.json).

### `digest`

- The body of a `report` artifact whose envelope inputs are its `sources`. Every
  `citation.artifact` is one of them, and claim ids are unique.
- The quote check: each quote must occur verbatim in the cited artifact's text (its body's `text`
  field when it has one, otherwise its canonical JSON), at `offset` (in code points) when one is
  given. A claim that fails is dropped and recorded first in `dropped`; a digest with no claim
  left is not written ([digests](../design/digests.md#the-quote-check)). When every claim of an
  economy Worker's answer fails, the request is written once more on the standard tier, never
  higher ([one escalation](../design/digests.md#one-escalation)).
- `sources` are the request's, never the Worker's answer's.
- Its classification is at least its sources'. A digest of `local-private` sources is written by
  a local Worker or one the egress policy allows. Example:
  [`digest.test-run.json`](../../schemas/examples/digest.test-run.json).

### `digest-extract`

- The body of an `evidence` artifact the extractive digest provider records before its Worker runs
  ([extractive-first](../design/digests.md#extractive-first)): verbatim spans of a request's
  sources, selected by code. Its envelope inputs are the `sources`, and its classification is at
  least theirs. The Worker's brief points at it, never at a source.
- Each extract's `quote` occurs verbatim in its source's text (the body's `text` field, else its
  canonical JSON) at `offset`, in code points: one line, or a part of a line longer than a quote may
  be, without surrounding whitespace, so it can stand as a claim's quote. A claim the Worker cites
  by an extract's `id` is given that extract's source, quote, and offset; the quote check still
  reads the source.
- `rule` names the selection rule and its version: the same stored sources, rule, and bound give
  the same body, so the artifact deduplicates. `sources[].spans` counts the spans of each source the
  rule weighed, `truncated` when its text is longer than the rule reads; `text` is what the Worker
  reads (the sources by number, then each extract with its id). An extract with no span is never
  recorded: the request is bypassed. Example:
  [`digest-extract.test-run.json`](../../schemas/examples/digest-extract.test-run.json).

### MCP tools: `digests_*`

| Tool | Scope | Does |
|---|---|---|
| `digests_request` | client | ask for a cited digest of 1 to 64 raw artifacts, by content id; waits up to `waitSeconds` for it to settle |
| `digests_get` | client | read a request as it stands: `pending`, `written` (with its digest), `not-written`, or `bypassed`, with why |

- Both answer with the request (`$defs/request` of
  [`mcp-digests.v1.json`](../../schemas/mcp-digests.v1.json); 1.1 adds its `escalation`, the
  decision that had it written once more on the standard tier); a refused input does nothing, and
  a `clientRequestId` reused for other sources is refused (`invalid`).
- A request no Worker can serve is not refused: it settles `bypassed` ([digests](../design/digests.md)).
  Example: [`mcp-digests.request.json`](../../schemas/examples/mcp-digests.request.json).

### MCP tools: agent accounts

| Tool | Scope | Does |
|---|---|---|
| `account_enroll` | operator | step `begin`: take the lowest free slot of a runtime (or the slot named; a taken slot, or an `accountId`, is signed in again) and return the runtime's own sign-in command for its home (a runtime with no identity reader takes no free slot: `config_error`, nothing enrolled); step `verify`: read who signed in and record the account (`accept` takes a `changed` slot's new principal as a new account) |
| `account_remove` | operator | free a slot, by `accountId` or by `provider` and `slot`; its home is kept |
| `account_agents` | operator | every slot and the account in it, with the Workers that run on its account and the operator's `label` of its account (`@1.2`); each runtime's slots, how many are taken, whether it reads identity and gives a sign-in command, and its `title` (`@1.2`) |
| `account_migrate` | operator | `@1.1` (a role's `kinds` and `description` `@1.2`): the move from hand-named agent Workers to Workers derived as account × role: `plan` (`workers`: each old Worker's `from`, `runtime`, `role`, new id `to` and `account`, or none when it stops, and why; the new row's `roles`, `assignments`, `providers`; `templates` for the resources row; `blockers`), the new row's whole config (`row`), the `outcome` (`planned`, `applied`, `already-applied`, `rolled-back`, `not-applied`), the `cutover` in force (its decision, when, and the plan applied), and how many sessions and runs were `moved`. `apply` and `rollback` never together |

- Input and output: [`mcp-agent-accounts.v1.json`](../../schemas/mcp-agent-accounts.v1.json)
  `$defs/<tool>-input` and `<tool>-output` (`mcp-agent-accounts@1.2`; 1.1 adds `account_migrate`). A slot is named by its
  `provider` and `slot` or by the `accountId` it holds, never both; `verify` and `remove` name the
  slot whole, and only `verify` accepts. An `accountId` two slots hold (a duplicate) names neither.
- `mcp-agent-accounts@1.2` adds, each optional: on a plan's role, `kinds` (1 to 16 `workKind`
  labels, each once) and `description` (1 to 200 characters), as the planner gives them (rule
  `agent-workers.migration` version 3: the rows' kinds, and their description when every row of
  the role gives the same one); in `account_agents`, an account's `label` (the operator's,
  `assignments[].label`, 1 to 64 characters) and a runtime's `title` (its provider's name for
  people, 1 to 64 characters). Readers accept 1.0 to 1.2. A 1.1 reader refuses a plan whose roles
  carry `kinds`: that was the defect 1.2 fixes.
- Each account is an [`agent-account@1.x`](#agent-account) record. The sign-in command's
  environment names the home and never a session bus; nothing holds a principal or a token (INV-8).
  A refused input does nothing (`invalid input, nothing done`); a refused call says its kind
  (`invalid_input`, `config_error`) and changes nothing.
- **Output checked before a change commits.** A call that changes anything (a slot taken, a reading
  recorded, a slot freed, a cutover applied or rolled back) checks the output it would give against
  its `<tool>-output` before its change commits: an output its schema refuses is a defect,
  refused as `<tool> would make an output its schema refuses (a defect), so nothing changed`. A
  call that changes nothing (`account_agents`, a plan) is checked as it returns (`<tool> made an
  output its schema refuses (a defect)`).
- Examples: [`mcp-agent-accounts.enroll.json`](../../schemas/examples/mcp-agent-accounts.enroll.json),
  [`mcp-agent-accounts.list.json`](../../schemas/examples/mcp-agent-accounts.list.json),
  [`mcp-agent-accounts.migrate.json`](../../schemas/examples/mcp-agent-accounts.migrate.json).

### MCP tool: agent runs

| Tool | Scope | Does |
|---|---|---|
| `agent_run_free` | operator | free the session and worktree an agent run holds because it ended without being known to be gone, on the operator's word that its agent is gone ([freeing what a run holds](../design/agent-runtimes.md#freeing-what-a-run-holds)) |
| `agent_worktrees` | operator | 1.1: the workflow runs' worktrees not removed yet, with their state, what they hold, and when the retention removes them ([the operator's removal](../design/agent-runtimes.md#the-operators-removal-of-run-worktrees)) |
| `agent_worktrees_remove` | operator | 1.1: remove the finished run worktrees now, never discarding a change ([the operator's removal](../design/agent-runtimes.md#the-operators-removal-of-run-worktrees)) |

- Input and output: [`mcp-agent-runs.v1.json`](../../schemas/mcp-agent-runs.v1.json)
  `$defs/agent-run-free-input` and `agent-run-free-output` (`mcp-agent-runs@1.0`). `agentRun` is an
  `arun_` id with 16 hex digits; `agentGone` must be `true` (anything else is refused by the schema,
  nothing done); `commitWorktree` has a dirty worktree's changes committed on its branch, then the
  worktree removed; `note` (at most 1,000 characters) is kept as the decision's rationale.
- The output names the operator's `reconciliation` decision (decider `operator.free`), recorded before
  anything was freed; `again` when the run was freed already (only its worktree was looked at again);
  `freed`, what it held that is free now, in words (empty when `again`); and each worktree of its
  workflow run, `removed` (with the `commit` that kept its changes, if any) or `kept`, and `why`.
- A refused call (`invalid_input`) changes nothing and records nothing: no such run, a run that holds
  nothing, a run freed already with no worktree of it left, its liveness still being looked at,
  another started run of its session or worktree not finished, its lease held, or its holder or
  agent process present on this host. Example:
  [`mcp-agent-runs.free.json`](../../schemas/examples/mcp-agent-runs.free.json).
- `agent_worktrees` (1.1; `$defs/agent-worktrees-input`, `-output`): `limit` 1 to 100 (default
  100). The output gives `retentionHours` (agent-workers `worktreeRetentionHours`), `total` (every
  worktree not removed), and at most 100 of them, oldest first: `runId`, `repository`, `path`,
  `branch`, `createdAt`, `lastActivityAt` (when its workflow run's last agent run ended, else when it
  was made), `state` (`in-use` while an agent run of its workflow run is queued or running; `held`
  while one ended without being known to be gone; `finished` otherwise), `changes` (`clean`,
  `uncommitted`, `gone` from disk, or `not-intact`: its `.git` file or branch is not what it was
  made with, so git is not run there), `retiresAt` once finished with a retention above 0, and the
  last retirement's `failure`. Example:
  [`mcp-agent-runs.worktrees.json`](../../schemas/examples/mcp-agent-runs.worktrees.json).
- `agent_worktrees_remove` (1.1; `$defs/agent-worktrees-remove-input`, `-output`): `runId` (a
  workflow run id) narrows it to that run's worktrees; `commitChanges` has a finished worktree's
  uncommitted changes committed on its branch before it is removed; `note` (at most 1,000
  characters) is the decision's rationale. The output names the operator's `retention` decision
  (decider `operator.worktrees`), recorded before any worktree was removed and absent when none
  could be (then nothing is decided); each worktree looked at (at most 50), `removed` (with the
  `commit` that kept its changes, if any) or `kept`, and `why`; and `more`, those not looked at. A
  worktree is removed only while it is `finished` and holds nothing uncommitted, or with
  `commitChanges`; the branch always stays. Its output is checked on its plan before anything is
  decided: an output its schema refuses (a defect) decides and removes nothing. Example:
  [`mcp-agent-runs.worktrees-remove.json`](../../schemas/examples/mcp-agent-runs.worktrees-remove.json).

### MCP tool: `report`

| Tool | Scope | Does |
|---|---|---|
| `report` | client | the baseline report of a period, for one project or every one, from recorded data only; by default the 7 days before now (the weekly investor report) |

- Input and output: [`mcp-report.v1.json`](../../schemas/mcp-report.v1.json) `$defs/report-input` and
  `report-output`. The period is `since` (inclusive) to `until` (exclusive, default the call), or
  the `days` before `until`; never both `since` and `days`, and at most 366 days.
- What each figure counts, and from which records, is in [reports](../design/reports.md#what-it-counts).
  `asOf` is when the board and the queue were read: the `now` counts are as of then. Two calls on
  the same records and period differ in `asOf` only.
- `mcp-report` 1.1 adds what a cap counts as 0, each only when there is any: `withoutTokens`,
  `withoutCost`, `withoutTurns`, and `unknownRuns` per pool and in all, and `usage.unknown`, the
  runs whose usage the ledger could not count by kind and how many were reconciled
  ([usage the ledger cannot count](../design/resources.md#usage-the-ledger-cannot-count)). A 1.0
  report has none of them and stays valid.
- `mcp-report` 1.2 adds `attention.liveness`, only when there is any: the agent runs whose liveness
  asked for the operator in the period (`stalled`, `unknown`, `freed`) and `held`, those that ended
  unknown in the period and were not freed in it (at most 64, `heldOmitted` counting the rest), each
  by its agent run, Worker, when, and workflow run. They are never counted as interruptions. A 1.1
  report stays valid.
- The call's text content is the report rendered for the operator (Markdown); the structured
  content is the report. A refusal (`unavailable`, `unknown-project`, `invalid`, `overloaded`)
  reads nothing more and reports nothing. Example:
  [`mcp-report.week.json`](../../schemas/examples/mcp-report.week.json).

### MCP tool: `roster`

| Tool | Scope | Does |
|---|---|---|
| `roster` | client | every Worker in one read model, projected on read: its account and the account's record, role, tier, quota class, availability, the work it serves now, its load, and its account's pools and windows ([roster](../design/roster.md)) |

- Input and output: [`mcp-roster.v1.json`](../../schemas/mcp-roster.v1.json) `$defs/roster-input`
  (no arguments) and `roster-output`. The record is computed on each call and never stored, so it
  carries no `schema` tag; `asOf` is when it was read, and two calls on the same state differ in
  `asOf` only.
- Every fact a source might not give is a *known* value: `{value}`, or `{unknown}` with why (its
  service is not mounted, its read failed, or it does not say). A reader never takes an `unknown`
  for an empty list or a default. `role` is `{value: null}` for a Worker that serves no role.
- `availability.state` is one of `ready`, `busy` (`running` of `slots`, when the load is known),
  `resting` (`until`, a known time or unknown), `unavailable` (`reason`, known or unknown), and
  `quarantined` (the account's quarantine `reason`, `since`, and the `enrollment` `decision`); each
  has a `summary`, its one-line form. What makes each is in [availability](../design/roster.md#availability).
- `account.record.label` is given to an operator-scope caller only; a client's record has no label.
- `mcp-roster@1.1` adds, per Worker, `description` (known: the operator's words from its
  descriptor, `capability-descriptor@1.7`, or `unknown` when none is configured) and `derived` (its
  provider, role, tier, quota class, and locality as one line, for a reader to show, marked as
  derived, when there is no description); and, per step of `work`, `since` (known: when its
  current attempt started, from the event log) and `summary` (the step in one sentence: its task,
  run, step, and for how long, as of `asOf`). Readers accept 1.0 and 1.1.
- `mcp-roster@1.2` adds, per Worker, `liveness`: present only when the router tells liveness and the
  Worker has a run that is `stalled`, being looked at (`looking`), or ended without being known to
  be gone (`unknown`), each with `execution`, `state`, `since`, `runId`, and `summary`; or
  `unknown` when the read failed or a source could not tell. A 1.1 record stays valid.
- `mcp-roster@1.3` adds each Worker's `name` for people: `<provider> · <account> · <role or tier>`,
  its provider's first word capitalised (a model Worker's, its family's), its account's label for
  an operator-scope caller (a website account's catalog label, an agent account's masked hint),
  else its account's id (a website account) or slot (an agent account), else the rest of its own
  id, and its role, else its tier. It is never an id to route by. A Worker its source describes
  ready, on which the engine runs a step, is `busy` whatever load its source reports, and its
  `summary` says so. Readers accept 1.0 to 1.3.
- `mcp-roster@1.4` makes `name` the display name, `<runtime> · <account> · <role or tier>
  [<kinds>]`, made on each read from the runtime's title (else its provider's first word, as in
  1.3), the account's label for an operator (an agent account's `assignments[].label`, else its
  masked hint and slot; a website account's catalog label, else its id; for a client the slot or
  the id, never a label; with no account, the rest of its own id), its role or tier, and its kinds
  ([display names](../design/roster.md#display-names)); never a routing input, never a key, and
  still at most 200 characters. It also adds an agent account quarantine's `detail`
  (`agent-account@1.1`), on the account record and the `quarantined` availability, and in its
  summary. Readers accept 1.0 to 1.4.
- Bounds ([roster bounds](../design/roster.md#bounds)): at most 256 Workers (`unlisted` counts the
  rest), 32 steps per Worker (`more`), 64 siblings, 64 pools, 16 windows per pool, 64 sources, 64
  step starts;
  past a bound with no count, the field is `unknown` with why, never cut silently. `work.unread`
  says the runs read were cut by their bound (500).
- The call's text content is the record rendered for a terminal (what `system roster` prints); the
  structured content is the record, validated before it is sent: a record its schema refuses is a
  defect, and the call is an error. Example:
  [`mcp-roster.call.json`](../../schemas/examples/mcp-roster.call.json).

### `plugin-manifest`

- `name` never changes; a renamed plugin lists its old names in `renames`, so the host matches
  its old configuration and records.
- Each `provides` version is the contract version of the seam's conformance suite that the
  plugin passed.
- A `core` plugin fails closed and a `family` plugin fails open
  ([ADR-0036](../decisions/adr/0036-guarantee-core-and-capability-plugins.md)).
- `config` lists the plugin's configuration keys, from its `Config` schema. A `sensitive` key
  holds a secret (its schema is marked `.role('secret')`): the host keeps it in `ctx.credentials`,
  and the plugin's configuration holds only its reference. No `system` plugin declares one.
- `egress` is the strictest classification the plugin may send off the machine under the default
  egress policy: a plugin that sends no Worker's content off the machine declares none. The
  operator's policy can widen a Worker class; the egress check runs on the actual payload
  (INV-12). `cacheStable` belongs to a context plugin only.
- A consumed seam's `range` is a caret range (`^1.3.0`): the plugin works with that contract
  version and every later minor of its major. At start the plugin host checks each plugin a row
  mounts against it: a range its mounted provider's manifest does not satisfy, or one the host
  cannot read, is a finding ([the manifest check](../design/plugin-host.md#the-manifest-check)).
- `plugin-manifest@1.1` adds `defines`: the seams whose abstract definition a definition package
  (a `*-core` package) owns, each at its conformance suite's contract. A manifest that names it
  must be `@1.1`; every other stays `@1.0`. Example:
  [`plugin-manifest.definition.json`](../../schemas/examples/plugin-manifest.definition.json).
- `_meta` belongs to the host: a declared manifest that carries it is refused. Each lifecycle
  change is recorded as a `lifecycle` decision before the state; Base records the state the
  composition gives a plugin and automates nothing, so it never records `shadow` or `canary`
  ([plugin host](../design/plugin-host.md)). A host also refuses a manifest that names another
  package than its row loads, or that is larger than 64 KiB. Each package's manifest is generated
  from its code and checked against it (`pnpm check:manifests`). Examples:
  [`plugin-manifest.digest-provider.json`](../../schemas/examples/plugin-manifest.digest-provider.json),
  [`plugin-manifest.core.json`](../../schemas/examples/plugin-manifest.core.json).

### MCP tools: `board_*`, `approvals_*`, `resources_*`

| Tool | Scope | Does |
|---|---|---|
| `board_projects` | client | list projects with task counts and budget use |
| `board_charter` | client | found a project or amend its charter; opens a `charter` approval request |
| `board_brief` | client | one page for a new agent: intent, in progress, waiting, next, what to read first |
| `board_tasks`, `board_task` | client | list tasks; read one |
| `board_propose` | client | propose a task; the board makes it ready when its dependencies are done and the policy allows |
| `board_claim` | client | take a ready task's lease; MCP `run` with the task and this claim starts the attempt, and that run submits and accepts its own result |
| `board_update` | client | report progress and renew the lease, or answer a waiting task's questions |
| `board_cancel` | client | cancel a task that is not running or in review |
| `board_pause`, `board_resume` | operator | pause an active project (nothing of it is claimed, started, or gated until it is resumed; running attempts and waits go on), or resume a paused one |
| `board_close` | operator | close an active or paused project as `achieved` or `stopped`, refused while one of its tasks runs or is in review; its open tasks are cancelled and the requests they and a pending amendment waited on withdrawn |
| `approvals_list`, `approvals_get` | client | read the queue |
| `approvals_decide` | operator | verdicts for up to 50 requests, each bound to its exact subject |
| `approvals_policy` | client | the studio and project policies, the effective mode per action class, and the set in force (`set`: its hash, whether it comes from the configuration or the store, and the projects with a policy) |
| `approvals_policy_propose` | operator | propose one policy record; the queue asks the operator with a `policy-change` request on the proposed set's hash, and applies it only on approval |
| `resources_pools` | client | each pool with the latest reading of each window, and whether it is available |
| `resources_usage` | client | usage records, filtered, with totals over every match |

- A page holds at most 100 items; `next` is an opaque cursor.
- No `board_*` tool starts, submits, accepts, blocks, or reconciles a task: the workflow run that
  serves an attempt does, as its owner, so one attempt has one writer
  ([INV-15](../architecture/invariants.md#inv-15-one-writer-per-subject)).
- `board_pause`, `board_resume`, and `board_close` are the operator's project moves
  ([board](../design/board.md#the-operators-project-moves)): the host serves them to the operator
  token only, and each handler refuses any other caller (`invalid`). Each output names the
  `board` decision that records the move; `board_close` also counts the open tasks it cancelled.
  `mcp-board` 1.1 adds them.
- A refused verdict (`unknown-request`, `already-resolved`, `expired`, `subject-changed`, or
  `failed`: the provider could not apply it, which it logs) leaves its request unchanged; the
  other verdicts of the call still apply. `mcp-approvals` 1.1 adds `failed`; 1.2 adds
  `approvals_policy_propose` and `set`.
- Examples: [`mcp-board.claim.json`](../../schemas/examples/mcp-board.claim.json),
  [`mcp-board.charter.json`](../../schemas/examples/mcp-board.charter.json),
  [`mcp-board.close.json`](../../schemas/examples/mcp-board.close.json),
  [`mcp-approvals.decide.json`](../../schemas/examples/mcp-approvals.decide.json),
  [`mcp-approvals.policy-propose.json`](../../schemas/examples/mcp-approvals.policy-propose.json),
  [`mcp-resources.usage.json`](../../schemas/examples/mcp-resources.usage.json).

### `objective-contract`

- The body of a `criteria` artifact: what "better" means for one application, versioned
  ([PROP-0011](../proposals/0011-feedback-loop.md#objective-contracts)). It is written only on the
  operator's approval (`producer.type: operator`); the registry refuses an experiment under a
  contract written otherwise. A new version supersedes the old one (`lineage.supersedes`), and an
  experiment pins `{id, version, hash, ref}`, `hash` being the sha256 of the contract's canonical
  JSON.
- `hardConstraints` always hold `invariants`, `egress`, and `autonomy-policy` (the schema checks
  it), each naming the collector that validates it; the loop never changes them.
- `metrics` says where each per-trial value comes from: `collector` (a registered collector),
  `ledger` (the sum of the usage records the resource ledger attributes to the trial, in one of its
  units), or `ratio` (the ratio of two other metrics' sums over cases; never a ratio of ratios).
  Every metric the contract defines is needed: a trial missing one makes its evaluation `invalid`.
- `primary` names one metric, its direction, and its `minimumPracticalEffect`; each guardrail has
  either a `nonInferiorityMargin` on the paired difference or a `floor` on the candidate's own
  level (a ceiling, for a metric that should decrease). There is no weights field and no other
  `comparison` than `constrained-dominance`.
- `protocol` declares the interval `confidence`, `minCases`, `repetitions`, the evidence
  `partitions` (never `development`), and one method per metric: `sign-flip`, `bootstrap` (with
  its `resamples`), or `bayesian` (with its `prior`). An experiment's protocol may only be
  stricter ([experiments](../design/experiments.md#a-registration)). Each method is the pinned
  statistics library's ([statistics](../design/statistics.md)).
- The registry also refuses a contract whose primary or a guardrail has no method or no metric, whose
  ratio reads an undefined metric or a ratio, or that guards the primary or one metric twice
  (`contractProblems` in [`experiments-core`](../../packages/experiments-core/README.md)). Example:
  [`objective-contract.review.json`](../../schemas/examples/objective-contract.review.json).

### `hypothesis`

- The body of a `criteria` artifact the experiment registry writes when it answers a registration:
  one falsifiable claim about one target. It is not the research profile's
  [`hypothesis-set`](#hypothesis-set-and-evidence-table), which frames one study.
- `fingerprint` is computed by the registry, never taken from the caller: version 1 of the
  [semantic key](../design/experiments.md#two-keys), each tag normalized to the vocabulary's
  canonical tag (the tag itself or one of its aliases). A tag the vocabulary does not hold is
  refused. The record keeps each tag as its author gave it.
- `priorEvidence.experiments` names earlier experiments by id; naming one links it by hand, so the
  registry treats it as related. `source.ref` names the research run, brainstorm decision, or
  retrospective the claim came from; only the operator's own claim has none. Example:
  [`hypothesis.worker-agnosticism.json`](../../schemas/examples/hypothesis.worker-agnosticism.json).

### `experiment`

- The body of a `plan` artifact the experiment registry writes when it answers a registration,
  pre-registered or refused ([a registration](../design/experiments.md#a-registration)). It never
  changes: a material change is a new `revision`, whose `supersedes` names the previous revision's
  artifact (from revision 2 on, and only then).
- `identity` is the exact identity (version 1) and `environment.hash` the sha256 of the normalized
  environment, both computed by the registry ([two keys](../design/experiments.md#two-keys)); the
  ids, the revision, the budget, the seed, and the prose are not part of the identity.
- `registry` holds the answer, the experiments the registration cites (each resolved to its
  pre-registered revision and artifact), the retry predicates it names as changed (each confirmed
  by the records against a match), and why the earlier evidence may no longer apply.
- Both arms are exact subjects with their versions (INV-5); the candidate's `provenance.runs` are
  the runs that produced it, whose usage counts as its cost. `stopping.trials` is every case of the
  partitions used, in both arms, at the protocol's repetitions.
- `budget.funding` is the operator's approval of the funding round that pays for it (an
  `approval@1.0` artifact, approved by the operator); every line a trial reserves (`perTrial`) has
  a budget line, and the lines in the contract's cost unit stay within its ceiling.
- `independence` names opaque provider families, compared for inequality only
  ([ADR-0027](../decisions/adr/0027-provider-diversity-in-routing.md)): maker, reviewers, and
  model-based validators pairwise different, and no validator of a family an arm runs on. Example:
  [`experiment.worker-agnosticism.json`](../../schemas/examples/experiment.worker-agnosticism.json).

### `evaluation`

- The body of an `evidence` artifact the evaluation engine writes once an evaluation ends
  ([an evaluation](../design/evaluations.md#an-evaluation)); its envelope inputs are the experiment
  and every trial's result artifacts. Measurements are observations: the verdict is a `verdict`
  decision that cites this record.
- `experiment.identity` is the identity of the exact experiment evaluated (INV-5). `trials` holds
  every scheduled trial, in schedule order, each `completed`, `failed` (measured: a failed run is an
  outcome), `lost` (started, its outcome unknown after a restart, never run again), or `skipped`
  (the evaluation ended first), with the source of each measurement (a collector and its version,
  or `ledger`) and why it is `invalid` when it is.
- `integrity` always records the seven checks (`pins`, `seal`, `arms`, `families`, `metrics`,
  `judge`, `trials`) and every value a trial lacks, with why. `analysis` is empty unless the
  horizon was reached with every check passed: v1 takes one analysis, at the end; each
  `difference` is candidate minus baseline as measured.
- `cost` comes from the resource ledger's usage records only, per pool and unit, per phase, sunk or
  projected; `arms` is descriptive. Example:
  [`evaluation.inconclusive.json`](../../schemas/examples/evaluation.inconclusive.json).

### `lesson`

- The body of a `finding` artifact the experiment registry writes; its envelope inputs are the
  verdicts and experiments it cites. Its `outcome` equals the outcome of every verdict it cites,
  each verdict is about an experiment it cites, and each such experiment is closed with one of
  those verdicts; the registry refuses it otherwise. Who may write one is open
  ([PROP-0011](../proposals/0011-feedback-loop.md#open-questions), Q11); the envelope's producer
  records who did.
- `applicability` is the envelope it was observed in. Whether it still applies is computed when it
  is read, never stored ([lessons](../design/experiments.md#lessons)): each `invalidatedBy`
  predicate fires when what it names changed in the current environment or the environment no
  longer shows it (a family's model version, a contract's or suite's version, a vocabulary
  mechanism, a collector's version, the cost model), or when its `expiry` passed. Example:
  [`lesson.inconclusive.json`](../../schemas/examples/lesson.inconclusive.json).
