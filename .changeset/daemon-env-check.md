---
"@tsuuanmi/system-cli": minor
---

`system check --env-file <file>` also checks the daemon unit's environment file: owner-only, systemd's `NAME=VALUE` syntax, `PATH` and `DSH_HOME` present, no name the daemon does not read nor a row names (`apiKeyEnv`, `forwardEnv`), and absolute paths. It prints names, never values. The runbook runs the live daemon under its own `system.service` unit, with that file as its `EnvironmentFile=`; `scripts/live-update.sh` stops and starts the daemon only through the unit.
