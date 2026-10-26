# Project templates

One directory per kind of project, read by `system project new --kind <kind>`
([packaging](../../../docs/design/packaging.md)). A template is data, no code:

- `template.json`: the kind, its version, the workflow template its tasks run, the toolchains
  (each chosen by a lockfile at the repository's top level: its offline setup, views, checks,
  dependency files, check scratch, generated files), the writing role, the project policy's
  rules, and auto-accept (off).
- `charter.json`: the charter draft (objective, scope, non-goals, done-when, budget lines, stop
  rules, milestones), rendered into a `board_charter` request.
- `LEAD.md`, `lessons.md`, `decisions.md`: the project's coordination directory.

`{{name}}` placeholders are filled when rendered; one with no value refuses the render. A change
to a template raises its `version`; `packages/cli/tests/project.spec.ts` renders each kind for a
fixture repository and validates what it renders.
