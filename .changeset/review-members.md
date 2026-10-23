---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-agent-workers": minor
---

A read-only agent Worker the operator names a review member can now be a member of a `review` team (ADR-0045, proposed; the operator decides):
- Routing takes capability offers scoped to one kind of work (`capability-descriptor@1.4`), and a requirement names its kind (`work-requirement@1.1`). The only kind is `review-member`, which the workflow engine names on every proposal, ballot, and debate step of a `review` team. A scoped offer counts for that work only, and a refusal says so (`does not prove reason (it proves reason only for review-member work)`).
- An agent Worker configured `reviewMember: true` (read-only only; a writer is refused at load) offers `reason` for a review member's steps only, never for an ask, a brainstorm, research, a planner, or a digest, so agent-plan quota is spent on nothing else. The quota order is unchanged: a website Worker still comes first where it is admitted.
- On a runtime that resumes a conversation (Codex, Claude Code), a member's steps continue its native session. On one that cannot (the Antigravity CLI), the `agents` source keeps the member's conversation by replay: each later turn is sent the member's earlier messages and answers, in order, then the new message, bounded by `maxReplayChars` (default 200,000; past it a turn fails unsent, never cut), and checked at egress as sent. A runtime that does not report `resume` is never asked to resume, and a session it cannot resume outside a review member's steps is refused before anything is sent.
- A board task's session is resumed only on a conversation its Worker keeps for any work.
