# Operations examples

Files a runbook asks you to copy or merge. Each names the runbook section it belongs to.

| File | Used by |
|---|---|
| [live-base.patch.yml](live-base.patch.yml) | [update the live install from e218ae7 to the Base release](../runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release): the rows the live profile patch changes, merged by row id |
| [work-kinds.patch.yml](work-kinds.patch.yml) | [route work by kind](../runbooks.md#route-work-by-kind): source-code work on a writing Claude Code Worker on the system repository (worktree per run), docs and test work on Codex, reviews on any reviewer (D35, D36), merged by row id |
