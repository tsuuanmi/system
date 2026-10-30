# The operator's web UI at a glance

> Target state. Boundary: [gateways](../architecture/components.md#gateways), plugin family
> *surface*. Implemented in [`web-ui`](../../packages/plugins/web-ui/README.md) (T239, `6a555d90`;
> T240, `9f0b245f`; T253, `20fe4c45`; T256, `be23958e`; T274b, `4aa5da45`; who decided, T273, `ef6a62f3`);
> differs from target: the phone is checked in Chromium's emulation of it (its size, scale, touch,
> and safe areas), not in Safari itself.

The design rules every page of the operator's web UI follows. The operator checks it from a phone
as often as from a desk, so each page says what needs them in few words, and keeps every other fact
one press away: in a fold, a tooltip, a **?**, or the item's own page. Each rule names the test that
checks it.

## Hierarchy

- **What needs you comes first, as cards.** A card has the item's own title (its task's or
  request's), one status chip, at most one short line of context, and its one primary action
  (**Approve**, **Accept**, **Start…**). Everything else (for which task, who asked, what no
  response does, mechanism, decisions, ids, hashes, raw reasons) is under the card's one
  **Details** fold or on the item's own page. Facts are folded, never dropped.
- **Home** leads with the counts that need action as tiles (*Approvals · 3*, *Reviews · 1*, *Runs
  needing attention · 1*), each linked to its cards and its names folded under it (when the first
  review expires is in sight within the hour, else beside each name, T256), beside the
  Workers' availability as chips (*● 1 free*, *◆ 1 working*, *▲ 1 resting*; free always, the others
  when there are any). Then the cards: approvals, reviews, runs needing attention, starts awaiting
  approval; then what happened since you last looked, the Workers' capacity, and the recent runs
  (5 rows, then **Show all N**). The Workers' counts are said once.
