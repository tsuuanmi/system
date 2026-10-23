---
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-mcp-server": patch
"@tsuuanmi/system-agent-workers": patch
---

A Worker source that does not answer is no longer missed (T50):
- Health names every Worker source that was silent (no answer within the router's 5 s) or failed in its last read, with when, and is degraded while one is, down when no Worker answered or the read failed. Before, `system health` could say `ok workers 7 available` while the agents source's three Workers were left out of that read. The new runbook entry "A Worker source does not answer" says what to do.
- `ctx.workers` gains the optional `sources()`: how each source answered its last read (`described`, `silent`, or `failed`). Routing is otherwise unchanged.
- The agents source refreshes each runtime's probe in the background once its result is half `probeTtlMs` old, one probe at a time per runtime, so a describe no longer waits for a re-probe. A result still stands for at most `probeTtlMs` from when its probe started: past it, the Worker reads `unavailable` until the next probe finishes. A probe that fails or proves less makes the Worker `unavailable` at once. A probe slower than half of `probeTtlMs` is logged.
