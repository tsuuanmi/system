# ADR-0002: TypeScript on Bun, Node-compatible core

- **Status:** Superseded in part by [ADR-0018](0018-build-on-dsh-core.md) (runtime is Node, because DSH does not support Bun; the supported range is [CON-2](../../requirements/constraints.md); TypeScript stays)
- **Date:** 2026-10-11
- **Related:** PROP-0001, CON-2

## Context

All three reference systems are TypeScript. The browser automation stack
(patchright/Playwright over CDP), the MCP SDK, tokenizers, and HTML-to-Markdown
tooling are first-class in the JavaScript ecosystem. codex-chatgpt-web shows that
Bun can ship a fast loopback daemon (`Bun.serve`) with embedded SQLite.

## Options

1. TypeScript on Bun.
2. TypeScript on Node only.
3. A Rust kernel with TypeScript provider adapters.

## Decision

Option 1. Bun is the runtime and package manager. Kernel, routing, and
orchestration packages avoid Bun-only APIs behind small ports, such as the store
driver and the HTTP server, so they also run on Node 22+.

## Consequences

- One language end to end, and direct reuse of patterns from the reference repos.
- Bun-specific features (`bun:sqlite`, `Bun.serve`) are confined to adapter
  packages.
- Option 3 was rejected for now. A split-language boundary adds build and IPC
  cost before there is any measured performance need. Revisit if kernel
  throughput or memory becomes a measured bottleneck.