- **Held for you** (T336) is the first section of the reviews on Home: every result held for the
  operator (one project's, when Home is filtered), the one that expires first on top. A row says the
  task (a link to its full card, which stays below as before), why it is held (the hold decision's
  words: heavy with its risk reason, the checks pending or not run, or the auto-accept rule's
  checks passed without their browser tests), its checks, each reviewer's verdict with the provider
  family of its Worker (from the roster), the first lines of the run's digest, and its change size.
  Select rows and **Accept N selected** or **Send back N selected**: each is still its own decision
  on the exact result shown (INV-5), sent one after another with the same *Note for all*. An accept
  of a row with a check not run asks in its row for why, and is not sent without it; the other rows
  go. The server's reason for a refusal shows on its row, which stays (and stays selected); a
  recorded row and its card leave at once, the outcome lists each row, and Home's counts follow on
  the refresh. The one-by-one logic is `client/heldbatch.ts` (no page in it), the section `client/held.ts`
  (`tests/held.spec.ts`).
  A result whose review **expired** unseen (its task waits for input as `review-expired`, T350) is
  listed there too, after the held ones, marked *Review expired* with when it expired and until when
  it can be reopened: the wait for input (7 days by default); past it the board's sweep cancels the
  task and the row is gone. `GET reviews` carries them as `expired` (`heldFor: expired`, `expiredAt`),
  not among the `reviews`, so Home's counts are of the reviews held now; a lead's token is sent none.
  **Accept N selected** on an expired row first reopens it (`POST reviews/<taskId>/reopen`, bound to
  the exact result shown: the board's `reopenReview`, which needs the run's worktree, recorded as the
  operator's board decision), then sends the same acceptance as a held result's, a second recorded
  decision. If the re-opened hold still asks why a check did not run and none was given, the row is
  reopened but not accepted: it is a held row now, and asks in its row. An expired row is not sent
  back (accept it, or leave it). Only the operator reopens or accepts a heavy result (ADR-0071): a
  lead's token is refused the re-opening (403), and its acceptance stays held to its listed dev
  branches (ADR-0076) (`tests/expired.spec.ts`).
- **Started by itself** (dispatch's own starts, T256) is the last section of Home: a table with the
  columns *Task · State · Worker · Run time · Started*. Each task has one row, its newest attempt's
  run state as a chip. Its attempts are folded into the row (*2 attempts*), each with how it was let
  start. A task never has one row per attempt. The newest 5 tasks show, then **Show all N**.
- **Home across projects** (T253, D88: each project has its own lead, and the operator sees every
  project in one UI). *Needs your attention* is a group per project, each headed by the project's
  name and its own count tiles, with what is in no project in a group of its own (*Other*). The most
  urgent group comes first: what expires within the hour, then the most that waits, then the
  earliest deadline. The cards below follow the same groups and the same order, each group headed
  by its project's name; a batch of requests stays whole, in its first request's project. A
  project's name filters Home to it, its recent runs too (`/ui/?project=<id>`, kept through a
  reload and Back, until **All projects**). Its weekly report and its maturity metrics have a small
  page of their own (T256, `/ui/?view=reports&project=<id>`), reached by the **Reports** link beside
  its group's name, and from its Details on the Board. The page is a table of the commands that print
  them (`system report --project <id>`, `system metrics --project <id>`), each with a copy button
  (`tests/portfolio.spec.ts`). Inside a project's group a card does not repeat the project: a review
  card's line is only when it expires, and its project is under its **Details**; an accepted result
  on its way in names its project only outside a group and when Home is not filtered to it.
- **The Board** shows one project at a time, chosen by its switcher (*Show*) and kept in the
  address (`&project=<id>`). It leads with its columns (*Needs your attention* first on a phone).
  The project, with its state, counts, and moves, is under one fold below the columns, its summary
  saying what of it needs you (*▲ 1 charter approval*), beside the done and cancelled tasks.
  **All projects** (`&project=all`, the default when there are several) shows each project's counts
  only: a card per project with its state, *Needs you · Working · Ready · Proposed*, what of it needs
  you, and its moves, its name opening its own board.
- **Workers** serve every project, so the page stays shared; each step a Worker runs now names the
  project its run is for (*no project* for a run outside the board).
- **A run's page** leads with its state as a chip, when it started, how long it took once it ended,
  and **Stop run** or **Retry failed step**. Then what it waits on as a card; its answer, its first
  lines and **Show all**; its steps, each a line; its id under **Technical details**. Where it is
  now and what happened to it sit beside them.
- **Each step's timing** (T256): a step that ended says how long it ran and when it ended
  (*develop:1 · 14 min · done 07:42*); a running step's elapsed time ticks each second
  (*review:1 · 3 min · running*). The exact start and end show on hover and keyboard focus, and
  under the step's **Details**. A step that has not started says only its state. Above the steps, a
  timeline bar has a segment per step placed by when it ran; its accessible name says each step's
  time and the run's total. The times come from the event log (each step's latest
  `workflow.node.started`, and its `completed` or `failed`). Without a log, or when it fails, the
  Steps section says *Times unknown*, why under that fold, and each step only its state
  (`tests/round2.spec.ts`).
- **How a step was decided** (under its **Details**) has one line per decision: *type · outcome ·
  time*. Its reasons and its id open on a click, or Enter on the line. The decisions about a
  deferred tool call (its *wait*, then its *continue* or *deny*) are one line per call, naming its
  verdict and how long it waited (*1 tool call approved by you · 2 min*), with each decision inside.
- **A Board card's line** has only who works on it and when it last changed. Its project, kind of
  work, template, and attempt are the line's tooltip, and also under its **Details**.
- **Workers** lead with the availability chips and *Right now* (folded, its summary the rows that
  need a look as chips; open while someone is stalled or cannot work). Each account is a card: its
  name, its rest as a chip, its shortest window as a bar and a line, every window and fact under its
  **Details**, and its Workers' cards under one fold. What blocks a Worker (unavailable,
  quarantined, a capability held off) and each run whose liveness needs a look are a line on the
  account's card, never folded.

## Words

- A button is labelled by its concept's one wording (T191: **Approve** / **Deny**, **Accept** /
  **Send back**, **Confirm** / **Cancel**). What it does is its accessible description
  (`aria-describedby`), shown as a tooltip on hover and on keyboard focus, never as text beside
  it. Escape hides the tooltip, and it stays within the screen (`tests/layout.spec.ts`).
