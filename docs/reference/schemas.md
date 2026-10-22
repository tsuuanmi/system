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
| MCP tool input and output | each call | MCP error to the client; nothing is executed |
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
  so earlier decisions keep their ids. Readers accept 1.0 through 1.4.
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
    `ask`, and `forbid`; the decider is the policy (`policy`, its id and version); the outcome is
    the mode, and `detail` names the action class and the effective policies.
  - `approval`: how an approval request was resolved. Options `approved`, `rejected`,
    `denied:expired` (decider rule `approvals.expiry`), and `withdrawn`. Example:
    [`decision.approval-expired.json`](../../schemas/examples/decision.approval-expired.json).
  - `board`: a move the board makes on its own (dependencies met, a lease lost, a wait expired,
    a retry). The outcome is the target state; `detail` names the task or project and the state
    it left.
  - `budget`: a reservation before a run. Options `reserved` and `refused`; `detail` names each
    pool, the amount, and what remained.
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

### `workflow-node`

- `nodeId` is deterministic. Unrolled loops append an ordinal, for example
  `review:cycle:2` ([ADR-0012](../decisions/adr/0012-dag-execution-model.md)).
- Every state transition updates `lastDecision` to the decision artifact that
  caused it ([INV-13](../architecture/invariants.md#inv-13-every-decision-is-an-artifact)).
- `workflow-node@1.1` adds the state `RETIRED`: a node a re-plan took out of the
  graph. It stays as history, never runs again, and its `lastDecision` is the
  `graph-growth` decision that retired it. Only a retired node is written as
  1.1; readers accept 1.0 and 1.1.

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

- `sessionId` never changes for the session's lifetime. `binding.nativeHandle`
  and `binding.generation` change on re-activation. A write from an activation
  with a stale generation is rejected.
- `mailboxSeq` is the last delivered inbound sequence number. Redelivery after a
  crash resumes at `mailboxSeq + 1`.
- `policy.writes` present means this session holds write authority over that
  subject (INV-15). At most one open session per subject may hold it.

### `message`

- `messageId` is unique per sender. Receivers deduplicate on `(from, messageId)`.
- `body` is untrusted data for the receiver, never authority (INV-6).
  Approvals travel only as `approval` artifacts.
- `refs` must pass the egress check for the receiver's locality (INV-12).
- It maps to A2A `Message`: `messageId`, `referenceTaskIds` ≈ `refs`/`inReplyTo`,
  and `parts` ≈ `body` plus refs.

### `capability-descriptor`

- `provider` is informational. Routing must not branch on it (INV-11). Only
  `capabilities`, `tier`, `quotaClass`, `locality`, `state`, `family`,
  `maxInputChars`, and `load` are routing inputs.
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

### `plan`

- Proposed by a planner node, and validated by the engine before anything is
  appended: unique ids under the planner's prefix, dependencies only among its
  own nodes, acyclic, within the node bound, allowed capabilities only.
- A `graph-growth` decision records whether it was appended and why.
- An edited plan is a new artifact with a new id. An approval of the old one
  never covers it.

### `approval`

- `subject` is the exact artifact approved (INV-5). Today that is a plan.
- It is written only through an operator channel (CLI or MCP `approve`), never
  from model output (INV-6).

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
  loop's model.
- Token counts are normalized as in [`usage-record`](#usage-record). The SDK's `modelUsage`
  uses the same field names with another meaning: its `inputTokens` excludes cached input. So
  here `inputTokens` is the SDK's `inputTokens` plus its `cacheReadInputTokens` and
  `cacheCreationInputTokens`.
- A crashed process writes no result message and so no `agent-result`; its usage is reconciled
  from the session transcript into a `usage-record`. A record carrying any of the three fields
  below `@1.2` is refused. Readers accept 1.0 to 1.2. Example:
  [`agent-result.usage.json`](../../schemas/examples/agent-result.usage.json).

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

### `limit-state`

- The body of an `evidence` artifact: one reading of one window of a resource pool. Pools and
  their windows are the operator's configuration of the resource ledger (an account can have an
  interactive window, a programmatic credit, an API key), never a hardcoded plan; `window.id`
  names a configured window.
- Every reading field is optional, because sources omit them (the status line's `rate_limits`
  has been missing in a release). The latest reading of a `(pool, window)` is its current state;
  older ones stay as history.
- `limited` lasts until the later of `cooldownUntil` and `resetsAt`. `unknown` means no reading
  says either way; a pool configured to fail closed is then unavailable to new work.
- `history-estimate` readings are computed by code from recorded usage, conservatively. Examples:
  [`limit-state.five-hour.json`](../../schemas/examples/limit-state.five-hour.json),
  [`limit-state.limited.json`](../../schemas/examples/limit-state.limited.json).

### `autonomy-policy`

- One rule per action class; a policy that names one twice is refused when loaded.
- The effective mode of an action is the strictest of the studio policy and the project's
  (`auto` < `notify` < `ask` < `forbid`). A project policy whose rule is looser than the studio
  policy it `narrows` is refused when loaded.
- `auto` and `notify` hold only while every check in `requires` passes; a failed check goes back
  to the lead as work to fix, never to the operator.
- A command on the `commands` list is classed by what it does (for example `workspace-write`);
  any other command is the `command` class.
- An approval request expires at its creation plus the rule's `expiresSeconds`, else
  `expiry.defaultSeconds`, never more than `expiry.maxSeconds`.
- A `policy-change` is never made by a Worker: a new policy version takes effect only through an
  operator approval, so the safety layer never changes itself. Examples:
  [`autonomy-policy.studio.json`](../../schemas/examples/autonomy-policy.studio.json),
  [`autonomy-policy.project.json`](../../schemas/examples/autonomy-policy.project.json).

### `approval-request`

- Written only by a core component (`requester.component`), never from model text (INV-6). The
  summary may quote a Worker's proposal; it carries no authority.
- One request, one exact subject (INV-5). An operator verdict names the subject it saw; if the
  subject changed since, the verdict is refused and the request is unchanged, so the requester
  must withdraw it and ask anew.
- An approving verdict writes an `approval@1.x` artifact by `operator` on the same subject,
  referenced from `resolution.approval`.
- Expiry is one transaction: the state becomes `rejected`, `resolution.cause` is `expired`, and an
  `approval` decision with outcome `denied:expired` is recorded. The waiting work resumes as
  denied. A request is `withdrawn` (also `rejected`) when the work waiting on it ends first.
  Examples: [`approval-request.batched.json`](../../schemas/examples/approval-request.batched.json),
  [`approval-request.expired.json`](../../schemas/examples/approval-request.expired.json).

### `project`

- Its charter is approved by the operator (action class `charter`) on the subject
  `{type: content, ref: project:<projectId>:charter:<version>, version: sha256 of the canonical
  charter without approval}`. An amendment is held in `proposedCharter` with the next version
  until approved, and the project keeps its state meanwhile.
- A milestone is funded (action class `funding`) by an approval on its budget, a funding round.
- Budget use is computed from the usage records of its tasks, never stored on the project.
- Stop rules are words: the lead or the operator judges them, and the action a rule names is put
  to the operator through the approval queue.
- `classification` is a floor for its tasks and briefs. Example:
  [`project.active.json`](../../schemas/examples/project.active.json).

### `board-task`

- `dependsOn` names tasks of the same project and is acyclic. While a task is not terminal, no
  other task holds write authority over the same `writes` subject (INV-15).
- `holder` is the lease on resource `board-task:<taskId>`; every write presents its generation
  as a fence.
- `run` is recorded before the run starts. After a restart, a task with a run and no result is
  reconciled and its run is never started again (INV-4); one that cannot be reconciled waits for
  approval with reason `reconciliation-failed`.
- A rejected review starts another attempt while `attempts.count < attempts.max`, and otherwise
  waits for input with reason `retries-spent`.
- Every wait expires and never starts work: an approval wait follows its request, which expiry
  rejects, and then waits for input with reason `rejected`; an input wait that expires cancels
  the task (`input-expired`).
- `done` needs an `acceptance` decision whose outcome is accepted; the schema checks only that
  it is named.
- `lastDecision` is the decision behind the latest move: a `board` decision for moves the board
  makes on its own, otherwise the acceptance, approval, route, or reconciliation decision that
  caused it. Examples: [`board-task.review.json`](../../schemas/examples/board-task.review.json),
  [`board-task.waiting-for-approval.json`](../../schemas/examples/board-task.waiting-for-approval.json).

### `brief`

- The body of an `objective` artifact. Every `artifacts[].ref` is also an input of its envelope,
  so unknown references are refused and the classification floor applies (INV-12).
- It carries pointers, never content: the Worker reads each artifact in windows through the
  `artifact` tool.
- `sandbox` comes from trusted configuration, and `budget.remaining` is computed from the
  ledger when the brief is written. Example:
  [`brief.task.json`](../../schemas/examples/brief.task.json).

### `digest`

- The body of a `report` artifact whose envelope inputs are its `sources`. Every
  `citation.artifact` is one of them, and claim ids are unique.
- The quote check: each quote must occur verbatim in the cited artifact's text (its body's `text`
  field when it has one, otherwise its canonical JSON), at `offset` when one is given. A digest
  that fails is not accepted and is written again at the next tier.
- Its classification is at least its sources'. A digest of `local-private` sources is written by
  a local Worker or one the egress policy allows. Example:
  [`digest.test-run.json`](../../schemas/examples/digest.test-run.json).

### `plugin-manifest`

- `name` never changes; a renamed plugin lists its old names in `renames`, so the host matches
  its old configuration and records.
- Each `provides` version is the contract version of the seam's conformance suite that the
  plugin passed.
- A `core` plugin fails closed and a `family` plugin fails open
  ([ADR-0036](../decisions/adr/0036-guarantee-core-and-capability-plugins.md)).
- A `sensitive` configuration key holds a secret: the host keeps it in `ctx.credentials`, and
  the plugin's configuration holds only its reference.
- `_meta` belongs to the host: a declared manifest that carries it is refused. Each lifecycle
  change is recorded as a decision; Base records the state and automates nothing. Examples:
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
| `board_claim` | client | take a ready task's lease (the lead working on it itself) |
| `board_update` | client | report progress and renew the lease, or answer a waiting task's questions |
| `board_complete` | client | submit results; the task goes to review, never straight to done |
| `board_cancel` | client | cancel a task that is not running or in review |
| `approvals_list`, `approvals_get` | client | read the queue |
| `approvals_decide` | operator | verdicts for up to 50 requests, each bound to its exact subject |
| `approvals_policy` | client | the studio and project policies, and the effective mode per action class |
| `resources_pools` | client | each pool with the latest reading of each window, and whether it is available |
| `resources_usage` | client | usage records, filtered, with totals over every match |

- A page holds at most 100 items; `next` is an opaque cursor.
- A refused verdict (`unknown-request`, `already-resolved`, `expired`, `subject-changed`)
  leaves its request unchanged; the other verdicts of the call still apply.
- Examples: [`mcp-board.claim.json`](../../schemas/examples/mcp-board.claim.json),
  [`mcp-board.charter.json`](../../schemas/examples/mcp-board.charter.json),
  [`mcp-approvals.decide.json`](../../schemas/examples/mcp-approvals.decide.json),
  [`mcp-resources.usage.json`](../../schemas/examples/mcp-resources.usage.json).
