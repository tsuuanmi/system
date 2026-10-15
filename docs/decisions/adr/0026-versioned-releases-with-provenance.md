# ADR-0026: Lockstep versioned releases with provenance; supported runtime policy

- **Status:** Accepted
- **Date:** 2026-10-14 (accepted 2026-10-15)
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
3. **One lockstep version for every package**, released from CI with provenance.

## Decision

Option 3, released on GitHub. The owner deferred publication to the npm registry
and the choice of a license.

- **Versioning.** Changesets manages one fixed version group for all packages and
  writes `CHANGELOG.md`. Packages declare `files` and stay `private`.
- **What SemVer covers.** The contracts `system` owns: MCP tools, gateway
  behavior, the CLI, plugin configuration, and the schemas in `schemas/`. DSH's
  own APIs are not covered. A DSH pin bump ships only in a minor or major release,
  after the conformance and composition suites pass.
- **Release.** A `v<version>` tag on the default branch runs every CI gate and the
  dependency audit, then creates a GitHub release. The release carries a tarball
  and a CycloneDX SBOM for each package, and `SHA256SUMS`. One build provenance
  attestation covers the tarballs and SBOMs. The seeded store fixture that the
  upgrade suite uses is committed when the release is versioned, from that
  release's code, so the tag carries it and it is never edited afterwards.
- **No registry publication.** Nothing is published to npm. Taking it up later
  is a new decision, in an ADR that supersedes this one: it would publish through
  npm trusted publishing (OIDC, no stored token) with provenance, take packages
  out of `private`, add the `dsh-plugin` keyword to the bundle, and add
  `npm audit signatures` to the release checklist.
- **Supported runtime.** `engines`, the CI matrix, and the start-up check name
  the same Node range. That range includes only releases with the `node:sqlite`
  fixes. A release that narrows it says so in the changelog.
- **Repository policy files.** `SECURITY.md` with a private reporting channel.
  The license is the owner's choice and is deferred; until one is added, no
  `LICENSE` file grants rights.

## Consequences

- Operators can pin a release, verify it (checksums, `gh attestation verify`),
  install it from its tarballs, and roll it back.
- Every release must keep the upgrade suite green for all earlier releases.
- The release job holds an identity that can attest builds and create releases.
  It runs only for a tag whose commit is on the default branch, and its
  `release` environment can require a reviewer.
- Revisit the SemVer boundary if DSH reaches a stable release with its own
  compatibility promise.
