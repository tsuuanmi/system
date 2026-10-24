# spikes/m0-dsh-core

Throwaway probes for the M0 spike. The results are canonical in
[docs/research/m0-dsh-core-spike.md](../../docs/research/m0-dsh-core-spike.md).

- **Owns:** reproducible evidence for the ADR-0018 verification points.
- **Does not own:** production code. Nothing here is imported by `packages/`.
  The directory is deleted once its findings are fully promoted.

| File | Probe |
|---|---|
| [bundle/](bundle/package.json) | the profile's **only** bundle (no `dsh-base`, ADR-0019): timer, credentials, `dsh-host-webserver`, and an MCP Streamable HTTP probe on `/mcp` |
| [sqlite.spec.ts](sqlite.spec.ts), [sqlite-worker.ts](sqlite-worker.ts) | `node:sqlite` WAL, `BEGIN IMMEDIATE`, and cross-process revision checks |

The probes are not part of `pnpm test` (operator decision D37, 2026-10-24): the store's conformance
suite holds the product to what they found. Run the `node:sqlite` probe by hand with
`pnpm exec vitest run --root spikes/m0-dsh-core` (its own [vitest.config.ts](vitest.config.ts)).

Exercise the MCP probe once the profile is running. The port is printed by
`ss -ltnp`, because the probe uses `port: 0`:

```sh
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
curl -s -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer probe-token' -d "$INIT" http://127.0.0.1:$PORT/mcp
```
