# Measures for PLAN 3.1, October 2026 (T353)

Non-normative research. Measure only; no code changed. It supplies the numbers that `docs/research/resource-capacity.md` 4.0 and `docs/research/model-routing.md` 7 list.

**Source of every figure.** The lead ran `scripts/measure-t353.ts` on the host on 2026-10-30 and kept its JSON output, `.t353-measures.json`. The store was read only, from a copy in a scratch directory. This run had no host access, so it took each figure from that file and did not re-measure. The script is not in this tree. A field the file lacks is marked "not taken" with its reason. Window for (2): 2026-10-25..30, as the task states; the file does not repeat the bounds.

## 1. Worktree disk, filesystems, reflink

Method: `du` (allocated KiB) of `node_modules` and of the rest of the worktree, plus the apparent size of `node_modules`, in three run worktrees. `findmnt -T <path>` for the filesystem, `statfs` for the type. `cp --reflink=always` of a pnpm store file to a scratch file under `/tmp`, to a file in a worktree, and within one worktree.

| Worktree (run) | node_modules KiB | rest KiB | total KiB | node_modules apparent KiB |
|---|---|---|---|---|
| run_caee88c93abcbc30 | 699 596 | 27 096 | 726 692 | 604 375 |
| run_8c732bd74f7669d6 | 699 652 | 27 084 | 726 736 | 604 417 |
| run_2db6ed5eae6ce3b8 | 699 648 | 27 216 | 726 864 | 604 426 |

- A worktree is about 710 MiB (726 700 KiB = 709.6 MiB). `node_modules` is 96.3 % of it (about 683 MiB); the rest is about 26.5 MiB. The three samples differ by under 0.1 %.
- The apparent size of `node_modules` (about 590 MiB) is below the allocated size, so about 93 MiB of the allocation is block rounding of many small files.

Filesystem (`findmnt -T`): `/`, the pnpm store `/home/tan/.local/share/pnpm/store/v11`, the worktrees directory `/home/tan/.dsh/system/worktrees` and `/tmp` are all on `/dev/sda2`, ext4, `rw,relatime,stripe=320`. `statfs` reports `ext2/ext3` (the ext4 magic) for `/`, the store and the worktrees.

Reflink: `cp --reflink=always` fails in all three cases with "Operation not supported": store to `/tmp`, store to a worktree, and within a worktree. ext4 has no reflink, so a copy across the store and a worktree is a full copy, or a hard link, which pnpm's `--package-import-method` can use; the install command in use is `--package-import-method=copy`.

## 2. Steps and fix rounds, 2026-10-25..30

