---
"@tsuuanmi/system-provider-chatgpt-web": minor
"@tsuuanmi/system-provider-gemini-web": minor
---

ChatGPT and Gemini: the answer-stable window (how long an answer's text must stay unchanged, with generation stopped, before it counts as complete) is now the validated `stableMs` option on each plugin's row. It defaults to 1.5 s, as before, so production behaves the same, and accepts 100 ms to 1 min. The turn runtime's and workflow engine's browser test stacks set it to 300 ms, as the drivers' own specs do, so their fake-site turns no longer wait 1.5 s each.
