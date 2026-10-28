# Right model, right Worker: the cost and value of each algorithm-development step

> Research, non-normative (T338, 2026-10-28). Operator: "optimize using the right model and the
> right worker"; "self-review may not be needed: a review should be objective and independent from
> develop". No code or policy changes here.

## Read this first: what this run could and could not measure

This run is confined to its worktree. It can read the repository and the board file
(`.system/TASKS.md`, cut to a part of the 290 tasks). It cannot read the live store: step start and
end times, findings records, `quota.draw`, usage reports and dossiers of other runs are not in the
worktree. So:

| Kind of number | Source | Marked |
|---|---|---|
| **Measured** | the lead's counts over 3 days (1,555 steps; 137 runs with develop and selfreview), given in the task; and the lead's notes on the board (T339) | M |
| **Derived** | arithmetic on the measured counts, shown | D |
| **Read** | the template, prompts, routing and eval records in this repository | R |
| **Assumed** | a stated assumption, to be replaced by a measurement | A |
| **Not measured** | needs the store; section 7 says what to pull and how | – |

Nothing below is a time, token or finding-class number that I did not have. Where the task asked
for one (median and p90 time, usage, a classification of findings), the table cell says
`not measured`, and [section 7](#7-what-to-pull-from-the-store) is the pull that fills it. The
conclusions that do not need those numbers (the shape of the pipeline, the self-review
break-even, the A/B design) stand on M, D and R.

## 1. Per step kind: count, tier, family, and what its output changed

### 1.1 Counts and ratios (M, D)

Window: 3 days, 1,555 completed steps.

| Step | Count (M) | Per develop (D) | Share of all steps (D) | Tier (R) | Family |
|---|---|---|---|---|---|
| `develop:1` | 261 | 1.00 | 17 % | `standard` in the template; `frontier` by `tierByRisk` on a heavy change | the author's (Claude Code) |
| fix | 238 | 0.91 | 15 % | the step it fixes (continues `develop:1`'s session) | the author's |
| `selfreview:1` | 188 | 0.72 | 12 % | `standard`; the author's account, read-only role | the author's |
| `review:1` and re-reviews | 412 | 1.58 | 26 % | `standard`; the first review takes its tier from the risk decision (T288) | another Worker (Codex in the pilot) |
| verify (`review:1:verify`) | 165 | 0.63 | 11 % | mostly `frontier` | another family where one is free |
| second-family review (heavy) | 157 | 0.60 | 10 % | mostly `frontier` | a family other than the first review's |
| `validate` | 106 | 0.41 | 7 % | `economy` in 14 of them | retired by T267; these are old runs |
| other | 28 | 0.11 | 2 % | – | – |

(106 + 261 + 412 + 238 + 188 + 165 + 157 = 1,527; the lead's 1,555 leaves 28 unnamed.)

Three readings that need no further data:

1. **The writing is 17 % of the steps; the review pipeline is 59 %.** Per develop there are 3.53
   review-type steps (self 0.72 + review 1.58 + verify 0.63 + second 0.60) and 0.91 fixes. A change
   in the review pipeline moves more cost than a change in develop.
2. **The economy tier is not in use.** 14 of 1,555 steps (0.9 %), all of a step that no longer
   exists. The tier ladder in practice is `standard` and `frontier`. The routing order already
   takes "lowest admissible tier first" ([routing](../design/routing.md#quota-in-every-route)), so
   the only way a step gets cheaper is that its minimum tier is lowered, in the template or in
   `tierByRisk`. No template step names `economy` today (R: `index.ts`, every node is `standard`).
3. **Tier is set by risk, not by the step's difficulty.** Under `tierByRisk`, a heavy change raises
   `develop` and `review` to `frontier` ([routing](../design/routing.md#intelligence-tiers)). Verify
   and the second-family review are mostly frontier; no measurement says they need to be.

### 1.2 Time, usage, acceptance (not measured)

| Step | Median / p90 time | Usage | Output led to a change |
|---|---|---|---|
| `develop:1` | not measured | not measured | the result of the run |
| `selfreview:1` | not measured | not measured | a fix in 41 of 137 runs (30 %, M) |
| `review:1` | not measured | not measured | a fix in 41 of 137 runs (30 %, M) |
| verify | not measured | not measured | unknown share of findings rejected (T330 shows one: its only blocking finding was rejected, so the result read `changes-requested` until the summary was fixed) |
| second-family review | not measured | not measured | not measured |
| fix | not measured | not measured | – |

The usage side is limited by what is recorded: usage is per run step and per account, and the Claude
Code five-hour window's share is not readable live
([quota-builtins](quota-builtins-2026-10-24.md)). A per-step cost will be tokens (or the account's
window used between two readings), not money.

### 1.3 Self-review against review, on the 137 runs (M, D)

| | Review asked a fix | Review clean | |
|---|---|---|---|
| **Selfreview asked a fix** | 17 | 24 | 41 |
| **Selfreview clean** | 24 | 72 | 96 |
| | 41 | 96 | 137 |

- Each step asked a fix in 30 % of the runs. A run got a fix from one or both in 65 of 137 (47 %).
- The two steps agree in 89 of 137 runs (65 %) and disagree in 48 (35 %). Most of the agreement is
  both saying "clean": the agreement expected by chance from the margins is 58 %, so kappa is
  0.17, barely above chance.
- When selfreview asked a fix, the review asked one in 41 % (17/41); when it did not, in 25 %
  (24/96): a relative risk of 1.7. Selfreview is a weak predictor of the review's result, and
  finds 41 % of the runs the review found a fix in.
- **The 24 "only selfreview" runs are not evidence that selfreview found what the review would
  miss.** The fix selfreview caused ran before the review, so a clean review afterwards is the
  expected result of the fix working. The counterfactual (what the review would have said of the
  unfixed change) is not in the data. Bounds: the review's fix rate without selfreview is between
  41/137 = 30 % (it would have found nothing more) and 65/137 = 47 % (it would have found all 24).
  The A/B in section 4 measures this.
- **The 24 "only review" runs** are defects the author's own account did not see in a fresh
  session, or findings a different reviewer made by taste. Which they are is the classification of
  section 2. The pairing of one family's author with the same family's reviewer is the blind spot
  that independent review is for.

## 2. The fix rate: its cause

### 2.1 The 91 % overstates how often a change needs a fix (D)

"238 fixes / 261 develops" divides a count of fix **steps** by a count of develop **steps**. It is
not the share of develop steps that get a fix round, for three reasons:

- A run can have several fix steps: one for the selfreview's confirmed findings, one for the
  review's, one more after a re-review, one for the heavy second review's findings.
- Not every develop reaches review (261 develops but 188 selfreviews: 73 develops ended before it,
  to a failed attempt, an evidence refusal, or a restart).
- In the 137 complete runs, the two first-round reviews asked for 41 + 41 = 82 fixes: 0.60 per run,
  and at least one fix round in 47 % of the runs (65/137).

So on the runs we can see, **about half the changes need no fix from selfreview or the first review;
the other 0.3 fix per run is rounds after those** (re-reviews, second-family findings). The lead
should confirm this with the per-run count in section 7 (item 1) before the "91 %" is used again.
Taking the ratio per run is also the right unit for the A/B.

### 2.2 What kind of finding made a fix: not classified yet

The task asks for a classification of the findings that made a fix, by severity and kind (real
defect, style, missing test, misread task). The findings records are not readable from this run, so
**I have not classified any finding, and I report no share by kind.** What I can give is the
method, so the lead (or a follow-up run with store access) fills it in one pass:

1. Population: every confirmed `important` finding (after verification, ADR-0075) that grew a fix,
   from selfreview and from the review, over the same 137 runs. A fix grown by a finding that
   verification rejected is counted apart.
2. Sample: all of them if fewer than about 120; else 30 from each of: selfreview-only runs,
   review-only runs, both-ask runs, and the heavy second review.
3. Rubric, one label per finding (the first that applies):
   - **real defect**: the change fails a stated criterion or breaks behaviour, shown by a file, a
     line and evidence;
   - **missing or weak test**: behaviour that the task requires has no test that fails without it
     (or a test weakened, skipped or unreliable);
   - **misread task**: the change does something the task did not ask, or leaves out something it
     did (scope creep or a missed criterion);
   - **stale document or file in the change**: a doc that disagrees with code, a scratch file, a
     generated report;
   - **style or wording** that was filed as `important`: a nit in the wrong severity;
   - **environment limit**: a command the reviewer could not run, filed as a defect.
4. For each, record whether the fix changed a behaviour test or only text, and whether the later
   review accepted it (one fix, or more than one round).

### 2.3 Likely causes, from the prompts and the process (R), to be confirmed by 2.2

These are hypotheses read from the code. None has a count behind it yet.

| # | Cause | Where | What it predicts in 2.2 |
|---|---|---|---|
| C1 | The review prompt makes "a change the task does not need" and "a test or benchmark weakened, skipped, or made unreliable" **important** findings. Scope is judged against the task's words, which a developer reads differently | `REVIEW_PROMPT`, `SELFREVIEW_PROMPT` | many **misread-task** findings, mostly scope |
| C2 | Selfreview's brief is broad ("a document that no longer matches the code, a file that should not be in the change"), and it costs the reviewer nothing to file one | `SELFREVIEW_PROMPT` | a high share of **stale document / file** findings in selfreview-only runs |
| C3 | The develop prompt names the test-first rule and the evidence gate, but no checklist of what the reviews then look for (docs agree with code, no scratch file, changeset, generated files) | `DEVELOP_PROMPT`, `VERIFY` | these classes recur across runs; a checklist would remove them |
| C4 | A reviewer never runs tests ("read and judge only"), so a **missing test** is a finding made by reading, and "tests that fail without the change" is checked by the System only afterwards (`red-on-base`) | `REVIEW_PROMPT`, ADR-0079 | missing-test findings concentrated where `red-on-base` was not yet in force |
| C5 | A heavy change gets a second-family review and its own findings, which grows a fix after the first review approved; the second family's taste differs | process by risk (ADR-0071) | most of the rounds after the first two reviews are from heavy changes |
| C6 | The two reviewers agree barely above chance (observed 65 %, chance 58 %, kappa 0.17): part of the fix rate is taste, which a stricter severity rule would remove | 1.3 | a share of **style / nit filed important** and findings that verification rejects |
| C7 | The author's session writes both the change and, in the fix, the answer to the review: a fix often brings a new defect, so a re-review follows | review cycles | a share of review-count growth (1.58 reviews per develop) is re-review of fixes |

### 2.4 What would lower it (to try, in this order)

1. **Handbook and develop prompt: a pre-review checklist** (C3, C2). The same list the reviews apply
   (every doc the change touches still true; no file outside the task; changeset; generated files
   rerun; test fails without the change). It costs a few lines in the develop prompt and, if the
   fixes of 2.2 are mostly this class, takes them out before selfreview and review run. Measure:
   the share of runs with a fix from a finding in those classes, before and after.
2. **Review strictness: only a defect that fails a criterion is `important`** (C1, C6). A scope
   finding without a failing criterion is a nit. This is a change to `REVIEW_PROMPT`, so
   `check:reviewer-eval` stops it until the eval is run again, no worse (recall 4/5, false
   important 1/3 on the standard tier at its first run). A lower false-important rate on clean
   changes is the thing to show.
3. **A cap, not a stop, on nits and on the number of fix rounds** (C7): the review guides already
   cap nits; a second fix round on the same finding class for a non-heavy change could go to the
   operator's queue as information, not as a loop.
4. **Do not lower review strictness for heavy changes.** The point of the second family is that
   taste differs; the cost is in the number of heavy changes (section 3.3), not in the rule.

## 3. Cheaper tier, or skip by risk: what each would miss

### 3.1 The evidence there is

- `reviewer-eval` ([experiment 4](../validation/experiments/reviewer-eval.md)): the board's
  reviewer **at the standard tier**, recall 4 of 5 past escapes, false important on 1 of 3 clean
  changes (2026-10-26, execution `e9bf3a5b`). It was run at one tier only, so it says nothing about
  whether `frontier` finds more, or whether `economy` finds less. A case served at another tier than
  the run's minimum is not counted ([the design](../validation/experiments/reviewer-eval.md#design)).
- Eight cases cannot compare tiers: 4/5 against 5/5 on the same five escapes has Fisher's exact
  p = 1. To see recall 0.80 against 0.90 at 80 % power takes about 200 cases per arm (D: n = 7.84 ×
  (0.8·0.2 + 0.9·0.1) / 0.1²). The set grows by one case per escape, so it will not answer this
  soon. **Use it as a regression gate, not as the evidence for a tier.**
- The only other evidence is the process's own: which runs a lower tier's review passed that the
  next stage (verify, the second family, the landing's checks, red dev) caught. That is the
  per-stage catch table of section 7 (item 4), not yet drawn.

### 3.2 Step by step

| Step | Could it run a cheaper tier or skip? | What it would miss, and the evidence |
|---|---|---|
| `validate` (106, 14 economy) | Already gone (T267) | nothing; the author's checks and the System's own required checks replaced it |
| `selfreview:1` | **Skip, A/B first (section 4)** | up to 24 of 137 runs' findings reach the review instead (D, 17 %); not shown to be defects. The step counts for no tier, family or acceptance (R), so skipping it removes no gate |
| `selfreview:1` at `economy` | Possible if kept | its job is the author's blind spots; a cheaper model has more blind spots. No evidence either way; the A/B arm C below tests "kept, cheaper" |
| verify (165, mostly frontier) | **Candidate for `standard`** on non-heavy changes | it judges one finding already stated with file, line and evidence, a narrower job than a review. A weaker verifier confirms a wrong finding (a needless fix round) or rejects a right one (a missed defect). The false-confirm and false-reject rates are not measured: item 3 of section 7. T330 shows verification rejecting a real-looking blocker, so it does reduce rounds |
| `review:1` | Keep at its tier; **do not skip** | it is the independent gate. Light changes (policy `light`) are the only candidates for a lower tier. The eval's false-important 1/3 on clean changes says the standard tier is not too lenient |
| second-family review (157, heavy) | **Keep for heavy**; narrow what is heavy | 0.60 per develop means a large share of changes are heavy by the path map; the heavy path map should be read for paths that are heavy by habit. The operator must accept a heavy result anyway (handbook layer 2), so the second family is a second look, not the last gate |
| `develop:1`, fix | Keep as is | the writing step; `frontier` on heavy is the policy |
| economy tier | Use it for steps that exist and are mechanical | none is a template step today; candidates would be a docs-only light change's review. Needs the light/normal/heavy mix of tasks before it is worth a map entry |

### 3.3 The size of each lever, in steps per 100 develops (D)

Per 100 develops the window had 91 fix, 72 selfreview, 158 review, 63 verify, 60 second-family
steps. If every step of that kind cost the same, then:

- Removing selfreview takes out 72 steps, and some of the 63 verify steps and the fixes that
  selfreview findings caused (up to 41/137 = 30 % of runs); it adds back the findings that reach the
  review (up to 17 % of runs).
- Verify at standard is 63 steps one tier down; no step is removed.
- Narrowing heavy by a quarter takes out about 15 second-family steps and the frontier tier from
  their develop and review.

Steps are not equal. A frontier step costs more than a standard one, a review reads a diff (a
large input), and a fix waits for the operator's approval, which is time and not tokens.
The per-step usage of section 7 is what turns these into savings.

## 4. A/B design for self-review

The operator's point stands: the independent review is another Worker and session, and selfreview
never counted as one. The question is whether selfreview, as a **cheap pre-filter**, pays for
itself in the pipeline. It does if

> P(selfreview removes a review fix round) × C(review fix round) + P(it catches a defect that would
> land) × C(escape) ≥ C(selfreview) + P(selfreview asks a fix) × C(its fix and its re-check)

where a review fix round is the fix, the re-review, the verification of the findings, and the
operator's approval wait, and an escape is a returned landing or a red dev. With A: P(removes round)
≤ 24/137 = 0.175, P(asks a fix) = 0.30, a review fix round of about 3.5 steps, and selfreview and
its fix at 1 + 0.30 × 2.5 = 1.75 steps per run, the left side is 0.175 × 3.5 = 0.61 steps per run
before escapes. On steps alone selfreview does not pay; if it pays, it pays through the escapes or
the operator's wait. The A/B measures exactly those. (The three numbers marked A are assumptions;
the A/B replaces them.)

### 4.1 The switch

Two ways, in order of preference:

- **A template option**, `selfReview: boolean` (default true) in the profile's `Config`, which
  `algorithmDevelopment()` reads: with `false` the template is `develop:1` then `review:1`, and
  `review:1` depends on `develop:1` only. It is configuration, never a Worker or family name (INV-11).
  Chosen once per task, so every attempt of a task follows its arm. The assignment is deterministic
  (INV-2): the parity of a hash of the task id, within the strata below, recorded in a decision
  artifact (INV-13) so the report can group by it.
- If T322's switch (enforce) is the place the lead wants it, the same assignment reads it per task.
  I did not find its text in this worktree, so this design does not depend on it.

### 4.2 Which tasks

- Board tasks of `algorithm-development`, all three variants (`code`, `docs`, `tests`).
- Stratify by risk tier (`light`, `normal`, `heavy`) and by kind, so each stratum is split in half.
  Heavy changes are included: the second family and the operator's acceptance already stand behind
  them, and they are where selfreview's cost is highest (frontier). If the operator prefers, start
  with `light` and `normal` only; that halves the throughput and removes the largest escape risk.
- Excluded: research templates, scheduled reviews, tasks that carry an earlier attempt's work
  (they follow the arm of their first attempt, not re-randomised).

### 4.3 Arms

| Arm | Process |
|---|---|
| A (control) | as now: develop, selfreview, review |
| B (off) | develop, review |
| C (optional, later) | develop with the section 2.4 checklist in its prompt, no selfreview: tests whether a checklist takes the place of the step |

Run A against B first. Start C only if B's escapes are not worse and its review fix rate rises.

### 4.4 Measures

| Measure | Definition | Role |
|---|---|---|
| review fix rate | runs with a confirmed important finding by `review:1` that grew a fix, over runs that reached it; baseline 41/137 = 30 % | the effect of removing selfreview (expected to rise, bounded 30 % to 47 %) |
| fix rounds per task | all fix steps over the task's attempts | primary, with the next one |
| steps per task | all completed steps of the task | cost |
| wall time per task | task claimed to result accepted, and to merged | cost; includes the operator's approval waits |
| usage per task | tokens or window share by account from the usage report | cost, if recorded |
| returned landings | tasks whose accepted result the landing's checks or the operator returned | guardrail (escape) |
| red dev | dev red after a landing, traced to a task | guardrail (escape) |
| nit and pre-existing findings | counts per review | noise |

A returned landing counts as an escape only when its cause is the change. A landing returned for the
host is recorded apart, so that environment failures fall on neither arm. T338's own first two
attempts are the case: both were accepted and then returned because the full suite failed in
`display-virtual`'s real-Xvfb tests (and, on the second, two timeouts in `project.spec.ts` and
`round2.spec.ts`), none of which a docs-only change can touch (the System's evidence entries #11
and #23 of this task's dossier).

The primary comparison is **total fix rounds and steps per task, with returned landings and red dev
as the harm guardrails.** The review fix rate alone is the wrong decision measure: in arm A selfreview
removes some of it by fixing first, so a rise in B is expected, and means only that the work moved.

### 4.5 How long

- Detecting a rise in the review fix rate from 30 % to 45 % (two-sided α 0.05, power 80 %) takes
  about 160 runs per arm (D: n = 7.84 × (0.30·0.70 + 0.45·0.55) / 0.15²), 320 in all.
- The window produced 261 develops in 3 days (M), so about 87 a day, and 137 runs that reached
  both steps in that time. At that rate 320 runs take about **4 to 7 working days**, longer if only
  light and normal changes are included.
- Returned landings and red dev are rare. The lead's notes on the board (T339, M) name two red dev
  in 2026-10-27/28 (typecheck after T325, dead code after T304a) and two landings returned by the
  whole-`pnpm check` landing (T330, T333). Four events in about three days cannot power a test in a
  week; they are guardrails with a stop rule. Report each as a count with its task, and read it for
  whether selfreview's class of finding would have caught it.

### 4.6 Stop rule

Look at 80 runs per arm and at 160 per arm (two looks; α 0.029 at each, Pocock).

- **Stop B for harm** at any look when arm B has at least 3 more escapes (returned landings plus red
  dev attributable to the change) than arm A, or any red dev whose cause is a class selfreview
  reported in arm A. All tasks then return to the template with selfreview.
- **Stop for no difference** at 160 per arm when both of these hold: B's steps per task are below A's
  by at least 10 %, and B's fix rounds per task are no more than A's by more than 0.1. Adopt B as
  the default for `light` and `normal`; keep selfreview for `heavy` until a heavy-only look.
- **Stop for futility** at 80 per arm if B's steps per task are not below A's: selfreview costs
  nothing net; keep it, and use the budget on section 2.4's checklist.
- A broken run (a failed attempt, a restart) is counted in the arm of its task, not dropped.

## 5. Recommendations, ranked

Expected savings are in steps (D) or marked, because the usage per step is not measured.

| # | Recommendation | Expected effect | Risk | Task it would become |
|---|---|---|---|---|
| 1 | **Pull the per-step table of section 7** (time, usage, findings, verification outcome per run) into a report, once, and keep it as a `system report` view | Turns every number in section 3.3 into a saving; settles the 91 % vs 47 % question and the finding classes | none (read-only) | "Report: per-step time, usage, findings and fix rounds per run" |
| 2 | **Classify the confirmed findings that made a fix** (section 2.2) | decides recommendations 3 and 9; no code | none | "Research follow-up: finding classes of the 2026-10-26..28 fixes" (depends on 1 or the store) |
| 3 | **Pre-review checklist in the develop prompt and the handbook** (section 2.4, 1) | removes the doc, scope and stale-file classes before any review; up to 0.1 to 0.3 fix per run if those are the larger classes (A) | the develop prompt is a template change; `check:reviewer-eval` does not cover it | "develop prompt: the checklist the reviews apply" |
| 4 | **A/B of selfreview** (section 4) | at most 0.72 steps per develop plus part of verify and fix, less the findings that move to the review; per the break-even, small on steps, uncertain on escapes | harm is bounded by the stop rule | "Template option selfReview and its assignment by task" then "Run the self-review A/B" |
| 5 | **Verify at `standard` for non-heavy changes** | 63 steps per 100 develops one tier down; the size is the frontier minus the standard cost | a weaker verifier confirms a bad finding or rejects a good one | "tierByRisk: verify at standard for light and normal" after recommendation 1 has the false-confirm rate |
| 6 | **Reviewer-eval at each tier** | the evidence for 5 and for any later tier cut; cannot reach statistical power on eight cases, so it is a regression gate | tokens for each run of eight cases | "reviewer-eval: run the set per tier and record the Workers" |
| 7 | **Read the heavy path map for paths that are heavy by habit** | each change moved from heavy to normal saves the second-family review and the frontier tier of develop and review (0.60 second-family steps per develop is the ceiling) | a defect on a path that should have stayed heavy; the operator's acceptance of heavy results is the backstop | "policy: heavy paths audited against the findings that second-family reviews made" |
| 8 | **Use the economy tier for a mechanical step** | none today (14 of 1,555 steps, a retired step) | – | none until there is a step; revisit after 6 |
| 9 | **Review strictness: scope without a failing criterion is a nit** (section 2.4, 2) | fewer fix rounds if scope findings are the larger class | the eval's recall must not fall (it was 4/5) | "REVIEW_PROMPT: the severity of scope findings", after 2 |

Order of work: 1, 2 first (they are measurements and cost no risk), then 3 and 4 in parallel (3 is
cheap; 4 needs time to collect runs), then 5 with 6, then 7. Nothing here asks for a cheaper tier
for the independent review or the second-family review of a heavy change, and nothing removes
independence: selfreview, in every design, counts for no tier, family or acceptance.

## 6. Limits of this analysis

- All counts are the lead's; I did not recompute them. The 137-run table has no time order, so a
  change of process inside the window (T284's recorded checks, T306's `red-on-base`, T288's first
  review tier, the review guides) is mixed into it.
- "Asked a fix" is the lead's count; whether it is after verification, and whether a fix of a nit is
  in it, is not stated. Both change section 1.3.
- The selfreview and the review are different families in the pilot (Claude Code authors and
  self-reviews, Codex reviews), so the disagreement of 1.3 mixes a fresh session's view with a
  different model's taste. The A/B removes the first; it cannot separate the two.
- The board file in this worktree is cut and is not a sample of attempts.
- Section 4's break-even uses assumed step counts (A) for a review fix round and a fix.
- Cells 1.2 and 2.2 are empty because the run cannot read the store; follow-up tasks 1 and 2 of
  section 5 fill them. The statements about the template (every node `standard`; the review and
  selfreview prompts) were read in `packages/plugins/profile-software-development/src/index.ts`.

## 7. What to pull from the store

One query per run of the template, joining by run id, over the 3-day window (and then every day):

1. **Fix rounds per run:** the count of fix steps, each with the review that grew it
   (selfreview, `review:1`, a re-review, the second-family review), and whether the run reached
   `review:1` at all. Gives the real "share of runs with at least one fix" against the 91 %.
2. **Time and usage per step:** step start and end (median, p90 by kind, tier and family), the
   usage record of the step's agent run (tokens, and the account's window read before and after),
   and the wait between a fix's request and the operator's approval.
3. **Findings:** every finding of selfreview, `review:1` and the second-family review: severity,
   file, line, its verification result (confirmed or rejected, by which family), and whether the
   fix that followed was accepted by the next review. Classify with section 2.2's rubric.
4. **Per-stage catch table:** for every defect found at a stage (selfreview, review, verify, second
   family, the landing's checks, red dev), the earliest stage that had it available. This gives
   what a cheaper or skipped stage would have missed, with no model needed.
5. **Tier served and family per step:** from the route and tier decisions, so a table by tier and by
   family does not depend on the template's declared tier.
6. **Heavy share:** the risk-tier decisions per task, and which path made it heavy.
