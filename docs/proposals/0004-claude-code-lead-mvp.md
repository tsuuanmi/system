---
id: PROP-0004
type: proposal
status: draft
owners: [tsuuanmi]
created: 2026-10-16
related-requirements: [QA-14]
related-decisions: [ADR-0009, ADR-0025, ADR-0026]
implementation: []
---

# Proposal: Claude Code as the lead (MVP): research, brainstorm, and review by teams

## Problem

The operator works in a loop, **Research → Brainstorm → Implement → Review**,
with Claude Code. Claude Code does all four steps itself and spends its own
tokens on the reading and reasoning that the operator's paid website accounts
could do from their separate quota
([P1](../requirements/purpose.md#p1-save-tokens-by-spending-the-separate-chatgpt-chat-quota)).

`system` can already take that work, but live use on 2026-10-15 and 2026-10-16
showed gaps between what it ships and what the loop needs:

- **Too much surface.** There are eight workflow templates, three kinds of Worker,
  two model gateways, and two presets. The loop needs four templates.
- **One account does everything.** Every node of every live run landed on one
  account. The "independent" critique ran on the same account as the evidence
  it critiqued. The second paid account was never used.
- **No team decision.** A team can answer and synthesize (`panel`), but it cannot
  debate and then decide by vote. A brainstorm or review needs a decision, not a
  synthesis.
- **Website chats accumulate.** Retention deletes local records, but the
  conversations `system` created on the websites stay there.
- **The live host and development shared one build.** A test gate in the
  development checkout rebuilt the code that the operator's MCP client ran,
  which broke it. A restart with `kill` instead of a drained shutdown failed two
  in-flight runs (correctly, without a resend).

## Goals

1. **MVP:** Claude Code uses `system` for three of the four steps of the loop.
   - Research: two providers search the internet in parallel. The result is one
     compact synthesis with citations, and the points where they disagree.
   - Brainstorm: either a persistent website conversation, or a team that
     proposes, debates, and decides by majority vote.
   - Implement: Claude Code alone. `system` takes no part.
   - Review: a team reviews an approach, a plan, a diff, or a public repository by
     its URL, and decides by majority vote.
2. **Both paid accounts are used.** Work spreads over the operator's providers.
   A critique or review runs on a provider other than the one whose work it
   judges.
3. **Only the core templates remain:** `ask`, `research`, `brainstorm`, `review`.
4. **Retention deletes the website chats** that `system` created, at the same
   deadline as the records.
5. **Dogfooding is the proof.** From this proposal on, the research, brainstorm,
   and review steps of developing `system` go through the live `system`.
6. Linux only.

## Non-goals

- An implement step in `system`: the `develop` template is removed.
- Agent Workers, the model gateways, and the `api-first` preset in the MVP
  composition. They stay in the repository, off by default, until the MVP is
  proven; keeping or removing them is a later decision. Their CLI helpers
  (`claude-env`, `codex-env`, `mcp-token --scope model`) and the `model` scope
  stay, and a helper whose row is off refuses and names how to turn it on.
- macOS, npm publication, a license, more than one user.

## Evidence and research

- Live runs, 2026-10-15:
  - two `research` runs and one `ask`, compared with answers verified from
    primary sources: accurate, 5 to 13 minutes each, all nodes on one account;
  - cited answers lost their URLs, fixed in fd0e4db.
- Restart, 2026-10-16: `kill -TERM` during two literature steps gave
  `reconciliation_failed`. A drained `system shutdown` would not have.
- Research through `system` for this proposal (dogfooding):
  - deleting a single chat on each website, and what each provider keeps
    afterwards: run `run_d0dbb417e79b384f`, results to be added;
  - multi-agent debate and voting (rounds, heterogeneous teams, conformity,
    ties): run `run_9e5216c10548d44b`, results to be added.
- Brainstorm through `system` (dogfooding), `panel` run `run_25b3d23277258af7`
  on diversity, ballots, early stop, and failure modes. Its two members agreed on
  the ballot fields, early stop on readiness, self-votes allowed with a
  comparative justification, and the decision contents above. It also showed
  the problem this proposal fixes: both members were ChatGPT accounts.
  Provider diversity is not proof of independent models, only a better default.
  Its own second `panel` run, `run_d05389582ae031f9` (round count, ballot
  options, tie path, repository review), is still running.
- Implementation impact map, 2026-10-16:
  - Old runs are safe: the template registry is read only when a run starts, and
    `explain` and `result` read the stored spec. The upgrade fixture already
    holds runs of templates that are no longer registered.
  - Disabling bundle rows is already supported by the bundle format.
  - Teams reuse barriers, rounds, mailboxes, and the lead's gate decision. A
    ballot step, a tally into a decision artifact, and a tie that waits for the
    caller are new.
  - No driver can delete a conversation today, and bindings expire with turn
    records.

## Proposed design

### Core templates

| Template | Steps | Decides by |
|---|---|---|
| `ask` | one turn; `persist` keeps a conversation for later turns | — |
| `research` | frame → literature on **each of two providers in parallel** → one evidence table from both → critique on a provider other than the evidence's → conclusion, which names agreement and disagreement between providers. Option `deep`: each literature step uses the provider's deep research. | — |

A literature step needs `web-search`. Today only one provider's driver proves it:
the other proves `deep-research` alone and refuses any other feature, so both
literature steps would land on the same provider. Phase 2 therefore starts with
one of two choices:
- **(a) Prove web search on the second provider.** This is preferred, if its chat
  answers show readable per-answer evidence of grounding (source chips, citation
  links), which a probe and the driver can check. Research run
  `run_9615e6f7f6044c6b` answers that.
- **(c) Otherwise,** a literature step needs only `reason`, and its gate is the
  existing citation acceptance (`acceptance.cited`): each provider searches its
  own way, and an answer without an http(s) source is rejected. This proves less
  than a capability.

Using deep research for the second provider's literature (b) is rejected for the
default: it is slow and spends the scarcest quota.
| `brainstorm` | the team protocol below over a question and its context | majority vote |
| `review` | the team protocol below over material (text) or a public repository URL; each ballot is `pass` or `changes`, with findings. Capabilities `reason`, plus `web-search` for a URL; no `local-data`. | majority vote |

The `review` template that exists today needs `review` and `local-data`, which only
agent Workers prove. It moves to the agent Workers' own template list, under
another name, and is registered only when their rows are mounted. `review`
means the team review.

Removed templates: `investigate`, `panel` (becomes `brainstorm`), `deep-research`
and `research-deep` (become the `deep` option of `research`), and `develop`. Runs of
removed templates that already exist keep their records and still answer
`explain` and `result`; they cannot be started again.

### Teams: propose, debate, vote

A team has one member per distinct provider among the admitted Workers: today,
two. A team that cannot find two distinct providers able to do the work fails
admission and says why ([INV-2](../architecture/invariants.md)). The protocol is
the same for `brainstorm` and `review`:

1. **Propose.** Each member answers alone, without seeing the others.
2. **Debate.** Each member sees the other members' answers without their
   provider names, and may revise. The number of rounds is bounded
   (default 1).
   The debate stops early once every member, independently, reports no
   unresolved material objection. An objection still open at the round limit
   does not block the vote: it is recorded as dissent.
3. **Vote.** Each member casts one sealed ballot. A ballot holds:
   - its first choice among the anonymized proposals (or `pass` / `changes` for a
     review);
   - its ranking of all of them;
   - the rationale and evidence;
   - the strongest counterargument to its choice;
   - its unresolved objections;
   - a confidence.

   Other members' ballots stay hidden until every ballot is in.
4. **Decide.** A strict majority (more than half the ballots) decides,
   deterministically. The decision is a decision artifact
   ([INV-13](../architecture/invariants.md)) that holds:
   - the members (by opaque identity), proposals, critiques, and revisions;
   - the rounds and why the debate ended;
   - every ballot, the tally, and the winner;
   - the dissent, and any deciding vote with its rationale.

   It is stored before the result returns. A team that fails, for example
   without enough distinct providers, records a failure artifact instead.
5. **Tie.** The run blocks with a `tie`, holding both positions in short. The
   caller casts the deciding vote with a new **client-scope** tool, `vote(runId,
   decision, option)`. The tool is bound to that exact tie decision, as
   `approve` is bound to an exact plan, and is recorded with the client as the
   decider. `approve` cannot serve, because it is operator scope
   ([ADR-0023](../decisions/adr/0023-scoped-control-credentials.md)). The
   operator can still override with an operator tool.

With two members, a strict majority means both agree, so every disagreement is a
tie and the caller decides often. The useful output of the debate is therefore
convergence: the debate round asks each member to revise toward agreement where
the other's argument holds. A member may vote for its own proposal, because
forbidding that would force a tie. Instead, each ballot must name the strongest
point of the option it rejects, so the dissent is in the record.

Routing gets a **diversity predicate**: a node may require a provider family
other than the one of a named node. The critique in `research` and every team
member use it. Today a Worker's provider is informational only, and routing never
branches on it ([INV-11](../architecture/invariants.md)). The predicate is an
opaque inequality: routing may require "a different provider family than node
X", and it never names a family, provider, account, or model. Because INV-11 is
binding, this needs an ADR (ADR-0027) that amends it in exactly that way. The
existing distinct-account rule for teams stays.

### Accounts and routing

- The free ChatGPT account is removed from the operator's accounts. It is
  operator configuration: its row in the profile's patch, its vault entry, and
  its browser profile. The operator removes those; the runbook names the steps.
- No code names that account. The one code path that exists only for a site
  without a model picker (the ChatGPT `site` preset) is removed. Gemini's
  equivalent stays, because a paid Gemini plan may also lack a picker.
- Load spreads over the paid accounts by the diversity predicate. Account
  capacity as a leased resource is out of scope for the MVP.

### Retention deletes website chats

- A **conversation ledger** records every website conversation `system`
  creates: account, provider, binding, owning run or session, created and
  deleted times. Today the bindings live only in turn rows and receipts, which
  expire on their own 30-day clock, and a compaction replaces a session's
  binding, so the ledger must outlive both.
- When a run expires under retention, or is deleted, each conversation the
  ledger holds for it is deleted on its site. A driver gains
  `deleteConversation`, backed by one UI map operation per site. The deletion is
  a leased, retried job with its own effect class
  ([INV-4](../architecture/invariants.md)): before it repeats, it checks the
  site, and a conversation already gone counts as deleted.
- A deletion runs through the account's turn scheduler, which holds the
  account's page exclusively, so it never runs beside a turn. A crash test kills
  the host between the click and the record.
- When the ledger is introduced, it is backfilled from the turn records and
  receipts that still exist (at most 30 days old). Older conversations are not
  deleted, and the runbook says so.
- Only recorded conversations are deleted. A chat the operator started by hand is
  never touched.
- Each deletion is recorded. A failure is retried a bounded number of times and
  then reported in health.
- A temporary chat, and what a provider keeps after deletion, follow the
  research results above. The runbook states that deletion on the site does not
  bind the provider's own retention.

### The live install

- The operator's daemon and MCP client helper run from a dedicated install (today
  the `system-live` worktree, pinned at `main`). No build or test runs there.
- An update is: back up, `system shutdown --deadline <s>` (drains), advance and
  build the install, start, and verify. A `system upgrade` command that does this
  in one step is a follow-up.

## Phases

| Phase | Content | Proof |
|---|---|---|
| 0 | Stabilize: citation fix on `main`, the live install, the MCP client reconnected | done 2026-10-16 |
| 1 | Removals and switch-offs: the five templates; the `deep` option of `research` (CLI and MCP); agent Worker and gateway rows disabled by default (their helpers refuse while off); the agent `review` moved into the agent Workers' template list; the `site` preset; the free account removed by the operator; Linux-only docs. Until Phase 3 there is no `review` in the default composition, which is accepted. | composition e2e row set; upgrade suite still explains old runs; crash suite |
| 2 | `research` on two providers in parallel, with the diversity predicate | a live run uses both providers |
| 3 | ADR-0027 (diversity predicate); teams: `brainstorm` and `review` with debate and vote, tie to the caller | live brainstorm of a real design question for `system` |
| 4 | `review` of a public repository by URL | live review of this repository |
| 5 | The conversation ledger; retention deletes website chats | fake-site tests per driver; one live deletion |
| 6 | The whole loop from Claude Code on a real `system` change | the change ships with its research, brainstorm, and review runs linked |

## Alternatives considered

- **Keep every template and add teams.** Rejected: the operator asked for the
  core only, and every extra template is upkeep against website drift.
- **Vote without debate.** Cheaper. The research run above decides whether one
  debate round is worth its cost; the round count is configuration.
- **Break ties with a third provider.** No third paid provider is configured; the
  caller already holds the context, and its vote is recorded.

## Validation plan

- Each phase: unit and conformance tests for the changed seams, the composition
  e2e row set, the upgrade suite, and the crash suite.
- Each phase is also proved live, as the table says, through the live install.
- Dogfooding: the Implementation section links the live runs that researched,
  brainstormed, and reviewed each phase.

## Rollout and rollback

- Each phase is its own reviewed and gated branch, fast-forwarded to `main`.
- The live install advances only after a backup and a drained shutdown. Rolling
  back means restoring the backup and starting the previous commit; the
  downgrade guard refuses a store a newer version migrated.
- Each phase ends with the operator's update of the live install: backup,
  `system shutdown --deadline`, advance, build, start. The implementers prepare the
  exact commands; stopping the operator's daemon is the operator's action.

## Observability and operations

- Team decisions appear in `explain`, with their ballots.
- Chat deletions are events. Repeated failures show in `system health`.
- The runbook gains the live-install update procedure.

## Security and privacy

- Public-repository review reads only what the URL makes public; its input is
  `public`.
- Deleting website chats acts only on conversations `system` recorded. A wrong
  selector must never delete another chat: a deletion verifies the conversation
  id on the page before it confirms.
- Egress rules are unchanged.

## Requirement and schema changes

On acceptance, with the code of each phase:

- **Requirements.**
  - The workflow requirements of the removed templates are retired.
  - New requirements: a team decides by majority vote with recorded ballots; a
    tie is broken by the caller through `vote`; routing honors a
    different-provider-family predicate; `research` uses two providers; retention
    deletes the website conversations `system` recorded.
  - QA-14 notes that the client scope gains exactly one decision power: breaking
    a tie it was asked to break, in a run it can read.
  - The release scope defines this MVP.
- **Schemas** (each a minor version, with examples):
  - the decision record gains a vote kind, with ballots;
  - the admission check gains `diversity`;
  - a run's blocked state gains a kind, `gate` or `tie`;
  - the conversation ledger record gets its own schema.

## Compatibility and migration

- Removed templates: old runs stay readable, and new runs of them are refused
  with `invalid_input`. No compatibility layer runs them.
- The removed account's records stay for audit until retention expires them.
- The upgrade fixture generator keeps its own copy of a removed template, so
  fixtures can still be generated.
- `deep` is recorded in the run's input, and the typed-artifact hook keys on it
  instead of on the old template name.

## Decision

Pending review.

## Implementation

None yet.
