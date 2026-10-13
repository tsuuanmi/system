# @tsuuanmi/system-egress

**`ctx.egress`**: explicit data egress
([INV-12](../../../docs/architecture/invariants.md#inv-12-data-egress-is-explicit),
[routing](../../../docs/design/routing.md#data-locality-policy)).

- **`check({ payload, classification?, workerClass })`** runs on the **actual
  outgoing payload**. The payload is allowed only when both checks pass:
  - the classification is permitted for the Worker class (`workerClasses`,
    default `website`, `agent`, and `model`: `[public, operator-shared]`;
    `model-local`: `[public, operator-shared, local-private]`). An unknown
    class is denied.
  - no credential is found: secretlint's recommended rules (private keys, cloud
    and SaaS tokens, and others; in process, with secrets masked), a built-in
    `aws-access-key-id` pattern for the AWS keys those rules miss (a secret
    ending in `+` or `/`), and operator `denyPatterns`.
- **Scan:** `src/scan.ts` (`scanCredentials`) holds the secretlint rules and the
  built-in patterns. The repository secrets audit (`pnpm check:secrets`) runs the
  same scan over every tracked file.
- **Decisions:** every check is an `egress` decision artifact. Findings record
  rule ids and offsets plus a payload hash, **never the matched text**.
- **Config:** `workerClasses`, `defaultClassification` (`operator-shared`),
  `scanSecrets` (true), and `denyPatterns`.
- **Callers:** `turns` (`website`, before a provider turn), `agent-workers`
  (`agent`, before an agent run), and `models` (`model` for an API model,
  `model-local` for a model on this machine, before a call), each on its actual
  payload after routing.
  `agent` is an agent runtime Worker: it runs here, but its model is remote. An
  operator whose agent model runs on this machine widens
  `workerClasses.agent` to admit `local-private`.
- **Limits:** a scan cannot recognize every kind of private data, so the
  caller's classification stays authoritative. `local-private` never goes to a
  `website`, `agent`, or `model` Worker by default. Setting `workerClasses`
  replaces the whole default, so list every class.
- **Injects:** `artifacts`.
