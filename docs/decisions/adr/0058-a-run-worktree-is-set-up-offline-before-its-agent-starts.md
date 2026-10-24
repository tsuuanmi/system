# ADR-0058: A run's worktree is set up offline, under the policy, before its agent starts

- **Status:** Accepted
- **Date:** 2026-10-24 (accepted 2026-10-24, by the operator, D49)
- **Related:** [ADR-0024](0024-agent-workers-confined-for-reads.md),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0038](0038-confined-commands-for-claude-code-workers.md),
  [ADR-0041](0041-policy-changes-through-the-approval-queue.md),
  [ADR-0050](0050-the-queue-proposes-a-policy-change-from-repeated-approvals.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in),
  [INV-12](../../architecture/invariants.md#inv-12-data-egress-is-explicit),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact),
  [INV-15](../../architecture/invariants.md#inv-15-one-writer-per-subject)

## Context

With `worktreePerRun`, a writing Worker works in a new git worktree of its repository for each
workflow run, on `system/run/<runId>`
([workspaces](../../design/agent-runtimes.md#workspaces)). That worktree is a checkout: it holds
what git tracks, so no dependencies. Its commands run in the runtime's sandbox, with no network
([ADR-0038](0038-confined-commands-for-claude-code-workers.md)). So the repository's own tests,
lint, and typecheck cannot run there, for the Worker or for `validate:1`. The runbook said so:
"prepare dependencies in the repository first", which a new worktree never is. This blocks moving
`system`'s own development into `system` (T70 phase 2).

What the host already has: the operator's package manager keeps a content-addressed store of every
package it has installed. On this host (`pnpm` 12.9.1, its store `v11`), checked live on
2026-10-24:

- an offline install of `system` from that store takes about 2 s outside a sandbox;
- under bubblewrap with the store **read-only**, it fails: the store's index is an SQLite database
  in WAL mode, which cannot be opened where its directory cannot be written, and the installer then
  finds no package ("snapshot not present in local store");
- hard links from the store into the worktree fail across bind mounts (`EXDEV`), and would let a
  Worker that writes its worktree change the store's files for every project: a store bound
  writable would too;
- an overlay (bubblewrap's `--tmp-overlay`) needs overlayfs in a user namespace, which this host's
  kernel (5.4) refuses;
- the store's files read-only, a private copy of its index writable, and the packages copied (not
  linked) into the worktree: the offline install passes (about 5 s, 684 MB for `system`), and the
  host's store is unchanged.

The change must keep the tool gate (every command the policy's to allow, by its exact argv), the
read confinement (ADR-0024), no network (INV-12), and fail closed with a named cause (INV-2). It
must name no tool in code (INV-11), and change no guarantee seam's contract beyond an additive,
optional field (ADR-0036).

## Options

1. **Network for the install.** An allow list for a package registry is an egress decision
   (INV-12), widens every run's sandbox for one step, and still runs the install inside the agent's
   turn. Rejected.
2. **Bind the main checkout's dependencies into the worktree.** They follow the operator's checkout,
   not the run's lockfile, and a writing Worker could change them. Rejected.
3. **Bind the host's store writable**, or hard-link from it. A setup's scripts, or a Worker writing
   its worktree, would change the operator's store. Rejected.
4. **The Worker installs them itself.** Its sandbox has no network and cannot open the store's
   index read-only; it would need option 1 or 3. Rejected.
5. **A per-repository setup step the operator declares, run by the `agents` source when a run
   first works in a new worktree, before the agent starts, under the policy, confined, with no
   network; a host directory the setup must write (the store's index) is a private view.** Chosen.

For the approval of a setup command the policy asks about:

6. **A standing approval of the setup's hash**, reused by every later worktree. That is a commands
   list outside the policy: a standing permission belongs in the policy, changed only through a
   `policy-change` approval ([ADR-0041](0041-policy-changes-through-the-approval-queue.md)).
   Rejected.
7. **One approval per worktree, per command, per setup hash, used once**, as a Worker's deferred
   call is used once; a standing permission is the policy's commands list, which the operator
   changes as for any command, and which the queue may propose after repeated approvals
   ([ADR-0050](0050-the-queue-proposes-a-policy-change-from-repeated-approvals.md)). Chosen.
8. **The engine continues the run by itself once approved**, as it does for a deferred tool call.
   The engine continues only a sent execution with a deferred event; a setup's wait is unsent.
   Teaching it this would change the `workflow` seam. Left: the operator continues the run
   (`system continue <runId>`).

## Decision

Options 5 and 7.

### The setup (`agent-workers`, `worktreeSetup`)

- **Declared per repository** by the operator (INV-6): the repository (a `worktreePerRun` Worker's
  workspace, else refused at load), 1 to 16 command lines (each its words split on single spaces,
  no shell metacharacter, at most 200 characters: the policy's own bound, so each can be listed in
  its commands), optional views, and a deadline (`timeoutSeconds`, default 600, at most 3600).
- **When:** an agent run that works in a workflow run's worktree, before its brief's files are
  written and before anything reaches the agent, when the worktree's setup has not run under the
  definition loaded now. Once it has (its hash stored on the worktree), later runs of the workflow
  run, reviewers included, work in it as it is. A worktree added again from its branch is set up
  again. One setup at a time per worktree.
- **The policy decides each command** (`ctx.approvals.check`, class `command`, its exact argv), as
  for a Worker's `Bash` call: `forbid` refuses the setup; `auto` and `notify` let the command run,
  their required checks pending (they bind when the run's result is accepted); `ask` opens one
  approval request per command, subject `content` `agent-worktree-setup:<repository key>/<run id>:<n>`
  at the setup's hash (INV-5), and the run waits. Approved, the next run of the workflow run uses
  it once; open, it waits again on the same request; rejected, expired, or withdrawn, that
  worktree's setup is refused, with nothing new queued. A changed setup is another hash: asked
  again. No queue loaded: nothing runs.
- **Confined:** the read confinement (ADR-0024, its hidden paths), with the host's file system
  read-only except the worktree, a network namespace of its own (loopback only), a private `/tmp`,
  its own PID namespace, the deadline, and the daemon's scrubbed environment. A **view** shows the
  setup a host directory as a private, writable one of its own: the files it names copied in, the
  paths it names bound back read-only, removed when the setup ends. A view of, or holding, a path
  hidden from agents, or overlapping the worktree, is refused. The confinement is proven on the
  host (`proveConfinement`) before each setup runs. `agent-runtime-core`'s `confinedCommand` takes
  these as optional options; with none, its command line is an agent child's, as before.
- **Fails closed:** a setup not allowed, waiting, or failing (a command's exit, signal, or the
  deadline, its output's last part named) fails the run as `config_error`, unsent, naming the cause
  and the decision. It is never skipped: the next run of the workflow run tries again.
- **Recorded:** each setup is a `gate` decision of rule `agent-workers.worktree-setup` (`start` or
  `refuse`, its inputs the policy's decisions and the approvals used), named among the run's
  decisions, and an `agent-workers.worktree.setup` event (`ran`, `refused`, `waits`).

For `system` on this host the operator declares `corepack pnpm install --frozen-lockfile --offline
--store-dir=<store> --package-import-method=copy`, with a view of the store that copies its index
and binds back its files ([runbook](../../operations/runbooks.md#set-up-a-runs-worktree)). The code
names no package manager: the command and the view are configuration.

### Unchanged

The `workers` and `workflow` seams, the approvals seam (a request is a `command` request like a
Worker's), every schema (`gate` is a decision type already), the agent runtimes' contracts (an
optional parameter on a helper only), cleanup (the worktree is committed and removed by the
retention sweep as before; the files the setup wrote are ignored by the repository and go with
it), and every Worker of a repository with no setup.

## Consequences

- A writing Worker's worktree and `validate:1` can run the repository's checks without a network,
  once the operator declares the setup and lists its command in the policy (or approves it per
  workflow run).
- Each setup copies the dependencies into the worktree (684 MB for `system`), kept as long as the
  worktree (`worktreeRetentionHours`).
- A setup runs repository content (install scripts) at the HEAD the worktree was cut from, under
  the same bounds as a Worker's own commands: no network, the host read-only but the worktree.
- A setup that waits for an approval needs the operator's `system continue <runId>` after approving;
  the engine does not continue it by itself. A board task's next attempt is a new run with a new
  worktree, which asks again, so for board work the setup's command belongs in the policy's
  commands list.
- The standing way to let a setup run is the operator's (D50, 2026-10-24): list the exact setup
  command in the studio policy's `commands`, one `policy-change` approval, so every worktree's
  setup runs unasked. Approving it per workflow run and `system continue` stay for a one-off; the
  engine is not taught to continue a setup's wait.

## Where it leaves room

- A view copies files while the operator's tools may be writing them: a copy torn mid-write fails
  the setup (closed), never a silent install.
- The store's files are read-only to the setup, not checked: a store the operator's own tools
  corrupted gives a corrupt install, as it would outside `system`.
- The setup's output is kept only as the last part of a failure's message (INV-9).
