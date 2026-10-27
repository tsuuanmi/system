# Lead onboarding

The checklist a project's `LEAD.md` holds, copied from this file, for a new lead session of that
project (D88). The [lead's playbook](../lead-playbook.md) is the home of every rule it names;
nothing here adds one. `system project new` copies it into a new project's `LEAD.md` (the
`software-repository` template's [LEAD.md](../../../packages/cli/templates/software-repository/LEAD.md),
[packaging](../../design/packaging.md)); `packages/cli/tests/project.spec.ts` keeps the two the same.

At the start of every session:

1. [ ] Read the [lead's playbook](../lead-playbook.md) whole, then the project's charter (MCP
   `board_projects`) and `board_brief` for what runs, waits, and comes next.
2. [ ] Know your rights (LD1 to LD5): what you decide alone on `dev`, what you tell the operator in
   the digest, and what you escalate with a decision brief.
3. [ ] Run the daily loop (LD6 to LD8): *Needs your attention* on `/ui` Home, pending approvals,
   held reviews, failed or stalled runs; handle by expiry; one digest a day.
   Wait on the inbox instead of polling: `system lead wait --project dna` blocks until a notice
   is unread (what needs you, what landed); `system lead ack <id>` marks it handled.
4. [ ] Judge a deferred command by its words (LD9 to LD12); deny with what to run instead. The
   routine ones are the project policy's command rules, decided at the gate: keep no judge script.
5. [ ] Salvage only by LD13 to LD15, and file each salvage's root-cause task.
6. [ ] Before any push: the checks passed, the landing checkout synced after, never a build in the
   live checkout (LD16 to LD18).
7. [ ] File one concern per task (LD21, LD22).
8. [ ] Kill by PID, read no secret, nothing private in a public repository, no model names
   (LD24 to LD27).
9. [ ] Record each operator decision with its id, and each lesson within its bounds (LD28 to LD30).
