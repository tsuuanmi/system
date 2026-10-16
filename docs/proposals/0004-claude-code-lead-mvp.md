---
id: PROP-0004
type: proposal
status: accepted
owners: [tsuuanmi]
created: 2026-10-16
related-requirements: [QA-14]
related-decisions: [ADR-0009, ADR-0023, ADR-0025, ADR-0026, ADR-0027]
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
    afterwards: `research` run `run_d0dbb417e79b384f`. Both sites delete one
    saved chat from the history sidebar's menu: ChatGPT with a confirmation
    ([OpenAI](https://help.openai.com/en/articles/8809935-how-to-delete-and-archive-chats-in-chatgpt)),
    Gemini with no confirmation documented
    ([Google](https://support.google.com/gemini/answer/13666746?hl=en)).
    - Temporary chats leave the history on their own. ChatGPT keeps them up to
      30 days
      ([OpenAI](https://help.openai.com/en/articles/8914046-temporary-chat-faq));
      Gemini keeps them 72 hours
      ([Google](https://support.google.com/gemini/answer/13275745?hl=en)).
    - ChatGPT erases a deleted chat within 30 days, with exceptions
      ([OpenAI](https://help.openai.com/en/articles/8983778-chat-and-file-retention-in-chatgpt)).
      Gemini follows the account's activity settings.
    - Both sites also offer bulk deletion, which reaches every chat of the
      account.
    - How a Deep Research chat, a project chat, or a Gem chat is deleted is not
      established.
    - This run's answer also confirmed the citation fix live: real tables and
      source links.
  - multi-agent debate and voting: `research` run `run_9e5216c10548d44b`.
    - Debate does not reliably beat independent answers plus a vote
      ([Debate or Vote](https://proceedings.neurips.cc/paper_files/paper/2025/hash/934252acd87f254d5d4672fbde283bd2-Abstract-Conference.html),
      [Should We Be Going MAD?](https://proceedings.mlr.press/v235/smit24a.html)).
    - Extra rounds can propagate errors and conformity
      ([Talk Isn't Always Cheap](https://arxiv.org/abs/2509.05396),
      [CONSENSAGENT](https://aclanthology.org/2025.findings-acl.1141/)).
    - Teams of different vendors are not shown to beat teams of one vendor once
      capability and cost are matched.
    - No tie-break method for two voters is shown best.
    - The answer kept its sources, but its Copy was refused (its math rendered
      twice), so tables came back flattened: a residual fidelity gap.
- Brainstorm through `system` (dogfooding), `panel` run `run_25b3d23277258af7`
  on diversity, ballots, early stop, and failure modes. Its two members agreed on
  the ballot fields, early stop on readiness, self-votes allowed with a
  comparative justification, and the decision contents above. It also showed
  the problem this proposal fixes: both members were ChatGPT accounts.
  Provider diversity is not proof of independent models, only a better default.
- A second `panel`, `run_d05389582ae031f9`, covered ballot options, the tie path,
  and repository review. Its recommendations are adopted:
  - neutral option extraction with provenance;
  - single-choice ballots;
  - an `inconclusive` outcome;
  - no default `pass` on a tied review;
  - a pinned commit, and findings merged by root cause;
  - the protocol enforced in code.

  It also recommended a debate round before every vote. The debate research
  above outweighs that: it was evidence-based, while both panel members were
  ChatGPT accounts.
- Reading a public repository, `ask` run `run_fd80ff72a3a5cee1`, 2026-10-16:
  - A link alone is not a reliable way for either website to read a repository.
  - GitHub's `robots.txt` disallows `tree` pages for the crawlers ChatGPT uses.
    Single files at a commit (blob or raw URLs) were read in a live test.
  - Gemini's code import reads public repositories without a linked account,
    but it is a separate UI feature.
  - Hence the review design above: `system` fetches the files at the commit and
    puts their text in the prompt, so members need neither web search nor
    browsing, and it verifies quotes against exactly what they saw.
  - The Phase 2 dogfood review (`panel` run `run_d890b6adc3e2cd65`, diff only)
    made 9 claims about the code, and none held against the full code. That is
    what quote verification guards against.
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
| `brainstorm` | the team protocol below over a question and its context | majority vote |
| `review` | the team protocol below over material (text) or a public repository URL; each ballot is `pass` or `changes`, with findings. Members need only `reason`. A repository is reviewed at one pinned commit, which `system` resolves and fetches itself, bounded by file count and bytes ([INV-9](../architecture/invariants.md)): README and manifests first, then entry points, the relevant code, and tests. The files' line-numbered text goes into the prompt, and raw URLs are kept only as provenance, so no member browses the repository. Every finding quotes `path:line` with the exact line text, and the orchestrator checks the quote against the bytes the members saw. A finding whose quote matches is `confirmed`; one that does not, or has no quote, is `needs-verification`; advice without a defect is a `suggestion`. Findings are merged only when they quote the same `path:line`; all others stay separate, with who reported them. No model merges findings. A file left out by the bounds, or not quoted by any member, is listed as unread. A confirmed blocking finding makes the outcome `changes` whatever the ballots say; only when none is confirmed does the vote decide between `pass` and `changes`. `pass` therefore means no confirmed blocking finding within what was read. | majority vote, after the blocking-finding rule |

A literature step needs `web-search`, and today only one provider's driver
proves it. The other provider's chat answers show sources (links and a Sources
panel), but nothing on its page proves an answer was grounded in a search or
lets a user force one (research run `run_9615e6f7f6044c6b`,
[Google](https://support.google.com/gemini/answer/14143489)). So the two
literature branches differ:
- **Branch A** requires `web-search`, which a probe proves.
- **Branch B** requires a provider family other than branch A's, and only
  `reason`. Its gate is the citation acceptance (`acceptance.cited`): an answer
  without an http(s) source is rejected. The driver reads the answer's source
  links from the page, as every cited answer now does.
- Deep research for branch B is not the default: it is slow and spends the
  scarcest quota. It is what the `deep` option uses.

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

1. **Propose.** Each member answers alone, without seeing the others. The
   proposals are kept unchanged: what a member said before any exchange stays
   on record.
2. **Options.** For a brainstorm, each member's proposal is one option: O*k* is
   member *k*'s structured recommendation, verbatim, with its provenance. This
   is neutral by construction, invents no hybrid, and needs no extractor, which
   would be one member's family judging both proposals. Agreement shows as both
   ballots naming the same option. A ballot may also say that an option
   misstates its author's position. Merging options is not part of the MVP. For
   a review, the options are `pass` and `changes`, over one merged list of
   findings.
3. **Vote.** Each member casts one sealed ballot. A ballot holds:
   - exactly one choice among the options;
   - its ranking of all of them, which is advisory only;
   - the rationale and evidence;
   - the strongest point of each option it did not choose;
   - its unresolved objections;
   - a confidence.

   Other members' ballots stay hidden until every ballot is in.
4. **Debate, only on disagreement.** A tally step reads the sealed ballots and
   records the vote decision. If they already give a strict majority, there is
   no debate. Otherwise the tally appends the debate, a re-vote, and a second
   tally to the run, the way re-planning appends steps; the tally decision
   justifies them. Otherwise each member sees the other proposals
   and ballots, without provider names, and answers only the crux of the
   disagreement: it may revise its proposal and vote again.
   - The number of debate rounds is bounded: default 1, at most 2.
   - The debate ends early once every member reports no unresolved material
     objection.
   - An objection still open at the end does not block the vote: it is recorded
     as dissent.
5. **Decide.** A strict majority (more than half the ballots) decides,
   deterministically. An invalid or missing ballot never lowers the threshold:
   a ballot still invalid after its retries fails the run, which `continue` can
   redo. The record names the method:
   `team-majority`, `caller-tiebreak`, or `inconclusive`. The decision is a
   decision artifact ([INV-13](../architecture/invariants.md)) that holds:
   - the members (by opaque identity), the original proposals, and any
     revisions;
   - the rounds and why they ended;
   - every ballot, the tally, and the winner;
   - the dissent, and any deciding vote with its rationale.

   It is stored before the result returns. A team that cannot form, for example
   without enough provider families, records no team decision: its failure
   record is the admission decision that names the `diversity` refusal, and the
   run's error.
6. **Tie.** The run blocks with a `tie`, holding both positions in short. The
   caller casts the deciding vote with a new **client-scope** tool, `vote(runId,
   decision, option)`. The tool is bound to that exact tie decision, as
   `approve` is bound to an exact plan, and is recorded with the client as the
   decider. `approve` cannot serve, because it is operator scope
   ([ADR-0023](../decisions/adr/0023-scoped-control-credentials.md)). The
   operator can still override with an operator tool.
   - The caller may also answer `inconclusive` instead of forcing a choice.
   - A tie waits a bounded time (default 24 hours,
     [INV-9](../architecture/invariants.md)). If no deciding vote arrives, the
     team completes as `inconclusive`, decided by that rule, and its result still
     shows both positions and any blocking findings.
   - A tied review never defaults to `pass`: blocking findings stay visible
     whatever the caller decides.

Each member's prompts are composed by the engine from sealed records. A peer's
proposal or ballot is quoted as delimited data, marked as another participant's
text and not instructions. The result begins with one machine-readable line
(the outcome, the method, the winner), so the caller reads the decision without
parsing prose.

The orchestrator enforces the protocol in deterministic code: it fixes the
options, validates and seals the ballots, tallies the votes,
handles a tie, and ends the rounds. The models supply reasoning and evidence
only.

With two members, a strict majority means both agree, so every remaining
disagreement is a tie and the caller decides often.

Debate runs only on disagreement because the evidence does not show it beats
independent answers plus a vote. Independent voting explains most of the gains
reported for debate, and more rounds can move a correct member to a wrong
answer (research run `run_9e5216c10548d44b`; Choi et al., *Debate or Vote*,
NeurIPS 2025; Wynn et al., *Talk Isn't Always Cheap*, 2025). Agreement costs no
extra turns. A disagreement gets one targeted exchange: the operator asked for
debate, and its value there can be measured from the recorded ballots.

A member may vote for its own proposal, because forbidding that would force a
tie. Instead, its ballot names the strongest point of each option it did not
choose, so the dissent is in the record.

Routing gets a **diversity predicate**: a node may require a provider family
other than the one of a named node. The critique in `research` and every team
member use it. Today a Worker's provider is informational only, and routing never
branches on it ([INV-11](../architecture/invariants.md)). The predicate is an
opaque inequality: routing may require "a different provider family than node
X", and it never names a family, provider, account, or model. Because INV-11 is
binding, this is recorded in
[ADR-0027](../decisions/adr/0027-provider-diversity-in-routing.md), which adds an
opaque `family` to a Worker's descriptor and allows only inequality on it. The
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
- A temporary chat has no binding and is never deleted by `system`: the site
  removes it from history itself, and the provider keeps it on its own clock
  (up to 30 days or 72 hours, above).
- The operation deletes exactly one recorded conversation from the history
  menu, and handles a confirmation dialog when the site shows one. A
  site's bulk deletion is never used: it would reach the operator's own chats.
- Deep research conversations are deleted only after a live check shows the
  same operation works for them. Until then they are recorded and reported as
  not deleted.
- The runbook states that deletion on the site does not bind the provider's own
  retention.

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
| 1 | Removals and switch-offs (the operator removes the free account before or together with this update; a Worker whose tier names an unknown mode is unavailable, never routed): the templates except `panel`, which serves the dogfood brainstorm until `brainstorm` replaces it in Phase 3; the `deep` option of `research` (CLI and MCP); agent Worker and gateway rows disabled by default (their helpers refuse while off); the agent `review` moved into the agent Workers' template list; the `site` preset; the free account removed by the operator; Linux-only docs. Until Phase 3 there is no `review` in the default composition, which is accepted. | composition e2e row set; upgrade suite still explains old runs; crash suite |
| 2 | `research` on two providers in parallel (branch A proves `web-search`, branch B is cited and on another provider family), with the diversity predicate. The diversity predicate needs ADR-0027, so the ADR moves here from Phase 3. | a live run uses both providers |
| 3 | `panel` removed; teams (`review` of text lists every member's findings with provenance; the blocking-finding rule waits for Phase 4's quote verification, since only a quoted finding can be confirmed): `brainstorm` and `review` with debate and vote, tie to the caller | live brainstorm of a real design question for `system` |
| 4 | `review` of a public repository by URL: fetched files, quote verification, merging by quoted line, and the blocking-finding rule for every review | live review of this repository |
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

Accepted by the owner on 2026-10-16, together with
[ADR-0027](../decisions/adr/0027-provider-diversity-in-routing.md). Two choices
followed the dogfood research:
- teams vote first and debate only on disagreement;
- the second research branch is gated by citations, not by proven web search.

## Implementation

None yet.
