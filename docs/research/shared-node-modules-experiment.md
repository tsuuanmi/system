# PROP-0020 task 1: what the sandbox could and could not measure about a shared node_modules (T356, 2026-10-31)

Non-normative research, task 1 of [PROP-0020](../proposals/0020-shared-node-modules.md#tasks-it-would-become).
No code, configuration, or other document was changed. **Result: the decisive measures (an install on a
read-only or global virtual store, the farm's size and file count, a `cp -al` timing, the writers during
`pnpm check`) could not be taken, because `pnpm install` does not run in an agent's sandbox.** What was
read from the existing install is below, then each measure not taken, with why. The note picks no
method yet; it says what the one host command would settle.

## 1. What blocks every install here

Command (in a scratch tree, `git archive HEAD` of this worktree under `.dsh-home/t356/scratch/`, with a
private copy of the store's `index.db`, offline):

```
corepack pnpm install --frozen-lockfile --offline --store-dir=<scratch store> --package-import-method=copy
```

Output, identical in every variant tried:

```
Error: ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK
  × installing dependencies
  ╰─▶ Failed to open the store operation lock at "pnpm-store-operation-locks":
      Read-only file system (os error 30)
```

Variants that all failed the same way: the scratch store with `files` as a directory of symlinks to the
host store; an empty store directory; a store directory named `…/v11`; the host store itself (the
policy's own install command); `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME` and `HOME` moved
into the worktree (with corepack's cache copied over, since otherwise corepack tries to download pnpm
12.9.1); a writable `node_modules` present; the working directory moved. `corepack pnpm store status
--store-dir=<scratch store>` ran ("Packages in the store are untouched"), so the store is readable and
pnpm runs; only the install's lock open fails, on a relative path whose base I could not find (no
`strace` here; `--loglevel=debug` printed nothing more). The sandbox mounts `/` read-only and allows
writes only in the worktree, `$TMPDIR` and the agent home; the scratch store, `$TMPDIR` and the cache
were all in writable places. The setup's own confinement does install (its runbook view binds the
store's `files` read-only and copies `index.db`), so the failure belongs to this agent sandbox, not to
the design.

**Decides:** nothing in A or B by itself. It does say that the experiment needs the host (or a setup-like
confinement), and that A's builder, which runs in the setup's confinement, is not affected.

## 2. What was read from the present install (no write, no install)

| Fact | Command (read tool) | Output essentials |
|---|---|---|
| `node_modules` of this worktree | `du -sh node_modules` | `684M` (PROP-0020 says 683 MiB) |
| `.modules.yaml` keeps one absolute path | grep `/home/` in `node_modules/.modules.yaml` | one line: `"storeDir": "/home/tan/.local/share/pnpm/store/v11"`; `"virtualStoreDir": ".pnpm"` (relative); `"nodeLinker": "isolated"`, `"layoutVersion": 5`, `"virtualStoreDirMaxLength": 120`, `"packageManager": "pnpm@12.9.1"`; its package keys are relative (`packages/…`) |
| shims hold no absolute install path | grep `/home/` in `node_modules/.bin/*` | 0 matches. `.bin/tsc` and `.bin/vite` compute `basedir_abs` from the shim's own location and use `$basedir_abs/../.pnpm/<pkg>/node_modules/…` (`NODE_PATH` and the `exec` line); `# cmd-shim-target=../.pnpm/…` is relative |
| the farm part of the tree | `.modules.yaml` has 64 workspace projects | `packages/*/node_modules` and the top of `node_modules` are the per-worktree links |
| filesystem | `df -k`, `stat -f` | `/dev/sda2`, ext4 (reported as `ext2/ext3`), 27 to 30 GB free of 8.7 TB (100 %); `mount` shows it read-only inside the sandbox outside the worktree |

**Decides (read only, not a run):** the shims and the one `.modules.yaml` field that is absolute do not
tie `.pnpm` to the worktree's absolute path: the shims find `.pnpm` by `../.pnpm` from `node_modules/.bin`.
So a read-only bind of the master over `<worktree>/node_modules/.pnpm` (A's design) keeps the shims
working, and the extra bind of the master at its own absolute path (PROP-0020's "if the shims hold the
build path") is **not needed for the shims**. It is not proven for the symlinks inside `.pnpm` (relative
by pnpm's layout, not counted here: no `find -lname` was possible without a shell run), nor for a
package's own `package.json`-recorded paths. `storeDir` is absolute, and it is the host store, the same
for every worktree, so it does not argue against sharing.

## 3. Measures not taken, and why

| Measure (PROP-0020 task 1) | Not taken because | The exact host command that would settle it |
|---|---|---|
| pnpm 12.9.1 global virtual store (`enableGlobalVirtualStore`): does it work offline, and with a read-only shared directory | an install does not start here (section 1) | in a scratch copy: `corepack pnpm install --frozen-lockfile --offline --store-dir=<private store view> --package-import-method=copy --config.enableGlobalVirtualStore=true`, then `chmod -R a-w` the `links` directory and a second worktree's same install |
| an install over a complete read-only `.pnpm` (A's farm by `pnpm install`) | same | in a scratch copy of a finished install: `chmod -R a-w node_modules/.pnpm`, then the same install without the flag; and the variant with `--virtual-store-dir <master>/.pnpm` |
| size and file count of the farm, `cp -al` of it, timed | there is no install of my own to measure, and the live install is not to be read as a scratch copy (a `find` over 50 000 files needs a shell run that was not approved) | `find node_modules/.pnpm -type f \| wc -l`, `du -sk node_modules/.pnpm`, then `time cp -al node_modules/.pnpm <empty dir>/.pnpm` and `df` before and after, on a **copy** of an install |
| the present install's time | the `agent-workers.worktree.setup` decision rows are in the daemon's store, outside the workspace the read tools reach; my own timed install cannot run (section 1) | read the `setup_decision` rows of `agent_worktrees` (`duration`, if recorded) with the store opened read-only, or `time` the policy's install command once in a spare worktree |
| writers into `node_modules/.pnpm` or `node_modules` during `corepack pnpm check` and the tests | the same install is the base of the run; and a read-only `node_modules` run needs the scratch install | in a scratch install: `touch marker; corepack pnpm check; find node_modules packages/*/node_modules -newer marker`, then again after `chmod -R a-w` of both |

What is already known about writers, from the repository and not from a run: the runbook's
`checkScratch: [node_modules/.vite, node_modules/.vite-temp]` for the system project says vite's cache and
bundled config are the writes a check makes, both at the root `node_modules`, outside `.pnpm`; PROP-0020
reads that as unchanged under A. No other writer is recorded; this note does not confirm it.

## 4. What this means for PROP-0020

- **A or B is not decided by this note.** Nothing measured here favours B over A; the recommendation
  stands, with its task 1 facts still open.
- **One decisive thing is cheap to settle on the host:** the section 3 rows 1 and 2 (does pnpm 12.9.1 accept
  a complete read-only virtual store, with or without the global virtual store). A "no" on row 2 sends A
  to the "copy of the master's farm" method (`cp -a` of symlinks) and costs no bind knowledge; a "no" on
  row 1 closes B. These two are the ones worth a lead's host run; the other rows only size the saving,
  and PROP-0020 already carries estimates for them.
- **Cheaper than a pnpm install for the farm method:** the shims' relative layout (section 2) means the
  farm can be a copy (`cp -a`, symlinks only, relocatable) of the master's non-`.pnpm` part. It needs the
  sizing in row 3 to confirm the 3 MiB per worktree.
- **A finding for the setup, not for this proposal:** `pnpm install` fails closed in a sandbox where the
  cache or state directory is read-only (section 1). The setup's confinement is not that sandbox; the
  failure does not bear on A, but a "no install in an agent step" statement is now backed by an observed
  failure, not only by the policy.

## 5. What was done and left behind

Scratch only, in the git-ignored `.dsh-home/t356` of this worktree (scripts, outputs, a few GB of scratch
trees); nothing in the tree except this note and its router row.
