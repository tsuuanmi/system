---
"@tsuuanmi/system-agent-workers": minor
---

Each writing Worker's brief carries the repository's lessons (T220, operator D82 #8): the same mistakes recurred on 2026-10-26 (TypeScript parameter properties in a file Node runs by type stripping, T213; colliding ADR and migration numbers, T185 and T193; schema contracts changed in place, T185 and T209; a stray generated report committed, T214; tests that read the wall clock).
- A run on a writing Worker (`workspace-write`, never a review member) is sent a section "Lessons of this repository" before its Tools section: the `- ` lines of `docs/engineering/lessons.md` as the Worker's repository has it committed at HEAD (read by git, never from the working tree, so an uncommitted edit, a Worker's included, never reaches a brief), at most 30 lessons of at most 400 characters each, the rest counted. No such file, or no repository, is no section. It is appended before the egress check, which sees it.
- `docs/engineering/lessons.md` is seeded with those lessons, each with the check or test that now enforces it; the lead or a review adds one by committing a line. A test fails when it holds more than 30 lessons, or one without its `Check:`.
