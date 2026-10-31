---
id: PROP-0021
type: proposal
status: draft
owners: [operator]
created: 2026-10-31
supersedes: [PROP-0020]
summary: Run worktrees share one node_modules through pnpm's global virtual store (GVS) with a single writer. One job writes the shared links/ (and its store index), when a listed branch's lockfile changes and at first use, confined, offline, from the store; it is read-only to every agent step, check and run setup. A run whose lockfile matches what links/ holds installs with the GVS (symlinks only, about 4 MiB against 684 MiB); a run whose result changes its lockfile installs privately by copy, as today, so no run setup writes the shared directory. Switch enforce.sharedNodeModules (off, warn, on), test profile first, any GVS failure falls back to the copy and is recorded. pnpm is pinned; an upgrade re-runs the experiment rows. It supersedes PROP-0020's recommendation of option A (the operator agreed on 2026-10-31), keeping its problem, options A and C analysis, and validation shape. Five small tasks, the first the writer job behind the switch, off. Nothing in this proposal changes code.
evidence: [docs/research/shared-node-modules-experiment.md section 6 (host results, 100f6e37), docs/research/measures-2026-10.md section 1, packages/plugins/agent-workers/src/setup.ts, packages/plugins/agent-workers/src/dependencies.ts, ADR-0078, ADR-0079, PROP-0020, PROP-0019, T235, T358]
related: [PROP-0019, PROP-0020, ADR-0058, ADR-0063, ADR-0078, ADR-0079, INV-2, INV-5, INV-9, INV-13, INV-15]
implementation: []
---

# Proposal: Run worktrees share one node_modules through pnpm's global virtual store, with a single writer

## Problem and what holds from PROP-0020

