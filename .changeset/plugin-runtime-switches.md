---
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-plugin-host-core": minor
"@tsuuanmi/system-plugin-host": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-bundle": minor
---

An optional plugin is turned off and on while the daemon runs, with no restart, and a gate-like mechanism is moved to warn the same way (ADR-0078, T322):
- `system plugin list` shows each row on or off, required or optional, and its last turn with why. `system plugin off <row> [reason]` and `system plugin on <row>` (MCP `plugin`, operator) turn an optional row in the running daemon. The turn waits until the row's plugin has finished or handed back its work and stopped, or has started, within the `plugin-host` row's new `quiesceSeconds` (60). It records a lifecycle decision with the reason and writes `disabled` into your profile's `cordis.patch.yml`, so a restart keeps it. A required row is refused with why. So is turning off `mcp-server`, the surface the switches are served on, because nothing could turn it on again; turn it off in your patch and restart. So is a plugin that does not stop in time, which is put back as it was.
- `system enforce` lists each gate-like mechanism's mode. `system enforce set <mechanism> <off|warn|on|configured> [reason]` (MCP `enforce`) sets it live, and each set is recorded as a decision. The mechanisms are `evidence-gate` (off, warn, on), `handbook-bound` (warn, on), `review-guides` (off, on), and `lead-rights` (on only). The workflow row's new `enforce` (`evidenceGate`, `handbookBound`, `reviewGuides`, each `on` by default) gives their start values.
- The `plugin-host` row's new `optionalWithoutManifest` names the DSH model rows (`llm`, `llm-pi-ai`), which may be turned off. A patch that targets the row replaces its whole config, so copy that list into it too.
- A new mechanism lands as an optional row or behind such a switch, off or warn, and moves to on after 7 days clean (docs/architecture/plugin-model.md).
- The plugin host's contract is now 1.2. This is a minor: each new call is optional.
