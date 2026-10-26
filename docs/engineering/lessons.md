# Lessons of this repository

Mistakes made in this repository before, each on one line with the check or test that now enforces
it. The brief of every run on a writing Worker (a `workspace-write` sandbox, never a review member)
carries these lines, as committed at the HEAD of the Worker's repository, in a section named
"Lessons of this repository" (agent-workers `src/lessons.ts`; T220): the lines that start with `- `,
at most 30, each cut at 400 characters. Nothing else in this file reaches a brief, and an
uncommitted edit of it reaches none.

To add a lesson, the lead or a review adds one line below and commits it: what went wrong, how to
avoid it, the task it came from, and `Check:` with what enforces it now (a check, a test, or, until
one exists, the review). Keep at most 30 lessons (`agent-workers/tests/lessons.spec.ts` fails on
more); fold or drop an old one, once a check makes it impossible to repeat, rather than add a 31st.

- Node's type stripping refuses TypeScript parameter properties (`constructor(private x)`), enums, and namespaces: a file Node runs as `.ts` itself (the workspace reads server) uses plain fields (T213). Check: `agent-runtime-core/tests/workspace-reads.spec.ts` starts that server with plain `node`.
- Parallel runs each take "the next" ADR, proposal, or store migration number, and collide when they land: take the next free one, and the change that lands second renumbers (T185, T193). Check: `pnpm check` (`check:docs`, `check:migrations`; `scripts/collisions.spec.ts`).
- A schema never changes in place: an added optional field or enum value is a minor version; removing, renaming, requiring, or narrowing a field is a new major, a new file with a tested store migration (docs/reference/schemas.md#versioning); then `pnpm gen:reference` (T185, T209). Check: `check:schemas` (`scripts/schema-snapshot.json`); the review, for a major.
- Commit only the change: a generated report, a test's JSON output, or a scratch file goes under `$TMPDIR`, never into the tree (T214). Check: the review reads `git status`; no automated check yet.
- A test never asserts on the wall clock: its data names fixed instants, and code that reads now runs with only `Date` faked (docs/engineering/testing.md, "Pin the time a test reads"). Check: the review; no automated check yet.
- A test never sleeps a fixed time and then asserts: on a loaded host the step has not started or has already ended. Wait for the event (`vi.waitFor`), and assert the property, not an order the code does not promise (the per-Worker queue test, 2026-10-26). Check: the acceptance `tests` check.
