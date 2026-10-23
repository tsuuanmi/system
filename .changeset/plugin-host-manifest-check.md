---
"@tsuuanmi/system-plugin-host-core": minor
"@tsuuanmi/system-plugin-host": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-bundle": minor
---

At each start, the plugin host now checks every plugin a row runs against its manifest:
- A row whose package ships no `plugin-manifest.json`, or one the host refuses, is a finding, unless the `plugin-host` row's new `allowWithoutManifest` names the package. The bundle lists its four DSH rows there. A patch that targets the `plugin-host` row replaces its whole config, so copy that list into it, or each DSH row becomes a finding.
- A seam a plugin consumes is a finding when the plugin providing it declares a version outside the consumer's range. This is what rows of two releases in one profile usually show.
- Each finding is recorded once as a decision. MCP `status` (operator) and `system plugins` list it under its plugin, and health `manifests` is down until it is cleared. The host cannot stop the row, so the plugin still runs. Turn its row off, or fix or allow its package, and restart (runbook: "The manifest check found a plugin").
- A refused manifest in a row that is off still makes `manifests` degraded.
- Every plugin manifest now lists its configuration keys, none of them sensitive. The Worker sources, website drivers, and agent runtimes now declare their `egress`: `operator-shared` under the default policy.
- The plugin host's contract is now 1.1. This is a minor: the new fields of a listed plugin are optional.
