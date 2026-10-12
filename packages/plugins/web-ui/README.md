# @tsuuanmi/system-web-ui

The **operator's web UI**, on the DSH webserver under `/ui` (loopback only):

- runs and their steps;
- each step's Worker, tier, quota class, and decision chain (egress, tier,
  route, acceptance, recovery);
- the answer;
- the operator's **Approve / Reject plan**, **Stop run**, and **Continue run**.

## Use

`system ui` prints the link: `http://127.0.0.1:<port>/ui/#token=…`. Open it on
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
- **API guard** (in order):
  - a loopback `Host` (against DNS rebinding);
  - no `Origin` other than the UI's own;
  - the bearer token, compared in constant time.

  A page on another site cannot read the token and gets no CORS answer.
- **Actions** take a JSON body only (a form post cannot reach them) and go to
  the workflow engine as operator decisions.
- **Rendering:** the page is built with DOM methods and `textContent` only.
  Model output is never parsed as HTML.
- **Token sharing:** the UI uses the MCP endpoint's token. A separate operator
  scope is a known gap ([threat model](../../../docs/security/threat-model.md)).

**Injects:** `webServer`, `workflow`.
