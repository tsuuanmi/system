---
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-provider-core": minor
"@tsuuanmi/system-models-core": minor
"@tsuuanmi/system-models": minor
"@tsuuanmi/system-turns": minor
"@tsuuanmi/system-provider-chatgpt-web": minor
"@tsuuanmi/system-provider-gemini-web": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-cli": patch
---

The operator's `/ui`, round 3 (T116):
- Website and model Workers are named for people by their own title: `ChatGPT · main · frontier`, `Gemini · main · standard`, `Gemini API · standard`. A website driver gives its site's title; a `models[]` entry takes the operator's optional `title` (plain text, at most 64 characters). Each Worker carries it on its descriptor (`capability-descriptor@1.8` `title`, optional), and routing never reads it.
- A ready task's Board card offers **Start…**: a confirmation says what runs (the task's template, step by step, and the kind of Worker each step needs, from the new `ctx.workflow.templateSteps`), and **Confirm start** starts the run as the lead does with MCP `run` and `task` (`GET`/`POST /ui/api/tasks/<taskId>/start`, bound to the task revision and template shown). A task that names no template is refused with why.
- The autonomy policy is edited as a form: a mode per action class (the classes that always ask shown fixed at ask, with why), the commands as lines, the expiry and batch numbers. The JSON stays under **Advanced**; **Show change** and **Propose** are as before, and the queue validates as before. `GET /ui/api/policy` adds `alwaysAsk`.
- Approval cards read in words first: long hashes are folded behind **details** and **Exact subject**.
- Each quota window on the Workers tab reads `5 h: used 9 % — resets 23:30 (read 22:05)` with a small bar, `5 h: no reading yet: <why>` before a reading, and a window or pool at its limit first.
- At 600 px no page is wider than the screen: the navigation wraps whole links, and the Board's columns stack.
