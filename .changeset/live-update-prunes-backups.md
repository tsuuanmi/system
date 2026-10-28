---
"@tsuuanmi/system-workflow": minor
---

Live-update backups are kept within a bound (T346). The host held 99 backups, 25 GB, never pruned, and the disk was at 99 %. After an update verified (never before, never one that rolled back), `scripts/live-update.sh` drops that update's `after` snapshot and prunes the older `<date>-before-base*` backups: it keeps the last `--keep` updates (default 3), the newest of each of the last 4 weeks, this update's, and any backup an unfinished update refers to. Each removal is logged in the update's notes. A dry run lists what it would remove.

See the runbook "Update the live install".
