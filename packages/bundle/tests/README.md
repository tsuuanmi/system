# Tests

- [patch-merge.test.ts](patch-merge.test.ts) — the profile's own patch
  changes the bundle's config through DSH's `composeEntries`: an account
  changed, added or removed by `ref`, a scalar replaced, a field removed by
  `null`, `$patch: replace`, and other rows untouched.
