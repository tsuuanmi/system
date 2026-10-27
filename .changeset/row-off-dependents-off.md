---
"@tsuuanmi/system-mcp-server": patch
"@tsuuanmi/system-bundle": patch
---

The removability matrix is green (T325): a plugin that waits only for services whose row is off is reported by health as `off` ("waits for service accounts, whose row is off"), not as down, and health stays ok; a plugin waiting for a service no row provides, or for a row that is on and has not provided it, is still down. The live stage runs the removability smoke with `--removability on` by default.
