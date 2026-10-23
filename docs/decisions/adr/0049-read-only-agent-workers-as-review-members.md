# ADR-0049: A read-only agent Worker may be a `review` team member under an enforced review-member profile

- **Status:** Proposed (the operator decides: D19)
- **Date:** 2026-10-23
- **Related:** [ADR-0027](0027-provider-diversity-in-routing.md),
  [ADR-0029](0029-opt-in-same-family-fallback.md),
  [ADR-0031](0031-model-worker-sessions-by-replay.md),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0040](0040-briefs-on-the-workers-and-workflow-seams.md),
  [ADR-0042](0042-codex-workers-ask-the-gate-through-a-hook-bridge.md),
  [ADR-0043](0043-antigravity-cli-workers-gated-on-a-version-verified-live.md),
  [purpose P1](../../requirements/purpose.md#p1-save-tokens-by-spending-the-separate-chatgpt-chat-quota),
  REQ-WRK-8, REQ-TEAM-2, REQ-TEAM-5, REQ-TEAM-6,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in),
  [INV-12](../../architecture/invariants.md#inv-12-data-egress-is-explicit)

## Context

The operator's worker-agnosticism experiment needs a [`review`](../../reference/workflow-templates.md#review)
team made of a Codex CLI Worker and an Antigravity CLI Worker, and the same team with one of them
swapped for a ChatGPT website Worker, by configuration only. Two rules block it.

**Agent Workers never offer `reason`.** The `review` template's team node requires `reason`, and
the engine gives every member step (proposal, ballot, debate) the team node's capabilities. The
`agents` source offers `local-data`, `review` or `develop` and `validate`, and
`persistent-conversation`, never `reason`. The reason is purpose P1 and REQ-WRK-8: the default
composition spends website chat quota on reasoning and keeps agent-plan quota for work only agent
Workers can do, so an ordinary ask never spends it
([quota policy](../../design/routing.md#quota-and-cost-policy),
[admission evidence](../../design/agent-runtimes.md#admission-evidence)).

**A team member must keep a conversation.** Each member is a Worker session, and every step in a
session requires `persistent-conversation` (Model A, REQ-TEAM-2, [teams](../../design/teams.md#membership-model-a)).
The `agents` source offers it when the runtime's probe reports `resume`. The Antigravity CLI
runtime never reports it: continuing an agy conversation is not proven, and its run refuses a
`resume` rather than starting a new one ([its README](../../../packages/plugins/runtime-antigravity-cli/README.md)).

What a member's conversation buys, step by step:

| Step | Asked | What the conversation holds that the step's prompt does not |
|---|---|---|
| proposal | first | nothing: it is the conversation's first turn |
| sealed ballot (every review, `debateRounds: 0` too) | second | the request, the source as shown (line-numbered), and the member's own findings. The ballot prompt carries only the merged findings list (ids, places, claims, classes); it says "its own proposal and the question are already in its conversation" |
| debate, after a split | third and fourth | all of the above, the findings list the ballots refer to (`F1`…), and its own ballot |
| re-review of a fix | not a team step | a remediation cycle grows only after a `review`-capability node whose producer wrote; its re-review runs in a temporary conversation |

So every `review` member is asked at least twice, single-round or not, and its later turns are
judged on what the conversation holds: a ballot says whether each finding holds in code it no
longer sees otherwise. With two members every split is a tie, so the ballots decide a review in
which no blocking finding is confirmed.

The operator's answer to D19 sets the bar:

- `reason` only for an **enforced** read-only profile: no write tools, read confinement, an
  exact-commit subject, and a fail-closed gate on every call; granted by the profile, never
  self-declared.
- `resume` required only where a template asks the same member again; a member that cannot resume
  is never silently given a fresh session for a continuation. A conversation kept by replay is
  acceptable only if the replay is exact and recorded (the member sees exactly its earlier turns,
  its answer is bound to them, and it is called a replay, not a resume) and fails closed when it
  cannot be complete.
- Provider-family separation is checked independently of capability eligibility.

The change must also keep INV-11 (no vendor or runtime named in routing, team, or workflow code),
the tool gate, the read confinement and read-only sandbox, and the review's exact subject. The
`workers` seam (gate) and the `workflow` seam (work state machine) are guarantee seams: their
contracts may change only by additive, optional fields (ADR-0036). Nothing changes for an operator
who does not opt in.

## Options

For the capability:

1. **An opted-in read-only agent Worker offers plain `reason`.** Then `ask`, `brainstorm`,
   `research`, planner steps, and digests route to it whenever no website Worker is admitted, which
   is exactly the spending P1 rules out.
2. **The member steps require a capability both kinds of Worker prove**, a new one or `review`.
   Every website and model Worker source would change, a `review` node binds the exact subject of
   an agent's working tree, and plan steps that require `review` would start routing to website
   Workers.
3. **Scoped offers.** A Worker may offer a capability for one kind of work only; the engine names
   that kind on the steps it is for. Routing compares the two for equality.

For what a member may do in its step:

4. **The gate keeps judging each call by the policy**, as for any read-only run. A member could
   then read its workspace: files at another commit than the subject, which no website member sees
   (REQ-TEAM-5), and its tool calls would be part of its conversation, which a replay cannot hold.
5. **The gate denies every tool call of a member's step**, in an empty workspace outside any
   repository. The member answers from its prompt alone, as a website member does.

For the conversation:

6. **Prove `resume` for agy.** A runtime change with a supervised live check of its own, as
   ADR-0043 did for the hook; not available here, and it would not cover a runtime that never
   resumes.
7. **The engine words a member's later steps self-contained** when its Worker keeps no
   conversation. The engine would decide by a Worker's property at promotion, and every member's
   requirement would drop `persistent-conversation`.
8. **No ballot in a single-round review.** A review would end on findings alone, against
   REQ-TEAM-6 (a strict-majority vote over sealed ballots).
9. **The `agents` source keeps a review member's conversation by an exact, recorded replay**, as
   the `models` source keeps a model Worker's (ADR-0031), offered for that kind of work only.

## Decision

Options 3, 5, and 9.

### Scoped offers (`workers`, core: gate)

A capability offer may carry `scope` (`capability-descriptor@1.4`), and a work requirement may name
one (`work-requirement@1.1`). The only scope is `review-member`: a step of a review team's member.
A scoped offer proves its capability only for a requirement that names its scope; an unscoped offer
proves it for every requirement, as before. Routing compares scopes for equality and nothing else,
and a refusal says the offer was scoped (`does not prove reason (it proves reason only for
review-member work)`). A descriptor below `@1.4`, or a requirement below `@1.1`, that carries a
scope is refused, so no reader takes a scoped offer for a plain one.

### The engine (`workflow`, core)

Every member step of a `review` team (proposal, ballot, and each debate) routes with `scope:
review-member`, set from the admitted spec, never from a template or model text (INV-6); no other
node does. Its capabilities are unchanged: `reason`, and `persistent-conversation` for its session.
Its prompts are unchanged. A board task's session is resumed only on an unscoped
`persistent-conversation`.

### The review-member profile (the `agents` source)

The operator places a Worker under the profile (`reviewMember: true`, default off). The
configuration is refused (`config_error`, at load) unless the Worker's sandbox is `read-only` (a
writer never reviews, INV-15), it names its provider `family` (below), and `worktreePerRun` is off.

**The profile grants `reason`, scoped to `review-member`, and only while it is enforced.** The
Worker offers it while it is ready, which means its runtime's probe proves now that it enforces the
read-only sandbox, keeps host state unreadable (`readsConfined`, ADR-0024), and asks the run's gate
before every tool call (`gatesToolCalls`); without any of them the Worker offers nothing. No Worker
or runtime declares the capability: the `agents` source derives it from the profile and that
evidence. A Worker not under the profile never runs a member step, not even its first
(`config_error`, nothing run).

Every member step runs under the profile:

| D19 requires | How a member step meets it |
|---|---|
| no write tools | the gate denies every tool call (below), and the runtime's own read-only sandbox still holds |
| read confinement | no tool call runs, so nothing is read; the runtime's read confinement still hides host state |
| an exact-commit subject | the member's material is its prompt alone: the source the engine read at the pinned commit (or the caller's exact text), line-numbered, every quote checked against those bytes. Its workspace must be an empty directory outside any git work tree, checked before anything is sent (`config_error`), so no file a runtime reads on its own (an instruction file, the repository above) reaches it |
| a fail-closed gate on every call | the run's gate denies each call as the runtime asks it, each a recorded `gate` decision of rule `agent-workers.tool-gate`; a runtime that cannot ask it is not admitted |

After the step, its workspace must still be empty; otherwise the read-only sandbox did not hold,
and the run fails as `reconciliation_failed`, its answer not trusted. Its record is
`agent-result@1.3` with `profile: review-member`.

### The conversation: resumed natively, or replayed exactly

`persistent-conversation` stays required on every member step, the proposal included, because the
`review` template asks every member again (its ballot), and routing must choose at the proposal a
Worker that can continue. No team template asks a member only once, so nothing requires it where a
member is not asked again. The `agents` source keeps a member's conversation one of two ways:

- **Resumed**, on a runtime that reports `resume`: its steps continue the agent's native session,
  as every agent session does. A member step whose session has earlier turns but no native
  conversation to resume is refused (`invalid_input`, nothing sent), never started fresh.
- **Replayed**, on a runtime that cannot resume: the Worker offers `persistent-conversation`
  scoped to `review-member` (evidence `conformance`). This is a replay, not a resume: the runtime
  starts a new conversation each time, and its first message holds the member's earlier turns.
  - **Exact.** The message is the session's earlier completed turns of its generation, in order,
    each the message it was given and its answer exactly as recorded, each between fence lines
    derived from its own text, then the new message. Every earlier turn ran under the profile, so
    no tool ran in it and a turn is exactly its message and its answer. Failed turns are no part
    of the conversation. A reset (compaction) starts a new generation, whose replay starts empty.
  - **Recorded.** The runs it replays are fixed when the run is first prepared, so a run taken up
    again after a restart replays the same turns (INV-4). Its `agent-result@1.3` names them
    (`replay.runs`), their answers (`replay.answers`, also the artifact's `inputs`), and the hash
    of everything it was sent (`replay.promptHash`), so its answer is bound to exactly the turns it
    answered after.
  - **Fails closed** (nothing sent) when it cannot be complete: an earlier turn still open, one
    not run under the profile, one whose answer is no longer stored, or more than
    `maxReplayChars` (default 200,000) characters of earlier turns. A history is never cut (INV-9).
  - Egress checks exactly what is sent, the replay included, at the strictest classification of
    its turns (INV-12). The runtime is never asked to resume, and the session keeps no native
    handle, so no brief claims one.
- A session that a runtime without `resume` is asked to continue for any other work is refused
  (`config_error`, nothing sent): such a runtime keeps no conversation outside a member's steps.

### Provider families, apart from capability

An agent Worker's descriptor carries the `family` its configuration names, or, when none is named,
its runtime, as before ([ADR-0027](0027-provider-diversity-in-routing.md)). A review member must
name it: a runtime's name does not tell whose models it runs, and the family is what keeps two
members of one vendor apart (the per-runtime override ADR-0027 left for later, for agent Workers).
The `diversity` check is unchanged and independent of capability: the engine resolves the families
of the members already routed and passes them to routing as an exclusion, which admission checks
on every Worker apart from its capabilities. A member that proves every capability but shares a
family is refused for `diversity`, unless the operator turns `allowSameFamily` on (ADR-0029), which
records it.

### Unchanged

Every tool call of every run still passes the run's gate; outside the profile, the gate judges it
by the policy as before. The read confinement and the read-only sandbox hold. The review's exact
subject is still the source snapshot. The team procedure, its prompts, and its record are as they
were. No routing, team, or workflow code names a runtime, vendor, or family.

## Consequences

- With the opt-in, a `review` team may hold agent members: two agent runtimes, or one beside a
  website Worker, single-round or with debates. The quota order is unchanged, so an agent Worker
  under the profile takes a member step only when no website Worker of the family the step needs is
  admitted, or the operator turns website rows off (the experiment's arms).
- Agent-plan quota is spent on review member steps of the Workers the operator placed under the
  profile, and on nothing else: an ask, a brainstorm, research, a planner, or a digest never
  reaches them.
- A member under the profile reviews what its prompt shows, like a website member: it cannot open
  other files of the repository. A Worker that should read a working tree (an `agent-review`
  reviewer) is configured separately, without the profile.
- A replayed turn's input grows with the member's turns, about the source again on each later step.
  The Antigravity CLI takes its prompt as one argument (at most 100,000 bytes): a longer turn fails
  as `invalid_input`, unsent.
- The operator keeps instruction files a runtime loads from outside its workspace (its home, a
  directory above) out of a member's way; the runbook says how. The source checks only the
  workspace and the repository around it.
- The author of a reviewed commit is not known to the `review` template, so keeping the maker's
  family out of the team is the operator's composition (as the experiment does); a template-level
  maker and reviewer family check is a later change.
- Still not offered: a Worker without `resume` in any other session (an `ask` that continues, a
  board task's session, a wake on a member's mail after the team); and a `brainstorm` member, whose
  reasoning is the ordinary kind P1 keeps on website quota.
- The schemas take one minor version each (`capability-descriptor@1.4`, `work-requirement@1.1`,
  `agent-result@1.3`); the `workers` conformance suite gains the scoped-offer scenarios. The live
  checks of a Codex and an Antigravity CLI review member are open
  ([release checklist](../../validation/release-checklist.md)).
- Revisit when agy proves `resume` (its members then continue natively), when a second scope is
  asked for (a brainstorm member, say), or if a replayed conversation is wanted beyond review
  members.
