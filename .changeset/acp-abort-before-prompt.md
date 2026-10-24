---
"@tsuuanmi/system-runtime-acp": patch
---

An ACP agent run aborted before its prompt was sent (while the agent was starting or making its session) no longer sends the prompt. It used to send it anyway once the session existed, so the agent worked on an aborted run until it was stopped 3 s later. The agent is now stopped at once, and the run ends as aborted.
