# @tsuuanmi/system-profile-software-development

The **software-development profile**: templates for local agent Workers,
contributed to the workflow engine with `ctx.workflow.template` (REQ-WF-9). It
holds no engine code and no rules of its own.

- **`agent-review`** is one node, `review:1`, requiring `review` and
  `local-data`, at the caller's tier and in the caller's session. Only a
  read-only local agent Worker proves both, so it never routes to a website
  account ([nodes](../../../docs/reference/workflow-templates.md#agent-review)).
- **`algorithm-development`** (PROP-0010 B8) is one attempt of a board task that
  tests one hypothesis
  ([nodes](../../../docs/reference/workflow-templates.md#algorithm-development)):
  - `develop:1` (`develop`, `local-data`; `code` work) states the hypothesis and changes the
    code in the run's own git worktree (agent Workers with `worktreePerRun`), on
    the run's session, which the task's next attempt resumes; when that attempt failed only
    after this step (its review's session broke, say), the next attempt's worktree already holds
    the change, and its brief says so ([starting from the previous attempt's work](../../../docs/design/workflow-engine.md#starting-from-the-previous-attempts-work)). Its variants `docs`
    and `tests` make it that kind of work, changing documentation only or tests
    only (`system run algorithm-development --variant docs`, MCP `run` with
    `variant`). **It ends with the author's own checks (T267):** it runs the checks
    the task's criteria name and appends their real output to the task's dossier as an
    `evidence` entry; without one that shows each command's exit code and output, the
    step is refused at its end (`evidence_missing`). It is admitted only to a Worker
    given the dossier tools (`dossier`), and every fix grown from it shows the checks'
    output again;
  - `selfreview:1` (`review`, `local-data`) is the author's own review in a fresh
    context: a new session on the author's account (its read-only role) that never saw
    the author's transcript, given only the task's goal and criteria, the exact diff, and
    the review guides, never the dossier, the task's pointers, or the author's orders. Its
    confirmed important findings grow a fix in the author's session, answered before `review:1`
    starts, with no approval gate; it counts for no tier, family, or acceptance;
  - `review:1` (`review`, `local-data`) reviews that exact change on a read-only
    Worker, after the self-review. It reads the task, its criteria, and the change, never the
    developer's answer (its prompt points at no step's result); a remediation
    cycle's re-review is given the same instructions, on the fixed subject. It is given the
    [review guides](../../../docs/review/README.md) of the areas the change touches. The
    reviewer reads and judges the change and never runs the project's tests or
    builds (the author showed its checks' output, and the run's required checks at
    acceptance run them again, ADR-0063): a command it could not run is not a finding
    about the change, and an environment limit (its read-only sandbox, a denied command)
    is at most a `nit`. The engine's exact-subject block says the same to every
    bound review, `agent-review`'s too. It is the final step: its report is the run's
    result, what the task keeps, what its digest cites, and what the next attempt reads.
    The template had a `validate:1` step until T267 (median 0.4 minutes, nothing the
    required checks did not catch); it is folded into the two above;
  - **Review cycles** ([ADR-0075](../../../docs/decisions/adr/0075-a-review-finding-has-a-severity-and-only-a-verified-important-one-blocks.md),
    [severity and verification](../../../docs/design/workflow-engine.md#severity-and-verification)):
    each finding of `review:1` is `important`, `nit`, or `pre-existing`, with its file, line,
    and evidence (one without is a nit); the assessment's summary opens with the count. An
    important finding grows `review:1:verify`, a second reviewer (another family where one
    is free, else a fresh session) that votes on it against the code; only a confirmed one
    grows the fix (`review:1:approve:1`, `review:1:fix:1`, in the author's session) and the
    re-review (`review:1:review:2`). The self-review's findings are verified the same way
    (`selfreview:1:verify`), and its confirmed ones grow `selfreview:1:fix:1` and
    `selfreview:1:review:2` with no approval gate. Nits reach the author once, as optional notes of a fix or
    a dossier entry, and never start a round or hold auto-accept; a pre-existing finding
    proposes a follow-up task. A re-review reads only the change since the last reviewed tree
    with the open and answered findings, and from its third round says whether the approach
    should change. The bound is `maxReviewCycles` (3, the first review included)
    ([which inputs reach which step](../../../docs/reference/workflow-templates.md#which-inputs-reach-which-step)).
  - **Kinds of work** ([ADR-0057](../../../docs/decisions/adr/0057-route-work-by-kind.md)):
    the steps name what they are, never who takes them: `develop:1` is `code`
    work (`docs` or `tests` in those variants). A Worker the operator gives kinds
    takes only steps of those kinds, so giving one writer `code`, `docs`, and `tests`
    keeps the changes on it
    ([route work by kind](../../../docs/operations/runbooks.md#route-work-by-kind));
    with no Worker given kinds, every step routes as before. The reviews name
    none, so their reviewers must be Workers given no kinds.
  - **Config `kinds`** sets the kind each step names, by step (`develop`, `docs`,
    `tests`), defaulting to the shipped kinds (`DEFAULT_KINDS`), so
    which Worker takes a step is configuration
    ([configuration](../../../docs/reference/configuration.md#profile-software-development)).
    `checkConfig` (for `system check`) and the load refuse a key that is not a
    step and a kind that is not a kind of work (INV-2); no key gives a review a
    kind. A `validate` key of an earlier version is accepted and ignored.
  - The project's charter and milestones are the board's, the exact-subject
    review, remediation through the approval queue, briefs, and digests the
    engine's, for any template ([workflow engine](../workflow/README.md)).
  - The author's pasted output is its report, not a check the engine reports: under a
    policy that requires `tests`, the board holds each result for the operator unless
    the run's own checks ran ([pilot](../../../docs/operations/pilot.md)).
- **Off by default:** the row is off in the default composition (PROP-0004),
  though the Claude Code agent rows it needs are on (PROP-0010 B3); the
  `api-first` preset turns it on
  ([turn a row on](../../../docs/operations/runbooks.md#turn-an-off-row-back-on)).
  PROP-0004 removed the `develop` template; its earlier runs keep their records.
- **Injects:** `workflow`.
- **Conformance:** [`profiles`](../workflow/conformance/profiles.ts).
- **Tests:** [`tests/algorithm-development.spec.ts`](tests/algorithm-development.spec.ts)
  runs the template on [a pilot in miniature](tests/pilot.ts): the real engine,
  board, approval queue, ledger, digest provider, and `agents` source with a
  worktree per run, over a scratch repository, with only the agent runtime
  scripted (it asks the tool gate before every call). One attempt with a fix
  through the queue, held for the operator with its digest, the author's
  checks' output in the dossier, the fix's again; a develop step with no such
  output, or evidence that shows none, refused at its end; a Worker with no
  dossier tool never admitted to it; the self-review in a new session on the
  author's account, given no dossier, refused one, and finding none the author's step was given in the worktree, its findings answered in
  the author's session before the review starts, with no gate;
  the review guides of the areas the change touches in the review's brief and
  not the writer's; Workers given kinds, every writing step (the fix, and the
  `tests` variant's) on the writer given `code`, `docs`, and `tests`; and a
  configured kind routing `develop:1` to the writer given `docs`.
  [`tests/profile.spec.ts`](tests/profile.spec.ts) checks the shipped
  and configured kinds, that the template has no validate step, and refuses a
  bad `kinds`.
  [`tests/landing.spec.ts`](tests/landing.spec.ts) lands an accepted result (ADR-0060), rebased
  onto a base that moved, a conflict resolved by its author's Worker (ADR-0068), and
  [`tests/carry.spec.ts`](tests/carry.spec.ts) starts a task's next attempt from the work its
  previous attempt left (ADR-0061, accepted 2026-10-25, D59): T110a's attempt, whose review's session broke after
  `develop:1`, carried and landed; a review that asked for changes, a result the board rejected, a
  tree off the commit the task writes or onto a moved HEAD, and a changed or removed worktree, never
  carried.
  [`tests/agent-review.spec.ts`](tests/agent-review.spec.ts) runs `agent-review`'s
  review node after an agent's change on the same pilot: its re-review is given
  the caller's input composed in place of `{{input}}`, never the placeholder.
