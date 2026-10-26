---
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-profile-software-development": minor
"@tsuuanmi/system-profile-scientific-research": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-web-ui": minor
---

The per-Worker handbook slice (PROP-0016 I1 part 2, D83, ADR-0072; docs/design/handbook.md):
- The handbook's five layers are declared once in the workflow engine (`HANDBOOK_LAYERS`: owner, homes, version, share of the bound). Every step of a board task's run is given its slice, selected by its role, task class, risk tier (ADR-0071), and touched paths. The engine's half, a `handbook-slice@1.0` context pointer, is read from the homes under `handbook.root` (default: the System repository the package sits in): the constitution's pointer, and for a heavy change the invariants' titles and the accepted ADRs naming a touched package; the tier's line; the project's charter; the role's playbook, its template's text and the role's rules of the handbook's layer-4 inventory keyed by class and path.
- A review's REVIEW.md guides (T267) are a part of its slice's layer 4: the guides its brief already points at (`review-guides@1.0`) are counted against the bound without being repeated, and layer 4's version names each guide's area and version. The writer's rules include W19 (the author's checks before review), the reviewer's V6 (the guides).
- The agent Worker source renders the other half: the gate view, and the lessons that apply to the step's role and paths (a lesson's `Applies:` clause; a reviewer now gets the lessons whose check is the review), both bounded in UTF-8 bytes, and records what it rendered with each part's version (the lessons file's blob at HEAD) and size (`agent-workers.handbook`).
- The slice is measured as `ceil(UTF-8 bytes / 4)` against 6,000 tokens: the lessons at what they render to (the engine measures them with the source's own renderer, now in libs: `lessonsSectionOf`, `lessonApplies`, `LESSONS_LIMITS`), the gate view at its constructed maximum (1,000), since only the routed Worker decides it. A source's half over its layer's share is refused in either mode. Over it, a `handbook.bound` decision names each layer over its share, its size, and its owner: sent whole for the first `handbook.warnTasks` board tasks (default 30), then refused, the step failing `config_error` (`handbook_over_bound`) before anything is sent. `handbook.enabled: false` turns the slice off.
- `brief@1.6` adds `handbook` (`@1.4` and `@1.5` are the tier and the model): the bound and its mode, the selection, and each layer's version (layer 1 the invariants' blob and the highest accepted ADR; layer 4 the template, its package's version, and the sha256 of the playbook carried), parts, and size. `ctx.workflow.template` takes the contributing package's `version`. `explain` gives it per step with the source's record; `system explain` prints both, and the run's page on `/ui` lists them under *What happened*.
