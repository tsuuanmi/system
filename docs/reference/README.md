# Reference

This area covers **what is exact**: data contracts, interface contracts, and
configuration semantics. Machine-readable schemas in
[`schemas/`](../../schemas/README.md) are canonical for shape. The documents here
explain the semantics that a schema cannot express.

> Target state. The contracts are defined ahead of implementation and become
> current truth when code validates against them.

| Document | Owns |
|---|---|
| [schemas.md](schemas.md) | semantics of the core record schemas, versioning, validation points |
| [configuration.md](configuration.md) | every plugin's options. It is generated from each plugin's `Config` schema (`pnpm gen:reference`), and CI fails when it is stale |
| [mcp-tools.md](mcp-tools.md) | the MCP tool contracts, as a running profile serves them. It is generated with `system tools --markdown` |
| [gateways.md](gateways.md) | gateway compatibility: what Claude Code and Codex send, and what the gateways answer |

Seam definitions are the abstract classes in the `*-core` packages, listed in
the [seam catalog](../architecture/plugin-model.md#seam-catalog).
