---
"@tsuuanmi/system-workflow": patch
"@tsuuanmi/system-profile-software-development": patch
---

The evidence gate no longer requires exit codes, which a Worker's shell tool may not print: evidence shows at least one command, names each required check with its output or why it could not run, and holds an output line.
