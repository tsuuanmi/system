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
    the run's session, which the task's next attempt resumes. Its variants `docs`
    and `tests` make it that kind of work, changing documentation only or tests
    only (`system run algorithm-development --variant docs`, MCP `run` with
    `variant`);
  - `review:1` (`review`, `local-data`) reviews that exact change on a read-only
    Worker. It reads the task, its criteria, and the change, never the
    developer's answer (its prompt points at no step's result); a remediation
    cycle's re-review is given the same instructions, on the fixed subject;
  - `validate:1` (`validate`, `local-data`, economy at least; `tests` work) runs the tests and
    benchmarks the task's criteria name, in a one-shot conversation (no session),
    on a Worker whose commands are proven confined (`executes`). It comes last, so its report
    measures the subject the task leaves after any fix, and that report is the
    run's result: what the task keeps, what its digest cites, and what the next
    attempt reads.
  - **Kinds of work** ([ADR-0056](../../../docs/decisions/adr/0056-route-work-by-kind.md)):
    the writing steps name what they are, never who takes them. A Worker the
    operator gives kinds takes only steps of those kinds, so giving one writer
    `code` and another `docs` and `tests` routes each step by what it changes
    ([route work by kind](../../../docs/operations/runbooks.md#route-work-by-kind));
    with no Worker given kinds, every step routes as before. The review names
    none, so its reviewer must be a Worker given no kinds.
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
  through the queue, held for the operator with its digest; validation with no
  Worker proving `validate`; an unlisted validation command; writers given kinds,
  each step (the fix, and the `docs` variant's) on the writer of its kind.
  [`tests/agent-review.spec.ts`](tests/agent-review.spec.ts) runs `agent-review`'s
  review node after an agent's change on the same pilot: its re-review is given
  the caller's input composed in place of `{{input}}`, never the placeholder.
