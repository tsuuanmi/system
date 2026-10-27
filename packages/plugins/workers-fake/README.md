# @tsuuanmi/system-workers-fake

The `fake` Worker source (T323): scripted Workers for the `system-test` profile, so its canary
(`scripts/live-stage.sh`) runs `ask`, `research`, and `algorithm-development` with no website or
agent account. It is off in the bundle; the test profile's patch turns it on.

- Workers `fake:economy`, `fake:standard`, `fake:frontier` (`reason`, `develop`), and `fake:developer`,
  `fake:reviewer`, `fake:reviewer-2` (the roles a review needs).
- Every execution completes on the next turn of the event loop: an approving review for a step that
  names a subject, a vote on each important finding of a verification step, otherwise the prompt
  echoed. Results are `provider-answer@1.0` artifacts.
- For a writing step of a board task's run (develop), it first appends an `evidence` entry to the
  task's dossier through `ctx.workflow.appendToDossier`, as a writing Worker does, saying it ran no
  command, so the step's evidence gate passes on what it really did. The engine refuses that entry for
  any other step, and the fake goes on without it.
- No network, no account, no model; executions are kept in memory only (a restart forgets them).
  It makes no promise about a real Worker: it proves that the engine, the routing, and the
  acceptance run the work, which is what a staged update must show.
