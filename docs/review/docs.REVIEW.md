---
paths:
  - docs/
  - AGENTS.md
  - CONTRIBUTING.md
  - README.md
  - .changeset/
owner: lead
version: 1
---
# Review guide: documentation, changesets, and the review guides themselves

## What failure looks like here
- A statement that is not true of the code in the tree: a path, a command, a default, a field, or a step that was renamed or removed. Read the code the sentence is about.
- A fact written in two places: one canonical home, the rest link (documentation policy). A new rule with no named check, and no "check: none" said.
- A numbered document (ADR, proposal, migration) that takes a number another change took; a link or an anchor that does not resolve; a conflict marker left in a rebased file.
- An accepted ADR rewritten instead of amended or superseded.
- A generated file (reference, schema snapshot, manifests, traceability) edited by hand, or not regenerated after the change that feeds it.
- A user-visible change with no changeset, or a changeset naming the wrong package or bump.
- A review guide that loosens review (a longer nit cap, a skipped path that hides code) or changes the evidence rule without the owner's name in the change. A guide is a rule for reviewers: read it as one.

## What to check first
1. Pick three concrete claims in the change and verify each against the code.
2. Run or read the generators' freshness checks named in the change's evidence.
3. The README of any directory the change adds a file to.

## Paths to skip
- `docs/research/` and `docs/proposals/` bodies (context only, never rules) unless the change edits their status.
- Generated tables: check they were regenerated, not their contents.

## Nit cap
At most 5 nits in all, then "and N more nits". Wording preferences are nits; a false statement is important.

## Evidence rule
Every finding names a file and a line and quotes the sentence; a "this is false" finding also names the file and line of the code that shows it.

## Summary rule
Open with the count: "1 important, 5 nits, 0 pre-existing". Then list the claims you verified, one line each.
