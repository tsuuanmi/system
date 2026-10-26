# The operator's web UI at a glance

> Target state. Boundary: [gateways](../architecture/components.md#gateways), plugin family
> *surface*. Implemented in [`web-ui`](../../packages/plugins/web-ui/README.md) (T239); differs
> from target: nothing known.

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
- **The Board** leads with its columns (*Needs your attention* first on a phone); a task's card
  names its project only when the cards come from several. The projects, with their state, counts,
  and moves, are under one fold below the columns, its summary saying what of them needs you
  (*▲ 1 charter approval*), beside the done and cancelled tasks.
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
  high. `tests/layout.spec.ts` checks every page at 360 px.

## Kept

One implementation per block (T172: the chip, the count, the relative time, the fold, the copy
button, the decision button), the decision wording (T191), **Skip to content** first in the
keyboard order, a visible focus, no motion under reduced motion, the stale banner, the loading and
error states, and no runtime dependency, external font, or CDN: the UI serves itself on loopback
and works offline (`tests/layout.spec.ts` checks the assets).

## Screenshots

The first screen of each page, before T239 and now, at 1280 and 360 px wide, in
[web-ui-screenshots/](web-ui-screenshots/README.md): `<page>-<width>-before.png` and `<page>-<width>.png`. Home, a run, and Workers
are `tests/web-ui.spec.ts`'s fixtures at a fixed clock (a run waiting on its plan); the Board and
Reviews (Home scrolled to its reviews) are `tests/layout.spec.ts`'s store-backed composition. The
tests write them again, and print the words each first screen holds, when `SYSTEM_UI_SHOTS` names a directory:

```sh
SYSTEM_UI_SHOTS=docs/design/web-ui-screenshots corepack pnpm exec vitest run packages/plugins/web-ui/tests/web-ui.spec.ts packages/plugins/web-ui/tests/layout.spec.ts -t "first screen"
```

| Page | 1280 px | 360 px |
|---|---|---|
| Home | [before](web-ui-screenshots/home-1280-before.png) · [now](web-ui-screenshots/home-1280.png) | [before](web-ui-screenshots/home-360-before.png) · [now](web-ui-screenshots/home-360.png) |
| Board | [before](web-ui-screenshots/board-1280-before.png) · [now](web-ui-screenshots/board-1280.png) | [before](web-ui-screenshots/board-360-before.png) · [now](web-ui-screenshots/board-360.png) |
| A run | [before](web-ui-screenshots/run-1280-before.png) · [now](web-ui-screenshots/run-1280.png) | [before](web-ui-screenshots/run-360-before.png) · [now](web-ui-screenshots/run-360.png) |
| Workers | [before](web-ui-screenshots/workers-1280-before.png) · [now](web-ui-screenshots/workers-1280.png) | [before](web-ui-screenshots/workers-360-before.png) · [now](web-ui-screenshots/workers-360.png) |
| Reviews | [before](web-ui-screenshots/reviews-1280-before.png) · [now](web-ui-screenshots/reviews-1280.png) | [before](web-ui-screenshots/reviews-360-before.png) · [now](web-ui-screenshots/reviews-360.png) |
