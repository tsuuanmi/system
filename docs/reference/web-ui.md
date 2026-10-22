# Web UI API

> Hand-written from [`web-ui`](../../packages/plugins/web-ui/README.md) (`src/index.ts`). The
> page at `/ui` is its only client; `system ui` prints its link.

Every route is under `/ui/api` and passes the shared request guard first
([gateway-core](../../packages/gateway-core/README.md#the-request-guard)): a loopback `Host`
(else `421`), no `Origin` but the UI's own (else `403`), and the operator token as
`Authorization: Bearer` (else `401`). A `POST` takes a JSON object only
(`content-type: application/json`, else `415`), of at most 16 KiB (else `413`). Errors are
`{error}`.

## Runs

| Route | Body | Answer |
|---|---|---|
| `GET runs` | — | `{runs}`: the latest 100 runs |
| `GET runs/<runId>` | — | `{run, explain}`; `404` for an unknown run |
| `POST runs/<runId>/approve` | `{verdict: approved \| rejected, note?, plan?}`: `plan` the `sha256:` id of the plan the page shows (INV-5) | `{run}` |
| `POST runs/<runId>/vote` | `{decision, option, rationale}`: the tie decision the page shows, an option or `inconclusive` | `{run}`; the vote is the operator's |
| `POST runs/<runId>/stop` | `{reason?}` | `{run}` |
| `POST runs/<runId>/continue` | `{nodeId?}` | `{run}` |

A refused action is `400` (a malformed body) or `409` (the engine refused it).

## Approval queue

Served when `ctx.approvals` is present; without it, both routes answer `503`
([approvals](../design/approvals.md)).

| Route | Body | Answer |
|---|---|---|
| `GET approvals` | — | `{batches: [{batchId?, requests}]}`: the open and batched `approval-request@1.0` records, by batch then expiry, the unbatched last (no `batchId`) |
| `POST approvals/decide` | `{verdicts, note?, batchId?}` | `{results}`: one `{requestId, state, approval?, refused?}` per verdict, in order |

- `verdicts` holds 1 to 50 `{requestId, subject, verdict: approved | rejected, note?}`. `subject`
  is the exact subject the page showed for that request (INV-5): a verdict for a request whose
  subject changed since is refused (`subject-changed`) and changes nothing.
- `note` applies to every verdict that has none of its own; a note is trimmed to 2000
  characters.
- With `batchId`, every verdict must be for a request of that batch, or nothing is decided
  (`409`). The page sends it for **Approve batch** and **Deny batch**, with one verdict for each
  request it shows.
- A malformed verdict refuses the whole call before any verdict applies (`400`). Otherwise
  the verdicts go to `ctx.approvals.decide` as the operator's (INV-6), at the server's clock:
  each applies or is refused on its own (`unknown-request`, `already-resolved`, `expired`,
  `subject-changed`, `failed`).
