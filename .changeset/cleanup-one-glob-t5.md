---
"@tsuuanmi/system-libs": patch
"@tsuuanmi/system-approvals-core": patch
"@tsuuanmi/system-agent-workers": patch
---

Clean-up (PROP-0018 T5): one glob matcher and one pattern validator. `globMatches` takes an `exact` flag (a bare name is only itself, not what is under it), and the new `globProblem(pattern, deep)` is the one validator (path characters and `*`, single slashes, no `.` or `..`, `**` only as a whole segment; without `deep`, no `**` and no trailing `/`). The risk-tier path map (`patternProblem` now wraps it), the lessons' `Applies:` paths (a refused one matches nothing), and the generated-file patterns of a worktree setup use them instead of their own. A generated-file pattern now takes only path characters (letters, digits, `. _ @ + -`) and `*`, and its refusals use the shared wording. approvals-core depends on libs at run time.
