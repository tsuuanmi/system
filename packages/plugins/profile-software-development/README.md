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
    `variant`);
  - `review:1` (`review`, `local-data`) reviews that exact change on a read-only
    Worker. It reads the task, its criteria, and the change, never the
    developer's answer (its prompt points at no step's result); a remediation
    cycle's re-review is given the same instructions, on the fixed subject. The
    reviewer reads and judges the change and never runs the project's tests or
    builds (`validate:1` and the run's required checks at acceptance run them,
    ADR-0063): a command it could not run is not a finding about the change, and
    an environment limit (its read-only sandbox, a denied command) is at most an
    `info` finding. The engine's exact-subject block says the same to every bound
    review, `agent-review`'s too;
  - `validate:1` (`validate`, `local-data`, economy at least; `validation` work) runs the tests and
    benchmarks the task's criteria name, in a one-shot conversation (no session),
    on a Worker whose commands are proven confined (`executes`). It reads the task's
    criteria, each with what checks it (`brief@1.3`), from its brief, and never the
    caller's input, which is the develop step's orders (T99 D4), nor any step's answer;
    with no criteria it runs nothing and says so
    ([which inputs reach which step](../../../docs/reference/workflow-templates.md#which-inputs-reach-which-step)).
    It comes last, so its report
    measures the subject the task leaves after any fix, and that report is the
    run's result: what the task keeps, what its digest cites, and what the next
    attempt reads.
  - **Kinds of work** ([ADR-0057](../../../docs/decisions/adr/0057-route-work-by-kind.md)):
    the steps name what they are, never who takes them: `develop:1` is `code`
    work (`docs` or `tests` in those variants), and `validate:1` is `validation`
    work, apart from test writing. A Worker the operator gives kinds takes only
    steps of those kinds, so giving one writer `code`, `docs`, and `tests` and
    another Worker `validation` keeps the changes on the one and the checks on
    the other ([route work by kind](../../../docs/operations/runbooks.md#route-work-by-kind));
    with no Worker given kinds, every step routes as before. The review names
    none, so its reviewer must be a Worker given no kinds.
  - **Config `kinds`** sets the kind each step names, by step (`develop`, `docs`,
    `tests`, `validate`), defaulting to the shipped kinds (`DEFAULT_KINDS`), so
    which Worker takes a step is configuration
    ([configuration](../../../docs/reference/configuration.md#profile-software-development)).
    `checkConfig` (for `system check`) and the load refuse a key that is not a
    step and a kind that is not a kind of work (INV-2); no key gives the review a
    kind.
  - The project's charter and milestones are the board's, the exact-subject
    review, remediation through the approval queue, briefs, and digests the
    engine's, for any template ([workflow engine](../workflow/README.md)).
  - A validation's report is evidence, not a check the engine reports: under a
    policy that requires `tests`, the board holds each result for the operator.
    A command the policy does not list exactly is denied (the step has no session
    to defer it on) and reported not run ([pilot](../../../docs/operations/pilot.md)).
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
  through the queue, held for the operator with its digest, the validator given
  the criteria and their checks but not the caller's input; validation with no
  Worker proving `validate`; an unlisted validation command; Workers given kinds,
  every writing step (the fix, and the `tests` variant's) on the writer given
  `code`, `docs`, and `tests`, and `validate:1` alone on the Worker given
  `validation`; validation failing closed when no Worker given kinds lists
  `validation`; and a configured kind routing `validate:1` to the writer given
  `tests`. [`tests/profile.spec.ts`](tests/profile.spec.ts) checks the shipped
  and configured kinds, and refuses a bad `kinds`.
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
