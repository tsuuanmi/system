---
"@tsuuanmi/system-models-core": minor
"@tsuuanmi/system-models": minor
"@tsuuanmi/system-agent-workers": patch
"@tsuuanmi/system-workflow": patch
---

A metered model API that answers `503 UNAVAILABLE` or `429 RESOURCE_EXHAUSTED` before any output (the provider says it did not process the request) is now sent again by the `models` Worker source, after a back-off that doubles from 1 s, at most `unprocessedMaxDelayMs` (default 60 s, 100 ms to 10 min) and at most `unprocessedRetries` times (default 4, 0 to 10), within `callTimeoutMs`. Each retry is a `recovery` decision on the call and a `models.call.retried` event; once they are used, a `recovery` decision `fail` says so. It used to fail the step at once for the operator ("the prompt was sent, so it is not resent automatically"), as a Gemini API overload did twice in one research run. Any other failure after the prompt was sent is still not resent. `ModelError` carries `unprocessed` and `attempts`. An answer whose send took more than 10 provider requests is written as `model-answer@1.1`, whose `attempts` allows 66, the combined bounds' worst case per send (`(unprocessedRetries + 1) × (maxRetries + 1)`); an answer of 10 or fewer stays `model-answer@1.0`.

A board task's step that started to wait on a deferred command call while the approval queue could not be read now gets the `deferredCommandMinutes` bound once the request can be read: a second `wait` decision and the bounded deadline on its row, kept across a restart. It used to wait until the request's own expiry, hours later.

The note a Worker's brief carries on the calls that run unasked now follows the policy's `command` mode (with `auto` or `notify`, other commands run; it used to say they wait for the operator), and says that a command on the commands list is judged as a workspace write, so with `workspace-write` `ask` it still asks.