Method: the store opened readOnly; the workflow node records grouped by step kind (the node id's first word), the tier it was served at, and the tier it asked for ("min"). Duration is node start to node end. A step with no end is "unfinished" and not in the duration statistics. "Wait" is the time from the run's last settled step to this step's start, which is the only queue measure in the file; it includes the time a step waits for its input as well as for a slot, so it bounds the queue wait from above. Overlap is the count of steps running in each minute that has at least one.

2 411 steps in all, in 368 runs (292 completed, 83 failed; the two sum to 375, a difference the file does not explain).

Steps by kind and tier ("served" blank means the record names no served tier), seconds. n is the finished steps behind the duration figures.

| Kind \| served \| min | count | unfinished | duration p50 | p90 | max | wait p50 | wait p90 | wait max |
|---|---|---|---|---|---|---|---|---|
| develop \| standard \| standard | 356 | 200 | 314.6 | 1060.3 | 2159.7 | 106.6 | 2089.2 | 5819.8 |
| develop \| (blank) \| standard | 237 | 125 | 487.0 | 1286.1 | 2716.1 | 102.7 | 5448.1 | 20588.3 |
| review \| frontier \| standard | 205 | 0 | 60.6 | 131.7 | 218.4 | 2.5 | 6.9 | 1057.3 |
| review \| (blank) \| standard | 193 | 0 | 63.9 | 131.2 | 348.0 | 0.4 | 1.6 | 3.8 |
| fix \| frontier \| standard | 193 | 65 | 385.3 | 948.3 | 3201.0 | 107.1 | 2152.6 | 7740.6 |
| review \| standard \| standard | 169 | 0 | 17.2 | 134.5 | 281.7 | 2.0 | 4.6 | 492.7 |
| second \| frontier \| standard | 138 | 0 | 58.6 | 116.0 | 201.1 | 1.5 | 3.5 | 16.8 |
| verify \| frontier \| standard | 136 | 0 | 45.4 | 72.3 | 290.3 | 1.4 | 4.7 | 290.9 |
| develop \| frontier \| standard | 133 | 78 | 442.3 | 1151.1 | 1936.4 | 181.6 | 1771.6 | 4353.2 |
| selfreview \| standard \| standard | 133 | 0 | 20.2 | 40.2 | 158.0 | 1.4 | 4.6 | 745.6 |
| fix \| standard \| standard | 107 | 41 | 254.2 | 1130.2 | 1612.8 | 76.6 | 2015.7 | 3174.8 |
| validate \| (blank) \| economy | 92 | 0 | 20.3 | 29.6 | 74.2 | 0.1 | 0.2 | 0.6 |
| fix \| (blank) \| standard | 86 | 3 | 346.0 | 1072.9 | 2362.8 | 60.4 | 572.4 | 4070.7 |
| verify \| standard \| standard | 66 | 0 | 35.1 | 78.9 | 177.3 | 1.5 | 2.9 | 6.4 |
| selfreview \| frontier \| standard | 41 | 0 | 83.2 | 158.0 | 165.6 | 1.3 | 2.7 | 170.6 |
| literature \| (blank) \| standard | 34 | 2 | 138.9 | 440.0 | 927.8 | 0.4 | 0.5 | 125.5 |
| frame \| (blank) \| standard | 18 | 2 | 60.7 | 98.3 | 160.5 | 0.1 | 34.7 | 157.2 |
| validate \| economy \| economy | 14 | 0 | 21.7 | 25.1 | 30.2 | 0.4 | 1.1 | 1.5 |
| literature \| standard \| standard | 8 | 3 | 101.0 | 128.4 | 128.4 | 0.2 | 213.5 | 213.5 |
| evidence \| (blank) \| economy | 7 | 0 | 97.9 | 123.4 | 123.4 | 0.1 | 0.4 | 0.4 |
| critique \| (blank) \| standard | 7 | 0 | 77.8 | 156.2 | 156.2 | 0.1 | 0.3 | 0.3 |
| conclusion \| (blank) \| standard | 6 | 0 | 96.3 | 144.8 | 144.8 | 0.07 | 0.08 | 0.08 |
| propose \| (blank) \| standard | 6 | 0 | 125.1 | 137.5 | 137.5 | 0.2 | 0.7 | 0.7 |
| ballot \| (blank) \| standard | 6 | 0 | 83.9 | 136.8 | 136.8 | 0.1 | 0.3 | 0.3 |
| review \| frontier \| frontier | 4 | 0 | 64.3 | 118.4 | 118.4 | 0.2 | 0.3 | 0.3 |
| verify \| frontier \| frontier | 4 | 0 | 28.3 | 38.4 | 38.4 | 1.0 | 1.5 | 1.5 |
| frame \| standard \| standard | 3 | 0 | 74.5 | 88.1 | 88.1 | 0.1 | 0.2 | 0.2 |
| critique \| standard \| standard | 3 | 1 | 45.8 | 271.5 | 271.5 | 1.3 | 903.3 | 903.3 |
| literature \| frontier \| standard | 2 | 1 | 429.5 | 429.5 | 429.5 | 0.1 | 321.9 | 321.9 |
| evidence \| economy \| economy | 2 | 0 | 239.0 | 337.1 | 337.1 | 0.1 | 0.5 | 0.5 |
| conclusion \| standard \| standard | 2 | 0 | 246.8 | 403.8 | 403.8 | 0.1 | 0.7 | 0.7 |

Where the p50 and p90 are equal to the max, the sample is under ten and the percentile is not meaningful.

Reading:
- The long steps are the writing steps: develop (p50 315 to 487 s, p90 1 060 to 1 286 s, max 2 716 s) and fix (p50 254 to 385 s, p90 up to 1 130 s, max 3 201 s). Review, second, verify and selfreview are about 17 to 83 s at p50; validate is about 20 s.
- Develop and fix are also where the wait is: p50 about 60 to 180 s, p90 570 to 5 448 s. All other kinds wait a few seconds at p50. Because the wait is from the last settle, a long develop wait is probably a run waiting on a person or on its own earlier step, not only on a slot; the file does not separate the causes. Not taken: a pure slot-queue wait (the time between a step being admitted and starting), because the file holds no such field.
- Unfinished steps are concentrated in develop (403 of 726) and fix (109 of 386); they are steps cut off by a failed run or a restart.
- The "served" tier is blank for 237 develop, 193 review, 86 fix and most other steps; for those the served tier is not in the record, so a split by served tier is only possible for the rest.

Steps overlapping per minute (3 122 minutes with at least one step running): p50 2, p90 5, max 10. Histogram, steps → minutes: 1 → 959, 2 → 783, 3 → 549, 4 → 404, 5 → 227, 6 → 113, 7 → 54, 8 → 21, 9 → 9, 10 → 3. The peak of steps running at one instant was 7.

Fix rounds per run (a round is a `fix:<n>` node), over the runs with a step in the window:

| Template | runs | with a fix | rounds 0 / 1 / 2 / 3 / 4 |
|---|---|---|---|
| algorithm-development | 323 | 171 (52.9 %) | 152 / 84 / 73 / 9 / 5 |
| agent-review | 19 | 0 | 19 / 0 / 0 / 0 / 0 |
| research | 19 | 0 | 19 |
| brainstorm | 3 | 0 | 3 |
| scheduled-review | 4 | 0 | 4 |
| all | 368 | 171 (46.5 %) | |

"47 % of runs need a fix" is confirmed as a share of all runs (171 of 368 = 46.5 %). It is a mix: of algorithm-development runs, the only template that has fix steps, 52.9 % need a fix, and 87 of them (27 % of the template's runs) need two rounds or more (73 + 9 + 5). The other templates never fix.

## 3. The store's tables

Method: `dbstat` on a copy of the store (never the live file). The live file is 1 052 499 968 bytes (1004 MiB) plus a write-ahead log of 4 177 712 bytes. The copy has 257 012 pages of 4 096 bytes (1 052 721 152 bytes), 17 on the freelist. That is 54 pages (221 184 bytes) more than the live file's 256 958 pages; the copy was probably taken after the log was folded in, but the file does not say. Shares below are of the copy's 257 012 pages. The `dbstat` result has 25 rows; the table shows the 8 largest.

| Table or index | MiB | share of file | pages | unused bytes |
|---|---|---|---|---|
| artifacts | 339.6 | 33.8 % | 86 946 | 24 685 761 |
| agent_runs | 327.6 | 32.6 % | 83 860 | 2 532 948 |
| workflow_nodes | 266.3 | 26.5 % | 68 165 | 3 784 298 |
| events | 13.1 | 1.3 % | 3 358 | 1 165 590 |
| turns | 9.8 | 1.0 % | 2 506 | 338 978 |
| sqlite_autoindex_artifacts_1 | 5.7 | 0.6 % | 1 454 | 721 992 |
| workflow_runs | 4.2 | 0.4 % | 1 087 | 456 032 |
| resource_usage | 3.8 | 0.4 % | 984 | 708 718 |
| the other 17 rows (each 88 to 957 pages, under 3.8 MiB) | 28.0 | 2.8 % | 7 179 | 4 249 312 |
| not in the 25 rows (schema page, the 17 freelist pages, smaller objects) | 5.8 | 0.6 % | 1 473 | not listed |

Three tables hold 978.8 MB (933.5 MiB), 93.0 % of the copy's pages (238 971 of 257 012): `artifacts`, `agent_runs`, `workflow_nodes`. The unused bytes inside pages sum to 38 643 629 (about 38.6 MB, 3.7 % of the file) over the 25 rows (34 394 317 in the 8 rows shown), and the freelist is 17 pages, so a `VACUUM` could shrink the file by about 4 % at most. The `events` table is small (13.1 MiB); by event type the largest are `quota.draw` (2 189 events, 2.37 MB), `workflow.node.started` (2 833, 1.33 MB), `workflow.node.completed` (2 196, 0.92 MB) and `agent-workers.tool.checks-pending` (1 856, 0.85 MB).

Not taken: the size inside `agent_runs` and `workflow_nodes` by column; the file has the table totals only. The store file `system.db.before-restore-1792888048659` (a pre-restore copy) also exists beside it in `/home/tan/.dsh/system/`; its size was not taken.

## 4. Per-user host limits

Method: `/proc/self/limits`, `/proc/sys` values, `unshare` of a user namespace, `ps` thread count for the user `tan`. Kernel 5.4.0-216-generic, 256 cores.

| Limit | Value |
|---|---|
| Max processes (`RLIMIT_NPROC`), soft and hard | 4 126 625 |
| Max open files, soft and hard | 1 048 576 |
| inotify `max_user_instances` | 128 |
| inotify `max_user_watches` | 524 288 |
| `max_user_namespaces` | 4 126 625 |
| `unprivileged_userns_clone` | 1; `unshare` of a user namespace worked |
| `pid_max` | 4 194 304 |
| `threads-max` | 8 253 251 |
| threads of `tan` at the time | 2 942 |
| cgroup filesystem | tmpfs |

- `ulimit -u` itself failed: the script ran it under `sh` (dash), which has no `-u`. The value is taken instead from `/proc/self/limits`, "Max processes", which is the same limit.
- The only limit near the load is inotify instances: 128 per user, which every watcher (editor, test runner in watch mode, each run's tooling) draws from. The others are far above the 2 942 threads in use now: the process limit is about 1 400 times that figure and the open-files limit (1 048 576) about 356 times. Nothing else here bounds runs at the peak of 7 steps at once.
- Not taken: how many inotify instances the user holds now, so the margin below 128 is not known.

## Method and caveats

- All figures come from one host and one run of the script on 2026-10-30; the three worktree sizes are samples of the same install.
- Step "wait" is from the last settled step of the run, not a slot-queue time; see section 2.
- The step table shows the 30 kind and tier groups the file holds; the file has no per-day split.
