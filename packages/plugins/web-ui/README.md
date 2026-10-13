# @tsuuanmi/system-web-ui

The **operator's web UI**, on the DSH webserver under `/ui` (loopback only):

- runs and their steps;
- each step's Worker, tier, quota class, and decision chain (egress, tier,
  route, acceptance, recovery);
- the answer;
- the operator's **Approve / Reject plan**, **Stop run**, and **Continue run**.

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
  (INV-5).
- **Rendering:** the page is built with DOM methods and `textContent` only.
  Model output is never parsed as HTML.
- **Scope:** only the operator scope reaches `/ui`
  ([scopes](../mcp-server/README.md#scopes)).

**Injects:** `webServer`, `workflow`.
