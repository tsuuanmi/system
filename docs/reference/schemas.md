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
- `limited` lasts until the later of `cooldownUntil` and `resetsAt`. A window with no reading yet
  counts as `unknown`, like an explicit `unknown` reading: missing telemetry is not capacity. Each
  pool's configuration says whether `unknown` leaves it available (a pool that never reports,
  such as a local model) or not, which is the default (fail closed).
- `history-estimate` readings are computed by code from recorded usage, conservatively. Examples:
  [`limit-state.five-hour.json`](../../schemas/examples/limit-state.five-hour.json),
  [`limit-state.limited.json`](../../schemas/examples/limit-state.limited.json).

### `autonomy-policy`

- One rule per action class, `expiry.defaultSeconds ≤ expiry.maxSeconds`, every rule's
  `expiresSeconds ≤ expiry.maxSeconds`, no rule giving a class that always asks `auto` or
  `notify`, commands-list entries of non-empty words with no shell metacharacter, and a batch
  rule whose `maxWaitSeconds` is under the shortest expiry a request it batches can get; a
  policy that breaks one is refused when loaded.
- The classes that always ask are the irreversible effects (`external-send`, `deploy`,
  `delete-data`, `spend`), the investor's decisions (`charter`, `funding`, `policy-change`), and
  `remediation`. The schema refuses `auto` and `notify` for them, except `remediation`,
  which it predates: a policy that gives `remediation` either is refused when loaded.
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
- A `policy-change` is never made by a Worker: a new policy version takes effect only through an
  operator approval, so the safety layer never changes itself. Examples:
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
  Examples: [`approval-request.batched.json`](../../schemas/examples/approval-request.batched.json),
  [`approval-request.expired.json`](../../schemas/examples/approval-request.expired.json).

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
- `sandbox` comes from trusted configuration (the Worker source's), never from model text, and
  `budget.remaining` is computed from the ledger when the brief is written. `resume` names the
  native session the brief continues, when the Worker keeps one. Examples:
  [`brief.task.json`](../../schemas/examples/brief.task.json),
  [`brief.node.json`](../../schemas/examples/brief.node.json).

### `digest`

- The body of a `report` artifact whose envelope inputs are its `sources`. Every
  `citation.artifact` is one of them, and claim ids are unique.
- The quote check: each quote must occur verbatim in the cited artifact's text (its body's `text`
  field when it has one, otherwise its canonical JSON), at `offset` (in code points) when one is
  given. A claim that fails is dropped and recorded first in `dropped`; a digest with no claim
  left is not written ([digests](../design/digests.md#the-quote-check)). Writing it again at a
  higher tier is not built.
- `sources` are the request's, never the Worker's answer's.
- Its classification is at least its sources'. A digest of `local-private` sources is written by
  a local Worker or one the egress policy allows. Example:
  [`digest.test-run.json`](../../schemas/examples/digest.test-run.json).

### MCP tools: `digests_*`

| Tool | Scope | Does |
|---|---|---|
| `digests_request` | client | ask for a cited digest of 1 to 64 raw artifacts, by content id; waits up to `waitSeconds` for it to settle |
| `digests_get` | client | read a request as it stands: `pending`, `written` (with its digest), `not-written`, or `bypassed`, with why |

- Both answer with the request (`$defs/request` of
  [`mcp-digests.v1.json`](../../schemas/mcp-digests.v1.json)); a refused input does nothing, and
  a `clientRequestId` reused for other sources is refused (`invalid`).
- A request no Worker can serve is not refused: it settles `bypassed` ([digests](../design/digests.md)).
  Example: [`mcp-digests.request.json`](../../schemas/examples/mcp-digests.request.json).

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
| `board_claim` | client | take a ready task's lease; MCP `run` with the task and this claim starts the attempt, and that run submits and accepts its own result |
| `board_update` | client | report progress and renew the lease, or answer a waiting task's questions |
| `board_cancel` | client | cancel a task that is not running or in review |
| `approvals_list`, `approvals_get` | client | read the queue |
| `approvals_decide` | operator | verdicts for up to 50 requests, each bound to its exact subject |
| `approvals_policy` | client | the studio and project policies, and the effective mode per action class |
| `resources_pools` | client | each pool with the latest reading of each window, and whether it is available |
| `resources_usage` | client | usage records, filtered, with totals over every match |

- A page holds at most 100 items; `next` is an opaque cursor.
- No `board_*` tool starts, submits, accepts, blocks, or reconciles a task: the workflow run that
  serves an attempt does, as its owner, so one attempt has one writer
  ([INV-15](../architecture/invariants.md#inv-15-one-writer-per-subject)).
- A refused verdict (`unknown-request`, `already-resolved`, `expired`, `subject-changed`, or
  `failed`: the provider could not apply it, which it logs) leaves its request unchanged; the
  other verdicts of the call still apply. `mcp-approvals` 1.1 adds `failed`.
- Examples: [`mcp-board.claim.json`](../../schemas/examples/mcp-board.claim.json),
  [`mcp-board.charter.json`](../../schemas/examples/mcp-board.charter.json),
  [`mcp-approvals.decide.json`](../../schemas/examples/mcp-approvals.decide.json),
  [`mcp-resources.usage.json`](../../schemas/examples/mcp-resources.usage.json).
