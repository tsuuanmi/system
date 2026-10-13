# ADR-0026: Lockstep versioned releases with provenance; supported runtime policy

- **Status:** Proposed
- **Date:** 2026-10-14
- **Related:** [PROP-0003](../../proposals/0003-production-readiness.md#m6d-supply-chain-and-release),
  CON-2, CON-8, [release scope](../../requirements/release-scope.md#operational-readiness),
  [ADR-0018](0018-build-on-dsh-core.md)

## Context

Every package is `0.0.0` and private. `system` runs from a checkout, with no
versions, changelog, license, or security policy. Production readiness asks for a
packaged distribution with checksum-verified artifacts, and for publication of the
bundle so DSH users can mount `system` plugins.

Two outside facts constrain any version promise:

- DSH and Cordis are a developer preview with about weekly breaking changes, and
  one exact version is pinned (CON-8).
- `node:sqlite` has defects that are fixed only in some Node releases
  (CVE-2026-58041 and text truncation at an embedded NUL), so the supported Node
  range is a security decision, not only a compatibility one.

## Options

1. Keep running from a checkout; tag commits only.
2. Independent versions per package.
3. **One lockstep version for every package**, published from CI with provenance.

## Decision

Option 3.

- **Versioning.** Changesets manages one fixed version group for all packages and
  writes `CHANGELOG.md`. Packages leave `private` and declare `files`. The bundle
  carries the `dsh-plugin` keyword.
- **What SemVer covers.** The contracts `system` owns: MCP tools, gateway
  behavior, the CLI, plugin configuration, and the schemas in `schemas/`. DSH's
  own APIs are not covered. A DSH pin bump ships only in a minor or major release,
  after the conformance and composition suites pass.
- **Publication.** A tag-triggered workflow runs every CI gate, then publishes
  through npm trusted publishing (OIDC, no stored token) with provenance. It
  generates a CycloneDX SBOM, attests the build, and attaches the SBOM and
  checksums to the GitHub release. It also emits the seeded store fixture that the
  upgrade suite uses.
- **Supported runtime.** `engines`, the CI matrix, and the start-up check name
  the same Node range. That range includes only releases with the `node:sqlite`
  fixes. A release that narrows it says so in the changelog.
- **Repository policy files.** A license chosen by the owner, and `SECURITY.md`
  with a private reporting channel.

## Consequences

- Operators can pin, verify (`npm audit signatures`, attestations, checksums), and
  roll back a release.
- Every release must keep the upgrade suite green for all earlier releases.
- Publishing gives CI an identity that can publish packages; it is limited to tag
  builds on the default branch.
- Revisit the SemVer boundary if DSH reaches a stable release with its own
  compatibility promise.
