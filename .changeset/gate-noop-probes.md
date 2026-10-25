---
"@tsuuanmi/system-agent-workers": patch
---

A Worker's shell probe that can do nothing is a read (T187): `echo`, `echo noop`, and `pwd` used to wait on the operator, up to 80 minutes, and stall the whole attempt.
- The tool gate classifies a `Bash` call as `read` when it is exactly `echo` with zero or more words (any word, `-e` and `-n` included), `pwd` with no argument, `true`, or `false`. Each is a shell builtin that reads no file and changes nothing: with no metacharacter (still refused, as before) the shell expands nothing, so it only prints its words, the working directory's name, or nothing.
- Anything else stays as before: `pwd`, `true`, or `false` with an argument, `/bin/echo`, and `printf` stay a `command`, by their exact argv.
