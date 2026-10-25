# Engineering

This area covers **how `system` is built and delivered**: developer setup, code
quality, dependencies, testing, CI, and releases.

| Document | Owns |
|---|---|
| [development.md](development.md) | toolchain, workspace layout, local commands |
| [code-quality.md](code-quality.md) | style, module size, dependency hygiene |
| [dependencies.md](dependencies.md) | dependency register: what is reused, adapted, or built ([ADR-0010](../decisions/adr/0010-reuse-before-build.md)) |
| [testing.md](testing.md) | test levels, conformance suites, fixtures, the smoke, upgrade, and crash suites, CI gates (the release checklist is in [validation](../validation/release-checklist.md)) |
| [releasing.md](releasing.md) | versions, changesets, cutting and verifying a release |
| [lessons.md](lessons.md) | the repository's lessons: mistakes made here before, one line each with what enforces it now, carried in every writing Worker's brief; the lead or a review adds one by committing a line |
