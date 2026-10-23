---
"@tsuuanmi/system-runtime-codex-sdk": minor
"@tsuuanmi/system-runtime-antigravity-cli": minor
---

Codex and Antigravity CLI Workers wait out a usage limit until its reset, not a fixed cooldown:
- A Codex run that hits the usage limit carries the reset time Codex's own message names (Codex 0.164.0) as a limit observation of window `*`, so its pool, or its runtime with no pool, stays closed until then. Codex now always starts with `TZ=UTC`, so that time reads the same on every host; the agent's commands see UTC too.
- An Antigravity CLI run that hits a quota reads agy's own usage report afterwards (`agy --print=/usage --output-format json`, no agent turn; agy 1.4.6): each quota bucket is a limit observation of the window its `id` names, an exhausted one until its `reset_time`. Map the bucket ids in the Worker's `windows`; an exhausted bucket left unmapped closes every window of the pool.
- A reset that cannot be read, or one from a Codex or agy version not verified, is not read: the run's error says `its reset time is not read: …`, and the pool closes for `limitCooldownSeconds` as before, never opens.
