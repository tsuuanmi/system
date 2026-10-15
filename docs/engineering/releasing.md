# Releasing

How a version of `system` is made, built, and verified
([ADR-0026](../decisions/adr/0026-versioned-releases-with-provenance.md),
[PROP-0003 M6d](../proposals/0003-production-readiness.md#m6d-supply-chain-and-release)).

## Versions

All `@tsuuanmi/*` packages share one version: Changesets keeps them in one
`fixed` group ([`.changeset/config.json`](../../.changeset/config.json)). The
version follows SemVer over the contracts `system` owns: the MCP tools, the
gateway behavior, the CLI, the plugin configuration, and the schemas in
[`schemas/`](../../schemas/). DSH's own APIs are not covered. A DSH pin bump ships
only in a minor or major release. A release that narrows the supported Node
range says so in its changeset.

A change that a user or operator can notice adds a changeset in the same pull
request:

```sh
pnpm changeset          # pick the bump; the summary becomes the changelog line
```

## Cutting a release

1. On a branch from `main`, run `pnpm version-packages`
   ([`scripts/version-packages.ts`](../../scripts/version-packages.ts)). It:
   - applies the pending changesets: the new version in every `package.json`
     (the bundle's presets too, which are layers inside it rather than workspace
     packages) and a section in each `CHANGELOG.md`;
   - seeds this release's store fixture for the
     [upgrade suite](testing.md) with `pnpm gen:upgrade-fixture v<version>`.
     Fixtures are never edited afterwards.
2. Run every gate, merge the pull request, then tag the merge commit on `main`
   with `v<version>` and push the tag.
3. The [`release` workflow](../../.github/workflows/release.yml) then:
   - checks first, in seconds, without an install
     (`node scripts/release-artifacts.ts --verify`,
     [`scripts/release-artifacts.ts`](../../scripts/release-artifacts.ts)). It
     refuses:
     - a tag whose commit is not on `main`;
     - packages that disagree on the version;
     - a prerelease version (no prerelease is cut yet);
     - a tag that names another version;
     - a version with no changelog entry;
     - a DSH pin that is not one exact version, and a patch release whose DSH
       pins (any declared, dev included) differ from the previous release
       tag's;
   - runs every CI gate and the dependency audit on the tagged commit (it calls
     the `ci` and `audit` workflows);
   - builds the assets below with `pnpm release:artifacts`. It refuses a
     tarball whose `@tsuuanmi/*` dependency is not another tarball at exactly
     that version;
   - attests build provenance for every tarball and SBOM, in one attestation;
   - creates the GitHub release with the notes and the assets.
   Re-running a release whose GitHub release was already created fails at that
   step; delete that release first.
4. Run the [release checklist](../validation/release-checklist.md). A skipped
   item blocks the release.

`pnpm release:artifacts` also runs locally. It writes the release assets to
`dist/release/`, flat as the release lists them, and the notes to
`dist/release-notes.md` (both ignored by git):

| Asset | What |
|---|---|
| `*.tgz` | one `pnpm pack` tarball per package, with `workspace:*` replaced by the exact version; still `private`, so for installing from the file (`npm install ./<file>.tgz`) and for verification, not for a registry |
| `*.cdx.json` | a CycloneDX SBOM of each package's production dependencies (`pnpm sbom`) |
| `SHA256SUMS` | the SHA-256 of every other asset |

The notes hold the changelog section of each package that changed. A package
whose section only lists the group's dependency bumps is left out.

## Verifying a release

In a directory holding the release's assets:

```sh
sha256sum -c SHA256SUMS
gh attestation verify tsuuanmi-system-cli-<version>.tgz --repo tsuuanmi/system   # and any SBOM
```

## Not yet decided

These wait on the owner. The first two are parts of ADR-0026, which stays
Proposed until they are settled:

- **npm publication.** The packages stay `private`, and no workflow publishes to
  npm. Publishing would add npm trusted publishing (OIDC, no stored token), a
  `publishConfig.provenance` on each package, and `npm audit signatures` in the
  release checklist.
- **A license.** There is no `LICENSE` file yet, so no rights are granted.
- **Prereleases.** A prerelease version (for example `1.0.0-rc.0` from
  Changesets' pre mode) is refused, so it can never become the latest release.
- **Repository settings.** A tag ruleset so that only maintainers create `v*`
  tags, and required reviewers on the `release` environment, which the release
  job already names.
