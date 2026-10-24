# Worker agnosticism on `review`

> Experiment 2, and the first record of PROP-0011's feedback loop (its
> [first experiment](../../proposals/0011-feedback-loop.md#the-first-experiment-worker-agnosticism-on-review)).
> State: **pre-registered** on 2026-10-23 (hypothesis, objective contract, suite, metrics,
> protocol), not yet frozen: its [preconditions](#preconditions) are open. Nothing has run.
> Records: [records](records/README.md).

## Hypothesis and design

The [`review`](../../reference/workflow-templates.md#review) template is worker-agnostic: with one
member's Worker held fixed, swapping the other member's Worker by configuration changes none of
its outcomes beyond pre-registered margins
([hypothesis](records/review-worker-agnostic.hypothesis.json),
[experiment](records/review-worker-agnostic-1.experiment.json)).

| Item | Pre-registered |
|---|---|
| baseline arm | a ChatGPT website Worker and an Antigravity CLI Worker |
| candidate arm | a Codex CLI Worker and the same Antigravity CLI Worker |
| comparison | non-inferiority of the candidate on defects identified per cost: candidate over baseline at least 0.8 |
| suite | [review-suite v1](records/review-suite.v1.json): the two commits the [self-build](../self-build.md#before-the-pilot-team-reviews-of-its-own-code) reviews ran on, nine labels (seven blocking defects, one defence-in-depth defect, one known non-defect; Q2 blocking by the operator's decision D20), all in the regression partition |
| trials | 2 cases × 2 arms × 3 repetitions = 12, in blocks: each round runs both arms in the order the seed gives, each arm both cases |
| maker, judges | the code was written by Claude Code sessions, a family in neither arm; the collector is deterministic; the operator adjudicates |
| expected verdict | `inconclusive`: two cases are fewer than the five any declared method needs ([objective contract](records/review-objective-contract.v1.json)), and the helper computes no statistic (it calls no method of F2's library). That is a valid outcome: the loop is accepted when it gives an auditable verdict, not when one arm wins |

The operator chose this one-member swap. PROP-0011's table proposed two website members against
two CLI members; that comparison is a later experiment, `RELATED` to this one. The suite was found
by the website families, so it favours the baseline: non-inferiority on it is a conservative test.
Every way the protocol departs from PROP-0011's is listed in the experiment record's `deviations`.

## Preconditions

| Id | Precondition | State |
|---|---|---|
| P1 | agent Workers are admitted to `review` member steps | built, opt-in: the review-member profile, below |
| P2 | Antigravity CLI Workers keep a conversation, as every team member must | built for review members: a replay, below |
| P3 | the arms' Workers verified live: the [release checklist](../release-checklist.md) rows *A Codex Worker*, *A Codex Worker's tool gate* (with a signed-in Worker), *An Antigravity CLI Worker end to end*, *A Codex Worker as a `review` team member*, *An Antigravity CLI Worker as a `review` team member*, and *`review` of a public repository by URL* | open |
| P4 | the labels confirmed by the operator, after the [calibration](#1-calibrate-the-labels) passes | open |
| P5 | a maintenance window: every other project paused, no other run, since an arm turns website and agent rows off for everyone | open |

**P1.** Each member step of `review` requires the team node's capability `reason` (the template in
[`spec.ts`](../../../packages/plugins/workflow/src/spec.ts), its steps unrolled by `unrollTeams`).
An agent Worker never offers plain `reason`, so that agent-plan quota is spent only on what only
agent Workers prove ([admission evidence](../../design/agent-runtimes.md#admission-evidence),
[routing](../../design/routing.md#quota-and-cost-policy)). The review-member profile
([ADR-0049](../../decisions/adr/0049-read-only-agent-workers-as-review-members.md), proposed: the
operator decides, D19) lifts this for member steps only. A read-only agent Worker with
`reviewMember: true` and a `family` offers `reason` scoped to review-member work, and the engine
names that scope on every member step. Its steps run with every tool call denied, in an empty
workspace outside any repository ([runbook](../../operations/runbooks.md#agent-workers-as-review-team-members)).

**P2.** A team member's steps all run in its own conversation, so they need
`persistent-conversation` ([teams](../../design/teams.md#membership-model-a)). The Antigravity CLI
runtime never reports `resume` (continuing a conversation by id is not proven). Under the
review-member profile, its Worker offers `persistent-conversation` for member steps only: the
`agents` source replays the member's earlier turns exactly before each later one, and records them
(`agent-result@1.3` `replay`); a step whose conversation cannot be replayed whole fails, nothing
sent. A fixed member of another family instead (a Gemini website Worker, say) is a different
experiment: a new hypothesis record, not an edit of this one.

The code that lifts P1 and P2 is part of what the experiment pins (`environment.system`), and the
arm rows below are checked against it before the freeze.

## The arms

No trusted envelope carries an arm into a run yet (PROP-0011, open question 2), so each arm is one
composition: the operator's whole profile patch, kept as a file, identical between the arms
except for the rows below. Routing then has no Worker but the arm's for a member step, and both
arms run the same template, request, and bounds. The freeze hashes each file into its arm's
`subject.version`, so the configuration in force is checked before every block.

```yaml
# Both arms.
- id: runtime-antigravity-cli
  disabled: false
- id: provider-gemini-web            # no Gemini website member in either arm
  disabled: true
# The resources row keeps your pools and adds one per agent seat, so the ledger records their runs.
#   - { pool: exp.agy, account: agy, kind: programmatic, unknown: available, windows: [{ id: day, kind: rolling, seconds: 86400 }] }
#   - { pool: exp.codex, account: codex, kind: programmatic, unknown: available, windows: [{ id: day, kind: rolling, seconds: 86400 }] }

# Baseline arm (arm-baseline.patch.yml).
- id: provider-chatgpt-web
  disabled: false
- id: runtime-codex-sdk
  disabled: true
- id: agent-workers
  config:
    workers:
      - { id: agy-review, runtime: antigravity-cli, workspace: /home/<you>/experiments/review-worker-agnostic-1/empty,
          sandbox: read-only, tier: standard, model: <pinned>, pool: exp.agy, account: agy,
          reviewMember: true, family: antigravity-cli }

# Candidate arm (arm-candidate.patch.yml).
- id: provider-chatgpt-web
  disabled: true
- id: runtime-codex-sdk
  disabled: false
  config: { executable: <your codex, as in the Codex Workers runbook> }
- id: agent-workers
  config:
    workers:
      - { id: agy-review, runtime: antigravity-cli, workspace: /home/<you>/experiments/review-worker-agnostic-1/empty,
          sandbox: read-only, tier: standard, model: <pinned>, pool: exp.agy, account: agy,
          reviewMember: true, family: antigravity-cli }
      - { id: codex-review, runtime: codex-sdk, workspace: /home/<you>/experiments/review-worker-agnostic-1/empty,
          sandbox: read-only, tier: standard, model: <pinned>, pool: exp.codex, account: codex,
          reviewMember: true, family: codex-sdk }
```

- The agent members' workspace is an empty directory: they read only what the engine shows them,
  like the website member, and cannot reach the repository, where the fixes are. A file in it
  after a trial means a read-only member wrote: a broken hard constraint.
- No Claude Code Worker is configured in either arm (the `workers` list replaces yours whole):
  Claude Code is the maker's family, and it must not take a seat.
- The Codex and Antigravity CLI rows are set up as their runbooks say
  ([Codex Workers](../../operations/runbooks.md#codex-workers),
  [Antigravity CLI Workers](../../operations/runbooks.md#antigravity-cli-workers)), and each agent
  Worker as a review member ([runbook](../../operations/runbooks.md#agent-workers-as-review-team-members)).
  Its `family` is the one its seat pins in the experiment record.
- Leave `allowSameFamily` off (the default): a same-family admission makes a trial invalid.
- The agent Workers are hand-named rows. They load only until you move agent Workers to accounts ×
  roles (`system account migrate --apply`,
  [runbook](../../operations/runbooks.md#migrate-agent-workers-to-accounts--roles)); from then on
  they are refused at load. After the move, each arm's `agent-workers` row is written with roles
  and assignments, its Workers are `agent:<accountId>/<role>`, and the experiment record is revised
  with those ids before the freeze (the runbook's step 7). An Antigravity CLI account cannot be
  verified yet (no reader of its identity), so its derived Worker takes no work, and the fixed seat
  waits for one.

## Metrics

Per [the objective contract](records/review-objective-contract.v1.json); each computed by the
collector, [`scripts/experiments/worker-agnosticism.ts`](../../../scripts/experiments/worker-agnosticism.ts),
from a trial's exported records.

| Metric | Per trial | Per arm | Contract |
|---|---|---|---|
| defects identified per cost (primary) | the defect labels the team's findings identify by the suite's matching rule: a confirmed quote on a label's lines; on lines of several labels, the adjudicator's pick | identified labels over member steps executed, a ratio of sums | non-inferior: candidate over baseline at least 0.8 |
| blocking recall | blocking labels identified over those present | a ratio of sums | at least 0.5; non-inferior within 0.17 |
| false positives | findings on the known non-defect's lines, and unmatched findings judged not a defect; open items as bounds | per trial | non-inferior within 1 per trial |
| quote validity | confirmed defect findings over all defect findings | a ratio of sums | non-inferior within 0.10 |
| latency | minutes from the run's start to the team's decision | median | at most 1.5 times |
| stalls | member-step attempts that stalled or timed out, retried or not | per trial | non-inferior within 0.34 per trial |
| cost | member steps; the ledger's totals per pool for the run (none for a source that records none); adjudication minutes | sums | reported |
| per seat | the labels each member identified with its own confirmed quote | by seat | reported |

**Integrity** (any breach makes the verdict `invalid`): every member step on a Worker of the arm,
one seat per member, no same-family admission, an egress decision on every member step; the source
read at the case's commit, its file shown as the labelled blob; the run decided, or failed only in
a way that is the arm's own (stalled, timed out, out of quota, overloaded, a broken session, or no
answer acceptance took); each seat's observed version as frozen; the workspace check and the
ledger's usage recorded; no finding naming a fix commit, nor one the operator judged to cite a fix.
**Hard constraint** (`refuted`): a read-only member's workspace changed.

## Procedure

Run the helper as `node --import tsx scripts/experiments/worker-agnosticism.ts <command>` from a
checkout of this repository; its header lists the commands. `<records>` is
`docs/validation/experiments/records`, and `<dir>` is `~/experiments/review-worker-agnostic-1`,
which holds `arms/`, `empty/`, `seeding/`, and `trials/`, outside the repository.

### 1. Calibrate the labels

Now, before the seeding runs leave the store (a finished run is kept 30 days by default, so until
about 2026-11-21): export them, then check every label against the findings that seeded it.

```sh
… export <dir>/seeding gate-59962e5 run_65c39f158163c5c6
… export <dir>/seeding queue-4dd2d3c run_d28538263173ef45
… calibrate <records> <dir>/seeding
```

Every label must be identified by a finding of its seeding run, or be a candidate of one on
shared lines. A label `NOT FOUND`, or a held finding on no label's lines, means the label's lines
are wrong: correct them against the fix commits named in the suite. The seeding runs are not
trials, so this is not tuning. Then read each label (summary, severity, lines) against its fix and
failing test, and set the suite's `labelling.confirmedBy` to `{"who": "operator", "at": "<time>"}`.

### 2. Pin and freeze

Once P1 to P5 hold:

1. Write `<dir>/arms/arm-baseline.patch.yml` and `arm-candidate.patch.yml` ([the arms](#the-arms)).
2. Fill the experiment record's pins: each seat's `workers` (the Worker ids `system health`
   shows: `worker:<account>/standard` for a website account, `agent:<id>` for a hand-named agent
   Worker, `agent:<accountId>/<role>` for one derived from an account), `family`
   (a website Worker's is its account's provider, an agent's the `family` its configuration names;
   [routing](../../design/routing.md#provider-diversity)), `model`, and `observed` (what the Worker
   shows: the site's mode and model, `codex --version`, `agy --version`); and
   `environment.system` (the install's version and commit).
3. Freeze: `… freeze <records> --repo <a full clone> --arms <dir>/arms`. It refuses while a pin is
   missing, while the labels are not confirmed, or while a case's file at its commit is not the
   labelled blob; else it fills every hash and moves the experiment to `preregistered`.
4. Commit the frozen records before the first trial: that commit is the pre-registration.

### 3. Run the trials

`… schedule <records>` prints the twelve trials in order. Each block is one arm:

1. Install the arm's file as your profile patch, `system check`, `system shutdown`, `system start`.
   `sha256sum ~/.dsh/profiles/system/cordis.patch.yml` must equal the arm's `subject.version`
   (without `sha256:`), and `system health` must show the arm's Workers ready and no other Worker
   that could take a seat.
2. `ls -A <dir>/empty` prints nothing. Note each seat's observed version.

Each trial of the block, with the client token:

1. MCP `review`:
   `{"material":"<the suite's request, verbatim>","repository":{"url":"https://github.com/tsuuanmi/system","ref":"<the case's commit>"},"focus":["<the case's path>"],"classification":"public","clientRequestId":"review-worker-agnostic-1/<trialId>"}`.
2. `result {"runId":"<runId>","waitSeconds":55}` until it no longer runs. A tie is ended at once:
   `vote {"runId":"<runId>","decision":"<blocked.decision>","option":"inconclusive","rationale":"experiment trial: ties are not broken"}`.
3. `… export <dir>/trials <trialId> <runId>`; save `resources_usage {"runId":"<runId>","limit":100}`
   as `<dir>/trials/<trialId>/usage.json`; in its `trial.json` set `observed` (`{"swapped": …,
   "fixed": …}`, as noted for the block) and `workspaceClean` (`ls -A <dir>/empty` still prints
   nothing).

A trial's run is never continued or started again: a failed run is its trial's outcome. Stop the
experiment when a budget line in the experiment record is spent.

### 4. Collect, adjudicate, evaluate

1. `… collect <records> <dir>/trials` writes each trial's `measurement.json` and
   `<dir>/trials/adjudication.json`. It refuses records that differ from the frozen ones, or a
   collector that is not the pinned one.
2. The operator adjudicates: each item's `verdict` (one of its `options`: a label, `not-a-defect`,
   `defect-unlabelled`, or `unsure`), `by`, `family`, and `minutes`; each contamination flag's
   `verdict` (`cites-fix` or `does-not`). A lead may draft them; its family is recorded, and the
   operator decides each. Run `collect` again at any time: it keeps every verdict given.
3. `… evaluate <records> <dir>/trials` writes `evaluation.json` and `verdict.json`. It refuses
   while a contamination flag waits.
4. Copy both into [records](records/README.md) as `review-worker-agnostic-1.evaluation.json` and
   `review-worker-agnostic-1.verdict.json`, then write the lesson: its claim, the verdict's outcome,
   the evidence, where it applies (the families and versions observed, the suite and contract
   versions, the date), and what would invalidate it (a new Worker version, a new suite version,
   more cases).
