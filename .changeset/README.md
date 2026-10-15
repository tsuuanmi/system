# Changesets

Every change a user or operator can notice adds a changeset: `pnpm changeset`.
All `@tsuuanmi/*` packages share one version (ADR-0026), so a changeset names any
package it touches and the bump applies to all of them. What a bump means, and
how a release is cut, is in [releasing](../docs/engineering/releasing.md).
