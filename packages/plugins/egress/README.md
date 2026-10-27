# @tsuuanmi/system-egress

**`ctx.egress`**: explicit data egress
([INV-12](../../../docs/architecture/invariants.md#inv-12-data-egress-is-explicit),
[routing](../../../docs/design/routing.md#data-locality-policy)).

- **`check({ payload, classification?, workerClass })`** runs on the **actual
  outgoing payload**. The payload is allowed only when both checks pass:
  - the classification is permitted for the Worker class (`workerClasses`,
    default `website`, `agent`, `model`, and `model-local`:
    `[public, operator-shared]`; an operator widens `model-local` for
    `local-private` once its route's address is loopback; and `webhook`, the
    [notify](../notify/README.md) plugin's webhook, `[]`: nothing leaves for it
    until the operator lists `operator-shared`). An unknown class is denied.
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
  payload after routing; `notify` (`webhook`, before each notice it posts, on
  the exact body).
  `agent` is an agent runtime Worker: it runs here, but its model is remote. An
  operator whose agent model runs on this machine widens
  `workerClasses.agent` to admit `local-private`. The workflow engine reads
  `defaultClassification` for a run that states none.
- **Limits:** a scan cannot recognize every kind of private data, so the
  caller's classification stays authoritative. `local-private` never goes to a
  `website`, `agent`, or `model` Worker by default. Setting `workerClasses`
  replaces the whole default, so list every class.
- **Injects:** `artifacts`.
- **The seam** (`Egress`, `Config`, `EgressRequest`, `EgressVerdict`, `Finding`, `DenyPattern`,
  `WORKER_CLASSES`) is defined in [`@tsuuanmi/system-workers-core`](../../workers-core/README.md), the
  gate's definition package; this plugin extends it, and every consumer imports from there.
- The conformance suite is [`conformance/egress.ts`](../../workers-core/conformance/egress.ts) in that
  package, run through the [conformance runner](../../libs/conformance/runner.ts) at contract 1.0
  against this plugin with `EGRESS_CONFIG`:
  - public and operator-shared content to every default Worker class;
  - local-private kept on the machine for every default class, `model-local` included, and
    let out only to a class the operator widened;
  - an unknown Worker class or classification denied (fail closed); an unstated
    classification judged as the configured default;
  - a credential refused anywhere in the actual payload, at its offset; operator deny
    patterns;
  - findings as rule ids and offsets plus a payload hash, never the secret;
  - every check one schema-valid `egress` decision whose selected candidate is the verdict.
