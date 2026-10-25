# Efficient System: research and brainstorm inputs (2026-10-25)

Non-normative. The raw outputs of System's own research, brainstorm and audit runs of 2026-10-25, which
[PROP-0015](../proposals/README.md) condenses; kept here as evidence. Each section is one run's answer as it was returned.

## Operator guidance on Jev

Operator guidance on Jev (2026-10-25, to be designed in PROP-0015):
- Besides which Worker and which tier, Jev also answers which model to use, preferring one whose account has much quota left.
- Jev's strength: it answers several questions in ONE query, each as a probability distribution. Design ONE Jev call per
  decision point that asks, together: P(accepted | worker), P(accepted | tier), P(hits a limit mid-task | account), the model
  with the most usable quota, the expected cost in quota per window, and P(needs the operator) — and record the whole
  distribution as the decision's input (INV-13), so a later outcome scores every probability (calibration), not just the winner.
- Hard gates (quota reserve, kinds, policy, budgets, the operator's exclusions) are applied BEFORE and AFTER Jev's advice;
  Jev never widens what is allowed.

## T177 research: quota, capabilities, operator, similar systems, handoffs

run_decdba4b2873ef06: frame:1 RUNNING, literature:1 WAITING, literature:2 WAITING, evidence:1 WAITING, critique:1 WAITING, conclusion:1 WAITING
run_decdba4b2873ef06: frame:1 COMPLETED, literature:1 RUNNING, literature:2 RUNNING, evidence:1 WAITING, critique:1 WAITING, conclusion:1 WAITING
run_decdba4b2873ef06: frame:1 COMPLETED, literature:1 COMPLETED, literature:2 RUNNING, evidence:1 WAITING, critique:1 WAITING, conclusion:1 WAITING
run_decdba4b2873ef06: frame:1 COMPLETED, literature:1 COMPLETED, literature:2 COMPLETED, evidence:1 RUNNING, critique:1 WAITING, conclusion:1 WAITING
run_decdba4b2873ef06: frame:1 COMPLETED, literature:1 COMPLETED, literature:2 COMPLETED, evidence:1 COMPLETED, critique:1 RUNNING, conclusion:1 WAITING
run_decdba4b2873ef06: frame:1 COMPLETED, literature:1 COMPLETED, literature:2 COMPLETED, evidence:1 COMPLETED, critique:1 COMPLETED, conclusion:1 RUNNING
### T177 — Final evidence-based conclusions

Overall finding: The literature supports strengthening System's safety, reliability, and operator oversight before introducing sophisticated adaptive scheduling or routing. The clearest evidence concerns established engineering mechanisms, not measured performance improvements in System itself.

The conclusions below evaluate each hypothesis as a whole. A hypothesis can have well-supported components while its promised improvement over simpler alternatives remains unproven. Evidence identifiers refer to the supplied E1–E60 table. Ratings reflect the strength of the evidence for System, not simply the authority of the cited source.

#### 1. Hypothesis verdicts

| Hypothesis                           | Conclusion                                                                                      | Confidence |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------- |
| H1 — Quota-aware scheduling          | Insufficient for claimed throughput improvement; established architectural precedents           | Moderate   |
| H2 — Capability-based routing        | Insufficient for learned-routing superiority; supports capability constraints                   | Moderate   |
| H3 — Human oversight                 | Insufficient for complete interface proposal; supports structured inboxes and actionable alerts | Moderate   |
| H4 — Reusable orchestration patterns | Supports core architectural patterns; incremental benefit remains untested                      | High       |
| H5 — Artifact-based handoffs         | Supports integrity and provenance mechanisms; insufficient for fresh-context review superiority | Moderate   |

##### H1 — Quota-aware scheduling

Conclusion: Insufficient evidence. Confidence: moderate.

Kubernetes demonstrates filtering, scoring, and resource reservation; Slurm demonstrates multifactor scheduling; LiteLLM demonstrates cooldowns and fallback behavior. These support the feasibility of System's proposed admission and recovery mechanisms [E1][E2][E3][E4][E5]. AWS provides a further precedent for backoff with jitter [E6].

However, these mechanisms were developed for infrastructure scheduling or API routing, not black-box subscription accounts. The uncertainty-aware inference scheduler provides evidence that cost uncertainty matters, but not that it improves multi-step coding-agent assignment [E7].

Both reviews agree that account-aware admission and cooldowns are valuable. They disagree over the 80% policy: A recommends testing multiple reserves and warns of wasted capacity [E10], whereas B recommends a hard 80% threshold without supporting experimental evidence [E11]. B's task-cost multipliers are also unsupported by identifiable measurements [E9].

Decision: Introduce account-specific eligibility, atomic leases, quota-state confidence, bounded cooldowns, and conservative recovery. Treat P95 estimation, fairness weights, and 80% gating as experimental scheduling policies.

Evidence that would change the conclusion: Replay identical timestamped System workloads under first-available, highest-headroom, earliest-reset, and reserve-aware scheduling. Measure independently accepted completions, quota-limit interruptions, idle usable capacity, tail latency, and project fairness. A reproducible improvement would support H1; equivalent or better simple baselines would refute its added complexity.

##### H2 — Capability-based routing

Conclusion: Insufficient evidence. Confidence: moderate.

CrewAI and LangGraph provide precedents for explicit roles and workflow organization [E12][E13]. FrugalGPT and RouteLLM provide experimental evidence that selecting between heterogeneous models can improve quality-cost tradeoffs on their evaluated workloads [E14][E17].

But those results do not establish that a learned router will increase accepted coding output across System's subscription Workers. The SWE-Bench audit demonstrates that apparent coding success can depend heavily on evaluation quality [E18]. LLM reviewer errors and unreliable benchmark labels further weaken any approach trained on uncorroborated outcomes [E21][E22].

Both reviews agree on capability manifests and independent quality measurement. A advocates delaying adaptive optimization until reliable labels exist; B proposes constrained bandit exploration earlier. Their FrugalGPT savings figures differ—98% versus 70%—and neither number should be treated as a predicted saving for System [E15][E16].

Decision: Use hard capability and independence filters now. Collect task-specific quality records from accepted artifacts, independently validated tests, defect findings, and revisions. Keep learned routing in shadow mode until evidence demonstrates a benefit.

Evidence that would change the conclusion: Run fixed-role, quota-only, empirical-quality, and constrained-adaptive routing on comparable pinned tasks. Stratify by project and task kind, preserve independent validation, and report uncertainty intervals. Stable gains in accepted work per quota unit would support H2; unstable rankings or noisy labels would refute it.

##### H3 — Human oversight

Conclusion: Insufficient evidence. Confidence: moderate.

GitHub implements contextual code review and filtered notifications [E25][E26][E28]. Google SRE provides operational guidance favoring actionable alerts over noise [E29]. Observational HCI research shows that notification disruption depends on context [E23].

These findings justify trying an evidence-linked decision inbox and selective notifications. They do not prove that those designs will reduce System's decision time or errors. One observational study found no evidence that batching email reduced stress [E24]. Neither review establishes a measured safety benefit for conversational approvals [E32].

Both reviews agree on actionable approvals and exception escalation. They differ in their third recommendation: A prioritizes cautious conversational/mobile triage; B prioritizes fail-closed explicit confirmation for consequential operations, drawing on least-privilege security principles [E31].

Decision: Implement a prioritized decision inbox and actionable notification policy first. Preserve individual approval gates tied to exact artifact versions. Offer conversational querying initially as read-only; require typed operations, previews, and explicit confirmation for consequential changes.

Evidence that would change the conclusion: Conduct counterbalanced operator task simulations with seeded urgent events and misleading summaries. Compare the current console with the proposed interface using decision time, missed alerts, mistaken approvals, interruption counts, and evidence-inspection time. Improvements must not come at the expense of authorization accuracy.

##### H4 — Reusable orchestration patterns

Conclusion: Supports core architectural patterns. Confidence: high.

Temporal documents durable workflow histories and replay [E33]. Its activity semantics also demonstrate why external effects still require idempotency and recovery safeguards [E34]. LangGraph documents interruption checkpoints [E36]. OpenHands provides execution-isolation examples [E42], while Vibe Kanban and GitHub Copilot coding agent demonstrate task-centric, reviewable coding workflows [E37][E45].

These sources offer concrete architectural precedents. SWE-agent additionally provides experimental evidence that agent-computer interface design affects coding performance [E40].

Both reviews agree on isolation, durable transitions, and separation of execution from review and merge authorization. Their important disagreement concerns reliability guarantees: B describes Temporal as eliminating state corruption [E35], while A correctly limits the claim because external actions may execute more than once [E34]. A also notes Vibe Kanban's announced sunsetting [E39], making it more useful as a design reference than a new dependency.

Decision: Strengthen System's existing orchestration engine rather than replace it. Prioritize crash-safe transitions, durable decisions, idempotency keys, fencing, worktree provenance, isolation checks, and independent merge authorization.

Evidence that would change the conclusion: Inject crashes before and after every consequential transition, including reservation, Worker execution, review, cancellation, and merge. Demonstrate that a simpler existing implementation already preserves all required invariants, or find that adopting a larger framework creates more operational failure modes than it removes.

##### H5 — Artifact-based handoffs

Conclusion: Supports integrity and provenance mechanisms; insufficient evidence for the complete review strategy. Confidence: moderate.

SLSA and in-toto provide established provenance and verification principles [E47][E48][E52]. GitHub Actions demonstrates immutable workflow artifact storage and content-integrity checking [E50][E51]. These are useful foundations for System's Worker-to-Worker handoffs, although they do not independently establish the effectiveness of AI-specific contracts.

Google's Elephant-Goldfish Model separates a deep-context author from fresh-context reviewers with distinct critical perspectives [E53][E54]. This is a documented methodology, not a demonstrated performance advantage. EGM also retains human accountability [E59].

Both reviews agree that producer context should not automatically become the reviewer's trusted context. Their disagreement concerns how broadly to adopt fresh-context review: A recommends selective trials and notes the absence of comparative evidence [E55][E56], whereas B asserts a 30–50% defect-detection effect without an identifiable supporting study [E57]. That numerical claim should be excluded from design justification. False-positive AI review findings are an additional concern [E21].

Decision: Enforce verifiable artifact manifests and typed handoff contracts at consumption boundaries. Use EGM-inspired fresh-context reviews selectively, giving reviewers the specification, relevant source revision, and evidence without the producer's conversational rationale. Never make an AI review result automatic merge authorization.

Evidence that would change the conclusion: First prove that corrupted, stale, unauthorized, or mismatched artifacts cannot cross handoff boundaries. Then compare shared-context reviews, fresh-context reviews, and fresh-context reviews with independent tests using blinded defect adjudication. Measure severity-weighted recall, precision, false positives, and quota cost.

#### 2. The three most valuable ideas for each research question

These rankings prioritize expected benefit, implementation effort, operational risk, and applicability to System. They are engineering recommendations, not experimentally proven rankings.

##### Q1 — Quota-aware work assignment

| Rank | Idea                                                                                                                                                                                                                                                | Benefit / Effort / Risk               | Evidence           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------ |
| 1    | Account-aware admission and atomic leases. Filter by verified identity, role, account state, both rolling windows, active reservations, and quota confidence before scoring candidates. Unknown quota must not mean unlimited quota.                | Very high / Medium / Medium           | [E1][E2][E4][E5]   |
| 2    | Account-scoped cooldown and retry recovery. Record rate limits at the actual entitlement boundary; use bounded backoff and jitter. Switching accounts requires a new eligible, audited attempt.                                                     | High / Low–medium / Low               | [E4][E6]           |
| 3    | Empirical cost prediction and fairness experiments. Collect task-kind and workflow-stage cost distributions, compare conservative estimates and reserves, and incorporate project priority and queue aging. Do not enforce an untested 80% ceiling. | Potentially high / High / Medium–high | [E3][E7][E10][E11] |

Measurement: Independently accepted completions per day, quota-limit interruptions per 100 attempts, idle capacity, P95 completion latency, and project fairness.

Sources: [Kubernetes scheduling](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/), [Slurm multifactor priority](https://slurm.schedmd.com/priority_multifactor.html), [LiteLLM routing](https://docs.litellm.ai/docs/routing), [AWS backoff and jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).

##### Q2 — Right Worker for the right job

| Rank | Idea                                                                                                                                                                                                                     | Benefit / Effort / Risk        | Evidence             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | -------------------- |
| 1    | Provider-neutral capability and eligibility registry. Define requirements for coding, research, reviewing, testing, tools, execution isolation, and independent role eligibility. Hard constraints precede optimization. | Very high / Low–medium / Low   | [E1][E12][E13]       |
| 2    | Independent quality ledger. Record results by task kind, role, Worker, and project, using verified tests, independently adjudicated findings, final acceptance, and revisions rather than self-assessment.               | Very high / Medium / Medium    | [E18][E19][E21][E22] |
| 3    | Shadow-tested adaptive routing. Compare task-specific success estimates and constrained quality-cost selection against static and quota-only dispatch. Introduce limited exploration only after labels are trustworthy.  | Conditional high / High / High | [E14][E17][E22]      |

Measurement: Accepted completions per unit of native quota, escaped defects, revision rate, queue delay, and calibration of predicted success, stratified by task type and project.

Sources: [CrewAI](https://docs.crewai.com/), [FrugalGPT](https://arxiv.org/abs/2305.05176), [RouteLLM](https://proceedings.iclr.cc/paper_files/paper/2025/hash/5503a7c69d48a2f86fc00b3dc09de686-Abstract-Conference.html), [Revisiting SWE-Bench](https://ieeexplore.ieee.org/abstract/document/11024333).

##### Q3 — Efficient communication with one operator

| Rank | Idea                                                                                                                                                                                                                       | Benefit / Effort / Risk                 | Evidence             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------- |
| 1    | Evidence-first decision inbox. Prioritize approvals and blockers. Show project, exact proposed action, artifact revision, validation status, risk, consequences, and a direct decision control.                            | Very high / Medium / Low–medium         | [E25][E26]           |
| 2    | Exception-based notifications and digests. Alert immediately on actionable failures and urgent approvals; retain routine activity in the console or digests. Escalate missing heartbeats and unresolved critical blockers. | High / Low–medium / Medium              | [E23][E24][E28][E29] |
| 3    | Fail-closed command and approval interface. Support read-only natural-language queries and mobile inspection first. Require scoped, typed, explicitly confirmed operations for changes; retain exact audit records.        | Conditional high / Medium / Medium–high | [E30][E31][E32][E36] |

Measurement: Median approval latency, mistaken approvals, missed urgent events, interruptions per day, and proportion of decisions made with complete supporting evidence.

Sources: [GitHub review workflow](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests), [GitHub notifications](https://docs.github.com/en/notifications), [Google SRE monitoring](https://sre.google/sre-book/monitoring-distributed-systems/), [CHI notification study](https://doi.org/10.1145/2858036.2858566).

##### Q4 — Architecture lessons from comparable systems

| Rank | Idea                                                                                                                                                                                                                                           | Benefit / Effort / Risk                       | Evidence             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------- |
| 1    | Durable, idempotent workflow transitions. Add fencing, stable decision identities, precondition checks, crash recovery, and reconciliation of uncertain external side effects.                                                                 | Very high / Medium–high / Medium              | [E33][E34][E36]      |
| 2    | Isolated execution with reproducible manifests. Retain per-attempt worktrees; capture base and result commits, execution environment, commands, test receipts, and output hashes. Separate Git isolation from process and credential security. | Very high / Low–medium incrementally / Medium | [E37][E40][E42]      |
| 3    | Task-centric control plane with independent merge gate. Keep operator intent, Worker execution, independent verification, final approval, and integration as separately authorized lifecycle states.                                           | High / Low–medium / Low                       | [E26][E37][E45][E46] |

Measurement: Duplicate authoritative decisions, unauthorized transitions, cross-attempt interference, lost artifacts, recoverable crash scenarios, and successful reproduction of completed attempts.

Sources: [Temporal workflows](https://docs.temporal.io/workflows), [Temporal activity semantics](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/activities/activity-definition.mdx), [OpenHands](https://github.com/All-Hands-AI/OpenHands), [SWE-agent paper](https://papers.nips.cc/paper/2024/hash/5a7c947568c1b1328ccc5230172e1e7c-Abstract-Conference.html), [Vibe Kanban](https://github.com/BloopAI/vibe-kanban).

The Vibe Kanban sunsetting notice [E39] is a dependency risk, not evidence that its architectural ideas are invalid. No reviewed evidence justifies replacing System's current workflow engine wholesale.

##### Q5 — Trustworthy Worker-to-Worker handoffs

| Rank | Idea                                                                                                                                                                                                                                                           | Benefit / Effort / Risk                    | Evidence                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------ |
| 1    | Content-bound provenance enforcement. Verify artifact digests, schema version, producer identity, task/run/attempt identifiers, source revision, dependencies, and authorized verification status at every consumption boundary.                               | Very high / Low–medium incrementally / Low | [E47][E48][E50][E52]           |
| 2    | Typed producer-consumer contracts. Specify requested work, acceptance criteria, evidence, unresolved limitations, and allowed downstream actions. Consumers must reject invalid, stale, or unverified inputs.                                                  | Very high / Medium / Low–medium            | [E49][E51][E60]                |
| 3    | Selective EGM-inspired independent verification. Give a fresh reviewer the specification, exact source revision, and relevant evidence without the producer's conversational history. Compare its results against shared-context review before wider adoption. | Conditional high / Medium–high / Medium    | [E21][E53][E54][E55][E56][E59] |

Measurement: Invalid handoffs accepted (target zero), provenance mismatches detected, defect-detection precision and recall, false-positive review rate, and incremental quota use.

Sources: [SLSA verification](https://slsa.dev/spec/v1.1/verifying-artifacts), [in-toto](https://in-toto.io/), [GitHub Actions artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data), [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model).

EGM's central lesson is separation of informed creation and independent criticism. The Elephant uses deep system context to produce a specification; Goldfish reviewers inspect the specification and code from fresh perspectives. The human retains final responsibility [E53][E54][E59]. Its documentation does not establish a numerical defect-detection improvement [E56][E57].

#### 3. Prioritized implementation decision

| Priority | Action                                                                                                   | Hypotheses | Acceptance evidence                                                  |
| -------- | -------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| P0       | Verify artifact lineage, hashes, schema, producer authorization, and contract integrity at every handoff | H5, H4     | All seeded invalid handoffs rejected                                 |
| P0       | Test durable decisions, lease fencing, idempotent retries, cancellations, and crash recovery             | H4, H1     | Zero duplicate authoritative decisions or unauthorized transitions   |
| P0       | Enforce capability, identity, and independent-role eligibility                                           | H2, H1     | No ineligible Worker or prohibited self-validation selected          |
| P1       | Add account-aware admission and bounded cooldowns                                                        | H1         | Demonstrated safety and throughput against first-available baseline  |
| P1       | Build the evidence-linked operator inbox                                                                 | H3         | Faster informed decisions without higher approval error rates        |
| P1       | Collect independent Worker quality outcomes                                                              | H2         | Traceable labels, sufficient sample coverage, calibrated uncertainty |
| P2       | Experiment with dynamic quota reserves and adaptive routing                                              | H1, H2     | Measurable gains against simple policies                             |
| P2       | Test fresh-context review, conversational commands, and mobile triage                                    | H5, H3     | Demonstrated incremental benefit without reduced safety              |

#### 4. Final synthesis

Three highest-value investments across the entire study:

1. Verifiable handoff contracts and provenance: Make every downstream Worker consume exactly the authorized, content-bound evidence intended for its role. This has the clearest standards-based foundation [E47][E48][E50][E52].
2. Crash-safe, quota-aware execution: Combine account-level admission with durable transitions, leases, fencing, and conservative recovery. Established schedulers and workflow systems provide design precedents, but performance must be tested on System's own workload [E1][E4][E33][E34].
3. Evidence-first operator oversight: Present consequential decisions and independent validation evidence in a prioritized inbox, with actionable escalation and explicit authorization [E23][E26][E29][E31].

The two reviews converge strongly on these foundations. Their main disagreements concern the timing and confidence of optional optimizations: hard 80% quota ceilings, bandit routing, conversational approval interfaces, and universal fresh-context review. The critique correctly lowers confidence in those proposals because their cited evidence either comes from a different operating environment or does not demonstrate the claimed effect.

Final research conclusion: H4 is supported as an architectural design hypothesis. H1, H2, and H3 remain insufficiently supported as comparative performance hypotheses. H5 is supported for artifact integrity and provenance, but remains insufficiently supported for the claimed incremental effectiveness of context-isolated review. None of the five is conclusively refuted in its entirety.

System should therefore make correctness measurable first, then optimize throughput and operator effort. This sequencing preserves its fail-closed invariants while producing the trustworthy operational data needed to decide whether more sophisticated routing, scheduling, and review mechanisms actually outperform simpler alternatives.
session: ses_029e3381fed5232c

## T178 brainstorm (team): the five fronts

run_d1717f4795e2ba8a: brainstorm:m1:propose RUNNING, brainstorm:m2:propose RUNNING, brainstorm:m1:ballot:1 WAITING, brainstorm:m2:ballot:1 WAITING, brainstorm:tally:1 WAITING, brainstorm WAITING
run_d1717f4795e2ba8a: brainstorm:m1:propose COMPLETED, brainstorm:m2:propose COMPLETED, brainstorm:m1:ballot:1 RUNNING, brainstorm:m2:ballot:1 RUNNING, brainstorm:tally:1 WAITING, brainstorm WAITING
run_d1717f4795e2ba8a: brainstorm:m1:propose COMPLETED, brainstorm:m2:propose COMPLETED, brainstorm:m1:ballot:1 COMPLETED, brainstorm:m2:ballot:1 RUNNING, brainstorm:tally:1 WAITING, brainstorm WAITING
outcome: O1; method: team-majority; winner: O1; decision: sha256:0b377a0d35ac6883ef3a455a3f8f2090a661b9ba1e284aec5c0f200818420d2f

#### Decision: O1 (m1's proposal)

Build System as a quota-aware, capability-aware, artifact-driven organization. Phase 1: introduce versioned Worker capability contracts, typed handoff artifacts with hashes and provenance, per-window quota feasibility checks, and atomic quota reservations. Phase 2: add first-class policy-gated Worker delegation, a unified operator decision inbox, quota pressure modes, and cross-project visibility. Phase 3: collect task-class performance scorecards, calibrate routing predictions, and compare new dispatch policies against a pinned baseline before enabling adaptive routing. Use hard eligibility gates before scoring. Preserve independent review, explicit merge approval, fail-closed behavior, provider-neutral routing, and recorded decisions. Optimize accepted outcomes per scarce resource and operator intervention, not raw utilization.

#### Votes (round 1 of 1)

- m1: O1 (confidence high). O1 provides the stronger architectural foundation and implementation sequence. It treats quota management, Worker specialization, delegation, operator interaction, and evidence-based adaptation as interconnected problems. Its hard eligibility gates, per-window feasibility estimates, atomic reservations, typed artifacts, and phased rollout preserve System's fail-closed and provider-neutral invariants. O2 offers useful operational simplifications, especially quota tiers and constrained operator prompts, but its rigid provider-role assignments and single-model elephant create unnecessary coupling and potential bottlenecks. O1 also explicitly distinguishes measured capability from declared capability and requires evaluation before adaptive routing. Adopt O1 as the foundation while incorporating O2's best interface and scheduling ideas.
- m2: O1 (confidence high). O1 provides an exceptionally rigorous, phased operational roadmap with hard eligibility gates, atomic reservations, and a baseline-calibrated adaptive routing approach. While O2 sets concrete operational thresholds and introduces the effective 'goldfish/elephant' memory topology, O1's emphasis on fail-closed behavior, governance against recursive delegation loops, and explicitly optimizing for accepted outcomes per scarce resource makes it a more robust foundation for System.

#### Options

- O1 (m1): Build System as a quota-aware, capability-aware, artifact-driven organization. Phase 1: introduce versioned Worker capability contracts, typed handoff artifacts with hashes and provenance, per-window quota feasibility checks, and atomic quota reservations. Phase 2: add first-class policy-gated Worker delegation, a unified operator decision inbox, quota pressure modes, and cross-project visibility. Phase 3: collect task-class performance scorecards, calibrate routing predictions, and compare new dispatch policies against a pinned baseline before enabling adaptive routing. Use hard eligibility gates before scoring. Preserve independent review, explicit merge approval, fail-closed behavior, provider-neutral routing, and recorded decisions. Optimize accepted outcomes per scarce resource and operator intervention, not raw utilization.
- O2 (m2): 1. Dispatcher Quota Tiers: Enforce strict quota bands (<65% Normal, 65-80% Light-only, >80% Drain/Park) with pre-allocated sliding-window consumption locks to eliminate mid-task rate limit failures. 2. Role Specialization via Schema Contracts: Restrict Claude Code strictly to implementation in clean git worktrees; bind Codex/Antigravity to test and validation diffs; route web agents exclusively to generate structured markdown research dossiers. 3. Operator Ergonomics: Implement single-click digest reviews and constrained A/B/Default structured prompts to minimize CEO interruptions to critical architectural decisions. 4. Goldfish/Elephant Memory Topology: Run tactical coding and review workers as stateless 'goldfish' operating solely on typed JSON/diff artifacts with cryptographic checksums, while maintaining a long-context metered Gemini model as the 'elephant' maintaining the system-wide architecture and decision ledger.

## T179 audit (Codex): what System does today

run_471ed53a25124e66: review:1 RUNNING
{
  "verdict": "approve",
  "findings": [
    {
      "severity": "info",
      "title": "1. Quota-aware assignment: dispatch uses headroom; ordinary routing and capacity use different rules",
      "detail": "| Area | System TODAY: evidence and documentation | Missing / gap |\n|---|---|---|\n| Ordinary routing | `packages/plugins/workers/src/index.ts:506` orders admitted Workers by lowest tier, quota-class preference (`budget.preferQuota`, then configured preference), total running/queued/pending load, priority, then id. Admission respects capability cooldowns, exhausted state, and assigned-account holds. Docs: `docs/design/routing.md`, Algorithm and Assigned accounts. | No percentage-of-window ordering or 80% cutoff in ordinary routes. A lead/operator start can use an account above 80% while its pool remains available. |\n| Dispatch pass | `packages/plugins/workflow/src/dispatch.ts:643` selects the first develop step, otherwise first Worker step; `:668` combines routing admission, account pools, load, running steps, account/repository bounds, and `quotaScoreOf`. `:536` honours forbid; `:541` starts nothing for auto/notify in D1 unless the board approval supplies authorization. ADR-0064, Decision §§1–9, defines bounded, approval-bound dispatch; PROP-0014, Increments, leaves broader automation and every-route quota ordering to later increments. | This is dispatch admission for a selected step, not quota-aware routing throughout the run. Later steps retain ordinary routing. PROP-0014's D1 table says auto/notify become ask, but current code and accepted ADR-0064 say they dispatch nothing: the proposal wording is stale. |\n| Quota score and 80% boundary | `packages/libs/src/quota.ts:40` defaults reserve to 20%; `:150` checks reading freshness/state and computes `100 − used − reserve`; `:176` requires every pool available and every window known with positive headroom. `:275` ranks by tier, metered flag, quota class, knowledge, near reset, headroom buckets, load, priority, id; `:321` chooses the first free candidate. Docs: routing, Candidates without a reservation; ADR-0064, Decision §§5–6. `packages/libs/tests/quota.spec.ts:95` explicitly checks 79% eligible and 80% ineligible. | Yes: dispatch rejects a new start at approximately 80% with default settings. It does not stop an in-flight run at that boundary or estimate whether the task fits remaining quota. Even a small positive headroom can qualify; there is no task-cost forecast or quota-based task splitting. |\n| Capacity summary and duplicated calculation | `packages/gateway-core/src/capacity.ts:129` independently computes remaining share as `max(0, 100 − used)`, selecting the least remaining among windows with known usage and a future reset. `:146` computes urgency as remaining share/minutes to reset; `:149` orders free Workers by urgency. `:164` projects capacity; `:244` forecasts a ready task's likely Worker using the first Worker step. Docs: `docs/design/roster.md`, Capacity now. `packages/gateway-core/tests/capacity.spec.ts:40` deliberately includes an 85%-used account as free. | The duplication is `capacity.ts`'s `quotaOf`/`orderFree` versus `libs/src/quota.ts`'s `windowOf`/`accountQuotaOf`/`keysOf`. They independently interpret windows, select a binding window, calculate remaining quota, and rank Workers, with different semantics. Capacity has no dispatch reserve or reading-age threshold and can use one current window while dispatch requires every window known. Capacity is advisory, not admission, and its likely Worker need not match dispatch. The quota row in `packages/libs/README.md` claims capacity reads `accountQuotaOf`; the actual capacity implementation does not import it. Reconcile that documentation and make the two meanings explicit before presenting them as one calculation. |"
    },
    {
      "severity": "info",
      "title": "2. Capabilities and kinds are configured/proven eligibility, without per-Worker quality learning",
      "detail": "| Area | System TODAY: evidence and documentation | Missing / gap |\n|---|---|---|\n| Work kinds | ADR-0057, Decision and its validation amendment, makes kinds opaque equality labels. A Worker listing kinds accepts only a matching named kind; an unrestricted Worker accepts any kind. `packages/plugins/agent-workers/src/roles.ts:172` validates kinds and refuses kinds on review-member roles; `:198` derives configured Workers. Docs: `docs/design/routing.md`, Work kinds. | Kinds are neither quality ratings nor preferences. They do not prove a capability or adapt after results. A kind-restricted Worker cannot take an unkinded step. |\n| Roles and assignments | `packages/plugins/agent-workers/src/roles.ts:53` defines role settings; `:73` assigns enrolled accounts to roles; `:198` derives `agent:<accountId>/<role>` Workers. Runtime-specific settings remain in configuration. Docs: `docs/design/agent-runtimes.md`, Workers = account × role; `packages/plugins/agent-workers/README.md`, configuration. | A role is a configured operating profile, not an observed specialty or learned record of suitability. |\n| Review versus validation | `packages/plugins/agent-workers/src/index.ts:740` grants local-data; workspace-write grants develop and, with execution evidence, validate; read-only grants review. Review members additionally receive scoped reason and, when necessary, scoped conversation replay. `packages/plugins/profile-software-development/src/index.ts:30` defaults validation to kind `validation`; its algorithm-development template routes writing, independent review, then validation. ADR-0057, Amendment; routing, Capability vocabulary and Scoped offers. | Validation's instruction to change nothing is narrower than its capability's required workspace-write sandbox. Review is independently read-only. Giving a Worker the tests writing kind does not automatically give it validation work. |\n| Provider capability descriptors | `packages/plugins/turns/src/index.ts:794` combines driver-conformance offers and account-probed features. `packages/plugins/models/src/workers.ts:215` offers reason when available and conversation by replay. Agent offers come from runtime/sandbox evidence above. `schemas/capability-descriptor.v1.json:8` contains tier, kinds, capability evidence, state, account, load, bounds, and display fields. Docs: routing, Capability vocabulary. | These describe what is proven now, not acceptance rate or output quality. No per-Worker acceptance-rate-per-kind field or routing key exists in these contracts/selection paths. |\n| Feedback from results | Ordinary routing's complete keys are at `packages/plugins/workers/src/index.ts:518`; dispatch's are at `packages/libs/src/quota.ts:275`. Neither reads historical quality. Acceptance, tier escalation, remediation, and later-attempt briefs do use an individual result. `docs/proposals/roadmap.md:51` records feedback-loop foundations; `:54` and `:56` mark the evaluation runner and controller/promotion as not started. Docs: routing, Intelligence tiers; workflow engine, Graph growth and A board task's brief. | There is local correction and reuse of evidence, but no implemented cross-task learning loop that changes Worker selection from acceptance by kind. A quality record would need defined attribution, denominators and outcome semantics, durable aggregation, and an explicitly recorded selection rule; the existing experiment/statistics foundations do not supply that runtime behavior. |"
    },
    {
      "severity": "info",
      "title": "3. Operator communication: durable decision channels exist, but questions and notifications are separate surfaces",
      "detail": "| Channel | System TODAY: evidence and documentation | Operator-only purpose / gap |\n|---|---|---|\n| Approval queue | `packages/plugins/approvals/src/index.ts:423` applies verdicts; `:462` writes operator approval on the exact requested subject. `packages/plugins/approvals/README.md` documents batching, expiry, withdrawal, and operator-scoped approvals_decide/policy proposals. Docs: `docs/design/approvals.md`, The autonomy policy and Request state machine. | This is for authority only the operator can grant: actions policy marks ask, policy changes, merges, funding, and relevant gates. Failed required checks return work to the lead; missing operator checks may hold a review. The queue is not a general question-and-answer inbox. |\n| Home and review UI | `packages/plugins/web-ui/README.md:5` describes Home, dispatch proposals, activity and capacity; `:44` the queue; `:71` operator reviews. `packages/plugins/web-ui/src/index.ts:741` counts requests, operator-held reviews, blocked runs and relevant standalone failures. Docs: `docs/reference/web-ui.md`, Approval queue and Dispatch. | Approve/deny, accept/reject, plan approval, tie vote, stop/continue and project controls are available. Home's waiting count is not a count of every board question: its implementation does not separately enumerate waiting-for-input question tasks. The Board remains necessary for those waits. |\n| Board questions | `packages/plugins/workflow/src/tasks.ts:1132` recognizes a whole-answer questions object, records a decision and ends the attempt; `:1186` blocks its task. `packages/plugins/board/src/index.ts:679` moves it to `waiting-for-input`; `:774` requires every question answered before gating another attempt. `packages/plugins/board/src/tools.ts:89` exposes answers through board_update. Docs: `docs/design/board.md`, input waits; workflow engine, A question from a run. | Intended for information only the lead or operator can supply. It is not operator-exclusive: the lead can answer. There is no semantic classifier proving that a question truly needs a person rather than another Worker. Answers become durable evidence in the next brief; they do not resume the same attempt in place. |\n| Out-of-band notifications | `packages/plugins/notify/src/notices.ts:12` lists approval opened/expiring, user-action failure, escalation, quota wait, pool limit, quarantine and review expiry. `packages/plugins/notify/src/sinks.ts:1` implements desktop notices and an egress-checked webhook. `packages/system-bundle/cordis.patch.yml:162` disables notify by default. Docs: `docs/design/notifications.md`, Sinks; notify README. | Notices direct the operator back to an action channel; they cannot collect approval or answers themselves. A board-question-specific notification kind is absent. Default-off is repository composition evidence, not proof of the live operator's installed settings. |\n| Reports and session messages | `packages/plugins/report/src/report.ts:182` builds a deterministic baseline report; its README documents MCP report/CLI, usage, attention, held reviews and unknown data. `packages/plugins/worker-sessions/README.md` documents session_send/session_inbox, with operator versus client attribution. Docs: `docs/design/reports.md`; `docs/design/sessions-and-messaging.md`, Direct messaging. | Reports are pull-based information, not decision requests. Messages can carry questions, but message content grants no authority. These channels do not replace an exact-subject approval or a board question's answer transition. |"
    },
    {
      "severity": "info",
      "title": "4. External systems skipped",
      "detail": "External systems were excluded as requested. This audit inspected only repository files in the admitted worktree."
    },
    {
      "severity": "info",
      "title": "5. Worker handoffs: artifact-backed workflows work today; arbitrary in-step delegation is incomplete",
      "detail": "| Area | System TODAY: evidence and documentation | Missing / gap |\n|---|---|---|\n| Artifact identity and provenance | `packages/plugins/artifacts/src/index.ts:231` validates bodies, canonicalizes input references, computes content identity, enforces classification inheritance and deduplicates. The envelope at `:26` records producer, subject, inputs, lineage, run/node and time. Docs: `docs/design/artifacts.md`, Envelope, Lineage and invalidation; `docs/reference/schemas.md`, Artifact envelope. | IDs and provenance support durable handoff, but do not by themselves prove a claim correct. Large-body storage remains planned; the artifacts README documents inline bodies and schema-validated contracts. |\n| Briefs and dependency results | `packages/plugins/workflow/src/spec.ts:586` composes dependency results as content-id pointers and grown results as pointers. `packages/plugins/workflow/src/briefs.ts:63` adds goal, acceptance, budget, subject and confinement; `:76` emits brief@1.3 when task criteria name checks. `packages/libs/src/briefs.ts:98` resolves pointers into the actual prompt at the Worker source. Docs: workflow engine, Briefs and A board task's brief. | A dependency edge orders execution; a template must deliberately consume the result through a node placeholder, grown-results placeholder, or task pointer. Pointer storage avoids copying content into instructions, but the source ultimately renders content into a bounded prompt; this is not automatic access to every prior transcript. |\n| Across tasks and attempts; digests | `packages/plugins/workflow/src/tasks.ts:278` adds accepted predecessor results, preferring their digest, plus previous-attempt results, stopped-step results, and the decision containing rejection reasons or answers. `packages/plugins/workflow/src/digests.ts:118` requests a bounded digest after the result reaches the board; `:203` attaches it. The digest README describes quote checking and fail-open bypass. Docs: workflow engine, A board task's brief and A digest of a task's result. | Digests are optional summaries, not an acceptance prerequisite; unavailable or failed digests leave raw artifacts. Quote checking proves verbatim support, not completeness. Task pointers are bounded, so this is selective context transfer. |\n| Exact review subject | `packages/plugins/workflow/src/review.ts:80` captures the dependent agent result's workspace subject and diff; `:113` accepts only an assessment naming that subject while the tree still matches, then stores the bound assessment. Docs: workflow engine, Exact-subject review; artifacts, Envelope. | Exact binding applies when the review has a qualifying agent-result dependency. Standalone agent-review is a single caller-input step (`packages/plugins/profile-software-development/src/index.ts:64`), so merely naming that template does not manufacture a preceding change or exact-subject gate. |\n| Team members' material | `packages/plugins/workflow/src/teams.ts:353` fences peer text as data; `:374` builds ballot/debate prompts from sealed records, including merged review findings and later ballots. The worker-sessions README states team members never message each other. Docs: `docs/design/teams.md`, Procedure; sessions and messaging, Direct messaging. | Team material follows the engine's staged protocol. A member cannot privately commission another member's test or research through the team protocol. Sealed ballots deliberately limit what another member sees and when. |\n| Tests and research as workflow work | Configured DAGs already route steps to different Workers and pass artifacts downstream. `packages/plugins/workflow/src/growth.ts:22` accepts a bounded planner plan, appends its steps and makes the planner's dependents wait; `:101` exposes grown results. `packages/plugins/workflow/tests/plans.spec.ts:8` demonstrates downstream synthesis consuming the findings. The software-development profile runs validation last and makes its measurements the run result that a later attempt reads. Docs: workflow engine, Graph growth; workflow-templates, Algorithm-development. | Yes, when the request is represented as a configured step or an authorized planner's grown step. The default growth allow-list (`packages/plugins/workflow/src/spec.ts:113`) includes reason/web-search/review/local-data, not validate. Test delegation therefore needs a suitable configured step or explicit growth policy, an admitted validate Worker, shared exact workspace/subject, allowed commands, budget and acceptance contract. Research needs admitted research capabilities and permitted egress. |\n| Arbitrary request from a running Worker | `packages/plugins/workflow/src/sessions.ts:31` wakes an existing idle session on mail; `:119` settles the wake and sends replies to its senders. `:154` sends reply text without attaching the wake result's artifact reference. Docs: sessions and messaging, implementation differences: a Worker sends only as its reply to a wake; session_send belongs to operator/client channels. | There is no general Worker-facing delegate/test/research call that creates a routed child task, suspends its caller, then returns a correlated accepted artifact. Reuse the existing workflow/board/artifact seams: define the request and allowed capabilities, bind its subject and inputs, record the child and decision, enforce budget/egress/approval, wait durably, and feed the accepted artifact back into a continuation. Existing DAG execution is sufficient for a known sequence; free-form delegation needs this additional contract and lifecycle. |\n\nVerification: read-only inspection of source, canonical documentation, schemas and relevant quota/capacity/planner/handoff tests. No files changed; no git commands or tests ran. Live configuration and coordination-board acceptance were not verified. The approve verdict approves this audit report; it does not record the lead's or operator's acceptance of T179."
    }
  ]
}

## T181 research: Jev as a decision model

run_912bc4af1f24f87a: frame:1 RUNNING, literature:1 WAITING, literature:2 WAITING, evidence:1 WAITING, critique:1 WAITING, conclusion:1 WAITING
run_912bc4af1f24f87a: frame:1 COMPLETED, literature:1 RUNNING, literature:2 RUNNING, evidence:1 WAITING, critique:1 WAITING, conclusion:1 WAITING
run_912bc4af1f24f87a: frame:1 COMPLETED, literature:1 COMPLETED, literature:2 COMPLETED, evidence:1 RUNNING, critique:1 WAITING, conclusion:1 WAITING
run_912bc4af1f24f87a: frame:1 COMPLETED, literature:1 COMPLETED, literature:2 COMPLETED, evidence:1 COMPLETED, critique:1 RUNNING, conclusion:1 WAITING
run_912bc4af1f24f87a: frame:1 COMPLETED, literature:1 COMPLETED, literature:2 COMPLETED, evidence:1 COMPLETED, critique:1 COMPLETED, conclusion:1 RUNNING
T181 — Research conclusions: Jev as a routing advisor for System

Overall recommendation: approve a restricted Jev feasibility experiment and conditional shadow evaluation. Do not authorize Jev-controlled dispatch yet.

The evidence supports learned routing as a promising technique and staged deployment as a reasonable engineering strategy. It does not establish that Jev improves System's accepted results per scarce quota unit, produces calibrated operator-acceptance probabilities, or satisfies all operational and privacy requirements.

The most important disagreement between Reviews A and B is now partially resolved: Jev exists. The official announcement dated September 15, 2026 is publicly accessible, and Vercel independently lists Jev 1.14.0 with an example of its structured decision interface. Review B's claim that no verifiable Jev release exists is therefore incorrect. However, this does not validate every technical or commercial claim in Review A. [E1][E2][E3][E6] 
TypeSafe AI Blog
+1

Hypothesis verdicts

Hypothesis

	

Verdict

	

Confidence




H1 — Jev interface and operational suitability

	

Insufficient

	

High




H2 — Learned routing outperforms quota-headroom dispatch

	

Insufficient

	

High




H3 — Cost and acceptance predictions can be calibrated

	

Insufficient

	

Moderate




H4 — Safe, staged Jev integration improves dispatch

	

Insufficient

	

Moderate

Confidence describes confidence in the verdict, not the probability that the proposed integration will succeed.

H1 — Jev's interface, capabilities and operational suitability

Verdict: Insufficient evidence. Confidence: High.

Jev is a real, publicly announced System One model. TypeSafe describes this category as fast decision models that consume unstructured state and produce predefined, typed probabilistic judgments rather than generating free-form conversational text. The announcement describes a parallel sampler and Reinforcement Learning for Calibrated Decisions (RLCD). These are vendor architectural and performance claims, not independently established properties of Jev on System's workload. [E1][E10] 
TypeSafe AI Blog

Review A identifies a documented decision API using model, state and named questions. Independent Vercel documentation provides a concrete decide() integration example with a typed boolean question, and lists a 32K context window and $0.04 per million input tokens. This supports interface feasibility. [E3][E6] 
Vercel AI Gateway

The original announcement also advertises end-to-end response times of 70–500 milliseconds, but these are vendor-reported figures, not System-specific latency measurements or service guarantees. The API reference requires JavaScript rendering, so its complete schema was not independently established here. Third-party guides describing choice, score and noul limits remain secondary evidence. [E4][E5][E12]

More importantly, Jev's native probability outputs must not be interpreted as validated probabilities of final operator acceptance. A probability attached to a choice among Worker candidates is not equivalent to a measured probability that the chosen Worker will produce an accepted artifact. Ordinal scores also do not automatically become numerical quota-consumption estimates. [E11]

Data-handling terms remain a separate gate. Review A reports a no-training policy for customer requests, conditional retention, and enterprise Zero Data Retention arrangements. Neither review establishes that System's particular account is authorized to transmit confidential task descriptions, repository metadata or source-code-derived context. A self-hosted Jev deployment and applicable model license also remain unverified. [E7][E8]

Review agreement and disagreement: Review A reports an announcement, API and third-party listing; Review B denies Jev's verifiable existence. Direct access to the official announcement and Vercel listing resolves that foundational disagreement in favor of A. The independent critique correctly identifies the need to verify specific API behavior, latency, commercial terms and privacy protection rather than treating vendor documentation as proof of production suitability. [E1]–[E12]

Evidence that would change the verdict: An authenticated API probe using representative synthetic System tasks; a verified request/response schema; measured p50/p95/p99 latency, error rates and pricing; written confirmation of commercial and data-processing permissions; and successful validation of the required structured responses. A verified local deployment would materially improve the privacy assessment.

H2 — Learned routing versus deterministic quota-headroom dispatch

Verdict: Insufficient evidence. Confidence: High.

There is strong evidence that learned routing can improve cost-quality trade-offs on conventional language-model workloads.

RouteLLM trains routing strategies using preference data and evaluates alternative strong-versus-cheap model choices. Review A reports savings exceeding 2× in some settings and up to 85% in an MT-Bench configuration while retaining approximately 95% of stronger-model performance. Review B reports a different 50–75% savings range. These findings support task-conditioned routing in general. [E13][E14][E15]

FrugalGPT similarly demonstrates adaptive selection and cascading, with both reviews reporting substantial cost savings, although their cited maxima differ. TREACLE adds evidence for contextual and budget-constrained sequential selection. [E17][E18][E19][E20]

None of these results demonstrates superiority over System's actual baseline.

System's resource economics differ in several important ways:

Subscription quotas have rolling five-hour and seven-day windows rather than simple per-token prices.

Multiple Workers can consume the same account-level quota pool.

Coding tasks have heterogeneous roles, retry costs, review outcomes and delayed acceptance labels.

The least expensive initial attempt may be more expensive overall if it causes additional attempts or consumes scarce capacity before future tasks arrive.

Both reviews acknowledge this transfer problem. The critique is correct to give it substantial weight. However, absence of a System-equivalent study is evidence of unproven generalization, not experimental proof that learned routing performs worse. [E26][E27]

Martian and Not Diamond provide commercial comparators, but Review B's specific benchmark claims are supported only by vendor homepages and are not corroborated by Review A. OpenRouter's relevance is similarly architectural rather than proof of quota-window optimization. [E21]–[E25]

Review agreement and disagreement: A and B agree that RouteLLM and FrugalGPT demonstrate potential improvements on standard workloads, and both acknowledge the mismatch with System's dynamic quotas. They differ on benchmark savings figures and on how confidently those results can be transferred. Review B is more optimistic; Review A is more appropriately conditional. [E13]–[E27]

Evidence that would change the verdict: A time-separated retrospective comparison followed by a prospective evaluation showing that a learned advisor produces more accepted work per scarcity-adjusted quota unit than a strong deterministic quota-aware baseline, without materially reducing acceptance or exhausting constrained quota pools. The comparison must include retries, availability, role restrictions and uncertainty intervals.

H3 — Calibration of acceptance probability and expected cost

Verdict: Insufficient evidence. Confidence: Moderate.

The underlying methodology is well established. Research by Guo et al. demonstrates that neural-network confidence can be miscalibrated and that post-hoc calibration can improve reliability. Brier score, log loss, reliability diagrams and calibration error provide ways to assess probabilistic predictions. [E28][E29][E31][E32]

Contextual-bandit research also establishes off-policy evaluation techniques, including inverse propensity weighting, doubly robust estimators and shrinkage. These can help evaluate alternative routing policies under appropriate assumptions. [E33][E34][E35][E36]

However, the critique correctly identifies three substantial gaps.

First, Jev's native probabilities have not been validated against System's operator-acceptance outcomes. Jev's reported calibration on vendor tasks is not transferable without empirical testing. [E10][E11][E41]

Second, historical deterministic dispatch introduces selective observation. System observes the outcome of the selected Worker, not the outcomes that alternative Workers would have achieved. Inverse propensity weighting cannot overcome complete lack of action overlap. Doubly robust estimation does not eliminate that identification problem. [E34][E35][E37][E38]

Third, neither review establishes that System already contains enough consistently labeled, representative completed attempts or sufficiently accurate native quota-consumption records to train and validate the desired predictions. [E39][E40][E41]

Review agreement and disagreement: Both reviews support calibration and off-policy evaluation as general methods and recognize missing counterfactual outcomes. Review B calls H3 strongly supported, whereas Review A appropriately distinguishes methodological feasibility from demonstrated Jev-specific performance. The critique strengthens A's position: counterfactual overlap and actual acceptance labels cannot be assumed. [E28][E33][E37][E38][E41]

A workable evaluation should define separate prediction targets: first-attempt acceptance, eventual acceptance after retries, and resource consumption in each quota pool's native unit. System should measure Brier score, log loss and reliability by project, task type and Worker/tier; cost-prediction error should be measured separately. An aggregate routing-value metric must include retries and scarce-quota opportunity costs. [E32][E39][E40]

Evidence that would change the verdict: Audited outcome joins from dispatch through operator acceptance; sufficient time-separated completed examples; reliable resource-usage measurements; demonstrated calibration superior to simple historical-rate predictors; and valid policy comparisons using supported actions or carefully controlled prospective randomization.

H4 — Staged Jev integration with deterministic hard gates

Verdict: Insufficient evidence for the complete hypothesis. Confidence: Moderate.

The proposed architecture is defensible: deterministic eligibility checks constrain the candidate set, and a learned advisor ranks only eligible Workers. The reviews agree on retaining a baseline dispatcher, shadow evaluation, operator-visible advice, explicit fallbacks and a bounded automated phase. RouteLLM provides a concrete example of replaceable learned-routing implementations. [E16][E42][E43]

But these are primarily engineering recommendations, not evidence that Jev has already improved production outcomes under System's constraints.

The critique also correctly rejects Review B's assertion that deterministic filtering automatically guarantees zero safety regressions. Eligibility can change between scoring and execution; a previously eligible Worker may exhaust its quota, lose a concurrency lease or become unavailable. System must revalidate mutable constraints at reservation time and preserve existing approval gates. [E44][E45]

Review A additionally recommends model-version pinning, decision artifacts, monitoring, circuit breakers and deterministic fallback. TypeSafe's October 14 release explicitly warns that experimental capabilities are not ready for production use, supporting this conservative approach. [E9][E46] 
TypeSafe AI Blog

Review agreement and disagreement: Both reviews favor separating hard constraints from learned ranking and agree on staged deployment. Review B presents stronger safety and readiness claims, while Review A treats the architecture as a plausible proposal awaiting tests. The critique supports the conditional interpretation. Neither review provides a controlled Jev deployment demonstrating System-specific safety and economic benefits. [E42]–[E46]

Evidence that would change the verdict: Successful fail-closed integration tests covering timeouts, malformed outputs, stale eligibility, quota races, unavailable accounts and privacy restrictions; complete decision auditability; measured latency within the dispatch budget; and prospective evidence of economic improvement without safety or acceptance regressions.

Recommendation for System

Implement a vendor-neutral decision-advisor interface, with Jev as one optional adapter. The interface should never determine candidate eligibility, modify quota reservations, override reviewer independence, authorize work or approve merges.

The flow should be:

Task + versioned decision-time context

Kind, size, file metadata, acceptance criteria, history, quotas

Deterministic eligibility and policy gates

Roles, credentials, quotas, capability, concurrency, provider separation

Baseline dispatcher

Always available

Jev advisor

Eligible candidates only

Policy-controlled candidate selection

Fallback on invalid, unavailable or untrusted advice

Revalidate → reserve → execute → operator approval

Immutable decision and outcome artifacts

Required telemetry

For each dispatch decision, capture a content-addressed record containing the task/project/attempt identifiers; decision timestamp; feature and policy schema versions; task features; complete candidate set and eligibility reasons; Worker capabilities and tiers; quota-pool identity, headroom and reset times; baseline recommendation; advisor model/version and input/output hashes; predicted scores and uncertainty; chosen action and actual selection probability; realized resource consumption; retries; reviewer and operator decisions; first-attempt and eventual acceptance; and final outcome timestamp. [E37][E38][E39][E40]

Do not invent propensities or label untried candidates as failures. Avoid transmitting raw source code, secrets or full repository histories to Jev until applicable data permissions have been verified. TypeSafe's published FAQ confirms that customer submissions are not used to train Jev, but also describes operational processing, telemetry and agreement-dependent retention; this does not by itself authorize every proposed System data flow. [E7] 
TypeSafe Help Center

Staged rollout

Stage

	

Authorized behavior

	

Advancement requirement




0 — Feasibility

	

Synthetic requests, API and contract verification

	

Verified data permissions, pricing, output schema and viable latency




1 — Shadow

	

Jev scores real eligible candidates without affecting dispatch

	

Sufficient labeled outcomes, measured calibration, stable fallbacks, no sensitive-data exposure




2 — Visible advice

	

Recommendations shown in the operator console; existing dispatch remains authoritative

	

Operator usefulness and workload impact measured; predicted benefits supported by prospective evidence




3 — Bounded routing

	

Advisor influences ranking among eligible candidates only

	

Prespecified, credible improvement against baseline; acceptance noninferiority; zero gate violations




4 — Monitored operation

	

Gradual expansion with version pinning, drift detection and rollback

	

Sustained performance, audit completeness and compliance

The thresholds of 200 labeled decisions proposed by Review A and p99 under 150 ms, calibration error below 0.05 and 15% gain proposed by Review B are not validated requirements. They should be replaced with System-specific latency budgets, minimum useful effect sizes and statistical power calculations. [E47][E48]

Final conclusion for T181

The evidence supports three conclusions.

First, Jev is a genuine, publicly documented System One model with a plausible structured-decision integration path, but its native outputs are not established System-specific acceptance or resource-cost predictors. Commercial permissions, local deployment, end-to-end economics and reliability need further verification. [E1][E3][E6][E7][E8][E11][E12]

Second, RouteLLM, FrugalGPT and related research show that learned routing can improve conventional cost-quality trade-offs. They do not demonstrate superiority over System's quota-aware baseline, and the strongest missing evidence concerns dynamic subscription windows, shared pools, role-constrained coding agents and delayed operator acceptance. [E13][E17][E20][E26]

Third, calibration and contextual-bandit methods provide a credible evaluation framework, but System must address selective observation, label quality, policy shifts and actual resource accounting before it can trust numerical predictions. A staged, fail-closed integration is appropriate for testing this proposition, not a reason to assume it will succeed. [E28][E33][E34][E37][E38][E42][E43]

Decision: Approve Stage 0 and authorize Stage 1 only after privacy and contract verification. Keep deterministic quota-aware dispatch as the production default. Do not authorize Jev-controlled routing until a prospective evaluation establishes incremental value and the existing hard gates remain independently enforced.

This decision accounts for both reviews, resolves the demonstrably incorrect nonexistence claim in Review B, and adopts the critique's central caution: general routing research and vendor capability claims are not substitutes for evidence on System's own workload.
session: ses_0b29af36fb906ed4

## T182 brainstorm (team): Jev as an advisor

run_5ac05734d74a1c15: brainstorm:m1:propose RUNNING, brainstorm:m2:propose RUNNING, brainstorm:m1:ballot:1 WAITING, brainstorm:m2:ballot:1 WAITING, brainstorm:tally:1 WAITING, brainstorm WAITING
run_5ac05734d74a1c15: brainstorm:m1:propose COMPLETED, brainstorm:m2:propose COMPLETED, brainstorm:m1:ballot:1 RUNNING, brainstorm:m2:ballot:1 RUNNING, brainstorm:tally:1 WAITING, brainstorm WAITING
outcome: O1; method: team-majority; winner: O1; decision: sha256:ede24fcf88aed3eccb2d3c7230807a9383d2e9b3bac006658453ede29766949e

#### Decision: O1 (m1's proposal)

Adopt a provider-neutral DecisionAdvisor architecture with Jev as an optional, untrusted probabilistic advisor. Implement eight designs: D1 quota-aware Worker ranking; D2 tier selection; D3 team composition; D4 remediation/retry/reject; D5 operator escalation; D6 quota-cost and acceptance forecasting; D7 cross-project scheduling; D8 adaptive research. Prioritize D1+D6, then D2+D4+D5, then D3+D7+D8. Deterministically filter eligibility before scoring and atomically revalidate before execution. Preserve every candidate's score, structured reason codes, exclusion reasons, uncertainty, model version, baseline choice, final choice, and outcome in linked content-hashed decision artifacts. Preserve native quota units and conservative reserves. Start with shadow mode, calibrate on observed outcomes, then conduct bounded prospective comparisons against the current quota score. Jev never grants permissions, bypasses approval gates, or directly launches Workers. Fail closed on constraints and fall back to the existing deterministic scorer on advisory failures.

#### Votes (round 1 of 1)

- m1: O1 (confidence high). O1 better satisfies T182's requirement for 5–8 concrete integration designs, each with inputs, outputs, measures, learning, constraints, and risks. Its provider-neutral DecisionAdvisor abstraction fits System's plugin architecture and preserves deterministic policy enforcement, auditability, and fallback behavior. It correctly distinguishes shadow-mode predictive evaluation from prospective causal evidence: observing 100 decisions cannot establish whether unchosen Workers would have produced better results. O1 also addresses native quota units, calibration, outcome attribution, candidate-level explanations, and vendor independence. O2 offers a valuable narrower initial implementation, but its two primary designs do not fully cover the requested integration opportunities. The preferred synthesis is O1's architecture and eight-design roadmap, implemented initially with O2's focused dispatch and remediation scope, while adding quota forecasting as a shared capability.
- m2: O1 (confidence high). Option O1 provides a substantially more rigorous, comprehensive, and production-ready architecture for System. It details an explicit 8-design roadmap, properly distinguishes prediction from arbitration, enforces atomic pre-execution revalidation, preserves native quota units across non-comparable pools, accounts for delayed outcome attribution, and introduces a vendor-neutral DecisionAdvisor interface with explicit fallbacks and calibration rather than relying on vendor-side fine-tuning.

#### Options

- O1 (m1): Adopt a provider-neutral DecisionAdvisor architecture with Jev as an optional, untrusted probabilistic advisor. Implement eight designs: D1 quota-aware Worker ranking; D2 tier selection; D3 team composition; D4 remediation/retry/reject; D5 operator escalation; D6 quota-cost and acceptance forecasting; D7 cross-project scheduling; D8 adaptive research. Prioritize D1+D6, then D2+D4+D5, then D3+D7+D8. Deterministically filter eligibility before scoring and atomically revalidate before execution. Preserve every candidate's score, structured reason codes, exclusion reasons, uncertainty, model version, baseline choice, final choice, and outcome in linked content-hashed decision artifacts. Preserve native quota units and conservative reserves. Start with shadow mode, calibrate on observed outcomes, then conduct bounded prospective comparisons against the current quota score. Jev never grants permissions, bypasses approval gates, or directly launches Workers. Fail closed on constraints and fall back to the existing deterministic scorer on advisory failures.
- O2 (m2): Integrate Jev primarily as an advisory Dispatch Pre-Execution Router (Design 1) coupled with a Failure Remediation Advisor (Design 3). Route all task dispatches through a pipeline where deterministic rules first prune unavailable/exhausted workers, Jev ranks the remainder with confidence and predicted quota usage, and the harness commits the decision artifact to git. Run Jev in shadow mode across 100 task attempts to benchmark acceptance rate and quota efficiency against the existing heuristic dispatcher before granting execution gating authority.
