# Browser interaction and self-healing for website drivers

Non-normative. Reviewed on 2026-10-11 under the research-before-build rule
([ADR-0010](../decisions/adr/0010-reuse-before-build.md)). The question is how a
provider driver (first, ChatGPT Web) should operate a website whose UI changes
often, without code changes for every UI change. Downloaded sources were read
only, never executed.

## Sources and what each does

| Source | Interaction approach | Reusable ideas |
|---|---|---|
| tsuuanmi/AgentOS | Docs only. It defines a Browser Port ("open, navigate, snapshot/inspect, submit/interact, wait for observable state") and says provider-specific DOM logic stays in drivers (`docs/architecture/plugins/website-agent/browser-composition.md`). It does **not** describe interaction modes (DOM, ARIA, vision, replay, network) | the port's verbs |
| tsuuanmi/internet (`src/browser/chatgpt*.ts`) | CSS selectors, several OR-ed per operation, scoped to the composer form and filtered to visible elements. It verifies after acting: prompt readback, `aria-expanded`, exact menu labels, and slider `aria-valuenow`. Auth checks the URL, then calls `fetch('/api/auth/session')` from the page, then the DOM | scoping, OR-ed candidates, verify-after-act. **Brittle:** hashed classes, React fiber `memoizedProps`, Deep Research completion found by scanning frames for an `Export` button. Tests mock locators; there are no DOM fixtures |
| miuuyy/codex-chatgpt-web (the most mature) | DOM plus ARIA plus **network observation**. Selectors carry a capture date. `getByRole` uses names localized to about 60 languages, taken from ChatGPT's own locale bundle. Prompts go in with `execCommand('insertText')` and exact readback. Turn identity comes from `data-turn-id` / `data-turn-key`. Completion is a state machine: stop gone, stream closed, copy-turn action after the last assistant turn, and stable text. `captureDiagnostic` dumps per-selector match counts, a skeleton of the turn DOM, and an opt-in screenshot | localized role names, turn identity, the completion state machine, a diagnostic bundle, and a **passive** network observer (`page.on('response')` for `backend-api/f/conversation`, `text/event-stream` still open = running, `cf-mitigated` = challenge, 413 = too long, SSE `error_code`). It never calls these endpoints. Everything is TypeScript constants, nothing is config |
| `@wlv-zedd/dsh-chatgpt-web` (an older fork of the above) | the same, minus some fallbacks | stage-timeout taxonomy; a suspension clock; submission evidence `user_turn \| assistant_turn \| generation_running \| mcp_tool_call` compared with pre-send counts; `onSendActivated` as the point after which a prompt is not replayed |
| Tencent/BrowserSkill | Trace v3 is a recording of state, action (`{op, target: {ref, role, name, ctx}}`), and next state. It is replayed by an LLM that re-observes the page and matches each step by role and name. VOM (`packages/vom`) joins the accessibility tree with DOMSnapshot geometry and detects blocking layers | target shape `{role, name, ctx}` as one locator candidate; VOM as a compact page view for diagnosis. Not usable as an operations config: no candidates, waits, or verification |
| Stagehand 3.x / 4.x (MIT) | `act` / `observe` / `extract` with an LLM; action cache; `selfHeal` | the observe, cache, replay, re-infer loop. **Rejected as a runtime:** it needs a CDP URL (or its own launch, or an extension with `--remote-allow-origins=*`), and pulls in heavy model SDKs |
| Playwright / patchright 1.63 (Apache-2.0) | role, test-id, and label locators; `locator.or()`; `describe()`; `ariaSnapshot({ mode: 'ai', boxes })` with `[ref=eN]`; the `aria-ref=` selector (internal in 1.63, public `getByRef` in 1.64); `locator.normalize()` turns a matched element into a test-id or role locator | **adopted**: every building block the engine needs, in process, no CDP port |
| Playwright Test Agents (planner, generator, healer; 1.56+) | an LLM replays a failing test, inspects the UI, patches the locator, re-runs, and a human reviews the diff | the promotion process: heal proposals are diffs a human reviews |
| `@playwright/mcp`, chrome-devtools-mcp, DSH `browser-use-playwright-mcp` / `-chrome-devtools-mcp` / `-stagehand-native` | LLM-facing browsing tools over snapshot refs | **Rejected as the heal engine:** each launches its own browser or attaches through a debugging endpoint; none accepts our in-process Page. `@playwright/mcp` and codegen remain useful **maintainer tools** for editing the UI map |
| browser-use (Python), Skyvern (AGPL, vision) | DOM + accessibility serialization; vision | ideas only; runtime and license do not fit |
| Healenium (Java, Apache-2.0) | stores the last good element's path, scores candidates on failure, accepts only above a score cap | the fingerprint plus score threshold idea |

An earlier discussion (2026-10-04) preferred "DSH Browser Use + Playwright MCP as
the baseline". On inspection, DSH `browser-use` only names a model-facing tool
provider, and every MCP browser server needs its own browser or a debugging
endpoint. They stay suitable for **exploratory** agent browsing, not for
deterministic provider turns on an account's browser.

