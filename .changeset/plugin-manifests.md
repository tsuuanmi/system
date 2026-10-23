---
"@tsuuanmi/system-plugin-host": minor
"@tsuuanmi/system-plugin-host-core": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-bundle": minor
"@tsuuanmi/system-schemas": minor
---

Every plugin package ships a `plugin-manifest.json`: the seams it provides, consumes, and defines at their contract versions, and its core component or plugin family, generated from its code and checked against it. The new `plugin-host` row (on) records each plugin's lifecycle state at start, every change as a `lifecycle` decision: a row on is `default`, a row off `candidate`, a plugin no row names any more `retired`. It records and automates nothing:
- `system plugins` and MCP `status` (operator) list every plugin of the composition with its rows, version, class, manifest, and recorded lifecycle.
- Health gains a `manifests` check, degraded when a plugin's manifest is refused.
- `decision@1.5` adds the `lifecycle` decision; `plugin-manifest@1.1` adds `defines`.
