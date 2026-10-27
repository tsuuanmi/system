# Contributing

How to change this repository, for people and for the Workers a board task's run gives a change
to ([give work to System Workers](docs/engineering/development.md#give-work-to-system-workers)).
The [engineering docs](docs/engineering/README.md) are canonical; this page is what a writer must
not miss.

## Before you finish

Run the generators your change needs, then the gate, from the repository's top level:

```sh
corepack pnpm gen:manifests
corepack pnpm gen:reference
corepack pnpm gen:traceability
corepack pnpm check
corepack pnpm test:related <the files you changed>
```

A Worker never runs the full suite: the acceptance runs the tests related to the result's files, and
the landing runs the full suite once on the rebased tree ([testing](docs/engineering/testing.md#tests-scale-with-the-change)).

Record a user-visible change with a changeset ([releasing](docs/engineering/releasing.md)).

## Take the next free number

Other changes are written beside yours, from the same tree, and each takes "the next" number. On
2026-10-26 two runs wrote ADR-0065 and two added agent-workers store migration 18. `pnpm check`
refuses each collision ([what parallel changes collide on](docs/engineering/testing.md#what-parallel-changes-collide-on)):

- **An ADR or a proposal:** the number after the highest in
  [`docs/decisions/adr/`](docs/decisions/adr/README.md) or [`docs/proposals/`](docs/proposals/README.md)
  on the branch you land on, never a number another file holds. Numbers are never reused.
- **A store migration:** the version after the highest in that owner's list (an owner is the first
  argument of `ctx.store.migrate`; agent-workers keeps some of its migrations as constants in other
  modules, such as `GATE_MIGRATION`), appended at the end of the list. Never change or renumber a
  migration that has landed: an install that ran it never runs it again.
- **A schema change:** requiring a property, no longer requiring one, removing one, or narrowing or
  relaxing an existing field is a new version: add its note (`1.10 adds …`, `1.10 makes … optional`)
  to the schema's description, take the version after the highest the schema names, and run
  `pnpm gen:reference` to commit its new contract snapshot. A field is never changed in place
  ([schema contracts](docs/engineering/testing.md#schema-contracts-against-a-committed-snapshot)).

When your change lands after another that took the same number, yours renumbers: rename the file
and its links, or move the migration to the next free version.
