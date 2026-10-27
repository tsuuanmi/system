---
---

`pnpm check` (through `check:deps`) now holds the dependency rules of "everything is a plugin": from the Package classes table of `docs/architecture/plugin-model.md` (kernel, guarantee provider, capability, surface, profile, and the families that may build on each other), it reads each package's `src/` imports, type and value apart, and refuses any import of a guarantee provider's package, and a plugin importing another plugin outside its family. `scripts/dependency-baseline.json` lists today's violations and may only shrink (`pnpm check:deps --shrink` drops a line that is fixed); `pnpm gen:deps` regenerates `docs/architecture/dependency-graph.md` (layers, edges by kind, counts), which the check holds up to date. Only a tool and docs change; no package.
