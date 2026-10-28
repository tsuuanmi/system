# The System's resource footprint per run, and a capacity model for more Workers (T337 research, 2026-10-28)

Non-normative research for the operator's remark of 2026-10-28: "it may be using a lot of RAM and
disk; needed to scale up to many Workers". D108 keeps 6 runs at once until the loop is clean; this
document says what 12 or 20 would cost, what to change first, and what to measure before changing it.
No code, configuration, or other document was changed.

## How to read it

Every number carries its origin:

- **[lead]** measured by the lead on 2026-10-28 (host: 1 TB RAM, 256 cores, shared with other users'
  jobs; `/` at 99 %, 166 GB free of 8.7 TB). The daemon idle holds 0.5 GB RSS; a run worktree is about
  710 MB; 46 worktrees held are 32 GB (71 GB the night before); 99 live-update backups are 25 GB; the
  store `system.db` is 875 MB; 1,555 workflow steps ran in 3 days (develop 261, review 412, fix 238,
  selfreview 188, verify 165, second-family review 157, validate 106).
- **[code]** read from the repository at this run's base (the file is named).
- **[derived]** arithmetic on the two above. The formula is shown, so a better input replaces it.
- **[assumed]** a planning figure with no record behind it. Each is listed in
  [what must be measured first](#4-ranked-recommendations-and-what-to-measure-first) and is to be
  replaced by a measurement, never trusted.

**What this run could not do.** It ran confined in its own worktree: the live store, the event log,
`~/.dsh`, `~/system-backups`, and `/proc` of the daemon's other runs are not readable from here, and
nothing was run on the host (no `du`, `free`, `ps`). So **no step or check duration, and no process
memory, is a record in this document**: those are named as unmeasured, with the exact way to read or
take them. Everything about disk below is the lead's measurement or arithmetic on it.

## 1. Per run and per step

### 1.1 What a run holds and runs

A workflow run of a board task (template `algorithm-development`) holds, from its first agent run
until retention removes it:

| What | Where | Lives |
|---|---|---|
| a git worktree of the repository, with its own `node_modules` | `~/.dsh/system/worktrees/<repo key>/<run id>` | from the first agent run until `worktreeRetentionHours` after the last one ended |
| the branch `system/run/<id>` | the repository's `.git` | never deleted |
| its agent sessions (transcripts) | the Workers' homes under `~/.dsh` | not measured; not pruned by any rule read here |
| rows and artifacts: steps, agent runs, events, decisions, briefs | `system.db` | event log: forever (`retainDays` 0, see 2.5); private text 30 days |
| processes, per step: one agent runtime (its CLI or SDK child), its bubblewrap, and what the agent starts (git, tests, tsc, rg) | the host | the step |

Checks run in two places, which matters for the model:

1. **The System's own acceptance checks** (`tests`, `typecheck`, `lint` on a result) run through one
   host-wide queue, `hostChecks` (`packages/plugins/agent-workers/src/check-queue.ts`, T292):
   `checks.maxConcurrent` at once (default 2) across every run, each told
   `SYSTEM_CHECK_MAX_WORKERS = min(32, floor((cores − 1) / maxConcurrent))` [code]. On this host that
   is `min(32, floor(255 / 2))` = **32 test workers per check, 64 at most for the host**. This part
   does not grow with the number of runs; its queue wait does.
2. **An agent's own `pnpm test:affected` / `test:related` / `pnpm check`**, which it runs through its
   `Bash` tool inside its confinement. Nothing in `checks.ts` or the runtime sets
   `SYSTEM_CHECK_MAX_WORKERS` for it (a search of the source finds the variable set only for the
   queued checks [code]), so vitest's own default applies: `maxWorkers = min(32, cores − 1)` = **32 forks
   per invocation** (`vitest.config.ts` [code]). Six runs testing at once ask for 192 forks, twelve for
   384, twenty for 640, on 256 shared cores. **This, not the queue, is what grows with the runs.**
   The comment in `vitest.config.ts` records the failure it caused: at 255 workers tests of 1 to 2 s
   passed their 5 s bounds.

No part of the confinement bounds a run's memory, CPU, processes, or disk: bubblewrap is started with
`--unshare-pid` and `--new-session` and no cgroup, rlimit, or quota (`packages/agent-runtime-core/src/index.ts`
[code]). A runaway agent process, a test fork leak, or a runaway `node_modules` write is bounded only
by its deadline and by the host (INV-9 holds for time and text, not yet for these).

### 1.2 Disk, per run

| Item | Size | Origin |
|---|---|---|
| worktree, total | 710 MB (46 held = 32 GB; 696 MB mean) | [lead] |
| of which `node_modules` | "mostly": the share is not recorded; the tracked tree plus the worktree's git state are the rest, small by comparison | [lead]; the split is **unmeasured** |
| why it is a full copy | `--package-import-method=copy`, since the store is a read-only bind on another mount and a copy keeps an agent that writes its worktree from changing the store | [code] `docs/operations/runbooks.md`, "Set up a run's worktree" |
| the setup's private views | a copy of the store's `index.db` (and WAL), removed when the setup ends | [code] `setup.ts` |
| check scratch (`node_modules/.vite` and the like) | fresh private directories a check writes, discarded when it ends; at most the check's cache | [code] `checkScratch` |
| retention | 24 h after the last agent run, per the live profile (the code's default is 168 h) | [lead], [code] `docs/reference/configuration.md` |
| held in the lead's snapshot | 46 worktrees, 32 GB | [lead] |
| night before | 71 GB, about 100 worktrees (71 000 / 710) | [derived] |

The worktree count is what moves: held = starts per day × (run lifetime + retention) / 24 h
[derived, Little's law]. The two snapshots (46 and about 100 held) put today's starts at roughly
**45 to 100 runs a day on 6 slots, 8 to 17 per slot per day**, if the lifetime is a few hours. That is
the only throughput figure this document uses for disk; it assumes a slot is busy about as much as it
was on those two days.

### 1.3 Disk, other than worktrees

| Item | Size | Reading |
|---|---|---|
| live-update backups | 99 dirs, 25 GB, about 250 MB each, never pruned | [lead]. Each update takes `system backup` into `<date>-before-base/store` (taken once the daemon has stopped) and, after the restart, a second one into `<date>-before-base/after` "for the record checks", plus `cp -a` of the profile directory (`scripts/live-update.sh`, `backup()` and `verify()` [code]). At 875 MB the store, **an update now writes about 1.75 GB**, and the `after` snapshot is only read once. The profile copy may include the profile's own `node_modules`: not measured. |
| the store `system.db` | 875 MB (+ its WAL) | [lead]. Not the capacity problem (see 2.5), but it is what every backup copies. |
| daily backup timer | one full snapshot a day, "prune old backup directories yourself" | [code] runbook, "Backups" |
| the pnpm store, the git repository (objects of `system/run/*` branches), daemon log, agent transcripts, `$TMPDIR` of runs | not measured | list in 4 |

### 1.4 Memory and CPU, per step

**Records that exist.** Steps have start and end times (the workflow step rows, `agent_runs.created_at`
and `updated_at` [code: `agent-workers/src/index.ts` migration], the `workflow.run.*` events); a
check's time is in its `agent-workers.check` events (start, stall, end); a setup's in
`agent-workers.worktree.setup` and its decision. No record holds memory, CPU seconds, or disk of a
step or a check. So the durations can be read now (see the method in 1.5) but the footprint cannot.

**What can be derived from the repository.**

- **Test work, per full suite.** `scripts/test-durations.json` holds the wall time of each of the 222
  test files from one committed run. Their sum is **about 3,650 file-seconds (61 minutes)** [derived,
  summed by hand, to be rechecked with the generator]. It is wall time per file under a loaded
  32-worker run, so it over-states CPU-seconds, and under-states a file's time on a busier host. The
  longest file is 71 s (`runtime-antigravity-cli`). Bounds: the whole suite cannot finish in less than
  3,650 / 32 = **114 s** at 32 workers, **456 s at 8**, and **15 minutes at 4**, whatever the host.
  Heavy files (browser, turns, provider drivers, workflow: 30 to 70 s each) are about 60 % of the sum
  and are skipped when a change does not touch them (T305), so an affected-groups run is a part of it.
- **Fork count, therefore memory of a test run.** A test run holds up to `maxWorkers` forks plus the
  vitest main process. A fork's resident size is not recorded; for planning this document uses
  **[assumed] 0.25 to 0.4 GB per fork** (a Node process that imports the workspace's source through
  tsx/vite and opens `node:sqlite` stores), so one uncapped run is **8 to 13 GB**, the queue's 64 forks
  **16 to 26 GB**.
- **Step mix.** 1,555 steps in 3 days = **518 a day, 21.6 an hour, 0.36 a minute** [derived]. Of them
  **32 % write** (develop + fix = 499), **49 % review** (review + selfreview + second-family = 757),
  **18 % verify or validate** (271) [derived]. By Little's law (concurrent steps = rate × mean
  duration), **six slots cap the mean step at 6 / 0.36 = 16.7 min** if they were never idle, and a
  mean step of 5 min would be only 1.8 steps in flight. The real mean is a record to read (1.5): it is
  what turns "6 runs" into "n live steps", and only a live step holds a process tree.
- **Agent process.** A model-driven agent step is mostly waiting for the provider; its own footprint is
  the runtime's child plus the tools it starts. **[assumed] 0.5 GB (range 0.3 to 1) per live agent
  runtime**, and one core while it works. This is an outside figure; the repository has no record.
- **Typecheck.** `tsc` over the monorepo is the likely single largest process of a step that is not
  a test run. **[assumed] 2 to 5 GB for a few tens of seconds.** Unmeasured.
- **The daemon.** 0.5 GB idle [lead]. One Node process, one SQLite writer (INV-15): its cost per
  live run is not known, and it is the one component that does not parallelise (see 3.3).

### 1.5 The measurement method (what to record, how, at what cost)

The aim is one record per step and per check, from the first run on, with no new dependency.

1. **A cgroup per agent step and per check run.**
   - First read the host: `stat -fc %T /sys/fs/cgroup` (`cgroup2fs` = unified v2, `tmpfs` = v1 or
     hybrid) and `uname -r`. The environment of this run reports **kernel 5.4**, whose default cgroup
     tree on a 20.04-era host is v1/hybrid, where an unprivileged user cannot create a cgroup, and whose
     v2 lacks `memory.peak` (added in 5.19) and `pids.peak`.
   - Where a user systemd instance has v2 delegation: start the runtime and its confinement under
     `systemd-run --user --scope --collect -p MemoryAccounting=yes -p CPUAccounting=yes
     -p IOAccounting=yes -p TasksAccounting=yes --unit=system-step-<runId>`; the bubblewrap tree is its
     child, so the scope sees all of it. Read at the step's end: `cpu.stat usage_usec`,
     `memory.current`, `io.stat`, `pids.current`.
   - **Peak memory** on 5.4 is sampled: read `memory.current` at 1 Hz and keep the maximum (v2), or read
     `memory.max_usage_in_bytes` (v1) at the end. A sample every second misses a peak shorter than a
     second; a test fork storm lasts tens of seconds, so 1 Hz is enough for the decision here.
   - **Without a cgroup** (the fallback, and the first experiment since it needs nothing): sample the
     process tree below the confinement's `bwrap` pid: sum `Pss` from `/proc/<pid>/smaps_rollup`
     (summing RSS double-counts shared pages) and `utime + stime` from `/proc/<pid>/stat` every 1 to
     2 s, and keep the maximum of the sums.
2. **What to record, per step and per check** (one event at the end, or the step's decision `detail`):
   the run, the step kind, the Worker and runtime, the wall time, CPU-seconds (user + system), peak
   memory and how it was read (`cgroup-peak`, `sampled-1hz`, `sampled-pss`), the sample count, bytes read
   and written, peak task count, the worktree's bytes at the step's end **excluding `node_modules`**, and
   for a check: its command, its worker count, how long it waited in the queue. `node_modules` is measured
   once per worktree, at setup, because `du` on a 700 MB tree of tens of thousands of files costs seconds
   of disk time.
3. **Overhead.** The kernel's cgroup counters cost under about 1 % of the work they count; the sampler
   reads two or three small files per scope per second, which for 20 scopes is under 0.01 core and
   some tens of kilobytes of events a step [assumed, to be confirmed in the first experiment by running
   one step with and one without]. The one expensive reading is `du`, and it is not repeated.
4. **A host-wide view next to it:** `free -b`, `/proc/pressure/{cpu,memory,io}` (PSI, from 4.20) every
   30 s, `df` on the worktree and backup filesystems, and the daemon's event-loop delay
   (`monitorEventLoopDelay`) and RSS. The other users' load is not ours to measure per process, but
   PSI shows when it is the host and not us that is saturated.
5. **Durations that exist now** need no new code. From the live profile, per step kind: step end minus
   step start (the workflow step rows); per check: the `agent-workers.check` events (`system events
   --type agent-workers.check`); per setup: `agent-workers.worktree.setup`. The percentiles (p50, p90,
   max) per kind, and how many steps overlap in time at each minute (the concurrency actually reached),
   are the two numbers every model below needs and none is known today.

## 2. The levers

Each lever gives its expected saving, its risk, and the number it depends on. "Saving" is against the
[lead] and [derived] figures above.

### 2.1 `node_modules` not copied per worktree

The 600 to 680 MB of a worktree that is not tracked source is the bulk of disk [lead: "mostly
node_modules"]. Four ways, in rising reach:

| Way | Saving per worktree | Why it may not work here | Risk |
|---|---|---|---|
| **a. Reflink** (`--package-import-method=clone-or-copy`, or `clone`) | about 90 to 95 % where the filesystem clones (XFS with reflink, btrfs, ZFS 2.2); **0 on ext4**, which falls back to a copy | The filesystem of the store, of the worktrees, and of `/` is not recorded. The store is bound read-only into the setup, on another mount; a clone needs the source and the target on one filesystem, and on kernel 5.4 a clone across two mounts of it may fail `EXDEV`: test it. | Low: a cloned file is copy-on-write, so a write by an agent never reaches the store. Only the disk saving is uncertain. |
| **b. Hardlink** (`--package-import-method=hardlink`) | about 90 % (the files are shared; directories and inodes are not) | `link(2)` fails across mounts, even of one filesystem, and on a read-only mount: the setup's read-only store bind forbids it. It needs the store and the worktrees on one filesystem, and the store mounted writable in the setup. | **High.** A hardlinked file is one inode: an agent (or a test) that writes `node_modules/<pkg>/…` in its worktree rewrites the store's file for every worktree and every later install. The confinement would have to give every agent step `node_modules` read-only. Not recommended without that. |
| **c. A shared read-only install** keyed by the lockfile's digest: one `node_modules` per distinct lockfile, bound read-only into each worktree | about 100 % of the install: **0.6 to 0.68 GB × every worktree** becomes one copy per lockfile (about 0.7 GB) | A pnpm workspace has links inside each worktree (`packages/*/node_modules` point at the worktree's own `packages/*`, by relative links), so the bulk (`node_modules/.pnpm`) can be shared but the link farms stay per worktree, and relative links must resolve in the worktree. The dependency digest the setup records (`dependenciesOf`, `setup_decision`) already identifies the install. A result that changes the lockfile needs its own install (the setup runs again on the result's tree). | Medium. Needs a new mount kind in the setup views, a rule for who may write the shared copy (the setup, once, never an agent), and a test that a checks run and an agent step never write it. |
| **d. pnpm's global virtual store** (`enableGlobalVirtualStore`, which links a project's `.pnpm` into one shared directory) | like (c), made by the package manager itself | A feature of pnpm 10 and later, marked experimental when added; **not verified here** against `packageManager` pnpm 12.9.1, nor against bubblewrap's read-only bind of the shared directory. | Medium. A small experiment on a scratch worktree answers it before any design. |

Expected saving: if the install is 650 MB of the 710 MB, the per-worktree footprint falls to about
**0.06 to 0.1 GB** (tracked tree, git state, directories) with (a) on a cloning filesystem or (c)/(d).
At 46 held that is **28 to 30 GB** of 32 GB; at the 100 of the night before, **about 65 GB** of 71 GB. The
split of the other 60 to 100 MB is not measured: **measure `du -sh node_modules`
and `du -sh --exclude=node_modules .` in two or three worktrees first.**

### 2.2 Remove a worktree sooner

Today a finished worktree stays `worktreeRetentionHours` after its run's last agent run ended
(24 h on the live profile), "so a held review's pending checks can run in it"
(`docs/operations/runbooks.md`, "Remove finished run worktrees"), whatever became of the attempt.

- **Landed (accepted and merged) results: remove at once.** Nothing needs the worktree after the
  landing: the branch stays, and a continued run gets its worktree back from that branch. Saving: the
  whole retention for the landed share *f* of runs. With held = starts × (L + R) / 24 (L = run
  lifetime, R = retention), the factor is (L + (1 − f) R) / (L + R). **Illustrative [assumed]: L = 2 h,
  R = 24 h, f = 0.4 → 0.63, a 37 % cut.** The real f is a board query (accepted and landed runs over
  runs started in the same days).
- **A shorter retention for what is not landed** (`worktreeRetentionHours`, a config value, no code):
  rejected and failed attempts rarely need 24 h. With R = 6 and f = 0.4: (2 + 3.6) / 26 = **0.22, a 78 %
  cut**. A review still held keeps its worktree (state `in-use` or `held`), which the runbook already
  says; the cost is a repeat install when a held decision arrives later than R (about the setup's
  time, and 0.7 GB again with today's copy, ~0 with 2.1).
- **Risk:** the operator's inspection of a failed attempt ("Recover work") is limited to the branch; the
  retention already commits uncommitted work there, so nothing is lost. The only new code is a
  removal on the landing's own event; the sweep and the removal path exist.

### 2.3 Check and test concurrency per run

- **The queue** (`checks.maxConcurrent` 2, workers 32 each): its footprint is fixed (64 forks, about
  16 to 26 GB [assumed]) and does not grow with runs; what grows is the wait. Raising `maxConcurrent`
  with the same `maxWorkers` shifts CPU and RAM up in proportion: it is the cheapest way to cut wait
  and the first thing the measurement of 1.5 (p90 queue wait) decides.
- **An agent's own test runs** are uncapped relative to the host (32 forks each). The lever is to give
  every confined agent step the same budget the queue gives a check: `SYSTEM_CHECK_MAX_WORKERS =
  floor(core budget / runs that may test at once)`, set in the step's environment (a variable the
  repository's `vitest.config.ts` already honours). With a budget of 128 cores (half the host, since it
  is shared) the cap is **21 at 6 runs, 14 at 9, 10 at 12, 6 at 20**. A fixed cap of 8 would be simpler
  and costs time: a full suite is bounded below by 456 s at 8 workers against 114 s at 32, but an
  affected group is a fraction of it and the longest file (71 s) bounds both.
- **Vitest's pool.** `vitest.config.ts` leaves the pool at its default (forks in vitest 4). Threads
  (`pool: 'threads'`) would cut the per-worker memory (shared V8 isolate startup) but test files here
  spawn processes, use `process.chdir`-like state, and run real stores: **not recommended** without a
  full run on both. `isolate: false` would speed files but breaks the tests' cleanup rules (T3). The
  safe knobs are the count of workers, and `fileParallelism` per group.
- **Saving:** it does not save disk. It caps peak CPU and RAM per run, and keeps the time-bound
  failures from returning as runs rise (3.2). **Risk:** a longer step wall time when the host is idle
  (the cap is lower than what the host could give); the wait is the price of not oversubscribing.

### 2.4 Backup retention

- **Keep the last N updates (say 3) and one a week; drop `after` once the verification passed.**
  Saving now: 25 GB → about **2 to 4 GB** (3 × 875 MB for the store, plus profiles), i.e. **21 to 23 GB**;
  per update going forward, **half** (the `after` snapshot is read once, by the record checks).
- **Compress what is kept** (the `store/system.db` copy): SQLite files of text and JSON usually shrink
  several-fold under zstd or gzip [assumed, measure on one]; a compressed backup restores through a
  decompress step, which `system restore` does not know: **do not** change the format, only compress the
  directories kept beyond the last one, by the script.
- **Risk:** a rollback needs the last update's `store`, never an older one; an older one is for a
  disaster, which the daily timer's snapshot also covers. The failure to avoid is deleting the backup
  an update in progress or a rollback needs: prune only **after** an update ended `done`, never the
  attempt that is open (the script already has `find_attempt`).
- It is a change to `scripts/live-update.sh` (and the runbook), not to the daemon.

### 2.5 Event retention and store compaction

- **Event log.** `event-log` `retainDays` is **0 by default: every event is kept** forever
  (`packages/plugins/event-log/src/index.ts`: "0: every entry is kept"). Whether the live patch sets it
  is not known here. Events are written per step, per check (with stalls), and per setup. What share
  of the 875 MB they are is unmeasured: in SQLite it is
  `SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC` (the virtual table is read-only
  and safe on a copy of the backup). **Do not set `retainDays` before that query**: the explain of old
  runs, the pilot report (the report reads events, with its records) and the "decision records" of the
  acceptance rely on them, and a trim is irreversible.
- **Upper bound on growth.** 875 MB over at most the store's age is **≤ 0.56 MB per step** if all of
  it came from the 1,555 steps of the last three days; it is lower, since the store is older and holds
  more than steps. Even at 20 runs and 3 times today's step rate, that is under 2 GB a day, and 875 MB
  is not the limit. **The store is not what limits capacity**; it matters through the backups (2.4)
  and through the single writer.
- **Compaction.** Trimming leaves free pages in the file; `VACUUM` or `PRAGMA auto_vacuum=incremental`
  returns them. `system backup` already uses `VACUUM INTO`, so **a backup is already compact**: the
  difference between the live file and its backup is the reclaimable free space (read it directly).
  A real `VACUUM` of the live file needs free disk of its size and an exclusive lock: **not** to be done
  to the live daemon without a stop, and with the disk at 99 % it needs the room first.
- **Private text** (prompts, inputs, 30 days) is already bounded; the artifacts are content
  addressed and never trimmed, by design (INV-13).

### 2.6 Smaller levers, not costed

- Delete merged `system/run/*` branches (`git branch -d`): git objects are shared, the saving is small.
- The agent sessions' transcripts: unmeasured, may be the next disk item after worktrees.
- A host guard: refuse a new run when `df` of the worktree filesystem is under a floor (the disk is at
  99 %, shared with other users, who may fill it): a failure that is **loud and early** beats `ENOSPC`
  half way through a landing.

## 3. A capacity model

### 3.1 Parameters

Unless noted, from the sections above. **Bold** is an assumption the measurement must replace.

| Parameter | Value |
|---|---|
| worktree | 0.71 GB (now); about 0.1 GB with 2.1 |
| held worktrees per slot at 24 h retention | 7.7 to 16.7 (46 and 100 held on 6 slots) [derived]; throughput assumed to scale with slots |
| other disk | backups 25 GB now (2 to 4 GB after 2.4), store 0.9 GB + WAL, git, logs, transcripts: **not measured** |
| disk the System may take | 166 GB free + 32 GB of finished worktrees it can reclaim = **198 GB** ceiling; a **150 GB** budget leaves the other users room, on a disk at 99 % |
| agent runtime per live step | **0.5 GB**, one core |
| test fork | **0.3 GB**, one core while it works; 32 per uncapped run; main process **1 GB** |
| typecheck step | **3 GB** for tens of seconds |
| share of a run's wall time spent in tests (duty *d*) | **0.3** (not 1: agents mostly wait for the model) |
| fraction of the runs live that hold an agent process at a given moment | **0.7** (the rest wait for a check, an approval, a retry) |
| RAM the System may take of 1 TB (shared) | **256 GB** budget |
| cores the System may take of 256 (shared) | **128** budget; the host is shared, and tests failed their time bounds when they took 255 |

### 3.2 Per-resource demand by runs at once

Disk is worktrees only (before) plus the 25 GB of backups; the two columns are the 46 and the 100
held at 6 slots, scaled linearly. RAM and CPU are *peaks*: runs × duty × forks. "Capped" is 2.3 with
a 128-core budget (21, 14, 10, 6 workers).

| Runs at once | Worktrees held (24 h) | Disk, before (worktrees + 25 GB) | Disk, after 2.1+2.2+2.4 (see 3.3) | Test forks at peak, uncapped (d = 0.3) | RAM at peak, uncapped | Test forks, capped | RAM at peak, capped | CPU: cores busy, uncapped / capped |
|---|---|---|---|---|---|---|---|---|
| 6 | 46 to 100 | 58 to 96 GB | 4 to 5 GB | 58 | 2 + 19 = 21 GB | 38 | 2 + 13 = 15 GB | 62 / 42 |
| 9 | 69 to 150 | 74 to 132 GB | 5 to 6 GB | 86 | 3 + 29 = 32 GB | 38 | 3 + 14 = 17 GB | 92 / 44 |
| 12 | 92 to 200 | 90 to 167 GB | 5 to 7 GB | 115 | 4 + 38 = 42 GB | 36 | 4 + 14 = 19 GB | 123 / 44 |
| 20 | 153 to 333 | 134 to 261 GB | 6 to 10 GB | 192 | 7 + 64 = 71 GB | 36 | 7 + 17 = 24 GB | 206 / 50 |

How the columns are made [derived from the assumptions of 3.1]: worktrees = 7.7 to 16.7 × runs / 1;
disk = that × 0.71 + 25; test forks = runs × d × 32 (uncapped), runs × d × cap (capped: 21, 14, 10,
6 → 38, 38, 36, 36); RAM = agents (runs × 0.7 × 0.5 GB, the first term of each sum) + test bursts (runs × d × (1 GB main
+ forks per run × 0.3 GB), the second term), the typecheck bursts left out (3 GB for each run
typechecking at once, at most about 60 GB at 20); cores = forks + runs × 0.7 (agents). Disk after the
levers = worktrees × 0.22 × 0.1 GB + 3 GB of backups.

### 3.3 The limiting resource, before and after

| Runs | Before the levers | After the levers |
|---|---|---|
| 6 | **Nothing binds.** Disk is the closest: 58 to 96 GB of a 150 GB budget (the lead's 99 % disk is the other users'). | Nothing binds. |
| 9 | **Disk** at the upper figure (132 GB of 150, with the 25 GB of backups growing). CPU begins to oversubscribe if tests overlap (92 busy cores of the 128 budget). | Nothing binds; CPU is the watched one. |
| 12 | **Disk, then CPU.** The upper disk figure is 167 GB, past the 150 GB budget and near the 198 ceiling: the disk would fill the week the 12 runs began. Uncapped CPU, 123 busy cores, is the whole budget, and tests would again pass their bounds. | **CPU, if uncapped; nothing if capped.** Disk 5 to 7 GB. The per-run test cap holds CPU near 44. |
| 20 | **Disk**, decisively: 134 to 262 GB, over the 198 ceiling at the upper figure. And CPU: 206 busy cores uncapped on 256 shared ones; 640 forks asked for. RAM (71 GB peak, up to about 130 GB if every run typechecked at once) is under its budget. | **The daemon and the dispatch bounds**, not a host resource: the store has one writer and one event loop for 20 runs (unmeasured), `maxActiveRuns` 16 less `leaveRunsFree` 4 caps dispatch at **12** (`docs/reference/configuration.md`), and `maxRunningPerAccount` 1, `maxRunningPerProject` 2, `maxRunningPerRepository` 4, `dispatch.maxPerHour` 6 each cap it lower still unless raised: 20 runs on one repository needs five settings changed, which the model does not pretend to have. Then the **provider quota** (the five-hour windows), which no host resource buys back. |

The figures after the levers use 0.1 GB per worktree and the 0.22 factor of 2.2 (retention 6 h for the
unlanded, at once for the landed: L = 2 h, f = 0.4 [assumed]) with the 3 GB of backups of 2.4. The
levers' effect separately, at 20 runs and the 153 to 333 worktrees: retention alone leaves
34 to 73 worktrees × 0.71 = **24 to 52 GB**; node_modules sharing alone leaves 153 to 333 × 0.1 =
**15 to 33 GB**; both leave **3 to 7 GB** of worktrees. **Either lever alone moves 20 runs from over the
disk ceiling to inside the budget; the retention one is a config value and needs no code.**

**RAM is not the limit at any size in the table**, by two orders of magnitude on a 1 TB host: the
"lot of RAM" the operator saw is more likely a transient (a typecheck and 64 test forks at once, the
queue's own maximum) than a steady load. The measurement must say; it is the one claim here that the
operator's observation contradicts, and the observation was of a host the System shares: **the
host's free memory is not the System's alone.**

## 4. Ranked recommendations, and what to measure first

### 4.0 Measure first (a day of reading, one small task)

None of the recommendations below should start before these, each cheap and read-only:

1. **Where the 710 MB is:** `du -sh node_modules` and `du -sh --exclude=node_modules .` in three
   worktrees; the filesystem type of the store, the worktrees, `/` (`findmnt -T`); whether a clone across
   the store's mount works on this kernel (`cp --reflink=always` of one file). Decides 2.1.
2. **Durations from the records** (1.5, item 5): p50, p90, max per step kind and per check; the queue wait;
   the concurrency reached (steps overlapping per minute) over the three days. Decides what "6 runs"
   means in live steps, and whether `maxConcurrent` 2 is the bottleneck.
3. **Landed share f and run lifetime L** from the board (runs started, accepted and landed, hours from
   start to last agent run) over the same days. Decides 2.2.
4. **`dbstat` of a backup copy** (never the live file): which tables hold the 875 MB; whether the live
   patch sets event `retainDays`; the live file against its backup (free pages). Decides 2.5.
5. **One instrumented run** (the cgroup or sampler of 1.5) of a develop step and a verify step, with and
   without a typecheck, to replace the [assumed] RAM and CPU of 3.1; and one with 6 runs on the host to
   see PSI. Decides 2.3 and the RAM claim.
6. **Which other disk the System fills:** sizes of the pnpm store, the repository's `.git`, the daemon
   log, the Workers' homes (agent transcripts), `$TMPDIR` leftovers, and the profile directory inside a
   backup (`du -sh <backup>/*`).
7. **Host limits that are per user and shared:** `ulimit -u`, `fs.inotify.max_user_instances`,
   `user.max_user_namespaces` (bubblewrap needs unprivileged user namespaces), `pid_max`, open files.

### 4.1 The ranking

| # | Recommendation | Would become | Saving | Risk | Needs first |
|---|---|---|---|---|---|
| 1 | **Shorten the retention of worktrees not landed** (`worktreeRetentionHours` 24 → 6) and **remove a landed run's worktree on its landing** | a config change (live profile patch) and a task: "remove a landed run's worktree at once" (workflow or agent-workers, a use of the existing removal path) | 37 % to 78 % of worktree disk, at once (2.2); no new code for the config part | A held review's later decision pays a repeat setup; the operator's look at a failed attempt is by branch | 4.0 items 3 |
| 2 | **Prune backups**: keep the last 3 updates and a weekly one, drop `after` after the verification passed | a task on `scripts/live-update.sh` and the runbook | about 21 to 23 GB now; half of each update's growth after | Deleting a backup a rollback needs (guard: only after `done`, never the open attempt) | none; read `du` of the dirs |
| 3 | **A per-run test-worker budget for the agent's own test runs** (`SYSTEM_CHECK_MAX_WORKERS` in the step's environment, from the dispatch cap and a core budget) | a task on agent-workers (environment of a step) and `docs/reference/configuration.md` | keeps CPU and time-bound failures from returning as runs rise; no disk | longer test steps when the host is idle | 4.0 items 2 and 5 |
| 4 | **Instrument steps and checks** (cgroup or sampler per run; one event) | a task: "record a step's and a check's CPU, memory, I/O, and disk" (an event type and a schema, INV-14) | turns every [assumed] here into a record; the basis of any later bound (INV-9 for resources) | the cgroup depends on the host's cgroup mode; fall back to the sampler | 4.0 items 5 and 7 |
| 5 | **Cheaper `node_modules`**: first `--package-import-method=clone-or-copy` on a cloning filesystem, else a shared read-only install by the lockfile digest (or pnpm's global virtual store) | an experiment task on a scratch worktree; then a design (ADR) if (c) or (d) | 28 to 30 GB of 32 now; 65 GB at the night's peak; and the setup's time falls | clone is safe and uncertain; hardlink is unsafe without a read-only `node_modules` for agents; a shared install is a new mount kind | 4.0 items 1 |
| 6 | **A disk floor**: refuse to start a run (and say so) when the worktree filesystem has less than a configured free space | a task: a dispatch or worktree-creation guard, off by a mechanism switch (ADR-0078) | no saving; converts a mid-landing `ENOSPC` into an early refusal on a disk at 99 % | a false refusal on a shared disk another user fills | none |
| 7 | **Event retention** (`retainDays`) and, after it, a compaction at a stop | a task, **only after** the `dbstat` reading; the compaction as a runbook step | unknown; the store is not the limit; the backups are (rec. 2) | irreversible loss of explain and report history | 4.0 item 4 |
| 8 | **Raise the concurrency in steps, 6 → 9 → 12, never past what the dispatch bounds allow**, each step after a week's records | settings of the live profile, per D108 | the whole point; the model says disk is the limit at 9 to 12 *before* recs 1 and 5, and nothing is at 6 | the loop's own cleanliness (D108) is the operator's gate, not a resource | recs 1, 2, 3 done; 4.0 items 2 and 5 |

The order is by saving per effort and per risk: 1 and 2 are cheap, safe, and remove most of the disk
now; 3 and 4 are what stops CPU and the unknown RAM from becoming the next limit and gives the
numbers; 5 is the big saving that needs an experiment; 6 to 8 follow the records. **With 1 and 2 done,
12 runs fit in the disk budget on the model's upper figures without touching `node_modules`; with 5
too, 20 do, and the limit moves to the daemon and the provider quota.** Neither claim is a measurement:
each is true only to the extent of the assumed figures marked in 3.1, which 4.0 replaces.
