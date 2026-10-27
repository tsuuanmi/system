---
---

`pnpm check` (through `check:dead`) now fails on a new dead export (a name a package's `src/` exports that nothing in the program refers to, resolved by the TypeScript compiler, a package entry's public surface excepted) and on a new unused plugin `Config` key (one no non-test source reads), against `scripts/dead-code-baseline.json`, which may only shrink (`pnpm check:dead --shrink` drops entries gone) (PROP-0018 T1, T307). Only a tool of the repository changes; no package.
