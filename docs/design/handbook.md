# The handbook and the per-Worker slice

> Target state. Decision: [ADR-0072](../decisions/adr/0072-the-handbook-in-five-layers-and-a-bounded-slice-per-worker.md),
> from [PROP-0016](../proposals/0016-operating-model.md#2-the-handbook-in-layers) (accepted
> 2026-10-26, D83; I1). The risk tier it selects by is
> [ADR-0071](../decisions/adr/0071-a-changes-risk-tier-comes-from-the-policys-path-map.md)'s (T237).
>
> Built: part 1, this design and the rule inventory (T249, `88b453a4`); the lead's playbook and
> onboarding, layer 4 (T252, `9afeb362`); part 2 (T259, `b311a213`, below). ADR-0072 is accepted
> (2026-10-27). Also built: the review guides, the author's own checks, and a fresh-context
> self-review (T267, `c524543e`), the checks recorded by the System (T284, `905c2f32`); the
> [scheduled review](#scheduled-review) of existing code (T290, `688ec090`). Not built: part 3 (the lead's file), part 4, probation's trust tiers.
>
> Implemented for I1 part 2 (T259). The layers are declared once (workflow `src/handbook.ts`
> `HANDBOOK_LAYERS`); every step of a board task's run is given its slice, selected by role, class,
> risk tier, and touched paths: the engine's half as a `handbook-slice@1.0` context pointer, read
> from the homes under `handbook.root` (the invariants' titles and the accepted ADRs naming a touched
> package for `heavy`; the inventory's layer-4 rules of the role, keyed by class and path,
> `PLAYBOOK_RULES`); the source's half by agent-workers (the gate view; the lessons by role and
> `Applies:`, a reviewer's included, X3). Both halves are bounded in UTF-8 bytes and measured against
> the bound, warned for the first `handbook.warnTasks` tasks and then refused (`handbook_over_bound`);
> the brief records each layer's version and size (`brief@1.6` `handbook`: `@1.4` and `@1.5` were
> taken by the tier and the model, [ADR-0073](../decisions/adr/0073-agent-workers-offer-tiers-per-role-with-quota-per-model.md)),
> the source records what it rendered (`agent-workers.handbook`), and `system explain` and `/ui`
> show both ([workflow engine](workflow-engine.md#the-handbook-slice)). The
> [review guides](#review-guides-reviewmd), built ahead of the slice (T267), are a part of its layer
> 4: a review step's slice counts and versions the guides its brief already points at for the paths
> its change touches, and the author's own checks and fresh-context self-review run before the
> independent review (W19, V6).
>
> Differs from target: the homes carry no rule ids or `Applies` keys of their own yet: the writer's
> and reviewer's rules are the inventory's lines below, and their keys are declared in code
> (`PLAYBOOK_RULES`); the validator's, researcher's, and lead's playbooks are their templates' text
> alone. The touched paths are read only where tiering is on (with it off, they are unknown: every
> path-keyed part); with them unknown, a heavy change's ADRs are not listed (the pointer's ADR index
> stands for them, rather than every ADR that names a package). Layer 1's blob is that of the file as
> checked out under `handbook.root`. The bound counts distinct tasks in a table
> (`workflow_handbook_tasks`) and records a `handbook.bound` decision only for a slice over the bound
> and for the move to refuse. The source records its half as an event of the workflow run, not as a
> field of an execution record. Probation's line (trust tiers) is not built; the lead's file is part 3.
> The gate view is counted at its constructed maximum (1,000 tokens), since only the routed Worker's
> evidence decides it; the lessons at what they render to. Measured on this repository at T259
> (`scripts/handbook-bound.spec.ts`: the real homes, guides, lessons, templates, and path map, a
> stand-in charter), in estimated tokens:
>
> | Change | `develop:1` | `review:1` |
> |---|---|---|
> | one area (`packages/plugins/workflow/`; normal) | 2,563 | 2,871 |
> | two areas (with `packages/plugins/agent-workers/`; heavy) | 3,135 | 4,051 |
> | paths unknown (heavy; every guide) | 3,080 | 5,830 |

System's rules are written in many places: the invariants and ADRs, the autonomy policy and its path
map, the board's charters, the templates' prompts, `AGENTS.md`, `CONTRIBUTING.md`, the engineering
docs, and the repository's lessons. Each new kind of failure was fixed once and written down
somewhere, but nothing tells a Worker which of those rules apply to it, nothing records which ones it
was given, and nothing counts the rules that no check enforces. This document gives the rules one
structure (five layers), takes stock of every rule the repository holds today, and says how a Worker
is given only its slice, within 6,000 tokens, with each layer's version recorded.

## The five layers

A higher layer wins over a lower one; a lower layer may make a rule stricter, never looser. A rule
has one home, in one layer; another place links to it and never copies it.

| Layer | Holds | Owner | Home (files) | Version | Changed by | Enforced by |
|---|---|---|---|---|---|---|
| **1. Constitution** | the invariants, the accepted ADRs, and the rules about ADRs and documents themselves | operator | [invariants](../architecture/invariants.md), [ADRs](../decisions/adr/README.md), [decision rules](../decisions/README.md#decision-rules), [documentation policy](../governance/documentation.md) | the git blob id of `docs/architecture/invariants.md` at the repository's HEAD, and the highest accepted ADR's number | an ADR the operator accepts (heavy in the path map) | `scripts/architecture.spec.ts`, the seams' conformance suites, the crash and upgrade suites, `check:schemas`, `check:docs`; for the rest, the review |
| **2. Organisation policy** | the autonomy policy (modes, action classes, `ALWAYS_ASK`, the commands list), the risk tiers' path map ([ADR-0071](../decisions/adr/0071-a-changes-risk-tier-comes-from-the-policys-path-map.md)), the trust tiers (PROP-0016 §3), what escalates (§7), the budgets the operator set (research 10 %, attention 15 a day) | operator; the lead proposes | the studio and project policies (configuration and the stored set, [approvals](approvals.md#the-autonomy-policy)); this repository's project policy and map, `policies/system.json`; `docs/operations/` for the prose | the policy's `version` and the hash of the set in force (`policy().set`); the map's `riskTiers.version` | a `policy-change` approval ([ADR-0041](../decisions/adr/0041-policy-changes-through-the-approval-queue.md)) | the tool gate on every call; the approval queue; the policy's load-time rules; `check:tiers` for the map; the `workflow.risk-tier` decision and the board's hold of a heavy result |
| **3. Project charter** | the project's objective, constraints, stop rules, budget, required checks, auto-accept branches | operator, with the lead | the board's project record (`project@1.x` `charter`, [board](board.md)) | the project id and `charter.version` (an integer the board already keeps) | a charter amendment the operator approves (`board_charter`) | the board (budgets, gates, `board.auto-accept`), a run's required checks ([ADR-0063](../decisions/adr/0063-a-runs-required-checks-run-on-its-exact-result.md)); a charter's `constraints` text, the review only |
| **4. Role playbooks** | how a writer, a reviewer, a validator, a researcher, and the lead each work, and what "done" means for the role | lead | the templates' prompts (`profile-software-development`, `profile-scientific-research` `src/index.ts`; the second review's wording, workflow `src/risk.ts`); for the rules a writer follows in this repository, [AGENTS.md](../../AGENTS.md), [CONTRIBUTING.md](../../CONTRIBUTING.md), and the [engineering](../engineering/README.md) docs; for the lead, the [lead's playbook](../operations/lead-playbook.md) | the template's name, its package's version, and the sha256 of the playbook text the slice carries (templates carry no version of their own today) | a reviewed change | per rule, the check it names (below); most are the review only |
| **5. Repository lessons** | mistakes made in this repository before, one line each, with what now enforces it | lead and review | [lessons](../engineering/lessons.md), one per repository | the git blob id of `docs/engineering/lessons.md` at the Worker repository's HEAD | a commit; a lesson whose check makes it impossible to repeat is folded or dropped | `agent-workers/tests/lessons.spec.ts` (at most 30 lines of at most 400 characters, each naming `Check:`); each lesson's own check |

**Rules for every layer:**

- **A rule names its check**, or says it has none: "Check: the review; no automated check yet", as
  the lessons already do. A rule is never claimed enforced by a check that does not test it. The
  number of rules without a check is an I1 metric; it should go down.
- **A rule has one home.** Where the same rule is written twice today, the [inventory](#the-rule-inventory)
  names the home it keeps and the copies that become links.
- **A lower layer is stricter, never looser.** A project policy can only tighten the studio policy
  (approvals' strictest-wins; a project's path map only raises a path's tier); a charter can add a
  required check, never drop one the policy requires; a playbook or lesson can never permit what
  the gate or an invariant refuses.
- **The slice carries what a Worker can break.** A rule the gate or the type system makes impossible
  to break (a denied call is denied whatever the Worker read) is in the slice only as far as it
  saves a wasted attempt: the gate view says what will be refused, not why the policy says so.

## The rule inventory

Every rule a Worker or the lead must follow that the repository states today, as of 2026-10-26
(after T237), mapped to the layer it belongs to. "Check" names what enforces it now; **none** means
the review alone (or nobody), and the rule is listed as such, never claimed enforced. Rules stated
only inside code (a schema's constraint, a gate's refusal) are not listed one by one: the code is
their check, and the design documents that describe them are their home. No `CLAUDE.md` exists in
the repository.

### Layer 1: constitution

| Id | Rule | Home | Check |
|---|---|---|---|
| INV-1 | one authoritative runtime per concern | invariants | `architecture.spec.ts` (one provider per service) |
| INV-2 | fail closed; no silent fallback | invariants | per mechanism's tests; no check of the rule as such: **none** |
| INV-3 | completion boundaries are distinct | invariants | conformance suites of the provider and Worker seams, in part |
| INV-4 | restart is reconciliation, not replay | invariants | the crash suite (`pnpm test:crash`) |
| INV-5 | exact-subject binding | invariants | the workflow's exact-subject gate and its tests |
| INV-6 | authority from trusted envelopes | invariants | per mechanism's tests; **none** as a rule |
| INV-7 | no mirrored protocol objects | invariants | `architecture.spec.ts` |
| INV-8 | credentials never cross upward | invariants | provider-runtime tests; `check:secrets` for the tree; **none** as a rule |
| INV-9 | everything is bounded | invariants | per bound's tests; **none** as a rule |
| INV-10 | everything is a plugin; a disposer per registration | invariants | `check:manifests`; HMR tests per registry (plugin rule 3) |
| INV-11 | no tool lock-in | invariants | `architecture.spec.ts` (capability-routed code names no tool) |
| INV-12 | data egress is explicit | invariants | the `egress` plugin's tests on the outgoing payload |
| INV-13 | every decision is an artifact | invariants | per decision's tests; **none** as a rule |
| INV-14 | every record has a versioned schema | invariants | `check:schemas`; store validation on write and read |
| INV-15 | one writer per subject | invariants | the board's and leases' tests |
| K1 | changing an invariant needs an ADR | invariants header; also [AGENTS.md](../../AGENTS.md) "Change invariants" | **none** (the path map makes the change heavy; nothing checks that an ADR came with it) |
| K2 | accepted ADRs are append-only: amend for a clarification, supersede for a change | [decision rules](../decisions/README.md#decision-rules), [documentation policy](../governance/documentation.md#amending-an-accepted-adr); also AGENTS.md | **none** |
| K3 | search existing decisions first; an ADR only for a durable decision; never a current-state manual | decision rules | **none** |
| K4 | every docs directory has one README; links and anchors resolve; no conflict markers; no two numbered documents share a number | [CI gates](../engineering/testing.md#ci-gates) | `check:docs` |
| K5 | target-state header in requirements, architecture, design; code and canonical doc corrected in the same change | documentation policy | **none** |
| K6 | work state lives in System's records, never in a vendor's folder (`.claude/`, `.codex/`) | [documentation policy](../governance/documentation.md#work-state-and-conversations) | **none** |
| K7 | diagrams are Mermaid; the layer map's diagram has one home | documentation policy | **none** |
| K8 | requirement ids are stable; a retired one keeps its id and no test cites it | [requirements](../requirements/README.md) | `check:traceability` |
| ADR-n | each accepted ADR's decision | the ADR | the tests it names; not inventoried one by one here (each its own home) |

### Layer 2: organisation policy

| Id | Rule | Home | Check |
|---|---|---|---|
| P1 | the four modes; the strictest of studio and project wins; `ALWAYS_ASK` classes never `auto` | [approvals](approvals.md#the-autonomy-policy) | the schema and load-time rules; the approvals provider's tests |
| P2 | a command is its exact argv; a shell metacharacter is `forbid`; a listed argv is a workspace write | approvals | the gate; its tests |
| P3 | a policy changes only through a `policy-change` approval | [approvals](approvals.md#a-policy-change), ADR-0041 | the approvals provider |
| P4 | a merge always asks the operator | ADR-0060 | `ALWAYS_ASK` |
| P5 | dispatch starts ready work only under its class's mode | ADR-0064 | the dispatch pass's tests |
| P6 | commands run confined to the worktree, with no network | the writing prompts (W1); in fact the agent's sandbox and the gate | bubblewrap confinement and its tests |
| P7 | the gate's own refusals: words split on spaces, absolute paths, inspection commands denied where a reading tool serves | `unaskedNote` in agent-workers `src/gate.ts` (rendered from the policy) | the gate |
| P8 | a change's risk tier is the highest of its paths' tiers; an unmatched or unreadable path is heavy; a heavy change needs two families' approvals and the operator | ADR-0071, `policies/system.json` | `check:tiers` (the map loads and matches every tracked path); the `workflow.risk-tier` decision; acceptance version 4; the board's hold |
| P9 | the trust tiers and their moves | PROP-0016 §3, D83 #5 | **none** (not built) |
| P10 | what System decides alone, tells, or escalates with a decision brief | PROP-0016 §7 | in part: `ALWAYS_ASK` covers merge, policy change, charter, funding, and the board holds a heavy result; a new project and a trust boundary: **none**; the decision brief is not built |
| P11 | research spends at most 10 % of the week's quota, never the 20 % reserve | D83 #6 | **none** |
| P12 | the attention budget: 15 decisions a day, 10 for `system` | D83 #8 | **none** |
| P13 | the handbook part of a brief is at most 6,000 tokens: a warning for 30 tasks, then a refusal | D83 #3 | the engine's `handbook.bound` (workflow `tests/handbook.spec.ts`; I1 part 2, T259) |

### Layer 3: project charter

| Id | Rule | Home | Check |
|---|---|---|---|
| H1 | no task starts outside an active project with an approved charter | [board](board.md) | the board |
| H2 | a run stops at a boundary once its task's budget is spent | ADR-0047 | the board and the crash suite |
| H3 | a run's required checks run on its exact result | ADR-0063 | the workflow's checks |
| H4 | a listed branch's result is accepted on its review and checks, unless heavy | ADR-0067, ADR-0071 | `board.auto-accept` and the board's hold |
| H5 | the charter's constraints and stop rules | the project record | stop rules: the board where they are budgets; a constraint's text: **none** |

### Layer 4: role playbooks

**Writer** (`develop:1` and its `docs` and `tests` variants; any Worker that writes this repository):

| Id | Rule | Home today | Check |
|---|---|---|---|
| W1 | one hypothesis per attempt, stated with why; a later attempt starts from what the last measured | `DEVELOP_PROMPT` (and the variants' equivalents) | **none** |
| W2 | change only what the task needs; the smallest coherent change | `DEVELOP_PROMPT`; AGENTS.md "Change invariants" | the review (`REVIEW_PROMPT`: "nothing beyond it"): **none** |
| W3 | never weaken, skip, or loosen a test or benchmark | `DEVELOP_PROMPT`, `TESTS_PROMPT`; AGENTS.md "Verification"; `REVIEW_PROMPT` | the review; **none** automated |
| W4 | the `docs` variant changes documents only, every statement true of the code in the worktree | `DOCS_PROMPT` | **none** (the tier decision lists the paths, but nothing refuses a docs task's code path) |
| W5 | the `tests` variant changes tests only, never the code under test | `TESTS_PROMPT` | **none** (as W4) |
| W6 | end with the hypothesis, the files changed, the criteria met | the writing prompts | **none** |
| W7 | read before changing: README, docs router, the nearest README, the source; proposals and research are context only | AGENTS.md "Read before changing" | **none** |
| W8 | documentation is part of the change (behaviour → docs and tests; seam → catalog and suite; record shape → schema; dependency → register; decision → ADR) | AGENTS.md | in part: `check:schemas`, `check:manifests`, `check:reference`, `check:packages`, `check:traceability`; the dependency register and the docs prose: **none** |
| W9 | everything is a plugin; no tool, model, or vendor named in routing, team, workflow, or profile code | AGENTS.md (copies INV-10, INV-11) | `architecture.spec.ts` |
| W10 | reuse or adapt before building | AGENTS.md, [code quality](../engineering/code-quality.md), ADR-0010 | **none** |
| W11 | one authoritative implementation; no fallback paths or compatibility layers | AGENTS.md (copies INV-1, INV-2); code quality "No silent fallback" | in part `architecture.spec.ts`; otherwise **none** |
| W12 | no speculative abstraction, protocol, knob, or dependency | AGENTS.md, ADR-0006 | **none** |
| W13 | do not duplicate a fact; one canonical home | AGENTS.md; [documentation policy](../governance/documentation.md#enforcement); [status ownership](../README.md#status-ownership) | **none** |
| W14 | the final review: the whole diff, no stale paths, source, tests, and docs agree, report what was verified | AGENTS.md "Final review" | **none** |
| W15 | run the generators, then `pnpm check` and `pnpm test:related <the files you changed>`, before finishing: never the full suite; the acceptance runs the tests related to the result's files and the landing runs the full suite once on the rebased tree (T299) | CONTRIBUTING "Before you finish"; testing.md "Tests scale with the change" | the run's required checks at acceptance (related tests) and again at landing (full suite) (ADR-0063, ADR-0068); the `check:*` freshness checks |
| W16 | a user-visible change adds a changeset | CONTRIBUTING; [releasing](../engineering/releasing.md) | **none** (the release refuses a version with no changelog, not a change with no changeset) |
| W17 | take the next free ADR, proposal, and migration number; the change landing second renumbers | CONTRIBUTING; testing.md "What parallel changes collide on"; lesson L2; development.md | `check:docs`, `check:migrations` (`scripts/collisions.spec.ts`) |
| W18 | how a schema changes (minor or major) | reference/schemas.md; CONTRIBUTING; lesson L3; AGENTS.md | in part: `check:schemas` (that a version moved), a `*.v2.json` and above heavy in the map; a major written in place: the review. See [contradiction X1](#contradictions) |
| W19 | before its review, a writing step of a board task's run runs the required checks, which the System records itself (command, exit code, output tail), and may add its own `evidence` prose to the task's dossier; a fresh session of its account then reviews the diff and the author answers the findings (T267) | `VERIFY` in the profile's writing prompts ([template](../reference/workflow-templates.md#algorithm-development)) | `workflow.evidence` gate: a step whose template says `showsEvidence` is refused at its end when no command the System recorded runs a required command check (and its own entry does not say why it could not run): the first refusal continues its session once with the message, and a second fails it (`evidence_missing`, "evidence refused twice"); it is admitted only to a Worker with the dossier tools; its fixes are held to the same; the self-review is a graph step, so it cannot be skipped, and its brief holds no dossier; that the checks passed: **none** (the acceptance checks run again) |
| Q1 | a package imports from its layer or a lower one | code quality | **none** (`check:packages` makes a new upward seam edge visible, it does not refuse it) |
| Q2 | a file past about 800 lines is a smell | code quality | **none** |
| Q3 | typed failures; no bare strings thrown | code quality | **none** |
| Q4 | a narrow public surface; no root re-export of everything | code quality | **none** |
| Q5 | the lockfile is committed; build output and vendored binaries are not | code quality | in part: `--frozen-lockfile` installs; otherwise **none** |
| Q6 | no `#private` in a Cordis `Service`; `Config` fields optional with defaults in code | code quality | **none** |
| Q7 | dependencies' native build scripts denied but `esbuild` | code quality | pnpm's `allowBuilds` |
| T1 | real plugins over mocks; mock only the expensive boundary | [testing](../engineering/testing.md#conventions-adopted-from-dsh) | **none** |
| T2 | one temporary parent per run; a test keeps using `tmpdir()` | testing | `scripts/test-tmp.ts`, the lanes' global setup |
| T3 | clean up with the test (`onTestFinished`) | testing | **none** |
| T4 | wait for the event, not the clock | testing | **none**; also lesson L6 |
| T5 | a test's bound fits its work | testing | **none** |
| T6 | an unhandled rejection is a failure | testing | vitest |
| T7 | pin the time a test reads | testing | **none**; also lesson L5 |
| T8 | every registry has a test that disposes its plugin | testing | **none** |

**Reviewer** (`review:1`, a review member, and a heavy change's second review):

| Id | Rule | Home today | Check |
|---|---|---|---|
| V1 | review independently: the task, its criteria, and the exact change, never the developer's conversation | `REVIEW_PROMPT`; ADR-0070 | the review step's brief holds no session and no pointer at the author's result (workflow tests) |
| V2 | a defect, an unneeded change, or a weakened test is blocking | `REVIEW_PROMPT` | **none** (no check reviews the reviewer) |
| V3 | never run the project's tests or builds; a command it could not run is at most `info` | `REVIEW_PROMPT` | in part: a review member's read-only, empty workspace (ADR-0049) |
| V4 | the review names the exact subject it was given | the brief's `exact-subject` criterion | the exact-subject gate |
| V5 | a heavy change's second review is by another provider family, independent of the developer and of the first review | `SECOND_REVIEW` (workflow `src/risk.ts`), ADR-0071 | routing (`differentFrom`) and acceptance version 4 |
| V6 | a review follows the [review guides](#review-guides-reviewmd) of the areas its change touches: its evidence rule, nit cap, and summary rule (T267) | the guides (`docs/review/`); the review prompts point at them | the guides are in the review's brief by the engine (a test); that the review follows them: **none** |

**Validator** (a `validate` step; `algorithm-development` has none since T267): **Y1** run each
criterion's check exactly as written, change no file, report verbatim, estimate nothing. Check: in
part; nothing checks "change no file" or "verbatim", but the run's required checks run again on the
exact result at acceptance (ADR-0063). The one template that had a validator measured its step at a
median of 0.4 minutes, catching nothing the acceptance checks did not, and folded it into W19; a
template that needs a separate validation Worker can still name the step (a final step may be
skipped at a light tier, `riskSkip`, ADR-0071).

**Researcher** (`profile-scientific-research`: frame, two literature reviews, evidence, critique,
conclusion): **S1** hypotheses as a `hypothesis-set@1.0`, citations, independent reviews (the
template's prompts). Check: in part, the result schema, and a `quote-check` where a criterion names
it. **S2** research Workers on at least two providers (PROP-0016 §5). Check: **none**.

**Lead** (not a step the engine starts; each project's own lead session, D88): the home of every
lead rule is the [lead's playbook](../operations/lead-playbook.md) (T252), each line with its id and
check; [examples/LEAD.md](../operations/examples/LEAD.md) is the onboarding checklist a project's
`LEAD.md` copies, pointing at it and adding no rule. The ids are `LD`, so they never read as an
operator decision's `Dnn`. The rules first listed here as D1 to D4 are LD22 (D1 and D2), LD23 (D3),
and LD4 (D4).

| Id | Rule (short; the playbook holds it whole) | Check |
|---|---|---|
| LD1 | decide alone on `dev`: a start, a read-only or own-scratch command, an accept on review and checks, a merge into `dev`, a salvage, a task filed | in part: the board (H1), `board.auto-accept` (H4) |
| LD2 | decide and tell the operator in the day's digest | **none** |
| LD3 | escalate with a decision brief: policy, charter, a deploy beyond `dev`, a merge to `main`, an external send, a security alert dismissed, a heavy result, spending past a budget, anything irreversible or outward-facing | in part: `ALWAYS_ASK`, the board's hold of a heavy result |
| LD4 | the decision brief's form | **none** (I2's later part) |
| LD5 | System's `merge` request stays the operator's | `ALWAYS_ASK` |
| LD6 | the daily loop's reading order | **none** |
| LD7 | the order to handle what it finds | **none** |
| LD8 | one digest a day, within the attention budget | **none** |
| LD9 | a deferred command judged by its words, never a pattern | **none** |
| LD10 | the Worker's own untracked scratch may be removed | **none** |
| LD11 | deny with what to run instead | **none** |
| LD12 | never a write to System's own directories | in part: the gate (`.git`) |
| LD13 | when to salvage | **none** |
| LD14 | how to salvage | in part: CI on `dev` |
| LD15 | each salvage files its root-cause task | **none** |
| LD16 | sync the landing checkout after every lead push | in part: the landing refuses a moved or dirty checkout |
| LD17 | never push on a failed check | in part: CI, the auto-update |
| LD18 | never build or test in the live checkout | in part: `live-update.sh` |
| LD19 | a live update: pause, wait, build, check, roll back, verify Workers | in part: `live-update.sh`; the lead's own starts **none** |
| LD20 | a paused automatic update is read the same day | **none** |
| LD21 | a task: one concern; what to read, deliver, test, document, and leave alone | **none** |
| LD22 | give work as a board task; propose just before running | in part: the board validates the shape |
| LD23 | a release is the operator's | the release workflow's `verify` job |
| LD24 | kill by PID only | **none** |
| LD25 | never read a secret | in part: `check:secrets` |
| LD26 | a public repository gets only public content | in part: `check:secrets` |
| LD27 | no model name in an artifact | **none** |
| LD28 | each operator decision with its id | **none** |
| LD29 | a lesson within its bounds | `lessons.spec.ts` |
| LD30 | a durable decision is an ADR, the next free number | in part: `check:docs` |

**Every Worker of a board task** (brief mechanics, rendered by code): **B1** ask instead of answering
with one JSON object of at most 8 questions (`renderBrief`, checked by `questionsOf`); **B2** write the
dossier: a plan at the start, progress after each step, a response per finding (the gate note;
ADR-0070). Check: B1 by `questionsOf`; B2 in part: its kinds by the dossier's gate, whether an entry
is written at all **none** (the engine writes the step's entry when a Worker wrote none).

### Layer 5: repository lessons

| Id | Lesson (short) | Check it names | Note |
|---|---|---|---|
| L1 | Node's type stripping refuses parameter properties, enums, namespaces (T213) | `agent-runtime-core/tests/workspace-reads.spec.ts` | |
| L2 | take the next free number (T185, T193) | `check:docs`, `check:migrations` | copies W17 |
| L3 | a schema never changes in place (T185, T209) | `check:schemas`; the review for a major | in part; copies W18; contradiction X1 |
| L4 | commit only the change; scratch under `$TMPDIR` (T214) | the review; **none** automated | never shown to the reviewer: X3 |
| L5 | a test never asserts on the wall clock | the review; **none** automated | copies T7; never shown to the reviewer: X3 |
| L6 | a test never sleeps a fixed time and then asserts | the acceptance `tests` check | in part (a flaky test can pass the check); copies T4; contradiction X2 |

### Counts

| Layer | Rules listed | With a check that tests the rule | In part | **None** |
|---|---|---|---|---|
| 1 | 23 (and the ADRs) | 11 | 1 | 11 |
| 2 | 13 | 9 | 1 | 3 |
| 3 | 5 | 4 | 0 | 1 |
| 4 | 75 | 14 | 20 | 41 |
| 5 | 6 | 2 | 2 | 2 |
| **All** | **122** | **40** | **24** | **58** |

"In part" counts INV-3, P10, W8, W11, W18, Q5, V3, Y1, S1, LD1, LD3, LD12, LD14, LD16 to LD19,
LD22, LD25, LD26, LD30, B2, L3, and L6. INV-2, 6, 8, 9, and 13 count as **none**: each mechanism
has tests, but nothing checks the rule itself. A rule whose only check is the review (W2, V2)
counts as **none**. These numbers are I1's starting reading of "rules without a check". The
reading before the lead's playbook (T249) was 94 rules, 36 checked, 13 in part, 45 **none**: the
playbook (T252) wrote down 30 lead rules for the 4 listed before, and most of them have no check yet.

### Duplicates

Each keeps the first home named; the others become a link (layer 4's and 5's copies) once I1's
later parts land.

| Rule | Home kept | Copies |
|---|---|---|
| invariants bind; a change needs an ADR (K1) | invariants header | AGENTS.md |
| ADRs append-only (K2) | documentation policy | decision rules, AGENTS.md |
| plugin and no-vendor rules (W9) | INV-10, INV-11 | AGENTS.md |
| one implementation, no fallback (W11) | INV-1, INV-2 | AGENTS.md, code quality |
| one home per fact (W13) | documentation policy | AGENTS.md, docs status ownership |
| reuse before build (W10) | ADR-0010 | AGENTS.md, code quality |
| never weaken a test (W3) | the writer's playbook | `DEVELOP_PROMPT`, `TESTS_PROMPT`, AGENTS.md, `REVIEW_PROMPT` (the reviewer's side of it stays, as V2) |
| take the next free number (W17) | testing.md "What parallel changes collide on" | CONTRIBUTING, development.md, lesson L2 |
| schema versioning (W18) | reference/schemas.md "Versioning" | CONTRIBUTING, AGENTS.md, lesson L3 |
| changeset for a visible change (W16) | releasing.md | CONTRIBUTING |
| wait for the event (T4) | testing.md | lesson L6 |
| pin the time (T7) | testing.md | lesson L5 |
| confined, no network (P6) | the sandbox and the gate view | the three writing prompts |
| the lead's lines that restate another home: the decision brief (LD4), giving work (LD22), a release (LD23), a lesson (LD29), an ADR (LD30) | PROP-0016 §4, development.md "Give work to System Workers", releasing.md, lessons.md, the decision rules (K1 to K3) | the lead's playbook, one short line each that links its home |

A lesson may stay while its copy earns its place in the brief (it is the line a writer sees), but
it then names its home in its text, as L3 and L5 already do.

### Contradictions

| Id | What disagrees | Resolution (owner; done in a later part) |
|---|---|---|
| X1 | **Schema versioning.** [reference/schemas.md](../reference/schemas.md#versioning), AGENTS.md, and lesson L3: removing, renaming, or tightening a field is a **major**, a new file with a tested store migration. [CONTRIBUTING](../../CONTRIBUTING.md#take-the-next-free-number): requiring, removing, or narrowing a field is "a new version: add its note (`1.10 adds …`)", a minor. `check:schemas` accepts any version note past the snapshot, so it passes the minor CONTRIBUTING describes. | schemas.md is the home (INV-14). CONTRIBUTING links it and drops its own wording; the check's limit stays documented (a major is the review's, and heavy by its file name). Lead. |
| X2 | **Sleeping in a test.** Lesson L6: "never sleeps a fixed time and then asserts". testing.md: "a fixed sleep stays only where a test shows that nothing happens during a window". The brief carries only the lesson, so a writer never sees the exception. | testing.md is the home; L6 names it and its exception, in its 400 characters. Lead. |
| X3 | **Lessons the review enforces never reach the review.** L4 and L5 say "Check: the review", but agent-workers sends lessons to `workspace-write` runs only, never a review member's (`withLessons`; `lessons.spec.ts` asserts it). | The reviewer's slice carries layer 5 ([below](#the-slice-of-each-role)). Lead. |
| X4 | **AGENTS.md reaches some Workers and not others.** It is a file in every worktree. Whether a runtime reads it on its own is that runtime's behaviour (agent-workers says a runtime "may read instruction files from its working directory"); nothing records whether it did. No `CLAUDE.md` exists, and the documentation policy forbids a vendor's folder for work state. | The writer's slice carries AGENTS.md's rules that bear on the role, as layer 4, recorded; AGENTS.md stays the router for a person or an agent outside System. No `CLAUDE.md` is added (it would copy AGENTS.md). |
| X5 | **PROP-0016 §2 names a version and a check layer 4 does not have.** Layer 4's version is "the template's version" (templates have none) and its check "template conformance tests" (`algorithm-development.spec.ts` checks the template's graph, routing, and what each step is sent, not whether a Worker follows its playbook). | This document's layer table is the current statement: layer 4's version is the playbook's hash; its checks are per rule, mostly **none**. |
| X6 | **"Only what it needs" against "documentation is part of the change".** `DEVELOP_PROMPT` tells a writer to change "the code ... only what it needs"; AGENTS.md makes docs and tests part of any behaviour change. | The writer's playbook says both in one line: the change is the code with its docs and tests. Lead. |
| X7 | **AGENTS.md's "Verification" against the review's prompt.** AGENTS.md tells "coding agents" to run the required checks; `REVIEW_PROMPT` tells a reviewer never to run tests or builds. Only a reviewer whose runtime reads AGENTS.md (X4) is told both. | Each role's slice holds its own playbook; AGENTS.md's verification rule is the writer's (W15). |
| X8 | **An unmatched path's tier.** PROP-0016 §4 says an unmapped path is normal; ADR-0071 (T237) makes it heavy. | Resolved by ADR-0071 and noted in PROP-0016's implementation; the slice follows ADR-0071. |

## The per-Worker slice

A Worker is given a **slice** of the handbook, never the whole: the parts of each layer that bear
on its role, its task's class, its risk tier, and the paths it touches. Everything else is one read
away (the workspace reads server, the dossier, `git`), and the slice says where.

### What selects a part

Each part of a layer carries **where it applies**, by four keys. A part with no key applies to
every role.

| Key | Values | Read from | When it cannot be read |
|---|---|---|---|
| **Role** | `develop`, `review`, `validate`, `research`, `lead` | the step's capabilities (`develop`, `review`, `validate`; `reason` in a research template); the lead's file is built for `lead` | — (every step has capabilities) |
| **Task class** | the step's kind of work ([ADR-0057](../decisions/adr/0057-route-work-by-kind.md)): `code`, `docs`, `tests`, `validation`, or another kind a row configures; the template's variant | the step's resolved node | the role's parts for every class |
| **Risk tier** | `light`, `normal`, `heavy` | a review, a second review, a validation, or a fix: the run's latest `workflow.risk-tier` decision (ADR-0071 decides it when a review approves); a writing step before any review: the same map ([`approvals-core`](../../packages/approvals-core/README.md) `changeTier`) applied to the touched paths below | **heavy**, as ADR-0071 rules for an unreadable change; with no applying map, tiering is off and the slice has no tier lines (recorded as `off`) |
| **Touched paths** | repository paths (globs on a part) | a review, a validation, or a fix: the exact subject's changed paths (`ctx.workers.changes`, as the tier reads them); a later attempt: the paths its previous attempt changed (ADR-0061's carried work); a first attempt: the paths the task declares, if any | **every** path-keyed part of the role is included, never none (INV-2): an unknown path is no reason to leave a rule out |

How each layer's parts carry the keys (I1 part 2 builds them; nothing is rewritten for it):

- **Layer 1:** no part is keyed but by tier. The slice never holds the invariants' text: `light`
  and `normal` get one line pointing at the invariants and the ADR index; `heavy` gets the
  invariants' titles with their anchors, and the ADRs whose Related or Decision name a touched path's
  package.
- **Layer 2:** the gate view is rendered for the Worker's sandbox and runtime, as `unaskedNote` does
  now. The tier's lines (what the change's path is: one review, or a second family and the
  operator's acceptance; whether validation may be skipped) and, for a Worker on probation (T1,
  §3), its one line, are selected by tier and trust tier.
- **Layer 3:** the charter's objective, required checks, and auto-accept branches, for every role;
  its constraints for `develop` and `review`.
- **Layer 4:** one playbook per role, the role's template text; a variant's text replaces the
  role's where the template has one. The writer's playbook adds the rules of AGENTS.md,
  CONTRIBUTING, and the engineering docs that bear on writing (W2 to W18, Q1 to Q7, T1 to T8), each
  one line linking its home, keyed by class and path (a test rule for `tests` and for a touched
  `tests/` path; a schema rule for a touched `schemas/` path).
- **Layer 5:** a lesson may end with an `Applies:` clause after its `Check:`, naming roles and
  paths (`Applies: develop, review; schemas/**`). A lesson with none applies to `develop` and
  `review`, every path. Its paths are read by libs' one glob matcher and pattern validator
  (`globMatches`, `globProblem`); a path the validator refuses matches nothing.

### The slice of each role

| Role | Layer 1 | Layer 2 | Layer 3 | Layer 4 | Layer 5 |
|---|---|---|---|---|---|
| **develop** (`code`) | the pointer; `heavy`: invariant titles, ADRs of touched packages | the gate view; the tier's lines; probation's line | objective, required checks, constraints | the writer's playbook: `DEVELOP_PROMPT`'s rules and the keyed writing rules | every lesson that applies |
| **develop** (`docs`) | as `code` | as `code` | as `code` | the `docs` variant's rules; of the keyed rules, docs and schema ones only (W4, W8, W13, W17, K4 to K7) | lessons that apply to `docs` or its paths, else all of `develop`'s |
| **develop** (`tests`) | as `code` | as `code` | as `code` | the `tests` variant's rules, T1 to T8, W3 | as `code` |
| **review** | as `develop` | the tier's review lines (a heavy change's second review: V5; the adversarial review, I2's later part); a review member has no gate view (it makes no call) | objective, required checks, constraints (to judge them) | the reviewer's playbook (V1 to V6), with the [review guides](#review-guides-reviewmd) of the paths the change touches | every lesson that applies to `review`, so a lesson whose check is the review reaches it (X3) |
| **validate** | the pointer | the gate view (it runs commands) | required checks | the validator's playbook (Y1) | lessons whose `Applies` names `validate` only |
| **research** | the pointer | egress: what may leave for which Worker (INV-12), from the gate view where it has one | objective | the template's step text (S1) | lessons whose `Applies` names `research` only |
| **lead** | the pointer, what needs an ADR (K1 to K3) | §7's table, the path map's tiers and what each means, the decision brief's form, the budgets (P8 to P12) | each led project's whole charter | the [lead's playbook](../operations/lead-playbook.md) whole (LD1 to LD30) | every lesson (the lead owns them) |

The lead is no step the engine starts, so it has no brief: its slice is a file built the same way
(`system handbook --role lead`, I1 part 3), read at the start of the lead's session, within the same
bound and recording the same versions.

**Trust and intelligence tiers.** A Worker's trust tier (T0 to T3, PROP-0016 §3) adds at most one
layer 2 line (a Worker on probation: light tasks only, every result reviewed by another family). Its
intelligence tier (`economy`, `standard`) changes nothing in the slice: a smaller model gets the same
rules, and the bound keeps them short for it.

### Where the slice is rendered

The slice has two halves, because two components hold what it needs:

- **The engine's half** (layers 1, 3, 4, and layer 2's tier lines): the workflow engine composes
  it when it drafts the brief (`briefs.ts` `draftOf`), as a `handbook-slice@1.0` report with role
  `context`, the way the dossier's slice is placed (ADR-0070). It is recorded with the brief, so the
  rules a Worker was given are an artifact (INV-13).
- **The source's half** (layer 2's gate view, layer 5): the Worker source renders them, as it does
  now, because only it knows the Worker's sandbox, runtime, and repository: the gate view from the
  policy in force, the lessons as committed at its repository's HEAD. Each is bounded by
  construction (`TOOLS_NOTE_MAX` 4,000 characters; `LESSONS_LIMITS` 30 lines of 400). It records
  what it rendered on the execution (below).

The task (goal, acceptance criteria, input, pointers, the dossier's slice, the brief's files) is no
part of the handbook and is not counted.

## The 6,000-token bound

**What is measured:** the handbook part of a brief, both halves, as the Worker receives it, in
UTF-8 bytes; tokens are estimated as `ceil(bytes / 4)`, the estimate the MCP surface budget uses
([token budget](../../packages/plugins/mcp-server/README.md#token-budget)). A provider's tokenizer
differs by some tens of percent; the bytes are what is bounded, and no vendor's tokenizer is named
(INV-11). 6,000 tokens are 24,000 bytes.

**Each layer has a share** of the bound, so the layer that overflows can be named:

| Layer | Share (tokens) | What fills it today (estimated from the bounds, not measured) |
|---|---|---|
| 1 | 400 | the pointer, about 30 tokens; `heavy`: 15 titles, about 300 |
| 2 | 1,300 | the gate view, at most 4,000 characters (about 1,000); the tier's lines |
| 3 | 300 | none yet |
| 4 | 900 | a role's prompt, about 150 to 300 |
| 5 | 3,100 | at most 30 lessons of 400 characters and the heading, about 3,050; today 6 lessons, about 600 |
| **Total** | **6,000** | |

This task's own brief (T249, a `docs` writer) carries about 6,300 bytes of handbook (its role text,
its gate view, six lessons), about 1,600 tokens: an estimate read from the brief, not a measurement
by code.

The lead's slice (T252) carries the [lead's playbook](../operations/lead-playbook.md) whole: about
10,000 bytes, about 2,600 tokens (estimated from the file, not measured by code), over layer 4's
900-token share. With the pointer and K1 to K3, the layer 2 lines (about 1,000), a charter (about
300), and today's six lessons (about 600), the total is about 4,700 tokens, within the bound: the
overflow of the share is recorded, never refused (below). Once the lessons fill their share (3,100),
the lead's total would pass 6,000; the playbook's owner, the lead, shortens it first.

**The bound acts on the total.** A slice whose total is within 6,000 tokens is sent whatever its
layers' shares; a layer over its share in such a slice is recorded, never refused. A slice over the
total has at least one layer over its share, and those layers are named. The engine checks its own
half when it drafts the brief. It counts the lessons at what they render to, with the renderer the
source uses (libs `lessonsSectionOf`) on the lessons file of the repository the run's worktree was cut
from, for the step's role and touched paths, and the gate view, which only the routed Worker's
evidence decides, at its constructed maximum (1,000 tokens); the lessons too when their repository
cannot be read (3,100). The source records the size it actually rendered. One exception to acting on
the total: a source's half counted over its layer's share is refused in either mode, so a source's
bound that grows is never sent in the warn period.

**First a warning, then a refusal** (D83 #3):

1. The bound starts in **warn** mode when the slice is turned on. A slice over the total is sent
   whole, with a `gate` decision (`handbook.bound`, outcome `warn`) naming each layer over its share,
   its size, and its owner. Nothing is cut (INV-9: never cut silently).
2. Once the slice has been built for **30 distinct board tasks** (counted from those decisions'
   records, not from overflows), the bound moves to **refuse**, itself a recorded decision. The count
   is configuration (`handbook.warnTasks`, default 30, 0 to 1,000, validated).
3. In refuse mode a slice over the total is not sent: the node fails as `config_error` before it is
   routed, as an unfilled placeholder does (`refuseInstructions`), with a `gate` decision naming the
   layers over their shares. The owner of a named layer shortens it (folds a lesson, moves a rule's
   text to its home and keeps the link); `continue` builds the slice again.

## What a brief records

Each brief records the version of each layer it was given, so a result traces to the rules it was
given (INV-13). `brief@1.6` (this design said `@1.4`; the tier and the model took `@1.4` and `@1.5`
first) adds an optional `handbook` (a minor version: a reader of `@1.x` keeps working):

| Field | What |
|---|---|
| `handbook.bound` | `{ tokens: 6000, mode: "warn" or "refuse" }` |
| `handbook.selection` | the role, task class, risk tier (`light`, `normal`, `heavy`, or `off`) and where it came from (the tier decision's id, or `map` for a writing step's own reading, or `unknown`), and how the touched paths were read (`subject`, `previous-attempt`, `declared`, `unknown`) |
| `handbook.layers[]` | per layer: `layer` (1 to 5), `version` (as in [the layer table](#the-five-layers): `git:<blob>` for 1 and 5, `policy:<version>:<set hash>` with the map's version for 2, `charter:<project>:<version>` for 3, `playbook:<template>@<package version>:<sha256>` for 4), `renderedBy` (`engine` or `source`), `parts` (the ids of the rules it carried), and, for the engine's half, `sha256` and `tokens` |
| the slice itself | the `handbook-slice@1.0` pointer among the brief's artifacts, role `context` |

The Worker source records, on the execution it starts, the version, sha256, and size of each part
of the source's half it rendered (an optional field of the execution record, additive). `system
explain` on a step shows both halves with their versions, sizes, and the bound's mode, beside the
run's `risk`.

## Adding, changing, and retiring a rule

| Layer | Who adds | Through | Its check | Version moves by |
|---|---|---|---|---|
| 1 | the operator | an ADR (heavy in the path map) | named in the ADR (a conformance, architecture, or crash test), or "the review; no automated check yet" | the ADR's number and status; the invariants file's blob |
| 2 | the operator; the lead proposes | a `policy-change` approval; for this repository's map, a change to `policies/system.json` (heavy) that then reaches the live set through that approval | the gate, a load-time rule, `check:tiers`, or a policy test | the policy's `version` and set hash; the map's `riskTiers.version` |
| 3 | the operator, with the lead | a charter amendment | the board where it is a budget or a check; otherwise the review | `charter.version`, by the board |
| 4 | the lead | a reviewed change to the playbook's text (template prompt, or the writing rules' home) | the test or check named in its line, or "the review; no automated check yet" | the playbook's sha256; the package version at release |
| 5 | the lead or a review | a commit of one line with `Check:` (and `Applies:` if keyed) | named in the line | the lessons file's blob at HEAD |

Every new rule, in any layer:

1. **One home.** Find the rule first (this inventory, then the layer's files). A rule that exists is
   linked or tightened in its home, never written again elsewhere.
2. **A check, or "none" said.** It names what enforces it, or says the review alone does.
3. **Where it applies.** Its role, class, tier, and paths, or none (every role).
4. **Its share.** It fits its layer's share in every slice it is selected into; if not, an old rule
   of that layer is folded or retired first (as the 30-lesson cap already asks of lessons).
5. **The version moves** as the table says; a brief built after it names the new version.

**Retiring a rule.** A rule leaves the slice when a check makes it impossible to break (a gate that
refuses, a type error, a check in `pnpm check` that fails): the Worker can no longer break it, so
reading it costs tokens for nothing. It stays in its home as documentation (layer 1 to 4) or is
dropped (layer 5, as lessons.md says), in the same change that lands the check. A rule superseded by
another is retired in the change that adds the other (an ADR supersedes; a policy change replaces).
The weekly report tells a lesson added or dropped (PROP-0016 §7).

## Review guides (REVIEW.md)

A reviewer is told what failure looks like **in the area it is reviewing**, by the people who own the
area, and only for the paths the change touches (after Anthropic's "Solving code review": guides
written by code owners say what failure looks like, cap nits, list paths to skip, require
`file:line` evidence, and ask for a summary that opens with a count). A guide is a part of **layer 4,
the reviewer's playbook**, keyed by **touched paths** (the key above): it is in the slice of a
`review` step for exactly the paths its front matter names, never in a writer's.

**The format.** One file per area, `docs/review/<area>.REVIEW.md` (the files of this repository are
listed in [its README](../review/README.md)):

```markdown
---
paths:
  - packages/plugins/workflow/
owner: lead
version: 1
---
# Review guide: the workflow engine

## What failure looks like here
## What to check first
## Paths to skip
## Nit cap
## Evidence rule
## Summary rule
```

| Part | Holds |
|---|---|
| `paths` (front matter) | the area: path patterns exactly as the autonomy policy's path map reads them (`docs/` is a directory and everything below it; `*` within a segment; `**` whole segments): a guide applies when a changed path matches one |
| `owner` | who writes and approves changes to the guide (`lead`, `operator`): a change to a guide is a change to a rule |
| `version` | a positive integer the owner raises when the guide's meaning changes; the brief records it with the guide's hash |
| What failure looks like here | what has gone wrong in this area before, written as the failure, not the rule: a hang, a leak, a guard that drifted |
| What to check first | the order a reviewer reads in: the part most likely to be wrong |
| Paths to skip | what is generated, recorded, or covered by a check, so no reviewer spends its words on it |
| Nit cap | the most style or wording findings in all; the rest are counted, and a nit is never blocking |
| Evidence rule | what a finding names (a file and a line, the input that triggers it); one without is a `nit` at most (ADR-0075) |
| Summary rule | how the summary opens: the count of findings by severity (`important`, `nit`, `pre-existing`), then one line per important finding |

Each guide is at most 6,000 characters, so a change touching several areas reads each in full; the six
sections are required, and a file that does not parse is named in the brief, never dropped in silence.

**Selection and delivery.** A review step's brief points at a `review-guides@1.0` report
([schema](../reference/schemas.md#review-guides)) that holds the guides whose `paths` match a path of
the run's change, as `ctx.workers.changes` reads it (the same read the risk tier makes), and says how
many it left out. When the change's paths are unknown, or any part of them could not be read, **every**
guide is given, never none (INV-2). The brief records each guide's file, version, and hash, so a
result traces to the rules it was reviewed by (INV-13). The step is any review of a run: the author's
self-review, the review, a re-review, and a heavy change's second review. The guides are part of that step's
[slice](#the-per-worker-slice) (T259): its layer 4 counts their text against the bound, as the step's
instructions are counted, without repeating it, and its version names each guide's area and version
(`;guides:<area>@<version>`), the text in the layer's sha256.

**Where they are read from.** The `docs/review/` directory of the repository the run's worktree was cut
from (its checked-out branch, as the landing target says), never from the worktree: a change cannot
rewrite the rules it is reviewed by. A repository with no such directory has no guides, which is no
error. Reading never follows a link and is bounded (32 files, 6,000 characters each).

**Writing and changing one.** The owner writes a guide from what reviews and salvages found, one failure
per line, with the incident when there is one; a rule a check now enforces is dropped from it, as a
lesson is. A change to a guide is reviewed as a change to a rule (the `docs` guide says so). The
documents' own path map makes `docs/` light, so a change to a guide is light until the map names
`docs/review/` (an operator's change to `policies/system.json`; recorded as a follow-up of T267).

### Scheduled review

A review of each change finds what the change introduced; a **periodic review of code already landed**
finds what those reviews missed (D93 item 8, after Anthropic's "Solving code review"). The workflow
engine runs one, **off by default**: the operator sets `workflow.scheduledReview.enabled`, a `projectId`
(where findings are proposed) and a `repository`
([configuration](../reference/configuration.md#workflow)).

- **One area a day, round robin.** The areas are the guides of the repository, read at the tip of the
  configured `ref` (default `dev`; never its working tree, as a run's guides are not): in name order,
  the UTC day number modulo their count picks the day's area, so every area comes round in turn, whatever
  the host's downtime. A day has at most one scheduled review, from `hourUtc` (default 3); the operator's
  own (`scheduledReviewNow`) is recorded beside it as a manual one.
- **The whole area, not a diff.** The files that match the guide's `paths` at that commit, each line
  numbered, with the guide's text: at most `maxFiles` (80), `maxBytes` (400,000), a file over
  `maxFileBytes` (60,000), or over `maxBytes`, named as not read. An area that does not fit is read as a
  window of consecutive files in path order around a ring, each round's window starting where the one
  before ended, whichever bound stopped it: every file is read within as many rounds as the area has
  files. The files left are named to the reviewer and counted in the row (INV-9).
- **Frontier tier, a second family verifies.** The `scheduled-review` template
  ([nodes](../reference/workflow-templates.md#scheduled-review)): `review:1` at the frontier tier reports
  `important` findings and `nit`s, as T266's classes mean them for code that has landed (it never says
  `pre-existing`: all of it has); `verify:1`, a second reviewer, reads the same code and votes with a
  reason on each important finding. Its votes count only when it is **of another provider family** than
  `review:1`, both families read from the Workers listed when the review settles: the template prefers
  another family, and when none was free (or a family cannot be read) every important finding stays
  unverified, nothing is filed, and the row says why. An unvoted, rejected, or reasonless finding is
  never filed, nor is one whose file and line were not in what the reviewers read.
- **A restart never loses a review (INV-4).** The review's run is written on its row as soon as the
  engine admits it, with the subject and the files shown. A review the host stopped while its run ran
  stays `running`; at the next start, once the board is attached (and at every pass), it is settled
  from that durable run: verified, filed, and counted as if nothing had stopped. Each task is written to
  the row as soon as the board took it, so a review settled again proposes none twice. A review the
  host stopped before its run was admitted is recorded failed, with why.
- **A confirmed finding is a proposed board task.** Its title (`Scheduled review (<area>): <finding>`),
  its goal (the place as `file:line`, the evidence, the verifier's reason, the guide it broke and the
  failure class, the commit and the review that found it) and one acceptance criterion; proposed, so the
  lead or the operator decides it. This is not the path of a pre-existing finding of a change's review
  (ADR-0075, `Pre-existing: …`): that one is found while reviewing a task; this one is found by looking.
- **A cap, and no duplicates.** At most `maxTasksPerRun` (default 5, at most 20) tasks a run; the rest of
  its confirmed findings are counted as `capped` and come round again when the area does. A finding is
  not filed while a task for it is open (not `done`, not `cancelled`): the same file and title, the same
  file within three lines (a defect re-found in other words), or any open task of the project with the
  same title, whoever filed it. Once the task is closed, a defect that still stands is filed again.
- **The report counts findings per area over time.** Every review is a row (`workflow_scheduled_reviews`):
  its area, commit, files read and left, and its counts: important, confirmed, rejected, unverified,
  nits, filed, duplicates, capped. `scheduledReviewReport()` sums them per area and lists the latest
  reviews, so a rising count of confirmed findings in an area, or a count of rejected ones that rises
  with no confirmed one, tells the owner whether the guide, the code, or the reviewer needs work. A run
  that did not finish (it failed, timed out, or answered with no readable assessment) is a row too,
  counted as unfinished, with why.

### The author verifies before review (W19)

The validation step of `algorithm-development` measured a median of 0.4 minutes and caught nothing the
acceptance checks did not. It is replaced by two things that run before the independent review:

1. **The author runs the required checks; the System records them itself (T284).** `develop:1` ends
   with the System holding, for every command its Worker ran, the command, its exit code, and a
   bounded tail of its output, as the runtime reports them (Codex reports exit codes; for Claude
   Code the tool result's error flag is the failure, and an `Exit code N` its error text names is
   read). The Worker pastes nothing: a required check counts as shown when a recorded command for it
   ran to its end in the step (`tests`, `typecheck`, `lint`), whatever the Worker wrote. A command
   the runtime reported no end of (a background launch, which answers once it starts; an
   interrupted command) is recorded with no exit code and shows no check. The records are bounded
   per step, and the bound never drops the last record that shows a check. The System writes them to
   the dossier as its own `evidence` entries, every check command first with its exit code and output
   tail, split into as many entries as the entry's bound needs, so a reviewer reads real exit codes. The Worker's own `evidence` entry is optional prose, still read
   (its shape: a command, each check named with its output or why it could not run, an output line)
   for a check no recorded command runs, such as one the Worker could not run and says why. A refusal
   (`evidence_missing`; a `workflow.evidence` `gate` decision says what is missing) does not end the
   step the first time: **the step continues its own session once**, the refusal's message (what is
   missing and how to show it) its next message. Only a second refusal fails the step, and the attempt
   is reported as "evidence refused twice" (T274, 2026-10-26: refusing at once spent the attempt of
   every honest Worker, whose shell tool prints no exit codes). The step requires the `dossier`
   capability, so a Worker that could not write the entry is never admitted to it. Every fix grown
   from it shows the checks again, for the tree it leaves, under the same gate. The gate reads what
   ran, never whether it passed, so the run's required checks run again on the exact result at
   acceptance (ADR-0063).
2. **A fresh session of the author's account reviews the diff** (`selfreview:1`): it never sees the
   author's transcript, and is given only the task's goal and criteria, the exact diff (the goal as its
   requested change), and the review guides within a reviewer's handbook slice (T259): no dossier (no
   dossier slice, no file, `dossier_read` refused, and none left in the shared worktree: a run's
   `.system/` holds only its own brief's files when its agent starts), no
   earlier results or decisions, and not the caller's input. Its important findings are verified as a
   review's are (ADR-0075), and the confirmed ones grow a fix that continues the author's session, answered and re-reviewed before the independent review starts,
   with no approval gate (the author answering its own review). It counts for no tier, provider
   family, or acceptance. When the author's account cannot take it now (busy, resting, or not back
   yet after a restart), it waits for that account, bounded by `fixSessionWaitMinutes`, recorded as a
   `workflow.self-review-wait` decision and spending no attempt; only past the bound does it fail.

## Measures (I1)

| Metric | From |
|---|---|
| slice size per run, per layer | the `handbook` field of each brief and the execution's source half |
| rules without a check | this inventory's **none** rows, counted again from the layers' homes once rules carry ids (58 today, after the bound's check, T259; 59 after the lead's playbook and the review guides; 45 before them) |
| reads fetched per run | the run's recorded `read` gate decisions on a handbook home (invariants, ADRs, lessons, AGENTS.md, the engineering docs): whether Workers read what the slice left out, or read too much |
| overflows | `handbook.bound` decisions, by layer, in warn and refuse mode |

## Later parts of I1

1. **Part 2, the engine's half:** the slice composer, `handbook-slice@1.0`, `brief@1.6` `handbook`,
   the bound in warn mode then refuse, the source's record of its half, the reviewer's lessons (X3),
   `explain` and `/ui` showing them: **implemented** (T259). Still to come from it: rule ids and
   `Applies` keys in the homes themselves (the keys are declared in code until then).
2. **Part 3, the lead's file** (`system handbook --role lead`) and `explain`'s view.
3. **Part 4, the docs that follow:** the duplicates turned into links and contradictions X1, X2, X6,
   and X7 resolved in their homes.
