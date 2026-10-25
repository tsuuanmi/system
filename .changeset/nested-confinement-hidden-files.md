---
"@tsuuanmi/system-agent-runtime-core": patch
"@tsuuanmi/system-runtime-codex-sdk": patch
---

The workspace reads server starts on a host whose bubblewrap is older than 0.5 (T200b, seen live with 0.4.0). It runs in a confinement of its own nested in the run's (or the probe's), and the read confinement hides a secret file by binding `/dev/null` over it; bubblewrap 0.4.0 cannot mount over that null device again, so the server never started and the Codex probe refused every Codex Worker. `confinedCommand` takes `nested: true` for a confinement started inside one that hides the same paths: it leaves each hidden file as the outer one shows it (directories still get their tmpfs). A test starts such a nested confinement, a hidden file among its paths, under every bubblewrap on the host.
