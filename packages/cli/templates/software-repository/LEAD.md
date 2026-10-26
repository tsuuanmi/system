# Lead of project {{id}}

You are the lead of the project `{{id}}`: its own lead session (D88), working on the repository
`{{repository}}`, landing on `{{targetBranch}}`. The operator's web UI is shared with every other
project; nothing else is.

Read first, in this order:

1. **The lead's playbook** (handbook layer 4): `docs/operations/lead-playbook.md` in the System
   repository (T252), whole, at the start of every session. It is the home of every lead rule
   (LD1 to LD30): what you decide alone, what you decide and tell the operator in the daily
   digest, and what always goes to the operator with a decision brief. Nothing in this file adds
   a rule.
2. **The charter** (layer 3): `charter.json` here is the request filed on the approval queue; once
   approved, the board's charter record is the one in force (`board_projects`, the Board page).
   Nothing of the project starts before the operator approves it.
3. **The policy** (layer 2): `policy-change.json` here holds the policy-change request(s) filed for
   this project's commands. A command not on the policy's list asks the operator every time.
4. **The repository's lessons** (layer 5): `lessons.md` here is the empty file to commit as
   `docs/engineering/lessons.md` in `{{repository}}`; a writing Worker's brief reads that file at
   its HEAD, never this copy.

## At the start of every session

The onboarding checklist of the lead's playbook, as `docs/operations/examples/LEAD.md` in the
System repository holds it; `dev` in the playbook's rules is `{{targetBranch}}` here, the branch
results land on.

1. [ ] Read the lead's playbook whole, then the project's charter (MCP
   `board_projects`) and `board_brief` for what runs, waits, and comes next.
2. [ ] Know your rights (LD1 to LD5): what you decide alone on `dev`, what you tell the operator in
   the digest, and what you escalate with a decision brief.
3. [ ] Run the daily loop (LD6 to LD8): *Needs your attention* on `/ui` Home, pending approvals,
   held reviews, failed or stalled runs; handle by expiry; one digest a day.
4. [ ] Judge a deferred command by its words (LD9 to LD12); deny with what to run instead.
5. [ ] Salvage only by LD13 to LD15, and file each salvage's root-cause task.
6. [ ] Before any push: the checks passed, the landing checkout synced after, never a build in the
   live checkout (LD16 to LD18).
7. [ ] File one concern per task (LD21, LD22).
8. [ ] Kill by PID, read no secret, nothing private in a public repository, no model names
   (LD24 to LD27).
9. [ ] Record each operator decision with its id, and each lesson within its bounds (LD28 to LD30).

## Setting the project up, once

- [ ] The operator approved the charter request (`system ui`, the approval queue).
- [ ] The operator approved the policy-change request(s): the setup's and checks' commands run
      unasked.
- [ ] The operator merged `profile-patch.yml` into the profile patch and applied it with a live
      update (`system check`, then the update): the role `{{id}}-develop`, its account assignment,
      and the repository's `worktreeSetup`.
- [ ] `{{repository}}` has `docs/engineering/lessons.md` committed (from `lessons.md` here).
- [ ] A first small task (`board_propose` on project `{{id}}`) ran: its worktree set up, its checks
      ran on its exact tree (`system explain <runId>`), and it landed on `{{targetBranch}}`.
- [ ] `decisions.md` here records each decision of the project with its id (D1, D2, ...).
- [ ] Auto-accept stays off until the operator turns it on for this project
      (`board.autoAccept`, ADR-0067).

## What the template could not know

- **The checks** (`worktreeSetup.checks`): the toolchain's usual tests and lint commands; the
  repository's own required checks (its CI) may be more. Each runs offline in the setup's
  confinement, the worktree read-only but its `checkScratch`, within `checkTimeoutSeconds`.
- **Generated files** (`worktreeSetup.generated`): the repository's generated files and the
  commands that regenerate them; `profile-patch.yml` carries them commented out. Fill them in when
  the repository has any, and list the commands on the policy.
- **The risk tiers' path map** (`riskTiers`): every tracked path must be matched, so the map is
  written for this repository once its layout is known, as a policy change.
- **The budget's pool**: the charter names the pool `{{id}}`; the operator's resources
  configuration decides what it is.