## ChatGPT operations and their most stable signals

Snapshot from the reference repositories (codex-chatgpt-web is the newest, dated
2026-10-09); not verified against the live site.

| Operation | Most stable signal today |
|---|---|
| login surface | URL `auth.openai.com` or `/auth/*`; `data-testid=login-button` |
| challenge | response header `cf-mitigated: challenge`; challenge URL |
| signed in | composer present plus a profile or user menu button test id |
| composer | `data-testid=prompt-textarea` / `#prompt-textarea`; `role=textbox` in the composer form |
| send | `data-testid=send-button`, accessible name "Send prompt", in the composer form, enabled; **Enter** in the composer as a fallback |
| stop / running | `data-testid=stop-button`; an open `text/event-stream` response (network) |
| model and effort | `data-testid=model-switcher-dropdown-button` (`aria-haspopup=menu`); `role=menuitemradio`; effort slider read through `aria-value*` |
| Deep Research | composer plus button with `aria-expanded`; option `connector_openai_deep_research`; pill `data-id="plugin:connector_openai_deep_research"` |
| attachments | `input[data-testid=upload-photos-input]`; a `role=group` named after the file; upload-stream completion (network) |
| turns | `data-turn-id`, `data-turn-key`, `data-message-author-role` |
| response body | `[data-markdown-text-style=assistant-message]`, `.markdown` |
| completion | copy-turn action after the last assistant turn; stop gone; stream closed; stable text |
| conversation binding | URL `/c/<id>` |
| errors | rate-limit and generic error dialogs; HTTP 413 `message_length_exceeds_limit`; SSE `error_code` |

## Live check (2026-10-11, signed-in account, read only)

The maintainer signed in through a temporary remote view. The login profile was
then reopened headed on a private Xvfb, and only the UI was read: nothing was
typed or sent, and no state left the browser.

- **Test ids are almost gone.** One `data-testid` remains on the home page
  (`app-shell-header-context-menu-surface`). `prompt-textarea`, `send-button`,
  and `model-switcher-dropdown-button`, which every reference repository relies
  on, are absent.
- **ARIA roles and names are present and stable-looking:**

| Operation | Live signal |
|---|---|
| composer form | `form[data-chatgpt-composer]` (no role) |
| composer input | `textbox "Ask ChatGPT"`, `contenteditable`, `[data-composer-markdown]` |
| add files and tools | `button "Add files and more"` with `aria-expanded`, `data-composer-navigation-target="add-context"` |
| file inputs | `input[type=file]` labelled "Attach files" / "Attach photos" |
| model picker | `button "Select ChatGPT model"` (`aria-haspopup=menu`, `data-composer-navigation-target="reasoning"`), showing the current mode ("Instant") |
| composer mode | `group "Composer mode"` with `button "Chat" [pressed]` and `button "Work"` |
| temporary chat | `button "Temporary chat"` |
| voice | `button "Dictate"`, `button "Start Voice"` (the send button appears only once text is entered; not yet observed) |

**Live turn (2026-10-11, two test prompts in Temporary chat, Chat mode).**
The first run sent the prompt, but the probe crashed before it captured the
answer, so a second prompt was sent.

- **Mode guard.** The home page has `group "Composer mode"` with `Chat` and
  `Work`, and the selected one carries `aria-pressed=true`. **Work spends the
  Codex quota**, so the driver selects Chat first. In Temporary chat
  (`?temporary-chat=true`, heading "Temporary chat", `button "Turn off temporary
  chat"`) the mode group is not rendered; the model picker shows a Chat model
  ("Instant").
- **Composer.** `form[data-chatgpt-composer]` is present (two forms exist on the
  page, so the composer is best found as the form around `textbox "Ask
  ChatGPT"`). `button "Send"` is disabled while the composer is empty. During a
  run, the same slot shows `button "Stop"`.
- **Turns.** `data-message-author-role`, `data-turn`, and turn test ids are
  **gone**. The conversation is `region "Conversation"`. Each turn starts with a
  level-4 heading, "You said:" or "ChatGPT said:", followed by the content. A
  finished answer is followed by `button "Copy"`, `"Rate response"`, `"Read
  aloud"`, and `"Regenerate response"`. The user turn has `"Copy message"` and
  `"Edit message"`.
- **Binding.** After the first answer the URL becomes `/c/<uuid>?temporary-chat=true`.
- **Network.** The send is `POST /backend-api/f/conversation`, answered with
  `text/event-stream`. It is preceded by `POST /backend-api/f/conversation/prepare`
  and the `sentinel/chat-requirements` pair. The stream did **not** report as
  finished within the observation window even after the answer was complete.
  An open stream is therefore not a reliable "still running" signal on this UI.
  Completion is decided from the DOM (stop gone, the answer's action buttons
  present, stable text). The network gives submission evidence and errors.

**Model and tools survey (2026-10-12, read only; the Power level was stepped and restored).**

