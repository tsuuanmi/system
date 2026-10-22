# @tsuuanmi/system-web-ui

The **operator's web UI**, on the DSH webserver under `/ui` (loopback only):

- runs and their steps;
- each step's Worker, tier, quota class, and decision chain (egress, tier,
  route, acceptance, recovery);
- the answer;
- the operator's **Approve / Reject plan**, **Vote** on a team's tie, **Stop run**, and **Continue run**;
- when `ctx.approvals` is present, the **approval queue**
  ([approvals](../../../docs/design/approvals.md)) above the runs: open requests by batch, each
  with its class, exact subject, summary, consequences, and expiry, and the operator's
  **Approve / Deny** for one request or a whole batch, with an optional note. Without it the
  page shows the runs alone and the queue routes answer `503`;
- when `ctx.board` is present, the **reviews**: every board task in review, those the board
  holds for the operator first ([board](../../../docs/design/board.md#required-checks-bind-at-acceptance)),
  each with its project, exact subject, result artifacts, the checks still pending, its run, and
  until when it waits, and the operator's **Accept / Reject**. Without it the reviews routes
  answer `503`.

The routes are in the [web UI API](../../../docs/reference/web-ui.md).

## Use

`system ui` prints the link: `http://127.0.0.1:<port>/ui/#token=…`, with the
operator token in the fragment. Open it on
the host, or over `ssh -L <port>:127.0.0.1:<port> host` like the login desktop.

## Security

- **Shell:** the page, script, and styles carry no data. They are served
  `no-store`, `no-referrer`, and `nosniff` under a strict content security
  policy: scripts and styles from `self` only, no frames, no forms.
- **Token:**
  - it travels in the URL **fragment**, which a browser never sends to a
    server;
  - the script moves it to session storage and removes it from the address bar;
  - it then sends it as `Authorization: Bearer` to `/ui/api`.
- **API guard**, the one every client endpoint shares
  ([`gateway-core`](../../gateway-core/README.md#the-request-guard)), in order:
  - a loopback `Host` (against DNS rebinding);
  - no `Origin` other than the UI's own (`sameOrigin`);
  - the operator token (`operator.token` under `tokenDir`), compared in
    constant time. A client or model token gets `401`.

  A page on another site cannot read the token and gets no CORS answer.
- **Bind:** on plain HTTP on a non-loopback host, `/ui` is not registered
  (`assertSafeBind`).
- **Actions** take a JSON body only (a form post cannot reach them) and go to
  the workflow engine as operator decisions. Approve and Reject send the plan
  the page shows (`plan`, a `sha256:` id), so the engine decides only that plan
  (INV-5). A vote sends the tie decision the page shows, an option or
  `inconclusive`, and a rationale; it is recorded as the operator's.
- **Queue verdicts** go to `ctx.approvals.decide` as the operator's (INV-6), at
  the server's clock, each with the exact subject of the request the page
  shows (INV-5); a batch verdict names its batch, and a request outside it
  refuses the whole call. This is the operator's human channel for verdicts:
  MCP clients get no new path (`approvals_decide` stays operator scope).
- **Review verdicts** are `acceptance` decisions made by the operator (decider and producer
  `operator`), naming the task, the exact subject of the result the page shows (a result on
  another subject is refused, INV-5), and every result artifact, then applied with
  `ctx.board.accept`. Like the queue's, this is the operator's human channel: no MCP tool
  accepts a review.
- **Rendering:** the page is built with DOM methods and `textContent` only.
  Model output is never parsed as HTML.
- **Scope:** only the operator scope reaches `/ui`
  ([scopes](../mcp-server/README.md#scopes)).

**Injects:** `webServer`, `workflow`; `approvals`, `board`, and `artifacts` are optional
(`ctx.get`), so the UI works without the queue or the board.

**Tests:** [`tests/web-ui.spec.ts`](tests/web-ui.spec.ts): the shell and its
headers, the guard, the run actions, the queue's routes (listing by batch,
verdicts bound to the subjects shown, a batch verdict bound to its batch, each
refusal, `503` without a queue or a board), and, with a browser, both pages.
[`tests/reviews.spec.ts`](tests/reviews.spec.ts) runs the UI over the store-backed board,
approval queue, and engine under the bundle's own default studio policy: a workspace-write task's
review held for the operator past its run's lease, listed with its pending checks, refused to a
client token, bound to the subject shown, accepted to done; a rejection as another attempt; and a
review that expires `review-expired`.
