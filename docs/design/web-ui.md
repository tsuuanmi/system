# The operator's web UI at a glance

> Target state. Boundary: [gateways](../architecture/components.md#gateways), plugin family
> *surface*. Implemented in [`web-ui`](../../packages/plugins/web-ui/README.md) (T239, T240, T253);
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
  needing attention · 1*), each linked to its cards and its names folded under it, beside the
  Workers' availability as chips (*● 1 free*, *◆ 1 working*, *▲ 1 resting*; free always, the others
  when there are any). Then the cards: approvals, reviews, runs needing attention, starts awaiting
  approval; then what happened since you last looked, the Workers' capacity, and the recent runs
  (5 rows, then **Show all N**). The Workers' counts are said once.
- **Home across projects** (T253, D88: each project has its own lead, and the operator sees every
  project in one UI). *Needs your attention* is a group per project, each headed by the project's
  name and its own count tiles, with what is in no project in a group of its own (*Other*). The most
  urgent group comes first: what expires within the hour, then the most that waits, then the
  earliest deadline. The cards below follow the same groups and the same order, each group headed
  by its project's name; a batch of requests stays whole, in its first request's project. A
  project's name filters Home to it, its recent runs too (`/ui/?project=<id>`, kept through a
  reload and Back, until **All projects**). Its weekly report and its maturity metrics are under its group's **Reports**
  fold, as the commands that print them (`system report --project <id>`, `system metrics --project
  <id>`), each with a copy button (`tests/portfolio.spec.ts`).
- **The Board** shows one project at a time, chosen by its switcher (*Show*) and kept in the
  address (`&project=<id>`). It leads with its columns (*Needs your attention* first on a phone).
  The project, with its state, counts, and moves, is under one fold below the columns, its summary
  saying what of it needs you (*▲ 1 charter approval*), beside the done and cancelled tasks.
  **All projects** (`&project=all`, the default when there are several) shows each project's counts
  only: a card per project with its state, *Needs you · Working · Ready · Proposed*, what of it needs
  you, and its moves, its name opening its own board.
- **Workers** serve every project, so the page stays shared; each step a Worker runs now names the
  project its run is for (*no project* for a run outside the board).
- **A run's page** leads with its state as a chip, when it started, and **Stop run** or **Retry
  failed step**; then what it waits on as a card; its answer, its first lines and **Show all**; its
  steps, each a line, what it needs and how it was decided under its **Details**; its id under
  **Technical details**.
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
- A relative time is short (*<1 min ago*, *2 h ago*), its exact time on hover and focus.
- **The bound:** on its first screen at 1280×800, Home, the Board, a run's page, and Workers each
  show at most half the words they showed before T239. The numbers before were measured once,
  rendering the UI of commit `3b535c30` over the same fixtures, and are recorded in
  `tests/glance.ts`; each test run measures today's (`tests/web-ui.spec.ts`: Home, a run waiting on
  its plan, Workers; `tests/layout.spec.ts`: the Board). Where no browser can run, those tests are
  reported as not run, with why, never as passed.

| First screen at 1280×800 | Words before T239 | Bound | Words at T239 |
|---|---|---|---|
| Home | 169 | 84 | 78 |
| Board | 167 | 83 | 77 |
| A run's page | 98 | 49 | 45 |
| Workers | 146 | 73 | 72 |

