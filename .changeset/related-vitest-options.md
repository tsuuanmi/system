---
---

`pnpm test:related <files>` now takes vitest's options also when `--` is missing: the files end at the first word that starts with `-` (its own `--dry-run` aside), as `group`'s names do (T331). `--` stays accepted; which tests are related is unchanged. Only a tool of the repository changes; no package.
