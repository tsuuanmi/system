---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-agent-workers": minor
---

A read-only agent Worker under the enforced review-member profile can now be a member of a `review` team (ADR-0049, proposed; the operator decides, D19):
- Routing takes capability offers scoped to one kind of work (`capability-descriptor@1.4`), and a requirement names its kind (`work-requirement@1.1`). The only kind is `review-member`, which the workflow engine names on every proposal, ballot, and debate step of a `review` team. A scoped offer counts for that work only, and a refusal says so (`does not prove reason (it proves reason only for review-member work)`).
- An agent Worker configured `reviewMember: true` (refused at load unless read-only, with its `family` named, and no worktree per run) runs a review member's steps under the review-member profile: its workspace must be an empty directory outside any git work tree (checked before and after the step), and the run's gate denies every tool call. The profile grants `reason` for those steps only, while the Worker is ready (its runtime enforces the read-only sandbox, keeps host state unreadable, and gates every tool call), never for an ask, a brainstorm, research, a planner, or a digest. A Worker not under the profile never runs such a step.
- On a runtime that resumes a conversation (Codex, Claude Code), a member's steps continue its native session; a step with earlier turns and no native session is refused, never started fresh. On one that cannot (the Antigravity CLI), the `agents` source replays the member's earlier turns exactly (each its message and its answer, in order) before each later one, fixes which runs it replays when the run is first prepared, and records them with the answer (`agent-result@1.3` `replay`: runs, answers, hash of what was sent; the answers are the artifact's inputs). A replay fails closed, unsent: an earlier turn still open, one not run under the profile, an answer no longer stored, or more than `maxReplayChars` (default 200,000). A runtime that does not report `resume` is never asked to resume, and a session it cannot resume outside a review member's steps is refused.
- An agent Worker may name its provider `family` (default: its runtime), so team members of one vendor stay apart; a review member must.
- A board task's session is resumed only on a conversation its Worker keeps for any work.