- Help is one **?** per section heading, plus Help's own page. A page header is its title, and
  one short sentence only where the title does not say what the page is for (the autonomy policy,
  Help).
- A relative time is short (*<1 min ago*, *2 h ago*), its exact time on hover and, on keyboard
  focus, as a small label under it that never moves the line (T256).
- No text walls (T256). A hash, an id, a commit, a branch, or a long path is shortened wherever it
  shows, in a card, a table, or a sentence (*read it in …/runs/run_ab12cd34…*): each run of 12 or
  more hex digits to its first 8 (a content id's `sha256:` dropped), a path past 32 characters to its
  last two parts, anything still past 32 characters to its start. The whole value is the code's
  tooltip and behind its copy button, a small icon named by what it copies (*Copy run ID*), a check
  once copied. The one exception is an approval's or a review's **Exact subject**, under its
  **Details**: the subject the verdict is recorded on is shown whole, with its copy button. A list of
  facts is a table with aligned columns, not prose.
- **The bound:** on its first screen at 1280×800, Home, the Board, a run's page, and Workers each
  show at most half the words they showed before T239. The numbers before were measured once,
  rendering the UI of commit `3b535c30` over the same fixtures, and are recorded in
  `tests/glance.ts`; each test run measures today's (`tests/web-ui.spec.ts`: Home, a run waiting on
  its plan, Workers; `tests/layout.spec.ts`: the Board). Where no browser can run, those tests are
  reported as not run, with why, never as passed.

| First screen at 1280×800 | Words before T239 | Bound | Words at T239 | Before T256 | At T256 |
|---|---|---|---|---|---|
| Home | 169 | 84 | 78 | 64 | 65 |
| Board | 167 | 83 | 77 | 69 | 69 |
| A run's page | 98 | 49 | 45 | 45 | 47 |
| Workers | 146 | 73 | 72 | 72 | 72 |
| Home, two projects | 169 | 84 | — | 84 | 67 |
| Board's All projects, two projects | 167 | 83 | — | 69 | 69 |
| Workers, two projects | 146 | 73 | — | 28 | 28 |

- **With two projects** (T253), Home, the Board (*All projects* and one project's), and Workers
  hold the same bound over a store-backed composition of two active projects, each with work that
  needs the operator and a run on a Worker (`tests/portfolio.spec.ts`). At T253 Home with two
  projects held exactly the bound (84); T256 wins its margin back (67): a review's first expiry in
  the tile only within the hour, and a panel's more generous padding from 900 px. *Before T256* is
  the dev branch at `748a34fa`, measured with the same tests.
- Every section of a page has a heading (`tests/layout.spec.ts`).

## Layout

- **Full width** (T256). No page has a maximum width. Prose alone (a paragraph, a list item, a
  definition) is capped at 75 characters (`--measure`).
- **A page's grid.** Home, a run's page, and Workers put their list in a main column and a summary
  or detail beside it from 900 px wide (`--main` 3 : `--side` 1). Home's side column holds the
  Workers' availability, kept in sight as the cards scroll; the Workers' capacity, the starts
  awaiting approval, what happened since you last looked, and the recent runs follow the cards. A
  run's side column holds where it is now, from 1600 px its *Summary* (its steps counted by state,
  and each decided step as a link to it, so the steps and their decisions are never said twice),
  and what happened to it. Workers' holds *Right now*.
  From 1600 px Home has three columns (5 : 4 : 3): the cards; the starts awaiting approval, what
  happened since you last looked, and the recent runs; the Workers' availability and their
  capacity (T274). Parts of *Since you last looked* that could not be read are one quiet line, the
  reasons in its tooltip. The Board's All projects cards are at most 420 px wide, so two projects
  are a compact grid, not two wide bands. On a phone the navigation's *policy* is capitalised like
  the other labels (CSS only; wide, it reads *Autonomy policy*), and a word's "?" stays on its
  word's line (a no-break space joins them).
  Below 900 px every page is one column, in the order main, side, more. The Board keeps its columns
  at full width. `tests/round2.spec.ts` checks the columns at 1920, 1280, and 899 px, and that main
  is the screen's width.

