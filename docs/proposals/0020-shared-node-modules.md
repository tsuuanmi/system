---
id: PROP-0020
type: proposal
status: draft
owners: [operator]
created: 2026-10-31
summary: A run worktree holds its own 683 MiB copy of node_modules (96 % of a 710 MiB worktree, measured on 2026-10-30), because the setup installs with --package-import-method=copy, on ext4 with no reflink. This proposal compares three ways to stop copying it per run, with the disk each saves at 6, 12 and 20 runs, setup time, what a run that changes its dependencies does, what breaks, and the confinement and invariant cost of each, and recommends one. Recommended, option A: one install per key (lockfile digest, setup, platform) built once by the setup, published immutable, and bound read-only into every confinement at the same absolute path, so a run can never alter it; the worktree keeps only its symlink farm. Six tasks, a switch (off, warn, on) and a test on the test profile. Option B (pnpm's global virtual store) is the experiment's second candidate; option C (hardlinks within one master) is rejected, since the master would be one inode with every worktree. Nothing in this proposal changes code.
evidence: [docs/research/measures-2026-10.md section 1 (T353), docs/research/resource-capacity.md 2.1 (T337), packages/plugins/agent-workers/src/setup.ts, packages/plugins/agent-workers/src/dependencies.ts, packages/agent-runtime-core/src/index.ts (confinedCommand), ADR-0058, ADR-0063, ADR-0079, PLAN.md 3.3, T355]
related: [PROP-0019, ADR-0058, ADR-0063, ADR-0078, ADR-0079, INV-2, INV-5, INV-9, INV-13, INV-15]
implementation: []
---

# Proposal: Run worktrees share one read-only node_modules per lockfile digest

## Problem

A run's worktree is about 710 MiB; its `node_modules` is about 683 MiB of it, 96.3 %, and the rest
(tracked tree, git state) about 26.5 MiB (measured on three worktrees, differing by under 0.1 %:
[measures 1](../research/measures-2026-10.md#1-worktree-disk-filesystems-reflink)). The setup
(`worktreeSetup`, [runbook](../operations/runbooks.md)) runs
`pnpm install --frozen-lockfile --offline --store-dir=<store> --package-import-method=copy` with a
private view of the store, so every run writes the same 50 000 or so files again (derived: the
apparent size, 590 MiB, is 93 MiB below the allocated size, which is block rounding at about 2 KiB a
file). The copy exists for one reason: a Worker that writes its worktree must not change the store.

The two cheap ways out are closed on this host. The filesystem of `/`, the pnpm store and the
worktrees is one ext4 (`/dev/sda2`), and `cp --reflink=always` fails there ("Operation not
supported", all three cases), so `clone` is a copy. A hardlink into the store would make a file of a
worktree the store's own inode: a run (or a test) that writes `node_modules/<pkg>/…` rewrites it for
every worktree and every later install
([resource-capacity 2.1 b](../research/resource-capacity.md#21-node_modules-not-copied-per-worktree)).

Disk is the resource the worktree count moves
([resource-capacity 1.2](../research/resource-capacity.md#12-disk-per-run)): 46 held worktrees were
32 GB, about 100 held were 71 GB. This proposal designs how a worktree stops holding its own copy,
and what it costs in confinement, invariants, and tools that write into `node_modules`.

## Goals

- A worktree's own bytes fall to the order of its tracked tree (tens of MiB), whatever the number of
  runs on one dependency set.
- No run, check, or landing can change the shared files: not by a write, not by a link (INV-5, INV-15).
- A run that changes its dependencies still gets exactly the install its result names, as today.
- Switchable (off, warn, on), proven on the test profile before live.

## Non-goals

- Shrinking the pnpm store, the git repository, backups, or the database
  ([resource-capacity 2.4, 2.5](../research/resource-capacity.md#24-backup-retention)).
- A filesystem change (reflink needs XFS, btrfs or ZFS; that is the operator's, and this proposal
  does not depend on it).
- Sharing between repositories or hosts. The key below is per repository.
- A removal of the worktree sooner ([resource-capacity 2.2](../research/resource-capacity.md#22-remove-a-worktree-sooner)).

## Evidence and research

What is measured, what is derived, and what is not known, because the design turns on the last.

| Fact | Status | Source |
|---|---|---|
| worktree 709.6 MiB; `node_modules` 683 MiB (96.3 %); rest 26.5 MiB | measured | measures 1 |
| ext4 everywhere; no reflink, in all three places | measured | measures 1 |
| about 50 000 files in `node_modules` | derived (93 MiB rounding at about 2 KiB a file) | measures 1 |
| the setup: offline install, `copy`, a copy of the store's `index.db`, the store's `files` bound read-only | code | `setup.ts`, runbook |
| a check sees the worktree read-only but its `checkScratch` paths (`node_modules/.vite`, `node_modules/.vite-temp`), each a fresh private directory | code | `confineIn`, `scratchPoint` |
| the dependency digest: package.json (any depth), pnpm-lock.yaml, pnpm-workspace.yaml, .npmrc, .pnpmfile.cjs, recorded by every setup decision; a result that changes any of them is set up again before its checks | code | `dependencies.ts`, `DEFAULT_DEPENDENCY_FILES`, T235 |
| `bwrap` can bind a view read-only over a path of the worktree (`views`, `--ro-bind`); a view that would expose a hidden path is refused | code | `confinedCommand`, `confineIn` |
| the setup time of a run (the install) | **not measured** | no record holds it (`agent-workers.worktree.setup` has its duration, unread) |
| the size and file count of the symlink part of `node_modules` (top level and `packages/*/node_modules`) | **not measured** | task 1 |
| whether pnpm 12.9.1 runs an install on a complete virtual store it cannot write, and its global virtual store (`enableGlobalVirtualStore`) behaviour | **not verified** | task 1 |
| whether the `.bin` shims and `.modules.yaml` pnpm writes hold the absolute path of the install | **not verified**; if they do, the master must be bound at its own absolute path (below) | task 1 |
| which tools write into `node_modules/.pnpm` (a `node_modules/.cache` of a package, found by its real path) | **not measured** | task 1 |

How pnpm lays the tree out, as far as the design needs: `node_modules/.pnpm` (the virtual store) holds
the package files and, beside each, the symlinks to its own dependencies, all relative; the top of
`node_modules` and each `packages/*/node_modules` hold symlinks into it, and the workspace packages
link to each other by relative paths inside the worktree. So the bulk, `.pnpm`, is identical for
every worktree of one dependency set, and the rest is a symlink farm that points into the worktree
itself and must stay per worktree. `virtual-store-dir` can move `.pnpm` elsewhere; the global virtual
store (`enableGlobalVirtualStore`, pnpm 10 and later) moves it to one directory shared by projects;
`node-linker` (`isolated`, `hoisted`, `pnp`) decides the shape: `hoisted` makes real files at the top
and no sharing is possible, `pnp` removes `node_modules` but changes every tool's resolution, so
neither is considered.

### The numbers each option is compared by

Per-run disk is 709.6 MiB today, so 6, 12 and 20 held worktrees cost 4.16, 8.31 and 13.86 GiB. All
options below are costed with one dependency set (one digest) live; a second digest costs a second
master (A, C) or only the changed packages (B). The per-worktree rest is the measured 26.5 MiB, plus
3 MiB of symlink farm for A and B, or about 30 MiB of directories for C (estimates, task 1
measures both).

## Proposed design

Three options, then the recommendation.

### Option A. A read-only bind of an install keyed by the lockfile digest

**What it is.** One install per key, built once, published immutable, bound read-only into every
confinement at the same absolute path.

- **The key** is `sha256(dependency digest, setup hash, platform, Node and pnpm version)`. The
  dependency digest (`dependenciesOf`) already names the install, but two things that change an
  install are not in it: the setup's own commands (its hash, `Setup.hash`) and the platform. A
  patch file under `patchedDependencies` is covered, since the lockfile records its hash.
- **The master.** `<shared root>/<key>/` holds a `node_modules/.pnpm` built by the setup's own
  install command, in the setup's own confinement (offline, scripts off, the store's `files` bound
  read-only, a private copy of `index.db`), into a directory under `<shared root>/.building-<id>`,
  then made read-only (`chmod -R a-w`) and published by one `rename` to `<key>`. A directory
  that exists under its key is complete; a crash leaves only a `.building-*` that the sweep
  removes. The builder is the only writer, once per key, under a per-key lock (INV-15); the master's
  content is a function of its key, so two builders would build the same thing.
- **The bind.** In every mode of `confineIn` (setup, check, verify), in every agent step's
  confinement, and in the landing's regeneration, `<shared root>/<key>/node_modules/.pnpm` is a view
  (`--ro-bind`) over `<worktree>/node_modules/.pnpm`. The mount point is an empty directory the
  setup makes in the worktree (git-ignored, never in a subject). Outside a confinement it stays empty,
  which is harmless: the daemon's git work (commit, retire) never reads it.
- **If pnpm's shims hold the build path** (task 1 decides), the master is also bound at its own
  absolute path (`--ro-bind <shared root>/<key> <shared root>/<key>`), so a shim's `NODE_PATH` and
  the realpath of a module resolve to the master. This is what pnpm's global virtual store does by
  design, so it is a known shape, not an exception.
- **The per-worktree part.** The symlink farm (top-level links, `packages/*/node_modules`, `.bin`)
  is the setup's per-worktree work: either `pnpm install --frozen-lockfile --offline
  --virtual-store-dir <shared>/<key>/…` linking only (needs no copy; needs pnpm to accept a
  complete virtual store it cannot write), or a copy of the master's farm
  (`cp -a`, symlinks only), whichever task 1 shows to work. The setup then records the key with the
  dependency digest in its decision (INV-13).
- **The check binds the key** (INV-5): before a check runs, the worktree's current dependency digest
  must equal the one the mounted key was built for; otherwise the setup runs again on the result's
  tree (as T235 does today), and the mount is the new key's.

**Disk.** The master (683 MiB) once, plus 26.5 + 3 = 29.5 MiB per worktree.

| Runs held | Today | Option A | Saved |
|---|---|---|---|
| 6 | 4.16 GiB | 0.84 GiB | 3.32 GiB (80 %) |
| 12 | 8.31 GiB | 1.01 GiB | 7.30 GiB (88 %) |
| 20 | 13.86 GiB | 1.24 GiB | 12.62 GiB (91 %) |

**Setup time.** First run of a key: today's install, once, plus a `chmod` and a `rename` (seconds).
Later runs of the key: the farm only, tens of thousands of fewer file writes; an estimate of seconds
against today's install, not measured (the present time is in `agent-workers.worktree.setup` and is
read in task 1). The run no longer waits for 683 MiB of writes, which is also the I/O the host's other
steps see.

**A run that changes its dependencies.** Its worktree starts on the old key, as today. It cannot
install in it: the `.pnpm` bind is read-only, and an offline install in an agent step could not
reach the store's view today either. When the result's dependency files differ from the digest the
setup recorded, the setup runs again on the result's tree (T235, unchanged): the key for its new
digest is built (its own install, offline, from the store, as today) or found, if another run
already built it, and the worktree's mount and farm are replaced. The old master stays for the
other runs. A fix round, or a landing's rebased tree with the same digest as dev, finds the new key
built. A second key costs one more master, 683 MiB, instead of a copy per run.

**What breaks.**

- A run's tool that writes into `node_modules/.pnpm`: a package's own cache (`node_modules/.cache`
  beside a package, found by its real path), an install, a patch for debugging. It fails with
  `EROFS`, which the runbook already names. Wanted: a run altering a dependency is the failure this
  proposal exists to prevent. Task 1 lists the writers by running the repository's own
  `pnpm check` under the bind; none is expected.
- Vite's `node_modules/.vite` and `node_modules/.vite-temp` (the root's `node_modules`, outside
  `.pnpm`): unchanged. They stay in the worktree, writable in an agent step and `checkScratch` in a
  check. A vite root below the top (`packages/plugins/web-ui/node_modules/.vite`) is in the farm,
  also outside `.pnpm`. `checkScratch` keeps its meaning and needs no change.
- `check:red-on-base`'s base tree links `node_modules` from the result's tree (ADR-0079): the link
  resolves inside the check's confinement, where `.pnpm` is bound. Unchanged, proven in the test.
- The workspace read server's "no hard link" rule exempts `node_modules`; unaffected, since there
  are no hard links.
- A worktree read outside a confinement (an operator's `ls`, an editor) sees an empty `.pnpm`: the
  runbook says so.

**Confinement and invariants.**

- A new read-only view in each confinement: the shared root is outside every path the confinement
  hides (the DSH home is hidden and the worktrees are bound back); the master is bound by its key
  only, so an agent sees its own key's directory, never the others' (INV-12 unchanged, nothing
  leaves the host). `confineIn`'s existing refusals (a view over the worktree, a hidden path) apply;
  the new view is bound inside the worktree on purpose and gets its own named exception. A bind that
  cannot be proven fails the setup closed (INV-2): there is no fall back to a copy under `on`
  (W11); `off` is the copy.
- INV-5: checks and landings bind the digest and key the setup recorded. INV-15: one builder per key;
  a published master is never written (read-only mode, and read-only mount in every confinement).
  INV-9: the shared root is bounded (below). INV-13: a build, a mount and a removal each leave a
  decision. INV-6: the builder runs only the setup's own approved command, with scripts and the
  pnpmfile off, as today; a lockfile verification (T333) still precedes any online step, and a key is
  never built before its digest is verified.
- The master is built from a result's lockfile, which is the result's content. What it adds over
  today: a build is shared by the later runs of the same key, so a poisoned build would reach them.
  The build is offline from the read-only store, with scripts off, which is what bounds it today;
  and the key holds the whole content that decides the install.

**Bound of the shared root (INV-9).** At most `maxKeys` masters (default 4); a master is removed when
no held worktree's decision names it and it is older than the retention (`worktreeRetentionHours`);
a build needs free disk of twice a master and the setup's deadline. The sweep that retires
worktrees also removes masters, under a decision each.

### Option B. pnpm's global virtual store

**What it is.** `enableGlobalVirtualStore` makes pnpm link a project's `node_modules/.pnpm` into one
shared directory (by default beside the store), where each package, with its dependency symlinks, is
stored once under a hash of its identity. The shared directory is then bound read-only into every
confinement but the setups.

**Disk.** The same as A for one digest: one copy of the packages and about 29.5 MiB per worktree
(6, 12, 20 held: 0.84, 1.01, 1.24 GiB). Better than A where it differs: packages are shared across
digests too, so a run that changes its dependencies adds only the changed packages, tens of MiB,
instead of a second master, 683 MiB. Per-package sharing is also its weakness, below.

**Setup time.** A first install fills the store, later ones only link: the same shape as A, with the
farm made by pnpm's own install (so its shims and paths are right by construction).

**A run that changes its dependencies.** Its setup runs an install that adds the changed packages to
the shared directory, then links its own farm.

**What breaks and what it costs.**

- **Every setup writes the shared directory.** Under A a setup of a key that exists writes nothing
  shared; under B every setup, of any result's lockfile, writes `<shared>/links` for packages it
  adds. One writer per subject (INV-15) becomes "any setup, concurrently", with pnpm's own locking as
  the only guard, and a result's lockfile can add to what every other run sees. A package is shared
  by its hash, so a poisoned add is shared by every digest naming it. This is the widest write
  surface of the three.
- A read-only bind of the shared directory cannot be used for the setup itself, so the setup
  confinement gets a writable bind of a path outside the worktree, which today it does not have (it
  writes the worktree only; the cache is read-only).
- It is documented as experimental, and **not verified** here against pnpm 12.9.1, its `.modules.yaml`
  and a read-only shared directory, or against `patchedDependencies` and `allowBuilds` (this repository
  has both).
- Everything else (`.vite`, `checkScratch`, red-on-base, the `EROFS` of a write into a package) is
  as in A.

**Confinement and invariants.** INV-2: pnpm's own failure is the only check. INV-5: the check binds
the digest; the shared directory is not keyed by it, so the exact content a run saw is not recorded
unless each package's hash is (a decision per install would list them). INV-15: weaker than A, as
above.

### Option C. A per-digest install copied once and hardlinked within it, read-only

**What it is.** The master, as in A, built once. Each worktree's `node_modules` is a hardlink farm of
it (`cp -al`): the same inodes, in the worktree's own directories, so a worktree has a real
`node_modules` and no bind is needed for the layout.

**Disk.** The master (683 MiB) plus, per worktree, the directories and entries, no file data: the
26.5 MiB of the rest and about 30 MiB for the directories (an estimate; none measured: task 1).

| Runs held | Today | Option C | Saved |
|---|---|---|---|
| 6 | 4.16 GiB | 1.00 GiB | 3.16 GiB (76 %) |
| 12 | 8.31 GiB | 1.33 GiB | 6.99 GiB (84 %) |
| 20 | 13.86 GiB | 1.77 GiB | 12.09 GiB (87 %) |

**Setup time.** One link per file, about 50 000 (derived), against 50 000 writes of data: an estimate
of 5 to 20 s, not measured.

**A run that changes its dependencies.** As in A: its own master and its own farm.

**What breaks.** The files of every farm are one inode with the master. A run that writes
`node_modules/<pkg>/…`, which its confinement allows (the worktree is writable), rewrites it for
every worktree and for the master, which is exactly the hardlink risk that closed the store's
hardlinks. To make that safe each confinement must still bind `node_modules` read-only, which is the
bind of A, with the master's disk cost and a second mechanism on top. A file mode of `a-w` does not
bound an agent running as the same user, who owns the files and may `chmod` them: only the mount
does. With the mount, hardlinks buy nothing over A: one more directory tree per worktree, a link
per file at setup, and the 65 000 links an ext4 inode allows, for the same bind. **Rejected.**

### Recommendation: option A, with option B as the experiment's second subject

Option A is the only one of the three whose safety is a property of the mount, not of a convention,
and whose one writer is the setup that builds a key, once. B has the best disk on a change of
dependencies, and pnpm makes the farm, but it gives every setup a writable shared directory, is
experimental, and is not verified here. So task 1 runs both on a scratch worktree; the decision to
build A or B waits for its numbers (setup time, farm size, `EROFS` writers, shim paths, B's behaviour
on a read-only shared directory), and only a result that favours B on those, not on disk alone,
would change the recommendation (a new proposal number, not an edit of this one).

Under A, a repository opts in by naming its `node_modules/.pnpm` in its setup; it gets nothing
by default, and nothing in routing or workflow code names pnpm (W9): the install command, the
directory to share and the dependency files are the setup's.

## Alternatives considered

- **Reflink** (`clone-or-copy`): 0 on ext4, measured. Revisit if the host moves to XFS or btrfs.
- **pnpm `hardlink` from the store** (resource-capacity 2.1 b): a run would write the store's own
  files; and `link(2)` fails on the setup's read-only store bind.
- **`node-linker=hoisted` or `pnp`**: no sharing is possible for `hoisted`; `pnp` changes every
  tool's module resolution and the editors', for a repository that runs vitest, vite and tsc.
- **A bind of the whole `node_modules`, farm included**: the workspace links point at the worktree's
  own `packages/*` by relative paths; bound from another place, a worktree's imports resolve to the
  master's sources, not to the worktree's own, which is the wrong subject. `.pnpm` alone is shared.
- **Remove worktrees sooner**: a separate lever (2.2), and the held count it saves is on the same
  disk.

## Validation plan

On the test profile (T323), with its fakes and the real bubblewrap, proving each fact the design
leans on. Unit tests in `packages/plugins/agent-workers/tests` use a small fixture repository (two
packages, one dependency) and a real install from a fixture store, never the 683 MiB tree.

1. Two worktrees of one key: the second setup writes under 5 % of the first's bytes; both resolve
   and run a vitest file; `du` of each worktree's own bytes is the farm and the rest.
2. A fake Worker that writes into `node_modules/.pnpm/<pkg>/…` in its step and in a check fails
   `EROFS`; a hash of the master's tree is equal before and after.
3. A hard link or a symlink an agent makes toward the master's files, then a write through it, fails:
   the mount is read-only whatever the path.
4. A run that edits `package.json` and the lockfile gets a new key at its next setup; a sibling on
   the old key is unchanged; the check refuses a mount whose key's digest is not the worktree's.
5. Two setups of one new key at once build it once; a build killed half way leaves no key directory
   and the next setup builds it.
6. vitest and vite run in a check with `checkScratch: [node_modules/.vite, node_modules/.vite-temp]`
   and pass; `check:red-on-base` runs on the fixture.
7. The sweep removes a key no held worktree names, keeps one it does; `maxKeys` bounds the root.
8. `off`: no shared root is made and the setup equals today's, byte for byte in the worktree.
   `warn`: the master is built and the worktree is its own copy as today; the decision lists the
   difference between the worktree's `.pnpm` and the master's (names, sizes, link targets), which
   must be empty, and the bytes it would save. `on`: the second setup of a key writes the farm only.

The measured numbers go into the evidence of the task that turns the switch: setup time off and on,
worktree bytes, the master's size.

## Rollout and rollback

Its switch is `enforce.sharedNodeModules: off | warn | on` on the `agent-workers` row, per
[ADR-0078](../decisions/adr/0078-a-plugin-or-a-mechanism-is-turned-off-at-runtime.md)'s convention (read live, no restart), after
PROP-0019's rule: new mechanisms start `off`, a deciding one moves to `on` only after days clean.

| Mode | What it does | Cost |
|---|---|---|
| `off` | today: a copy in each worktree; no shared root | none |
| `warn` | builds the master once per key beside the copy, compares the two, records the decision with the bytes `on` would save; mounts nothing | one extra master per key (683 MiB), an extra build per new key |
| `on` | the master is mounted, the worktree writes only its farm; a bind that cannot be proven refuses the setup | the saving |

The stages: the test profile at `warn`, then `on`, with the canary (a board task through
`algorithm-development` on fakes, with a result that changes its lockfile); then live at `warn` for
five working days with an empty comparison; then live `on`. Rollback is `off`: new worktrees copy
again; a worktree set up under `on` keeps working while it lives (its mount is made by each
confinement from the key its decision names), and the shared root is removed by the sweep when no
held worktree names it. A worktree's retention is unchanged.

## Observability and operations

- A decision `agent-workers.shared-node-modules` per build, mount refusal, and removal (INV-13): the
  key, the digest, bytes, duration, and in `warn` the comparison.
- `system worktrees` shows each worktree's key; `system explain <runId>` shows the setup's decision
  with it; the web UI's disk figure per worktree falls with the farm.
- Runbook: where the shared root is, what an empty `.pnpm` outside a confinement means, `EROFS` in a
  `node_modules/.pnpm` path as a tool writing a dependency, and `system worktrees` to read the
  key. The configuration reference gains the switch and the setup's `shared` entry.
- The resource-capacity model's 3.3 is re-run with the new per-run disk once `on` has a day.

## Security and privacy

- The read-only mount is the control: a run cannot alter the master by a write, a link, or `chmod`.
  A file's mode alone would not hold, since the run's user owns its files.
- The shared root is outside any path an agent can list; each confinement binds one key. The
  confinement's existing refusals (hidden paths) are not weakened: the new view is a named
  exception for `node_modules/.pnpm` of the worktree, and tested.
- Supply chain: the key's content is built offline from the read-only store with scripts and the
  pnpmfile off, after the lockfile's verification (T333), as the install is today; the
  difference is reuse, bounded by the key's content.
- A master holds package files only: no credentials, no run data.

## Compatibility and migration

No record changes shape. The setup's decision gains a key (an added optional field, a minor version,
[schemas](../reference/schemas.md#versioning)); the switch is one optional key on a row. A worktree
set up before `on` keeps its copy; there is no migration. A repository that does not declare the
shared entry is unaffected.

## Tasks it would become

Ranked, each small, each under about 500 changed lines, none before task 1.

1. **Experiment (research, no code in the tree).** On a scratch worktree on this host: pnpm 12.9.1's
   global virtual store; an install on a complete read-only virtual store; whether shims and
   `.modules.yaml` hold the absolute path; the size and file count of the farm; a `cp -al` timing;
   the install's present time (`agent-workers.worktree.setup`); the writers into `.pnpm` found by a
   `pnpm check` under the bind. Output: `docs/research/` note; it picks A's farm method, or B.
2. **The shared install** (`agent-workers/src/shared-install.ts`): the key, the build under a lock,
   publish by `rename`, read-only mode, the integrity marker, the sweep with `maxKeys`; its tests
   (5, 7).
3. **The bind** (`setup.ts` `confineIn`, the agent runs' confinement): the view in every mode and in
   an agent step, the named exception, the key bound by the check (2, 3, 4); the setup's `shared`
   entry in the config schema and `docs/reference/configuration.md`.
4. **The setup flow** and the switch `enforce.sharedNodeModules`: the farm, the decision with the
   key, `off`, `warn` (with the comparison) and `on`; the test profile case (1, 6, 8).
5. **Observability and docs**: `system worktrees` and `explain`, the runbook, the design
   (`agent-runtimes.md` setup section), an ADR for the shared root.
6. **Promotion**: `warn` then `on` on the test profile, then live, by the stages above; a task whose
   evidence is the measured numbers.

## Decision

Open. A reviewer's question to answer first: should `on` keep a per-repository opt-in (the setup
names the directory to share), or become the setup's default for a pnpm repository?

## Implementation

None yet.