- **Model menu.** `button "Select ChatGPT model"` opens `menu "Select ChatGPT model"`. It holds:
  - the Power slider: `menuitem "Power"` over `[data-reasoning-slider]`, driven by
    arrow keys, with a `status` that reads "Instant, 1 of 3.". The levels are
    **Instant, Medium, High**. The button shows the level, and carries
    `data-selected-reasoning-effort`;
  - the model radios (`menuitemradio`, `aria-checked`): **Latest** (the
    default), **GPT-6**, **GPT-5.6 Sol**, and **GPT-5.5** ("Leaving on October
    14"). There is also a "Locked, opens access options" note.
- **Tools.** `button "Add files and more"` opens a popover of plain buttons whose
  names are the title and a description. Examples: "Deep research Get a detailed
  report", "Web search Find real-time news and info", "Create image ...", and
  apps such as GitHub and PDF.
- **Deep research.** The tool inserts a non-editable mention chip *inside* the
  composer (`[data-prompt-link-href="app://connector_openai_deep_research"]`,
  `app-mention-name="deep-research"`). Send becomes enabled. Reloading removes the
  chip. Deep research is **not offered in Temporary chat**, so it always runs in a
  persistent conversation. How a run completes (clarifying questions, report
  rendering) is not observed yet; it needs one live run.

**Live Deep research run (2026-10-12, one question, about 2 minutes).**

- **Acknowledgement first.** The thread's "ChatGPT said:" answer is only an
  acknowledgement ("Deep Research has started investigating ... the final
  report will appear here"), and it completes like a normal answer. Treating it
  as the result was the first defect found live.
- **The report frame.** The research runs in **nested iframes** under the turn:
  - while it runs, the frame shows a heading (the research title), the plan as
    a list, "Researching...", and `button "Stop research"`;
  - when it finishes, it shows "Research completed in 2m · N citations · N
    searches", then "Deep Research Report", then the report with its sources.
- **The composer slot stays idle** ("Start Voice") during the research, so
  Stop/Send does not signal a running Deep research. Its signals are the frame's.
- **Clarifying questions.** The prompt asked for none, and none came. A reply with
  no research frame is treated as a clarifying question.

This confirms the design choice: role plus accessible name first, structural
`data-*` attributes second, test ids only where they still exist.

**Remote login without root on Ubuntu 20.04:** TigerVNC's static `Xvnc` needs
`libxcvt`, which Focal lacks. Its `x0vncserver` runs, and serves an existing Xvfb
display (`-localhost`, `VncAuth`), with noVNC and websockify in front. This is
the fallback when `x11vnc` is not installed.

## Live check (2026-10-12, a Deep research session with two runs, read only)

Found while verifying the `research` workflow; the conversation was reopened
read-only afterwards.

- **The report layout changed.** There is no "Deep Research Report" heading any
  more. The report frame now shows:
  - the summary "Research completed in 2m · <n> citations · <n> searches", with
    each count rendered as a 0–9 digit reel;
  - the title;
  - Export and Expand buttons;
  - the report itself, in the container of a level-1 heading with the report's
    title.

  This run had no citation links at all. The driver saw "completed" but read an
  empty report, so it waited until the 30-minute stall deadline.
- **Each run has an embedded app frame** (a `web-sandbox` URL) after its
  prompt, with the report frame nested inside. Resolving "the first frame that
  matches" reads the oldest run in a session.
- **A freshly reopened conversation can take more than 5 s to render.** A
  snapshot taken before any turn rendered looked like "nothing new", and the
  ported reconciliation chose RESUBMIT.

## Findings

1. No existing tool keeps a website's operations **as data** with ordered
   candidates, verification, and healing. Every reference hard-codes selectors.
2. The most robust references combine three independent signal sources: ARIA
   role and accessible name (localized), stable test ids, and passive network
   observation. Hashed classes, SVG paths, and framework internals are the
   brittle ones.
3. Patchright already provides what a heal step needs in process: an AI-mode
   ARIA snapshot with refs, ref resolution, and `normalize()` to turn a found
   element back into a durable locator.
4. Every reference that heals at all (Stagehand, Playwright's healer, Healenium)
   **verifies** a healed locator and keeps a human in the loop before it becomes
   the shipped default.

## Adopted

- UI operations as a versioned, schema-validated data file per provider, with
  ordered locator candidates, scope, cardinality, pre- and postconditions, and
  timeouts ([ADR-0021](../decisions/adr/0021-ui-operations-as-data.md)).
- A deterministic resolution engine on patchright locators; network observation
  as a second, passive signal.
- A bounded self-heal step on ARIA snapshots with a deterministic matcher first
  and an optional economy-tier model, always verified, recorded as a decision,
  and written to a local overlay; promotion to the shipped map only by review.
- localized accessible names; turn identity by `data-turn-*`; the completion
  state machine; a diagnostic bundle on drift.

## Not adopted

- Stagehand, MCP browser servers, and DSH experimental browser-use packages as
  runtime engines (debugging endpoint or own browser).
- Calling private endpoints from the page (internet's `fetch('/api/auth/session')`).
  Network signals are observed, never requested.
- Reading framework internals (React fiber props) or hashed classes.
- Vision or computer use in the turn path; screenshots are for diagnosis only.
