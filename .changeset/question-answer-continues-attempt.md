---
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-board-core": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-web-ui": patch
"@tsuuanmi/system-agent-runtime-core": patch
"@tsuuanmi/system-libs": patch
---

A Worker's question no longer spends an attempt (T291): answering a question wait continues the attempt that asked.
- `answer` leaves `attempts.count` as it was, also on the last attempt (it used to end `retries-spent`), and the policy is still asked for the continuing attempt. A flag beside the record (`board_tasks.continues`, store migration 5; `Board.continuing`) lets the next `start` run that same attempt again, not count another; its decision says `continues`. The conformance board does the same.
- The workflow engine continues the asking step: at the first turn of the run after an answer, once its carry settled, the run takes the asking run's steps, the completed ones kept as they ended (they do not run again), and the asking step runs again on its own session, resumed on its Worker when that Worker keeps it, the answers its next message; a step with no session of its own starts a new one of the same attempt, its brief carrying the answers. A step whose result is bound to the asking run's tree (a writing step, one whose result names its worktree, or one bound to its subject) is never kept, since its result would point the run's review, checks, and landing at the asking run's worktree: the template then runs again from its first step on the same attempt, in the run's own worktree, which the carry gave the change. When the asking step is itself a writing step, its tree (the edits it made before it asked) is the attempt's change, kept on the asking run's branch (T271) and carried, and the step resumes on a worktree the carry gave that tree, or when it asked before changing anything (the source refuses the tree as empty: nothing is lost); otherwise the run starts again in a new session, every brief saying the edits are gone. A board that cannot say whether a start continues an attempt fails the start before the task is taken. The choice is an `admission` decision (`workflow.task-continue`), written in the transaction that rewrites the steps. Briefs, carries, and admission decisions name the continued attempt.
- An answered question's approval request names the wait it answers (`board-task:<id>:attempt:<n>:answered:<wait>`), also when a policy change withdraws it and the board asks again, so no other gate of the same attempt adopts its approval.
- Only a step that fails or is rejected spends an attempt. Every brief that offers to ask says so: the answers continue the attempt, and asking spends none.
- The confined-shell spec (agent-runtime-core) has the integration specs' 120 s test timeout: it runs tens of real shells in sequence and ran past the 5 s default under load.
- Docs: the board design (waits), the lead playbook (answering), the runbook's waits, the workflow engine design (a question from a run), the board and workflow READMEs, and the `board_update` reference.
