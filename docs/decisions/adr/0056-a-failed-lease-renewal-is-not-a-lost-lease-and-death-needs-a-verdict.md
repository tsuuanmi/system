# ADR-0056: A failed lease renewal is not a lost lease, and death needs a verdict

- **Status:** Accepted
- **Date:** 2026-10-24 (accepted 2026-10-24, by the operator, D43)
- **Related:** [PROP-0013](../../proposals/0013-feedback-from-work.md) (phases L1 and L2, accepted by
  the operator in D32), [ADR-0015](0015-worker-sessions-and-peer-messaging.md),
  [ADR-0024](0024-agent-workers-confined-for-reads.md),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0040](0040-briefs-on-the-workers-and-workflow-seams.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact),
  [INV-15](../../architecture/invariants.md#inv-15-one-writer-per-subject)

## Context

PROP-0013 found three faults in how `system` decides that work is gone
([a failed probe is treated as death](../../proposals/0013-feedback-from-work.md#problem)):

- **A failed renewal was a lost lease.** `ctx.leases.hold` aborted its `lost` signal on any error
  a heartbeat's renewal threw, not only `LeaseLost`. An agent run's signal includes `lost`, so a
  transient store error (`database is locked`) during one heartbeat stopped a live agent, and its
  run failed as if another process had taken it.
- **A missing fact was death.** At restart, or once a lost lease could be retaken, the `agents`
  source failed every started run as `reconciliation_failed` on the strength of its lease alone.
  Nothing showed the agent was gone; a paused holder's agent could still be writing.
- **A blocked session took input.** A board task's next attempt resumed the session before it
  without asking whether that session's last run stopped on a tool call whose approval request is
  still open, and a peer message woke such a session too. Its only input should be that request's
  resolution.

`leases`, `workers`, and `workflow` are guarantee seams (work state machine, gate, runner). Under
ADR-0036 their contracts change only by ADR. `agentRuntimes` is a capability seam.

## Options

1. **Narrow `hold`; give death a verdict; derive a session's hold when read.** `lost` fires only on
   a positive loss. A pure rule decides whether a run is gone from recorded signals, and only its
   `dead` reconciles. The Worker source that owns a session says why it takes no input, and the
   engine asks before any automated input.
2. **Keep today's rule and retry around it.** Resubmit a run its lease lost. A run that already
   reached the agent cannot be repeated blind (INV-4), so this replays.
3. **A session state flag** (`blocked`), set when a call defers and cleared when the request
   resolves. A second copy of facts the gate's requests and the queue already hold, which drifts
   on a crash between the two writes.

## Decision

Option 1.

**Leases, contract 1.1.** `hold` aborts `lost` only on a positive loss: `renew` throws `LeaseLost`
(the row expired, was taken over, or invalidated), or the lease's own expiry passes with no
renewal. Any other error from a renewal is not a loss: the heartbeat tries again at its next beat,
and never later than the lease's expiry. Fencing is unchanged: every commit still presents the
lease inside its transaction, so a holder whose lease lapsed commits nothing whatever it was told.
It is a minor version: no record changes, and a consumer of `lost` loses no case it handled.

**The liveness verdict.** `livenessOf` in `@tsuuanmi/system-libs` (rule `liveness@1`), a pure
function beside the reconciliation decision function, over three signals and two configured bounds:

| Verdict | When |
|---|---|
| `alive` | the holder's lease is live and the agent process present, with activity within `stallSeconds` |
| `stalled` | the agent process is present, with no activity for `stallSeconds` or more |
| `unknown` | any probe failed, a signal was never reported, or anything else |
| `dead` | the holder's lease lapsed and its process is gone, the agent process is gone, and no activity was seen within `deadAfterSeconds` |

Only `dead` is death. A process is `gone` only on positive evidence from this host's `/proc`: no
process has its pid, the one that has it started at another time, it has exited, or the host booted
again since. A process recorded on another host is `unknown`.

- The `agents` source records each run's holder (the process that submitted it), its agent process
  (`RunObserver.onProcess`, optional on `agentRuntimes`), and its activity (the submission, then
  `onActivity` at most once per heartbeat).
- A started run whose holder no longer holds it gets a verdict before it is reconciled. `dead`
  fails it as `reconciliation_failed`, never run again, with a `reconciliation` decision naming
  every signal. An open activity window is waited out, and that wait is not counted. Any other
  verdict is looked at again with a bounded backoff. After `maxUnknownVerdicts` it goes to the
  operator (`reconciliation_failed`, `USER_ACTION`), with the decision saying it is not declared dead.
- A run that ended without a `dead` verdict holds its session and its worktree (INV-15). The source
  runs nothing more in either, and the retention sweep keeps the worktree.
- A running agent whose process is present and that has been quiet for `stallSeconds` is reported
  once per stall (`agent-workers.run.stalled`). It is never prodded or stopped; its own deadline and
  turn limit end it.
- Website turns keep their receipts; the verdict does not apply to them.

**No automated input to a held session.** `WorkerSource.held` and `Workers.held`, optional and
additive on the `workers` seam, say why a session takes no input now. The source derives it when
asked, from durable facts, never a flag:

- its latest run has not finished;
- any of its runs ended without being known to be gone;
- its latest run stopped on a deferred tool call whose approval request is still open (the run
  records the request, and the queue is asked).

A source that cannot tell says so, and is never read as free (INV-2). The engine asks before every
automated input:

- A board task's next attempt does not resume a held session. It starts a fresh session given the
  brief, and the `workflow.task-session` decision says why.
- An automated wake on a peer message keeps the mail durable and unread until the session takes
  input, looking again at each queue poll and at start.
- The only input such a session takes is its request's resolution: the engine's one continuation
  of an approved deferred call. A provider of `ctx.workers` without `held` cannot show a session
  free, so the engine gives it no automated input.

The `workerSessions` mailbox contract is unchanged, so ADR-0015 needs no amendment: delivery still
appends to the mailbox, and only the engine's wake decides when a turn is taken.

## Consequences

- A transient store error no longer stops a live agent run. A lease that lapsed while its holder
  could not reach the store still stops it, at the lease's expiry.
- After a restart on one host, a Claude Code run's holder and confined agent are usually gone
  (`--die-with-parent`), and the run fails as before, now with its verdict, once the activity
  window has passed. A runtime that reports no process (Codex, ACP, the Antigravity CLI today)
  leaves its runs `unknown`. Such a run reaches the operator after `maxUnknownVerdicts` looks, and
  its session and worktree stay held. Before, it failed at once, and its session could be resumed.
- A run started before this change records no holder and no process. At the first restart after
  the upgrade it is reconciled as `unknown`, so it reaches the operator.
- A session held for good, because its run ended `unknown`, is never resumed. Later work starts
  fresh sessions. Freeing it is the operator's judgement; no command for that exists yet.
- Contract versions: `leases` 1.1 (two scenarios: a renewal error keeps the lease, and every
  renewal failing loses it at expiry and fences the old holder's commit); the `workers` suite
  checks `held` where a provider offers it; the `agentRuntimes` provider suite checks a reported
  process and activity are consistent, or absent.
- Revisit if a runtime other than Claude Code can report its agent process, or if the operator
  needs a way to free a session held by an `unknown` run.

## Amendment (2026-10-24): the operator frees a held run, and a cancel gets a verdict

The second revisit condition came (T74's "not finished"). Nothing above changes: only `dead` is
death, and nothing automated frees what an `unknown` run holds. Three additions, each additive and
optional on the `workers` seam (ADR-0036):

- **Freeing is the operator's word, recorded.** `agent_run_free` (operator scope,
  `mcp-agent-runs@1.0`; `system free <run> --agent-gone`) frees the session and worktree of a run
  that ended without being known to be gone, only with the operator's statement that its agent is
  gone, recorded first as their `reconciliation` decision (decider `operator.free`) with the signals
  as the host shows them then (INV-13). It is refused while the run's liveness is still being looked
  at, while a process holds its lease, and while its holder or agent process is present on this
  host, whatever the operator said (INV-2). A worktree is removed only when it holds nothing
  uncommitted, or with an explicit flag once its changes are committed on its branch; the branch
  always stays.
- **An operator cancel takes the verdict path.** A cancel of a started run that no process holds
  used to fail it `aborted` with no verdict, freeing its session though its agent might still act.
  It now gets a verdict first, as a reconciliation does: `dead` ends it as gone, anything else ends
  it `aborted` not known to be gone and held as above.
- **The operator sees it.** `WorkerSource.liveness` and `Workers.liveness` tell the runs that are
  stalled, being looked at, or held for want of a verdict; `status`, `explain`, the roster, and the
  report show them ([what the operator sees](../../design/agent-runtimes.md#what-the-operator-sees)).
