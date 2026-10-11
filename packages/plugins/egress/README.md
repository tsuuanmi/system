# @tsuuanmi/system-egress

**`ctx.egress`**: explicit data egress
([INV-12](../../../docs/architecture/invariants.md#inv-12-data-egress-is-explicit),
[routing](../../../docs/design/routing.md#data-locality-policy)).

- **`check({ payload, classification?, workerClass })`** runs on the **actual
  outgoing payload**. The payload is allowed only when both checks pass:
  - the classification is permitted for the Worker class (`workerClasses`,
    default `website: [public, operator-shared]`). An unknown class is denied.
  - no credential is found: secretlint's recommended rules (private keys, cloud
    and SaaS tokens, and others; in process, with secrets masked), a built-in
    `aws-access-key-id` pattern for the AWS keys those rules miss (a secret
    ending in `+` or `/`), and operator `denyPatterns`.
- **Decisions:** every check is an `egress` decision artifact. Findings record
  rule ids and offsets plus a payload hash, **never the matched text**.
- **Config:** `workerClasses`, `defaultClassification` (`operator-shared`),
  `scanSecrets` (true), and `denyPatterns`.
- **Limits:** a scan cannot recognize every kind of private data, so the
  caller's classification stays authoritative. `local-private` never goes to a
  `website` Worker by default.
- **Injects:** `artifacts`.
