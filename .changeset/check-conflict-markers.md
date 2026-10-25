---
---

`pnpm check` (through `check:docs`) now fails on an unresolved git conflict marker in any tracked text file, naming the file and line (T167). Until now a Markdown, YAML, or shell file with conflict markers passed every check; TypeScript was caught by `tsc` alone. A line of seven `<`, `|` (diff3), or `>`, alone or with a label, is always a marker; a line of seven `=` is one only after a `<` marker in the same file, so a Markdown setext heading is not flagged. Binary files are skipped.
