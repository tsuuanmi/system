# Reviewer eval: past escapes, and clean changes

> Experiment 4 (T268, D93, after Anthropic's "Solving code review": past bug-causing changes,
> confirmed, form an eval set the reviewer runs on every change to its prompts, tools, or model).
> State: **the runner, its gate in `pnpm check`, five escapes and three clean changes, every ref
> pinned**; no measured run is recorded yet ([preconditions](#preconditions)). Helper:
> [`scripts/experiments/reviewer-eval.ts`](../../../scripts/experiments/reviewer-eval.ts). Records:
> [the set](records/reviewer-eval-set.v1.json) and [the gate](records/reviewer-eval-gate.json).

## Question

Does the reviewer, as it is now, still hold what it held? A change to the review template, its
prompts, or the reviewer's tier or model is kept only when the reviewer, run on the set, finds at
least the escapes it found, and gives an important finding on no more of the clean changes. The set
grows by one case for each defect that escapes ([runbook](../../operations/runbooks.md#run-the-reviewer-eval)).

## Design

| Item | What |
|---|---|
| escape | a change that let a defect through, and the later change that fixed it: the pair of commits, and the finding a review of the defective change must make (the file the fix changed, and the words a finding of it uses) |
| clean | a change no later change was needed to fix: a review of it must give no finding at an important severity |
| what is reviewed | a change that introduces the defect, narrowed to the files the defect is in: the defective commit against its parent; or, when the defect was a state of the code no single commit introduced, the fix reverted against the fixed tree; or, when no commit ever held it, a recorded patch |
| execution | each run is a fresh execution: every case's run key is its own, so a rerun after a change to the reviewer's Workers, models, or tools never returns an earlier review; a record never names an execution twice |
| the reviewer | System's own, as the board's `review:1` runs: MCP `run` of `agent-review` at the board reviewer's tier (the same capabilities, so the same reviewer Workers; refused when `agent-review` cannot serve that configuration, and a case the host served at another minimum tier is not counted), given the board reviewer's instructions (`REVIEW_PROMPT`), the task in its own words (the case's `request`, never the defect), and the engine's subject block with the change; its assessment read with the engine's parser |
| important | the severities the set names (`important`, [ADR-0075](../../decisions/adr/0075-a-review-finding-has-a-severity-and-only-a-verified-important-one-blocks.md)), as the engine's parser reads `review:1`'s answer: an important finding without file, line, and evidence is a nit; what counts is what the reviewer reports, before a second reviewer verifies it |
| measured | **recall**: escapes whose expected finding an important finding made, of the escapes run; **false-important rate**: clean changes that got an important finding, of those run |
| not run | a case whose change is not in the clone, whose input is over the `run` tool's bound, or whose review failed, is listed with why and is in neither count; a rate of no cases is `not measured`, never 0 |
| gate | `pnpm check` (`check:reviewer-eval`) fails when the reviewer's fingerprint (its instructions, subject block, parser, `review:1` steps, the set, the runner) is not the one of the last measured run; before the first measured run it reports what changed and passes, because that run needs the changed reviewer live; `run --record` records a run only when every case ran, no worse than the last |

A ref is never a search: it is a pinned commit, or a patch file of the records directory. A match
is deliberately plain: the finding is important, its file (when it names one) matches the case's
path pattern, and its claim or evidence matches the case's claim pattern. Extra important findings
on an escape are listed, never counted as false: only a clean change can show a false one.

## The set

Most defective versions never landed on `dev`: the lead fixed them first, so they sit on run
branches of the repository, which the clone the eval reads must have.

| Case | What is reviewed → fix | Expected finding |
|---|---|---|
| `t235-npm-config-name` | `479ce7e2` (T235's Worker result: the check environment named only `npm_config_*`, which pnpm 12 ignores) against its parent, on `agent-workers/src/checks.ts` → `5332fecd` | the name pnpm 11 and later read is `pnpm_config_*` |
| `check-starts-install-in-confinement` | `5332fecd` reverted against its own tree, on `agent-workers/src/checks.ts`: the check environment as it stood at `43c61b00`, where a check could start a `pnpm install` inside the confinement with no network (T228's change adding a workspace package triggered it, T238 found it) → `5332fecd` | the check can hang on an install |
| `regenerate-without-no-install-environment` | `8eb36439` reverted against its own tree, on `agent-workers/src/regenerate.ts`: the regenerate step as `5332fecd` left it, with a plain `childEnvironment()` and not the no-install environment (`5332fecd`'s own diff does not touch `regenerate.ts`) → `8eb36439` | pnpm may start an install when generated files are made again |
| `t247-proc-fd-report-channel` | `effbbc75` (T247's Worker result: a report channel opened through `/proc/self/fd`, which a confined process cannot reopen) against its parent, on the runtimes and `agent-workers` → `096d6b6d` | a descriptor path that cannot be reopened |
| `t253-home-filter-lists-other-projects` | [a patch](records/reviewer-eval-t253-defective.patch) → `20fe4c45` | Home's filter does not apply to the recent runs |

The check-environment defect was the state of the code before T235, which no single commit
introduced: reviewing `43c61b00` itself would show an unrelated change. Its case is the fix taken
away instead, a change against a sound baseline that brings the defect back. The regenerate defect
is built the same way: `5332fecd` left `regenerate.ts` as it was, so the case is the fix `8eb36439`
taken away from that file. The T253 defect was
never committed anywhere: the lead fixed it inside `20fe4c45`. Its change is a fixture, that
commit's recent-runs filter reverted as a diff against the file as it is now. Three clean changes
(T250 `ba9a904b`, T255 `adbfeef1`, T258 `7e4e00ea`) stand for normal work.

### Preconditions

| Id | Precondition | State |
|---|---|---|
| P1 | each expected finding confirmed by the lead against its fix (the file the fix changed, the words the defect is told in), and each case's `paths` checked with `resolve` (a diff, within the `run` tool's 32,000 characters) | half: every case resolves against a clone with the run branches, each review input within the bound (the two `agent-workers` cases narrowed to `checks.ts`, the whole directory being over it); the expected findings are not yet confirmed by the lead |
| P2 | the `agent-review` template served (the `profile-software-development` row on) with a reviewer Worker given no kinds, as `algorithm-development`'s `review:1` needs | as the host runs the board's reviews |
| P3 | a first measured run, recorded with `--record`, after the reviewer is live | open: until then the gate reports drift from the reviewer as T268 found it and does not fail |

## Limits

Eight cases measure nothing about the reviewer's quality: the eval catches a regression that a case
shows (a prompt that stops finding what it found), not an improvement. The reviewer sees the change
and the task, not the repository around it, as a review of a diff does; an escape that needs the
surrounding code to see is told by its expected finding in what the diff itself shows. The Workers
and models the review routes to are deployment configuration, which the gate cannot see: each
recorded run names the Workers that served it, and the runbook says to run it after changing them.
