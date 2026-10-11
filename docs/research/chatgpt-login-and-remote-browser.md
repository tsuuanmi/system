# Automated ChatGPT login and a remote browser on Linux

Non-normative. Researched on 2026-10-11 to answer two questions without
designing from scratch:

1. Is there an existing project that logs in to ChatGPT automatically with email,
   password, and a 2FA (TOTP) code?
2. Which component should provide an interactive remote browser on Linux over
   noVNC and an SSH tunnel?

Promoted into [ADR-0017](../decisions/adr/0017-credential-login-and-linux-remote-browser.md)
and [browser runtime](../design/browser-runtime.md). Items marked
**[unverified]** could not be checked against a primary source.

## A. Automated login with email, password, and TOTP

| Project | Approach | 2FA | Status in 2026 | Verdict |
|---|---|---|---|---|
| [acheong08/OpenAIAuth](https://github.com/acheong08/OpenAIAuth) | reverse-engineered Auth0 login over HTTP | none | archived 2023; the Auth0 flow no longer exists | dead |
| [transitive-bullshit/chatgpt-api](https://github.com/transitive-bullshit/chatgpt-api) | Puppeteer form login (2022–23) | none; solved CAPTCHAs through paid services | archived | dead; CAPTCHA solving is out of policy anyway |
| pengzhile/pandora | token proxy | — | repository deleted | dead |
| [Zai-Kun/reverse-engineered-chatgpt](https://github.com/Zai-Kun/reverse-engineered-chatgpt) | the session cookie is pasted by hand | none | archived 2024 | dead |
| [lanqian528/chat2api](https://github.com/lanqian528/chat2api) | no login; the user supplies access or refresh tokens | none | active | chat only, does not log in |
| [xtekky/gpt4free](https://github.com/xtekky/gpt4free) `OpenaiChat` | opens chatgpt.com with nodriver and **waits for a human to log in** | whatever the human enters | active | confirms the "human logs in once" pattern |
| [Draivix/codex-autologin](https://github.com/Draivix/codex-autologin) | Camoufox automates `codex login` OAuth: email, password, then an **email OTP read through IMAP** | email OTP only; no TOTP | small, recent | good reference for the form and OTP steps; it produces Codex tokens, not a web session |
| bacluc-agent/agent-runner PR #14 | Playwright login plus `pyotp` TOTP | TOTP | merged 2026-09; the PR states that an end-to-end login is **not proven** | reference only |
| [browser-use](https://docs.browser-use.com/customize/browser/authentication) | LLM agent; `sensitive_data` with a `bu_2fa_code` key holds the TOTP secret, and the code is generated locally | TOTP (local) | active, generic | pattern: the secret stays local, and a code is minted at the moment of use |
| [Skyvern](https://skyvern.com/docs/credentials/totp) | LLM agent with stored credentials | TOTP from an authenticator key; email or SMS codes pushed through an API or webhook | active, generic | pattern: an "authenticator key" field and a code-provider webhook |
| Stagehand | LLM actions on Playwright | none; human-in-the-loop live view | active | — |

**Conclusion:** no maintained, proven project automates **ChatGPT Web** login
with TOTP. The reverse-engineered HTTP flows are dead. Full LLM agents are
overkill for a fixed form of four steps. **We should build a small,
deterministic login state machine** that borrows its patterns from
codex-autologin (form steps, IMAP OTP), browser-use, and Skyvern (local TOTP, a
code-provider hook).

### Codex "Sign in with ChatGPT" does not give a web session

Codex CLI uses OAuth 2.0 with PKCE against `auth.openai.com` (redirect
`127.0.0.1:1455`), or a device code (`codex login --device-auth`). It stores
`id_token`, `access_token`, and `refresh_token`. Those tokens are used against
the Codex backend. The ChatGPT **Web** app authenticates with its own NextAuth
session cookie, and nothing documented converts OAuth tokens into that cookie.
The browser still needs a real login.

### What the OpenAI login can ask for

- The flow asks for the email first, then the password, then any challenge.
- MFA methods are an authenticator app (TOTP), push, SMS or WhatsApp, and
  passkeys. When several are enabled, the strongest is offered first, so the
  automation may need to choose "try another method" (exact label
  **[unverified]**).
- A **risk-based login check** on a new device or location sends a **6-digit code
  by email** or a push to the app. **TOTP cannot satisfy it.** A fresh browser
  profile looks like a new device, which is one more reason to keep a persistent
  login profile.
- Cloudflare challenges and Turnstile exist on chatgpt.com. They are never
  solved automatically (CON-3).

### TOTP: compute locally, never on a website

- `2fa.live` is a website where you paste a Base32 TOTP secret and it shows the
  current code. The secret *is* the second factor (RFC 6238). Whoever holds it
  can generate valid codes forever. **Sending it to any third-party site defeats
  2FA.** A secret that was already pasted there should be treated as
  compromised and re-enrolled.
- Computing the code locally takes a few lines, with npm
  [`otpauth`](https://www.npmjs.com/package/otpauth) (RFC 4226/6238; works on
  Bun and Node) or `otplib`. It needs a synced clock (NTP) and a guard against
  reusing a code.

## B. Remote browser on Linux over noVNC and an SSH tunnel

| Component | Fit for one user, loopback, a token, and an SSH tunnel | Can a human and patchright share the same system Chrome profile? | Verdict |
|---|---|---|---|
| **Xvfb + x11vnc + noVNC/websockify** (what internet does) | excellent: `-localhost`, a one-time password, websockify on 127.0.0.1, our own token page | **yes**: same X display, same profile, real X input | **port it for the MVP** |
| TigerVNC `Xvnc` + noVNC | excellent; one process acts as X server and VNC server, with no screen-scraping lag | yes | first upgrade candidate |
| KasmVNC | very good; built-in web client, no websockify | yes | heavier configuration |
| neko (m1k1o) | WebRTC, multi-user oriented, containerized | awkward; the browser lives in the container | no |
| linuxserver/docker-chromium | containerized Chromium | not our system Chrome or profile | no |
| steel-dev/steel-browser | browser API with CDP sessions; no human takeover over VNC | no | no |
| browserless | SSPL or commercial license; live handoff is a paid feature | no | no (license) |
| Selenium Grid noVNC | WebDriver-centric | no | no |
| CDP screencast (Skyvern's `cdp` mode) | no extra dependencies | yes, but input is injected through CDP, not real X input | fallback only (**[unverified]** detection impact) |

**Conclusion:** port internet's existing Xvfb + x11vnc + noVNC remote login. It
already has per-login loopback ports, a tokenized noVNC page, a one-time VNC
password, revocation on save, and Save, Cancel, and paste buttons. It matches our
stack. TigerVNC `Xvnc` is a drop-in improvement for later. Start the remote view
only on demand (first login or `NEEDS_HUMAN`), with a short-lived token.

## Sources

- [acheong08/OpenAIAuth](https://github.com/acheong08/OpenAIAuth)
- [transitive-bullshit/chatgpt-api](https://github.com/transitive-bullshit/chatgpt-api)
- [lanqian528/chat2api](https://github.com/lanqian528/chat2api)
- [gpt4free OpenaiChat provider](https://raw.githubusercontent.com/xtekky/gpt4free/main/g4f/Provider/needs_auth/OpenaiChat.py)
- [Draivix/codex-autologin](https://github.com/Draivix/codex-autologin)
- [bacluc-agent/agent-runner PR #14](https://github.com/bacluc-agent/agent-runner/pull/14)
- [browser-use authentication](https://docs.browser-use.com/customize/browser/authentication)
- [Skyvern TOTP](https://skyvern.com/docs/credentials/totp)
- [Codex login source](https://raw.githubusercontent.com/openai/codex/main/codex-rs/login/src/server.rs)
- [Codex auth docs](https://learn.chatgpt.com/docs/auth)
- [OpenAI Help: MFA](https://help.openai.com/en/articles/7967234)
- [OpenAI Help: login verification](https://help-lb.openai.com/en/articles/9889414)
- [otpauth on npm](https://cdn.jsdelivr.net/npm/otpauth@9.5.2)
- [otplib](https://otplib.yeojz.dev)
- [neko](https://github.com/m1k1o/neko)
- [linuxserver docker-chromium](https://docs.linuxserver.io/images/docker-chromium)
- [steel-browser](https://github.com/steel-dev/steel-browser)
- [browserless](https://github.com/browserless/browserless)
- [x11vnc releases](https://releasealert.dev/github/LibVNC/x11vnc)