- **With two projects** (T253), Home, the Board (*All projects* and one project's), and Workers
  hold the same bound over a store-backed composition of two active projects, each with work that
  needs the operator and a run on a Worker (`tests/portfolio.spec.ts`; at T253, Home 84, the
  Board's All projects 69, Workers 28 words).
- Every section of a page has a heading (`tests/layout.spec.ts`).

## Visual

- One spacing scale (`--s1` 4 px, `--s2` 8 px, `--s3` 16 px, `--s4` 24 px) and one type scale
  of three sizes (`--small` 12 px, `--body` 14 px, `--large` 18 px). `tests/layout.spec.ts` checks
  every margin, padding, gap, and font size against them.
- Cards sit on a quiet page background. A section's heading is small and quiet; a card's title is
  bold at the body size.
- A **primary** button is filled with the accent colour, and a card has at most one. A
  **secondary** button is outlined.
- Columns, tiles, cards, and tables sit in aligned grids. A status colour always comes with its
  shape and its word (● ok, ▲ waiting, ■ failed, ◆ info, ○ idle), never colour alone.
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

The first screen of each page, before T239 and now, at 1280 and 360 px wide, and on the phone at
402 px (`<page>-402.png`, with touch and the safe areas), in
[web-ui-screenshots/](web-ui-screenshots/README.md): `<page>-<width>-before.png` and `<page>-<width>.png`. Home, a run, and Workers
are `tests/web-ui.spec.ts`'s fixtures at a fixed clock (a run waiting on its plan); the Board and
Reviews (Home scrolled to its reviews) are `tests/layout.spec.ts`'s store-backed composition. The
tests write them again, and print the words each first screen holds, when `SYSTEM_UI_SHOTS` names a directory:

```sh
SYSTEM_UI_SHOTS=docs/design/web-ui-screenshots corepack pnpm exec vitest run packages/plugins/web-ui/tests/web-ui.spec.ts packages/plugins/web-ui/tests/layout.spec.ts -t "first screen|T240"
```

With two projects (T253), `tests/portfolio.spec.ts` writes `portfolio-<page>-1280.png` and
`portfolio-<page>-402.png` for Home, the Board's All projects, and Workers (its Workers unfolded, so
each running step's project is in sight; on the phone, scrolled to the working Worker):

```sh
SYSTEM_UI_SHOTS=docs/design/web-ui-screenshots corepack pnpm exec vitest run packages/plugins/web-ui/tests/portfolio.spec.ts -t "word bound"
```

| With two projects | 1280 px | iPhone, 402 px |
|---|---|---|
| Home | [now](web-ui-screenshots/portfolio-home-1280.png) | [now](web-ui-screenshots/portfolio-home-402.png) |
| Board, All projects | [now](web-ui-screenshots/portfolio-board-1280.png) | [now](web-ui-screenshots/portfolio-board-402.png) |
| Workers | [now](web-ui-screenshots/portfolio-workers-1280.png) | [now](web-ui-screenshots/portfolio-workers-402.png) |

| Page | 1280 px | 360 px | iPhone, 402 px |
|---|---|---|---|
| Home | [before](web-ui-screenshots/home-1280-before.png) · [now](web-ui-screenshots/home-1280.png) | [before](web-ui-screenshots/home-360-before.png) · [now](web-ui-screenshots/home-360.png) | [now](web-ui-screenshots/home-402.png) |
| Board | [before](web-ui-screenshots/board-1280-before.png) · [now](web-ui-screenshots/board-1280.png) | [before](web-ui-screenshots/board-360-before.png) · [now](web-ui-screenshots/board-360.png) | [now](web-ui-screenshots/board-402.png) |
| A run | [before](web-ui-screenshots/run-1280-before.png) · [now](web-ui-screenshots/run-1280.png) | [before](web-ui-screenshots/run-360-before.png) · [now](web-ui-screenshots/run-360.png) | [now](web-ui-screenshots/run-402.png) |
| Workers | [before](web-ui-screenshots/workers-1280-before.png) · [now](web-ui-screenshots/workers-1280.png) | [before](web-ui-screenshots/workers-360-before.png) · [now](web-ui-screenshots/workers-360.png) | [now](web-ui-screenshots/workers-402.png) |
| Reviews | [before](web-ui-screenshots/reviews-1280-before.png) · [now](web-ui-screenshots/reviews-1280.png) | [before](web-ui-screenshots/reviews-360-before.png) · [now](web-ui-screenshots/reviews-360.png) | [now](web-ui-screenshots/reviews-402.png) |
