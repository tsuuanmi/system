# ADR-0049: A read-only agent Worker the operator names may be a `review` team member: scoped offers, and its conversation kept by replay

- **Status:** Proposed (the operator decides: D19)
- **Date:** 2026-10-23
- **Related:** [ADR-0027](0027-provider-diversity-in-routing.md),
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
team made of a Codex CLI Worker and an Antigravity CLI Worker, and then the same team with one of
them swapped for a ChatGPT website Worker, by configuration only. Two rules block it.

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

So every `review` member is asked at least twice, and its later turns are judged on what the
conversation holds: a ballot says whether each finding holds in the code it no longer sees
otherwise, and with two members every split is a tie, so the ballots decide a review in which no
blocking finding is confirmed. Requiring `resume` only of members asked more than once would not
lift the rule for `review`; the conversation matters on each later step.

The change must keep INV-11 (no vendor or runtime named in routing, team, or workflow code), the
tool gate, the read confinement and read-only sandbox, and the review's exact subject. The `workers`
seam (gate) and the `workflow` seam (work state machine) are guarantee seams: their contracts may
change only by additive, optional fields (ADR-0036). Nothing may change for an operator who does
not opt in.

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

For the conversation:

4. **Prove `resume` for agy.** A runtime change with a supervised live check of its own, as
   ADR-0043 did for the hook; not available here, and it would not cover a runtime that never
   resumes.
5. **The engine words a member's later steps self-contained** when its Worker keeps no
   conversation. The engine would decide by a Worker's property at promotion, and every member's
   requirement would drop `persistent-conversation`.
6. **No ballot in a single-round review.** A review would end on findings alone, against
   REQ-TEAM-6 (a strict-majority vote over sealed ballots).
7. **The `agents` source keeps a review member's conversation by replay**, as the `models` source
   keeps a model Worker's (ADR-0031), offered for that kind of work only.

## Decision

Options 3 and 7.

**Routing (`workers`, core: gate).** A capability offer may carry `scope`
(`capability-descriptor@1.4`), and a work requirement may name one (`work-requirement@1.1`). The
only scope is `review-member`: a step of a review team's member. A scoped offer proves its
capability only for a requirement that names its scope; an unscoped offer proves it for every
requirement, as before. Routing compares scopes for equality and nothing else, and a refusal says
the offer was scoped (`does not prove reason (it proves reason only for review-member work)`). A
descriptor below `@1.4`, or a requirement below `@1.1`, that carries a scope is refused, so no
reader takes a scoped offer for a plain one.

**The engine (`workflow`, core).** Every member step of a `review` team (proposal, ballot, and each
debate) routes with `scope: review-member`, set from the admitted spec, never from a template or
model text (INV-6); no other node does. Its capabilities are unchanged: `reason`, and
`persistent-conversation` for its session. Its prompts are unchanged. A board task's session is
resumed only on an unscoped `persistent-conversation`.

**The `agents` source (Worker family).** A Worker configured `reviewMember: true` (default off;
refused unless its sandbox is `read-only`, since a writer never reviews, INV-15):

- offers `reason` scoped `review-member`, while it is ready (evidence `probe`);
- keeps a member's conversation natively when its runtime reports `resume` (its
  `persistent-conversation` stays unscoped, as for every agent Worker);
- otherwise offers `persistent-conversation` scoped `review-member` (evidence `conformance`), and
  keeps the conversation by **replay**: a session run's prompt is the session's earlier completed
  turns, each its own message and its answer in order, between fence lines derived from their
  content, then the new message. The replay is bounded by `maxReplayChars` (default 200,000): past
  it the run fails as `invalid_input` before anything is sent, and a history is never cut. Egress is
  checked on exactly what is sent, at the strictest classification of its turns (INV-12). A runtime
  that does not report `resume` is never sent one. A session reset starts a new replay.
- A session run that its runtime cannot resume and that is not review-member work fails as
  `config_error` before anything is sent.

**Unchanged.** Every tool call of every run still passes the run's gate; the read confinement and
the read-only sandbox hold; the review's exact subject is still the source snapshot, every quote
checked against the bytes shown; an agent Worker's provider family is its runtime, so the members
still differ (ADR-0027) and keep distinct accounts; the team procedure, its prompts, and its record
are as they were. No routing, team, or workflow code names a runtime or vendor.

## Consequences

- With the opt-in, a `review` team may hold agent members: two agent runtimes, or one beside a
  website Worker, single-round or with debates. The quota order is unchanged, so an opted-in agent
  Worker takes a member step only when no website Worker of the family the step needs is admitted,
  or the operator turns website rows off (the experiment's arms).
- Agent-plan quota is spent on review member steps of the Workers the operator named, and on
  nothing else: an ask, a brainstorm, research, a planner, or a digest never reaches them.
- A replayed conversation holds each turn's message and final answer, not the agent's tool calls:
  a member that read a workspace file in an earlier turn reads it again to use it. A review member
  reads its material in the prompt.
- A replayed turn's input grows with the member's turns, about the source again on each later
  step. The Antigravity CLI takes its prompt as one argument (at most 100,000 bytes): a longer turn
  fails as `invalid_input`, unsent.
- Still not offered: a Worker without `resume` in any other session (an `ask` that continues, a
  board task's session, a wake on a member's mail after the team): native resume stays required
  there; and a `brainstorm` member, whose reasoning is the ordinary kind P1 keeps on website quota.
- The schemas take one minor version each (`capability-descriptor@1.4`, `work-requirement@1.1`);
  the `workers` conformance suite gains the scoped-offer scenarios. The live checks of a Codex and
  an Antigravity CLI review member are open ([release checklist](../../validation/release-checklist.md)).
- Revisit when agy proves `resume` (its members then continue natively), when a second scope is
  asked for (a brainstorm member, say), or if a replayed conversation is wanted beyond review
  members.
