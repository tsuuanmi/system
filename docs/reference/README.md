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
| [cli.md](cli.md) | every `system` command, grouped, one line each. Hand-written from the CLI's usage text |
| [workflow-templates.md](workflow-templates.md) | every workflow template (built-in and from profiles): its nodes, tiers, capabilities, conversation mode, and acceptance contract. Hand-written from the code |
| [gateways.md](gateways.md) | gateway compatibility: what Claude Code and Codex send, and what the gateways answer |
| [web-ui.md](web-ui.md) | the operator web UI's API under `/ui/api`: runs and their actions, the reviews of board tasks, and the approval queue. Hand-written from the code |
| [glossary.md](glossary.md) | short definitions of the terms the documents use, each linking to its canonical document |

Seam definitions are the abstract classes in the `*-core` packages, listed in
the [seam catalog](../architecture/plugin-model.md#seam-catalog).