[PROP-0020](0020-shared-node-modules.md) states the problem and it holds unchanged: a run worktree is
about 710 MiB, 96 % of it `node_modules` (684 MiB), written again per run by the setup's
`pnpm install --frozen-lockfile --offline --package-import-method=copy`, on an ext4 with no reflink
([measures 1](../research/measures-2026-10.md#1-worktree-disk-filesystems-reflink)). Its goals and
non-goals hold too: a worktree's own bytes fall to its tracked tree; no run, check or landing can
change shared files (INV-5, INV-15); a run that changes its dependencies gets exactly the install its
result names; the change is switchable and proven on the test profile.

PROP-0020 recommended option A (a read-only bind of one install per lockfile digest) and left B (pnpm's
global virtual store) for an experiment. The experiment's host rows
([experiment section 6](../research/shared-node-modules-experiment.md#6-host-results-the-lead-2026-10-31),
pnpm 12.9.1, offline, a full copy of the store) change the footing:

| Fact | Result | Bears on |
|---|---|---|
| GVS install, first tree | exit 0, 1.3 s; the tree's `node_modules` 4.1 MiB; the store gains `links/` (664 MiB) | B works offline on this pnpm; the per-worktree part is 4.1 MiB, not PROP-0020's estimated 29.5 MiB |
| GVS install, second tree, `links/` read-only | exit 0, 0.9 s; 4.1 MiB | a complete read-only `links/` is enough for a run |
| in-place install over a complete read-only `.pnpm` | exit 0, 135 ms, writes nothing | an install over what is already there is a no-op |
| a second tree with a foreign `--virtual-store-dir` | exit 1, refused | A's cross-tree form does not work; A needs the same-path bind, **untested** |
| baseline copy install | 1.5 s; 684 MiB; 31 449 files in `.pnpm` | today |

PROP-0020's one serious objection to B was that every setup writes the shared directory, so INV-15
("one writer per subject") would become "any setup, concurrently", and a result's lockfile could add
packages every other run sees. The design below removes that objection instead of accepting it: the
shared directory has one writer, and a run's setup never writes it.

## Proposed design

### 1. A single writer

The shared `links/` and its store index are written by one job, the **shared-install job**, and by
nothing else.

- **Where.** A directory `<shared root>/links` (the GVS directory, set by the job with pnpm's
  `virtual-store-dir`/store settings so it is not beside the user's store by accident), and the store
  index it needs. Both are read-only to everything but the job.
- **When.** At first use (the directory is absent or empty, a run asks for it), and when a listed branch's
  lockfile changes: after a landing whose diff changes the dependency files (`dependenciesOf`, T235's
  digest) on a branch the repository's setup lists (`sharedNodeModules.branches`, default the
  repository's integration branch). It is one job at a time per repository, under the engine's one
  queue for that subject (INV-15); a second request while one runs is the same request.
- **How.** The setup's own install command, in the setup's own confinement (offline, scripts and
  pnpmfile off, the store's `files` read-only, no network), on the listed branch's tree at the landed
  commit, with the GVS on and the shared root writable. A lockfile verification (T333) still precedes
  any online step, and the job is never run on a lockfile no landing has accepted. It records the
  lockfile digest `links/` now holds (a marker file written last, INV-13 decision beside it).
- **Publication.** The job installs into `<shared root>/.building-<id>`, writes the marker, makes the
  tree read-only (`chmod -R a-w`), and publishes by one `rename` to the current name; a crash leaves
  only a `.building-*` which the sweep removes. The previous generation stays until no held
  worktree's decision names it. A GVS link is absolute and names its directory, so a generation is a
  directory of its own and a rebuild copies the previous one first (664 MiB, once per landing that
  changes the lockfile); whether pnpm can instead add to the one directory in place, without a reader
  seeing a half-added package, is task 1's question, and the answer is that either way a reader sees
  only a complete, marked generation.
- **Read-only to everything else.** In every agent step, every check and every run setup, the shared
  root is a read-only bind (`--ro-bind`) in the confinement, so a write, a link or a `chmod` fails
  (`EROFS`). A file mode alone would not hold (the agent's user owns its files; PROP-0020's point
  stands). The job's confinement is the only one with it writable.

### 2. What a run does

At setup, the run reads the marker and compares its digest to the worktree's dependency digest.

- **Match.** The setup installs with the GVS: `pnpm install --frozen-lockfile --offline
  --config.enable-global-virtual-store=true` over the read-only shared root (experiment row 1b). The
  worktree gets symlinks only (about 4.1 MiB), pointing into the shared root, which is bound at the
  same absolute path in every confinement (a GVS link is absolute by design, so the same-path bind is
  what it needs: **untested**, task 1 tests it before anything else).
- **No match** (the run's result changes its lockfile, or the job has not caught up with a landing).
  The setup installs privately with `--package-import-method=copy`, as today: its own 684 MiB, no
  shared directory touched. This is also T235's path unchanged: a result that changes its dependencies
  is set up again on its tree before its checks, and that second setup finds no match and copies.
  A landing's rebased tree matches once the job has run for the landing before it.
- **Never written.** No run setup writes the shared root in either branch. A new package set
  reaches `links/` only through a landing, then the job.
- **Recorded.** The setup's decision names the way it took (`gvs` or `copy`), the digest, and, for a
  copy, the reason (no marker, digest differs, switch off, failure).

### 3. The switch and the fallback

`enforce.sharedNodeModules: off | warn | on` on the `agent-workers` row, per
[ADR-0078](../decisions/adr/0078-a-plugin-or-a-mechanism-is-turned-off-at-runtime.md) (read live, no
restart), and PROP-0019/D108's rule that a deciding mechanism starts `off` and moves to `on` only
after days clean, test profile first.

| Mode | The job | A run's setup | Cost |
|---|---|---|---|
| `off` | does not run | the copy, today | none |
| `warn` | runs; fills `links/` | installs **both** ways (a copy and a GVS install into a scratch directory), compares the two trees (package names, versions, link targets, `.bin`), **uses the copy**; the decision holds the difference and the bytes `on` would save | the shared root (664 MiB) once and one extra install per run |
| `on` | runs | the GVS when the digest matches, else the copy | the saving |

Any failure of the GVS path under `on` (an install error, an unreadable marker, a bind that cannot be
proven, a comparison that differs in `warn`) **falls back to the copy** and is recorded as a decision
with its cause; the run is never refused for it. This differs from PROP-0020's "no fall back under
`on`" (W11), on purpose and narrowly: the copy is not a second implementation of the feature but the
unchanged present path, and `off` is the same code. A failure of the job itself leaves the previous
generation (or no `links/`), so runs copy.

### 4. pnpm pinned

The GVS is documented as experimental, and its layout is pnpm's. The repository's `packageManager`
pin (corepack) is the only version that writes or reads `links/`; the marker records the pnpm version
that built it, and a run whose pnpm differs from the marker's copies. A pnpm upgrade is a change of the
pin; before the switch stays `on` on it, the experiment rows are re-run (GVS install offline from a
read-only `links/`, the in-place read-only install, the same-path bind inside bubblewrap, a
`patchedDependencies` and `allowBuilds` fixture), and their output is the upgrade task's evidence. Until
then the switch is `warn` for the new pin.

## Disk and time

Per-run disk today is 709.6 MiB. With the GVS a run's own bytes are the rest (26.5 MiB, measured) plus
4.1 MiB (measured), 30.6 MiB; `links/` is 664 MiB once (measured, one digest). A run that copies (a
changed lockfile) costs 710 MiB. `links/` grows by the packages a landing adds (derived: tens of MiB
for a typical change; the generation the job replaces is removed once no worktree names it).

| Runs held | Today | GVS, all matching | GVS, one run in six copies |
|---|---|---|---|
| 6 | 4.16 GiB | 0.83 GiB (3.33 saved, 80 %) | 1.52 GiB (2.64, 63 %) |
| 12 | 8.31 GiB | 1.02 GiB (7.29, 88 %) | 1.89 GiB (6.42, 77 %) |
| 20 | 13.86 GiB | 1.25 GiB (12.61, 91 %) | 2.30 GiB (11.56, 83 %) |

(derived: `0.649 + n x 30.6 MiB`, and with `n/6` runs, rounded up, at 710 MiB; the second column is a
planning case, not an observation.) Compared with PROP-0020's option A at the same runs: the same
saving for a matching run, and no 683 MiB master for a run that changes its dependencies, which copies as
it does today.

Time (measured on the host, one run each, a warm store): baseline install 1.5 s; GVS install 0.9 s
over a read-only `links/`. The setup's total is dominated by other commands, so the saving is I/O
(684 MiB of writes per run), not seconds. The job costs one install, 1.3 s measured for a full first fill, plus a
`chmod` and a `rename`. `warn` costs both installs, about 2.5 s a run. Not measured: the whole
`worktreeSetup` duration (`agent-workers.worktree.setup`), read in task 1.

## Failure modes

| Failure | Effect | Handling |
|---|---|---|
| no marker, digest differs, job behind a landing | the run copies | recorded; the next landing's job catches up; today's cost |
| job crashes or is killed | `.building-*` left, previous generation intact | sweep removes; runs use the previous marker or copy |
| two jobs started at once | would write `links/` twice | one queue per repository (INV-15); the second request is dropped as the same |
| pnpm refuses the GVS (a foreign path, a changed layout) | a failed install | copy, with the cause (experiment row 2b shows pnpm refuses foreign paths) |
| the same-path bind cannot be made | links dangle | the setup checks one link resolves in its own confinement; else copy |
| a tool writes into `links/` in a run | `EROFS` | wanted: a run altering a dependency is what this prevents; the job's own writes are the exception, in its own confinement |
| `links/` corrupted or partial | module not found in a check | marker is written last and read before use; a check that fails with a missing module under `gvs` is retried once as a copy and the shared root is flagged for a rebuild |
| disk full during the job | build fails | free-disk precondition (twice `links/`); previous generation kept |
| a poisoned package in a landed lockfile | shared by every matching run | the same exposure as today's install (offline from the read-only store, scripts off, lockfile verified T333); reuse is bounded by the digest |
| two repositories | no sharing | the shared root is per repository |
| `patchedDependencies`, `allowBuilds` | not verified for the GVS | an upgrade/first-use row; `warn`'s comparison shows a difference and the run copies |

## INV and ADR implications

- **INV-15** (one writer): holds by construction; the job is the only writer of `links/`, queued per
  repository. This is the change from PROP-0020's objection to B.
- **INV-5** (exact subject): a run binds the marker's digest to its worktree's digest, recorded in the
  setup decision; a check on a `gvs` worktree refuses a marker that no longer matches.
- **INV-2** (fail closed): a bind that cannot be proven under `on` falls back to the copy, which is
  today's behaviour and keeps the confinement; no step runs with a writable shared root.
- **INV-9** (bounded): one shared root per repository, at most one previous generation, a sweep, a
  free-disk precondition for the job.
- **INV-13** (decisions): a decision per job run, per setup way (`gvs` or `copy` and why), per removal.
- **INV-6/8/12**: the job runs only the setup's approved install, offline, no credentials; nothing leaves
  the host.
- **ADR.** One new ADR on acceptance of the tasks (not of this proposal): the shared root as a
  confinement exception (read-only everywhere but the job), the single writer, and the copy fallback.
  [ADR-0078](../decisions/adr/0078-a-plugin-or-a-mechanism-is-turned-off-at-runtime.md) governs the
  switch; ADR-0058, ADR-0063 and ADR-0079 (red-on-base's tree links `node_modules` from the result) are
  unchanged and re-proven in the test (the link resolves inside a confinement that binds the shared
  root). No existing ADR is superseded.

## What it supersedes in PROP-0020

- **Superseded:** the recommendation of option A, and option A's design (the key, the master, the
  `.pnpm` view bind and its per-key sweep) as the thing to build. PROP-0020 is marked `superseded`,
  `superseded-by: PROP-0021`, and the proposals router says so.
- **Kept:** the problem and measurements, the goals and non-goals, the rejection of option C and of
  reflink, `hoisted` and `pnp`, the observation that `.vite` and `checkScratch` are unchanged, the
  `EROFS` runbook text, the validation shape (a fixture repository on the test profile) and the
  stages (`warn`, then `on`, canary, five days live).
- **Changed:** B's "every setup writes the shared directory" (single writer); "no fall back under `on`"
  (copy fallback); per-worktree cost 29.5 MiB (now 4.1 MiB, measured); a run that changes its
  dependencies costs a copy, not a second 683 MiB master; the experiment's open items are mostly
  closed (the same-path bind and the writers during `pnpm check` are not).
- PROP-0020's tasks 2 to 6 are not built; its task 1 is done (T356, host rows).

## Validation plan

On the test profile with the real bubblewrap, on a fixture repository (two packages, one dependency)
and a fixture store, never the full tree:

1. The same-path bind: a GVS install whose links resolve inside a confinement binding the shared root
   read-only at its absolute path (the untested row); vitest runs.
2. A fake Worker writing into the shared root in a step and in a check fails `EROFS`; the root's tree
   hash is equal before and after; a link or `chmod` attempt fails.
3. Two worktrees on one digest: the second writes under 5 % of the first's bytes, both run a vitest file.
4. A run that edits the lockfile copies, the sibling is unchanged, the shared root's hash is unchanged
   (no setup wrote it); a landing of that lockfile then runs the job and the next run matches.
5. Two job requests at once run once; a job killed half way leaves the previous generation and the next
   job completes.
6. `off`: setup equals today's byte for byte. `warn`: both installs, empty difference, the copy used.
   `on`: a GVS failure injected (a missing marker, a pnpm version mismatch) copies and records.
7. `check:red-on-base` runs on the fixture; vite's `checkScratch` paths work.
8. The pnpm-upgrade rows (section 4) as a script of the research note, run on a pin change.

## Rollout and rollback

Stages: test profile at `warn`, then `on`, with the canary (an `algorithm-development` task on fakes whose
result changes its lockfile, then lands); live at `warn` for five working days with an empty comparison; live
`on`. Rollback is `off`: new worktrees copy; a worktree set up under `on` keeps working while it
lives (each confinement binds the shared root it names); the sweep removes the shared root once no held
worktree names it and the switch has been `off` past retention. A worktree's retention is unchanged.

## Compatibility and migration

No record changes shape: the setup decision gains optional fields (way, digest, cause), a minor
version ([schemas](../reference/schemas.md#versioning)); the switch is one optional key on a row, and the
setup's `sharedNodeModules` entry (branches, optional) is one optional config field. A worktree set up
before `on` keeps its copy. A repository without the entry is unaffected; nothing in routing or workflow
code names pnpm (W9): the install command and the dependency files are the setup's.

## Tasks it would become

Each small (under about 500 changed lines); the first is the job, behind the switch, off.

1. **The single-writer job, behind the switch, off** (`agent-workers/src/shared-install.ts`): the
   GVS install in the setup's confinement with the shared root writable, the marker written last,
   publish by `rename`, the queue per repository, the sweep, the trigger after a landing that changes
   a listed branch's dependency files and at first use; `enforce.sharedNodeModules` exists, `off`; the
   same-path bind test (validation 1) first; tests 5. The config entry and `docs/reference/configuration.md`.
2. **The read-only bind**: the shared root as a read-only view in every agent step, check and run setup
   (named exception in `confineIn`); tests 2 and 7.
3. **The run setup**: marker compare, the GVS install or the copy, the decision with way and cause,
   the fallback on any failure, `warn`'s comparison; tests 3, 4 and 6.
4. **Observability and docs**: `system worktrees` and `explain` show the way and digest, the runbook
   (an empty or `EROFS` shared root, the job's decision), the design section, the ADR; the pnpm-upgrade
   script (validation 8).
5. **Promotion**: `warn` then `on` on the test profile, then live, by the stages; its evidence is the
   measured disk and time of runs off and on.

## Decision

Open; the operator chose this design on 2026-10-31. A reviewer's question to answer first: whether the
job's trigger also covers a branch's first landing after a pnpm pin change, or only a lockfile change
(this text says the marker's pnpm version mismatch makes runs copy until the job runs again, so the pin
change should trigger it).

## Implementation

None yet.
