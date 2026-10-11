# ADR-0014: JSON Schema is the canonical contract for records and wire payloads

- **Status:** Accepted
- **Date:** 2026-10-11
- **Related:** INV-14, ADR-0008, [reference: schemas](../../reference/schemas.md)

## Context

The maintainer requires clear schemas. `system` exchanges structured data across
several boundaries:

- the durable store (artifacts, receipts, nodes, leases);
- MCP tool inputs and outputs;
- the decision model's questions and answers;
- structured outputs requested from Workers, such as a writer's result or a
  reviewer's verdict;
- and, later, the gateways.

internet validated records with hand-written strict parsers. AgentOS limited
JSON Schema to "AgentOS-owned serialized structures". MCP and OpenAI structured
outputs both describe their shapes with JSON Schema.

## Options

1. TypeScript types as the source of truth (zod or TypeBox), with JSON Schema
   generated from them.
2. **JSON Schema (draft 2020-12) files as the source of truth**, with TypeScript
   types generated from them and runtime validation at every boundary.
3. No formal schemas; rely on types only.

## Decision

Option 2.

- The schemas live in [`schemas/`](../../../schemas/README.md) at the repository
  root. One file per record type, versioned in its filename and `$id`
  (`<name>.v<major>.json`).
- Every record carries `schema: "<name>@<major>.<minor>"`. Readers accept the
  same major version, ignore unknown fields only where the schema allows it, and
  reject everything else, failing closed.
- **Validation points:** store writes and reads, MCP input and output, decision
  model input and output, Worker structured outputs (the schema is also sent to
  the Worker when its provider supports schema-constrained output), and config
  bundles.
- **Evolution:** an additive optional field is a minor bump. Removing,
  renaming, or tightening a field is a new major version with a migration.
  Published schemas are never edited in place within a major version, except
  for additive minors.
- Plugin `Config` keeps using Schemastery, which is native to Cordis
  ([ADR-0007](0007-everything-is-a-plugin.md)). A configuration catalog is
  generated from it into `docs/reference/`.

## Consequences

- The contract is language-neutral and tool-agnostic (ADR-0008). Any client or
  future implementation can validate against the same files.
- CI validates every schema against the metaschema, validates the examples in
  `schemas/examples/` against their schemas, and checks that generated
  TypeScript types are current.
- Schema changes require review, like code changes. The rule is in
  [AGENTS.md](../../../AGENTS.md).
