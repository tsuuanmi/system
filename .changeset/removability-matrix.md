---
---

A daily removability matrix (T317): `pnpm test:removability` boots the system bundle once per optional row with that row off, on a scripted Worker, and smokes it (health, the MCP tools that need no removed row, a run through `ask` and one through `algorithm-development`). A failure names the row and the step. `docs/architecture/plugin-model.md` lists which rows are required (guarantee seams and the host) and which are optional (capability and surface rows); a bundle row in neither list fails `pnpm test`. It runs daily and on demand in `.github/workflows/removability.yml`, never on a pull request.