## The page's files

The page is all TypeScript, none of it a hand-written HTML, CSS, or JS file (PROP-0018 T15, T303, T304; D102):
`src/ui/shell.ts` (`renderShell`, the shell as a function whose scripts and stylesheets are typed inputs, each
with an optional subresource-integrity hash and CSP nonce), `src/ui/styles/` (the design tokens as typed
constants in `tokens.ts`, a `css` template helper, and the rules in `base.ts` and `pages.ts`, joined by
`stylesheet` into `APP_CSS`), and `client/` (the script: typed ES modules with the DOM lib, so the linter, the
type checker, and the dead-code check read them). The server renders the shell and the stylesheet at start (same
input, same bytes) and reads the script that the package's build compiles with `tsc` (no bundler) to
`lib/client/` (`clientDir`, default `lib/client/`); it refuses to start when `app.js` is missing, and
serves each file as its bytes with its sha256 content hash as its `ETag`, `no-store`, and the same strict
content security policy. `app.ts` is a classic script of a few lines (the shell's `<script src="/ui/app.js">`
stays as it was) that runs `import('./boot.js')`; the server serves every compiled `.js` file of `clientDir`
beside it. The modules are split by page and concern, each under 600 lines, none with an `any`
(`tests/client-source.spec.ts` fails on a longer module or an `any`): `dom.ts` (the shared blocks: element,
chip, fold, copy button, table, decision button and its tooltip, times), `state.ts` (the token and the API client, the
state the address names, `show` and `report`), `router.ts` (the links and the pages they open), `boot.ts` (navigation and
the refresh), `glossary.ts` and `help.ts`, `describe.ts` and `queue.ts` (the approval queue's cards), `evidence.ts` and
`reviews.ts` (with `held.ts` and `heldbatch.ts`), `runwords.ts` and `runpage.ts`, `home.ts`, `since.ts`, `dispatch.ts`, `board.ts` (with the lead panel),
`roster.ts` and `workers.ts`, `policy.ts` and `changeview.ts`, and `reports.ts`. The API's response types are one
declaration file, `src/api.d.ts`, imported with `import type` by the server (which checks what it sends against them)
and by the client (a declaration file, so the build emits nothing of it). Tests build the client into a temporary
directory and pass it as `clientDir`: they never write into the package.

## Visual system

In the spirit of Anthropic's and Google Material 3's product UIs: calm neutral surfaces, one accent
colour, thin borders, no shadows. Every colour, space, type size, and radius is one of the tokens
below. They are written once as CSS variables at the top of the stylesheet (`src/ui/styles/tokens.ts`), and the rest of the
stylesheet uses only them. `tests/layout.spec.ts` checks every margin, padding, gap, and font size.

| Tokens | Light | Dark | For |
|---|---|---|---|
| `--page`, `--bg`, `--sunk` | #f8f9fa, #fff, #f0f2f4 | #131314, #1e1f20, #282a2c | the page, a surface (card, table), a sunk surface (tile, column) |
| `--fg`, `--muted` | #1f1f1f, #5f6368 | #e3e3e3, #a8abaf | text, quiet text |
| `--line`, `--edge` | #e3e3e3, #c4c7c5 | #333537, #5f6368 | a hairline border, a control's edge |
| `--accent`, `--on-accent` | #0b57d0, #fff | #a8c7fa, #062e6f | the one accent: links, focus, a primary button, a running step |
| `--ok`, `--wait`, `--bad` | #146c2e, #7a5900, #b3261e | #6dd58c, #f0c75e, #f2b8b5 | status only, always with its shape and word |
| `--s1` … `--s4` | 4, 8, 16, 24 px | | the 8 px grid (`--s1` its half step); the safe areas are made of it; a panel's padding is `--s3`, `--s4` from 900 px |
| `--small`, `--body`, `--large` | 12, 14, 18 px | 13, 16, 20 px on touch | three type sizes, in the system's own font |
| `--r1`, `--r2`, `--radius`, `--round` | 4, 8, 12 px, pill | | a tag, a control or small card, a panel, a chip or button |

- Cards sit on a quiet page background, with a 1 px border and no shadow. A section's heading is
  small and quiet; a card's title is bold at the body size.
- A **primary** button is filled with the accent colour, and a card has at most one. A
  **secondary** button is outlined. Buttons and chips are pills.
- Columns, tiles, cards, and tables sit in aligned grids. One status chip style: its symbol, its
  colour, and its word (● ok, ▲ waiting, ■ failed, ◆ info, ○ idle), never colour alone.
- Light and dark follow the system's preference (`prefers-color-scheme`, `color-scheme: light
  dark`).
- **A phone, 360 px wide:** one column, the navigation on one row under the name, no horizontal
  scroll, every button within the screen, a card's buttons sharing its width, and buttons 40 px
  high (44 px on a touch screen, [below](#the-operators-iphone)). `tests/layout.spec.ts` checks
  every page at 360 px.

## The operator's iPhone

The operator's phone is an iPhone 16 Pro: 402×874 CSS px at 3 device pixels each, Safari, portrait,
the Dynamic Island above and the home indicator below (T240).

- **Safe areas.** The page lays itself under both (`viewport-fit=cover`), and keeps its content
  clear of them: a safe-area token is a step of the spacing scale, or the screen's own inset where
  that is larger (`--safe-top: max(var(--s2), env(safe-area-inset-top))`, and so for each side).
  The header, sticky at the top on a phone, the sides of every page, the bar at the bottom, and the
  page's last row use them.
- **Touch targets** where a finger points (`pointer: coarse`): every button, fold, field,
  navigation link, and action link is at least 44 by 44 px; a word's **?** is a small circle in a
  44 px target. A link inside a sentence is not a target of its own.
- **Tooltips on a tap.** Nothing hovers on a phone, so each row of buttons whose effect is a
  tooltip has one **?** (shown only where nothing hovers) that shows what each of its buttons does
  under the row, *Accept: marks it done*; a second tap, a tap outside, or Escape hides it. A tap
  on a button itself does what it says at once. A word's **?** opens its sentence the same way and
  closes on a tap outside.
- **No zoom on focus.** On a touch screen the type scale is 13, 16, and 20 px (still three sizes),
  and every field is 16 px, so Safari never zooms into a field it focuses.
- **One thumb.** A card's buttons share its width at its bottom, above its **Details**; on a
  detail page (a run's) the primary action is a bar at the bottom of the screen, above the home
  indicator: the plan's **Approve** and **Deny** while it waits on one, else **Stop run** or
  **Retry failed step**. The page's last row stays above the bar.
- **Tables** below 600 px are a list of cards, a card per row, each cell named by its column.
- **Light and dark** follow the phone, Safari's own bars too (`theme-color`).
- No page scrolls sideways at 402 or at 360 px.

`tests/layout.spec.ts` checks each on every page at 402 and 360 px with touch and the safe areas
(62 px and 34 px) emulated; `tests/web-ui.spec.ts` the run page's bar; `tests/portfolio.spec.ts`
no sideways scroll and the touch targets (a project's name too) at 402 px with two projects: Home,
Home filtered to one, the Board's All projects and one project's, and Workers.

## Kept

One implementation per block (T172: the chip, the count, the relative time, the fold, the copy
button, the decision button), the decision wording (T191), **Skip to content** first in the
keyboard order, a visible focus, no motion under reduced motion, the stale banner, the loading and
error states, and no runtime dependency, external font, or CDN: the UI serves itself on loopback
and works offline (`tests/layout.spec.ts` checks the assets).

## Screenshots

The first screen of each page before T256 (`<page>-<width>-before.png`, the dev branch at
`748a34fa`) and after it (`<page>-<width>.png`), at 1920×1080, 1280×800, and on the phone at 402 px
(with touch and the safe areas), in [web-ui-screenshots/](web-ui-screenshots/README.md); the pages
at 360 px after it too (`<page>-360.png`). Home, a run waiting on its plan, and Workers are
`tests/web-ui.spec.ts`'s fixtures at a fixed clock; the Board and Reviews (Home scrolled to its
reviews) are `tests/layout.spec.ts`'s store-backed composition. A run with its step times, its
timeline, and its first step's decisions unfolded (`run-timed-<width>.png`), and *Started by itself*
(`started-<width>.png`), are `tests/round2.spec.ts`'s. Two images show the dark theme
(`home-1920-dark.png`, `run-timed-1920-dark.png`). The tests write them again, and print the words
each first screen holds, when `SYSTEM_UI_SHOTS` names a directory:

```sh
SYSTEM_UI_SHOTS=docs/design/web-ui-screenshots corepack pnpm exec vitest run packages/plugins/web-ui/tests/web-ui.spec.ts packages/plugins/web-ui/tests/layout.spec.ts packages/plugins/web-ui/tests/portfolio.spec.ts packages/plugins/web-ui/tests/round2.spec.ts -t "first screen|T240|word bound|full-width grid|dispatch started|on the phone at 402"
```

| Page | 1920 px | 1280 px | iPhone, 402 px |
|---|---|---|---|
| Home | [before](web-ui-screenshots/home-1920-before.png) · [after](web-ui-screenshots/home-1920.png) · [dark](web-ui-screenshots/home-1920-dark.png) | [before](web-ui-screenshots/home-1280-before.png) · [after](web-ui-screenshots/home-1280.png) | [before](web-ui-screenshots/home-402-before.png) · [after](web-ui-screenshots/home-402.png) |
| Board | [before](web-ui-screenshots/board-1920-before.png) · [after](web-ui-screenshots/board-1920.png) | [before](web-ui-screenshots/board-1280-before.png) · [after](web-ui-screenshots/board-1280.png) | [before](web-ui-screenshots/board-402-before.png) · [after](web-ui-screenshots/board-402.png) |
| A run | [before](web-ui-screenshots/run-1920-before.png) · [after](web-ui-screenshots/run-1920.png) | [before](web-ui-screenshots/run-1280-before.png) · [after](web-ui-screenshots/run-1280.png) | [before](web-ui-screenshots/run-402-before.png) · [after](web-ui-screenshots/run-402.png) |
| A run with step times | [after](web-ui-screenshots/run-timed-1920.png) · [dark](web-ui-screenshots/run-timed-1920-dark.png) | [after](web-ui-screenshots/run-timed-1280.png) | [after](web-ui-screenshots/run-timed-402.png) |
| Workers | [before](web-ui-screenshots/workers-1920-before.png) · [after](web-ui-screenshots/workers-1920.png) | [before](web-ui-screenshots/workers-1280-before.png) · [after](web-ui-screenshots/workers-1280.png) | [before](web-ui-screenshots/workers-402-before.png) · [after](web-ui-screenshots/workers-402.png) |
| Reviews | [before](web-ui-screenshots/reviews-1920-before.png) · [after](web-ui-screenshots/reviews-1920.png) | [before](web-ui-screenshots/reviews-1280-before.png) · [after](web-ui-screenshots/reviews-1280.png) | [before](web-ui-screenshots/reviews-402-before.png) · [after](web-ui-screenshots/reviews-402.png) |
| Started by itself | | [after](web-ui-screenshots/started-1280.png) | [after](web-ui-screenshots/started-402.png) |

With two projects (T253), `tests/portfolio.spec.ts` writes `portfolio-<page>-1280.png` and
`portfolio-<page>-402.png` for Home, the Board's All projects, and Workers (its Workers unfolded, so
each running step's project is in sight; on the phone, scrolled to the working Worker).

| With two projects | 1280 px | iPhone, 402 px |
|---|---|---|
| Home | [after](web-ui-screenshots/portfolio-home-1280.png) | [after](web-ui-screenshots/portfolio-home-402.png) |
| Board, All projects | [after](web-ui-screenshots/portfolio-board-1280.png) | [after](web-ui-screenshots/portfolio-board-402.png) |
| Workers | [after](web-ui-screenshots/portfolio-workers-1280.png) | [after](web-ui-screenshots/portfolio-workers-402.png) |
