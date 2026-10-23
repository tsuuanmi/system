# Documentation policy

## Standard

`system` adopts the
[DNA Documentation Architecture Standard](https://github.com/tsuuanmi/DNA/blob/main/docs/governance/documentation-architecture.md)
by reference. The standard is not copied here. This file records only
`system`-specific choices.

## Adopted areas

The repository uses the minimum set (`requirements/`, `architecture/`,
`decisions/`, `engineering/`) plus `design/`, `proposals/`, `research/`,
`security/`, `reference/`, `validation/`, `operations/`, and `governance/`,
because each has real content. Machine-readable schemas live in the root
`schemas/` directory, which has its own README.

## Identifiers

| Id | Home | Stability |
|---|---|---|
| `REQ-<FAMILY>-<n>` | [requirements/SRS.md](../requirements/SRS.md) | never reused |
| `QA-<n>`, `CON-<n>` | [requirements](../requirements/README.md) | never reused |
| `INV-<n>` | [architecture/invariants.md](../architecture/invariants.md) | changed only through an ADR |
| `ADR-<nnnn>` | [decisions/adr](../decisions/adr/README.md) | append-only |
| `PROP-<nnnn>` | [proposals](../proposals/README.md) | status in front matter |

## Target and current state

Requirements, architecture, and design documents describe the **target** system
and say so in a "Target state" header, which stays when code lands. Current
state has its own homes, set out in
[status ownership](../README.md#status-ownership): package READMEs say what is
built, and a design document links to its implementation in one line, noting
where it differs from the target. A change that makes the code differ from a
canonical document corrects one of the two in the same change.

## Amending an accepted ADR

An accepted ADR is not rewritten. A clarification that does **not** change the
decision, such as a detail found while implementing it, may be appended as a
dated section, `## Amendment (YYYY-MM-DD): <title>`, below the original text.
Anything that changes the decision needs a new ADR that supersedes the old one,
in whole or in part.

## Work state and conversations

What the operator and the agents building `system` decide and do lives in artifacts any later
Worker, of any vendor, can read; never only in one session's memory:

- a product decision goes into these documents (an ADR, a requirement, a design);
- dialogue, decisions waiting on the operator, and the state of delegated work are the system's own
  records (`decision` artifacts, approval requests, board tasks), each answer recorded with its
  time and who gave it;
- a Worker reads them through its brief and the git-ignored `.system/` projection in its run's
  worktree ([TASKS.md in a run's workspace](../design/workflow-engine.md#tasksmd-in-a-runs-workspace)),
  which names its sources and is never authoritative.

No vendor's folder (`.claude/`, `.codex/`, `.agents/`) holds them
([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)).

## Enforcement

CI checks the documentation structure and links (`pnpm check:docs`) and the
freshness of generated pages ([CI gates](../engineering/testing.md#ci-gates)).
Reviewers also check that:

- every fact has one canonical home. Diagrams of the layer map live only in
  [architecture/README.md](../architecture/README.md);
- diagrams are Mermaid, so they render on GitHub and stay diffable.
