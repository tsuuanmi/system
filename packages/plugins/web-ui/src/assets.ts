/** The UI's static shell, script, and styles. The script builds the page with DOM methods and textContent only. */

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1e1f20" media="(prefers-color-scheme: dark)">
<title>system: runs, approvals, reviews, board, Workers, and policy</title>
<link rel="stylesheet" href="/ui/app.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header><h1><a href="/ui/" id="home">system</a></h1><nav aria-label="Pages"><a href="/ui/" id="home-link">Home</a> <a href="/ui/?view=board" id="board-link">Board</a> <a href="/ui/?view=workers" id="workers-link">Workers</a> <a href="/ui/?view=policy" id="policy-link" aria-label="Autonomy policy"><span class="wide">Autonomy </span>policy</a> <a href="/ui/?view=help" id="help-link">Help</a></nav><span id="status" aria-live="off"></span></header>
<div id="stale" class="stale" role="status" hidden></div>
<div id="outcome"></div>
<main id="main" tabindex="-1"></main>
<script src="/ui/app.js"></script>
</body>
</html>
`

export const APP_CSS = `
/* The visual system (T239, T256, docs/design/web-ui.md#visual-system): every colour, space, type size, and radius is one of
   the tokens below, written once here. Neutral surfaces and one accent colour (the status colours only ever in a chip, with
   their shapes); thin borders and no shadows; an 8 px grid (--s2, with --s1 its half step); three type sizes in the system's
   own font; a filled primary and an outlined secondary button; light or dark as the system prefers; a full-width grid that
   is one column below 900 px and scrolls no page sideways from 360 px. */
:root { color-scheme: light dark;
  /* Colours: the page, a surface on it, a sunk surface, text, muted text, a hairline, a control's edge, the one accent, and the three status colours. */
  --fg: #1f1f1f; --page: #f8f9fa; --bg: #fff; --sunk: #f0f2f4; --muted: #5f6368; --line: #e3e3e3; --edge: #c4c7c5; --accent: #0b57d0; --on-accent: #fff; --bad: #b3261e; --ok: #146c2e; --wait: #7a5900;
  /* Space (the 8 px grid), type (three sizes), radii, and the measures of the layout. */
  --s1: 4px; --s2: 8px; --s3: 16px; --s4: 24px; --small: 12px; --body: 14px; --large: 18px; --r1: 4px; --r2: 8px; --radius: 12px; --round: 999px;
  --measure: 75ch; --side: 1fr; --main: 3fr;
  /* The safe areas (T240): the spacing scale, or the screen's own inset where it is larger (the Dynamic Island, the home indicator). */
  --safe-top: max(var(--s2), env(safe-area-inset-top)); --safe-right: max(var(--s4), env(safe-area-inset-right));
  --safe-bottom: max(var(--s4), env(safe-area-inset-bottom)); --safe-left: max(var(--s4), env(safe-area-inset-left));
  --safe-bar: max(var(--s2), env(safe-area-inset-bottom)); --bar-room: calc(var(--s4) * 4 + env(safe-area-inset-bottom)); }
@media (prefers-color-scheme: dark) { :root { --fg: #e3e3e3; --page: #131314; --bg: #1e1f20; --sunk: #282a2c; --muted: #a8abaf; --line: #333537; --edge: #5f6368; --accent: #a8c7fa; --on-accent: #062e6f; --bad: #f2b8b5; --ok: #6dd58c; --wait: #f0c75e; } }
* { box-sizing: border-box; }
body { margin: 0; font: var(--body)/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--fg); background: var(--page); overflow-wrap: break-word; -webkit-text-size-adjust: 100%; }
h1, h2, h3, h4 { line-height: 1.3; margin: 0; }
h2 { font-size: var(--large); } h3, h4 { font-size: var(--body); font-weight: 600; }
/* A section's heading: small, quiet, the same on every page; a card's title is the body size, bold. */
main h2:not(.page) { font-size: var(--small); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: var(--s4) 0 var(--s2); }
header { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s3); padding: var(--safe-top) var(--safe-right) var(--s2) var(--safe-left); background: var(--bg); border-bottom: 1px solid var(--line); }
header h1 { font-size: var(--large); } header a { color: inherit; text-decoration: none; } header nav { display: flex; flex-wrap: wrap; gap: 0 var(--s1); }
header nav a { padding: var(--s1) var(--s2); white-space: nowrap; display: inline-block; border-radius: var(--round); color: var(--muted); }
header nav a[aria-current="page"] { color: var(--fg); font-weight: 600; background: var(--sunk); } header nav a:hover { color: var(--accent); }
#status { color: var(--muted); margin-left: auto; font-size: var(--small); }
/* Full width (T256): no page has a maximum width; prose alone is held to a readable measure. */
main { padding: var(--s4) var(--safe-right) var(--safe-bottom) var(--safe-left); }
/* A page's grid (T256): its list in the main column, a summary or detail beside it from 900 px, a third column from 1600 px; one column below 900 px. */
.page-grid { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-areas: "main" "side" "more"; gap: var(--s3) var(--s4); align-items: start; }
.page-grid > * { min-width: 0; } .page-grid > .col-main { grid-area: main; } .page-grid > .col-side { grid-area: side; } .page-grid > .col-more { grid-area: more; }
.page-grid > div > :first-child, .page-grid > div > :first-child > :first-child { margin-top: 0; } .page-grid > div > :last-child { margin-bottom: 0; }
@media (min-width: 900px) { .page-grid { grid-template-columns: minmax(0, var(--main)) minmax(0, var(--side)); grid-template-areas: "main side" "more side"; grid-template-rows: auto 1fr; } }
/* Home (T256): its Workers in a narrow column beside the cards from 900 px, what else it says below them; from 1600 px what
   happened and the recent runs a middle column, the Workers' capacity and the starts awaiting approval under their availability. */
.page-grid.three { grid-template-areas: "main" "side" "extra" "more"; } .page-grid.three > .col-side { display: contents; }
.page-grid.three > .col-side > * { min-width: 0; } .page-grid.three > .col-side > .panel { grid-area: side; margin: 0; } .page-grid.three > .col-side > .side-extra { grid-area: extra; display: flex; flex-direction: column; gap: var(--s3); } .page-grid.three .side-extra > * { margin: 0; }
@media (min-width: 900px) { .page-grid.three { grid-template-areas: "main side" "extra side" "more side"; grid-template-rows: auto auto 1fr; } .page-grid.three > .col-side > .panel { position: sticky; top: var(--s3); } }
@media (min-width: 1600px) { .page-grid.three { grid-template-columns: minmax(0, 5fr) minmax(0, 4fr) minmax(0, 3fr); grid-template-areas: "main more side"; grid-template-rows: auto; }
  .page-grid.three > .col-side { display: flex; flex-direction: column; gap: var(--s3); } .page-grid.three > .col-side .panel { margin: 0; } .page-grid.three > .col-side > .panel { position: static; } }
.page-bottom { margin-top: var(--s4); }
h2.page { margin: 0 0 var(--s3); } ul.chips.availability, .status-line, .actions.run-actions { margin: 0 0 var(--s3); } .overview ul.chips.availability { margin: 0; }
main section > details.fold, main > details.fold { margin-bottom: var(--s2); } .panel .panel { margin: var(--s3) 0 0; } h2.page:has(+ p.lead) { margin-bottom: 0; } p.lead { color: var(--muted); margin: var(--s1) 0 var(--s3); }
section { min-width: 0; }
a { color: var(--accent); text-underline-offset: 2px; }
p { margin: var(--s2) 0; }
.muted { color: var(--muted); } code { font-size: var(--small); } .unknown { color: var(--muted); font-style: italic; }
.state { font-weight: 600; } .COMPLETED, .completed, .ready { color: var(--ok); } .FAILED, .failed, .unavailable, .quarantined { color: var(--bad); } .BLOCKED, .RUNNING, .running, .busy, .resting { color: var(--wait); }
.soon { color: var(--wait); font-weight: 600; } .state.unknown { font-style: normal; }
/* A card: a title, one status chip, a short line of context, and its one primary action; the rest under its Details. */
.panel { border: 1px solid var(--line); border-radius: var(--radius); padding: var(--s3); margin: 0 0 var(--s3); background: var(--bg); overflow-wrap: anywhere; }
.panel > :first-child { margin-top: 0; } .panel > :last-child { margin-bottom: 0; }
@media (min-width: 900px) { .panel { padding: var(--s4); } .panel .panel { padding: var(--s3); } }
.panel h3 + p, .panel h4 + p { margin-top: var(--s1); }
.panel.ok { border-color: var(--ok); } .panel.bad { border-color: var(--bad); }
.line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s1) var(--s2); }
.request .meta { color: var(--muted); margin: var(--s1) 0 0; }
.request dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--s1) var(--s3); margin: var(--s2) 0; } .request dt { color: var(--muted); } .request dd { margin: 0; overflow-wrap: anywhere; }
.request .summary { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s2); margin: var(--s2) 0 0; }
.tag { border: 1px solid var(--line); border-radius: var(--r1); padding: 0 var(--s1); font-size: var(--small); color: var(--muted); }
/* Buttons: a secondary one outlined, the primary one filled; what each does is its tooltip and its accessible description. */
button { font: inherit; min-height: 32px; padding: var(--s1) var(--s3); border-radius: var(--round); border: 1px solid var(--edge); background: var(--bg); color: var(--fg); cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
button:disabled { opacity: 0.6; cursor: progress; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin: var(--s3) 0 0; }
.actions label, .request label, .batch-actions label { display: flex; flex-direction: column; gap: var(--s1); color: var(--muted); font-size: var(--small); }
.batch-actions { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--s2); margin: var(--s2) 0; }
.does { display: none; }
.does.shown { display: block; position: fixed; z-index: 10; max-width: min(36ch, calc(100vw - 16px)); padding: var(--s1) var(--s2); border-radius: var(--r2); background: var(--fg); color: var(--bg); font-size: var(--small); line-height: 1.4; pointer-events: none; }
input, select, textarea { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--edge); border-radius: var(--r2); }
input { padding: var(--s1) var(--s2); min-height: 32px; min-width: 240px; max-width: 100%; }
select { min-height: 32px; padding: var(--s1) var(--s2); max-width: 100%; }
textarea { font: var(--small)/1.4 ui-monospace, monospace; width: 100%; min-height: 320px; padding: var(--s2); }
input.number { min-width: 0; width: 9em; } textarea.lines { min-height: 96px; }
button:focus-visible, a:focus-visible, input:focus-visible, summary:focus-visible, select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* Tables: aligned columns, a quiet header row. */
table { width: 100%; border-collapse: collapse; margin: var(--s2) 0 var(--s3); background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
th, td { text-align: left; padding: var(--s2) var(--s3); border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: break-word; }
tr:last-child > td { border-bottom: 0; }
th { color: var(--muted); font-weight: 600; font-size: var(--small); white-space: nowrap; } td.nowrap { white-space: nowrap; }
/* Folds: a quiet summary, closed by default. */
details summary { cursor: pointer; color: var(--muted); list-style: none; } details summary::-webkit-details-marker { display: none; }
details > summary::before { content: '▸'; display: inline-block; width: 1em; color: var(--muted); } details[open] > summary::before { content: '▾'; }
details.fold { margin: var(--s2) 0 0; } details.fold > summary { font-size: var(--small); } details.fold[open] > summary { margin-bottom: var(--s1); }
details.fold.inline { display: inline-block; margin: 0 0 0 var(--s1); vertical-align: top; } details.fold.inline > summary { display: inline; }
details.card-details > .fold-body > * { margin: var(--s2) 0; }
/* Shared building blocks (T172): a status chip (word, colour, and symbol), a count, a relative time with its exact time on focus, a fold, and a copy button. */
.chip { display: inline-block; max-width: 100%; border: 1px solid color-mix(in srgb, currentColor 45%, transparent); border-radius: var(--round); padding: 0 var(--s2); font-size: var(--small); font-weight: 600; line-height: 1.7; vertical-align: baseline; background: color-mix(in srgb, currentColor 10%, transparent); }
.chip.ok { color: var(--ok); } .chip.warn { color: var(--wait); } .chip.bad { color: var(--bad); } .chip.info { color: var(--accent); } .chip.idle { color: var(--muted); }
ul.chips { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: var(--s1) var(--s2); }
.glance .n, .qty .n { font-weight: 600; } .glance > span { white-space: nowrap; } time.rel { white-space: nowrap; }
/* A time's exact value on keyboard focus (T256): a small label under it, never text that moves the line. */
time.rel, .took { position: relative; }
time.rel:focus::after, .took:focus::after { content: attr(data-exact); position: absolute; left: 0; top: calc(100% + var(--s1)); z-index: 10; padding: var(--s1) var(--s2); border-radius: var(--r2); background: var(--fg); color: var(--bg); font-size: var(--small); font-weight: 400; line-height: 1.4; white-space: nowrap; pointer-events: none; }
/* The copy button (T256): a small icon of two sheets, drawn in CSS, named by its label; a check once copied. */
button.copy { position: relative; width: var(--s4); min-width: var(--s4); height: var(--s4); min-height: 0; padding: 0; margin: 0 0 0 var(--s1); border: 0; border-radius: var(--r1); background: transparent; color: var(--muted); vertical-align: middle; }
button.copy:hover { color: var(--accent); background: var(--sunk); }
button.copy::before, button.copy::after { content: ''; position: absolute; width: 9px; height: 11px; border: 1.5px solid currentColor; border-radius: 2px; }
button.copy::before { left: calc(50% - 6px); top: calc(50% - 7px); border-right: 0; border-bottom: 0; } button.copy::after { left: calc(50% - 3px); top: calc(50% - 4px); }
button.copy.done { color: var(--ok); } button.copy.done::before { display: none; } button.copy.done::after { width: 6px; height: 10px; border-width: 0 2px 2px 0; border-radius: 0; transform: rotate(45deg); left: calc(50% - 3px); top: calc(50% - 7px); }
code.copied { margin-left: var(--s1); } code.subject { overflow-wrap: anywhere; }
/* A hash, an id, or a long path shortened (T256): its first characters, the whole on hover and behind its copy button. */
code.short { white-space: nowrap; }
button.why { margin: 0 0 0 var(--s1); font-weight: 400; text-transform: none; letter-spacing: 0; }
.explain-note { font-size: var(--small); font-weight: 400; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: var(--r2); padding: 0 var(--s1); display: inline; text-transform: none; letter-spacing: 0; } .explain-note[hidden] { display: none; }
.stale { margin: 0; padding: var(--s2) var(--safe-right) var(--s2) var(--safe-left); border-bottom: 1px solid var(--wait); color: var(--wait); background: var(--bg); font-weight: 600; } .stale[hidden] { display: none; }
#outcome { padding: 0 var(--safe-right) 0 var(--safe-left); } #outcome .panel { margin: var(--s3) 0 0; }
.loading { color: var(--muted); } .skip { position: absolute; left: -9999px; top: var(--s2); } .skip:focus { left: var(--s2); z-index: 11; background: var(--bg); padding: var(--s1) var(--s2); }
main p, main li, main dd, p.lead, #outcome p { max-width: var(--measure); } ul.plain { list-style: none; padding-left: 0; }
.status-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s2); }
@media (prefers-reduced-motion: no-preference) { .loading { animation: pulse 1.2s ease-in-out infinite alternate; } }
@keyframes pulse { from { opacity: 1; } to { opacity: 0.4; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
/* Home: what needs the operator as count tiles, the Workers' availability beside it; lists of 5 rows and a "show all". */
.overview > .panel { margin: 0 0 var(--s3); }
.overview > .panel > .head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s2); margin-bottom: var(--s2); }
ul.tiles { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: var(--s2); }
ul.tiles > li { border-radius: var(--r2); padding: var(--s2) var(--s3); background: var(--sunk); max-width: none; }
ul.tiles > li > a:first-child { font-size: var(--large); font-weight: 600; text-decoration: none; display: block; }
ul.tiles ul.named { padding-left: var(--s3); margin: var(--s1) 0 0; } ul.tiles .soon, ul.tiles .muted { font-size: var(--small); }
button.show-all { margin: var(--s1) 0; }
/* Home by project (T253): each group headed by its project's name and its own count tiles; its cards under its name, each kind a quiet heading. */
.groups { display: grid; gap: var(--s3); } section.group > h4 { margin: 0 0 var(--s2); }
main h2.group-title { font-size: var(--large); font-weight: 600; text-transform: none; letter-spacing: 0; color: var(--fg); margin: var(--s4) 0 var(--s2); }
main section.group h3.kind { font-size: var(--small); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: var(--s3) 0 var(--s2); }
.group-head { align-items: baseline; margin: var(--s4) 0 var(--s2); padding-top: var(--s2); } main .group-head > h2.group-title { margin: 0; }
table.reports code { overflow-wrap: anywhere; } .tag.project { white-space: nowrap; } a.reports { font-size: var(--small); }
section.group > h4 { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--s1) var(--s2); }
/* Started by itself (T256): a compact table at the bottom of Home, one row per task, its attempts folded into its row. */
table.started td:first-child { min-width: 12em; } table.started td.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
/* The Board's All projects (T253): each project's counts as a card, in aligned columns. */
.portfolio .projects { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); gap: var(--s3); } .portfolio .projects > .panel { margin: 0; } .portfolio > h2 .chip { text-transform: none; letter-spacing: normal; }
ol.timeline { list-style: none; padding: 0; margin: var(--s2) 0; border-left: 2px solid var(--line); } ol.timeline li.step { padding: var(--s1) 0 var(--s2) var(--s3); position: relative; overflow-wrap: anywhere; color: var(--fg); font-style: normal; }
ol.timeline li.step::before { content: ''; position: absolute; left: -6px; top: 10px; width: 10px; height: 10px; border-radius: var(--round); background: var(--edge); }
ol.timeline li.step.COMPLETED::before { background: var(--ok); } ol.timeline li.step.FAILED::before { background: var(--bad); } ol.timeline li.step.RUNNING::before, ol.timeline li.step.BLOCKED::before { background: var(--accent); }
/* A step's timing (T256): how long it ran and when it ended, the exact start and end on hover and focus; a running step's time ticks. */
.took { white-space: nowrap; font-variant-numeric: tabular-nums; }
/* A run's timeline (T256): one bar, a segment per step placed by when it ran; each segment's step and time on hover. */
.runbar { position: relative; height: var(--s1); margin: var(--s2) 0 var(--s3); border-radius: var(--round); background: var(--line); overflow: hidden; }
.runbar > span { position: absolute; top: 0; bottom: 0; min-width: 2px; background: var(--edge); border-right: 2px solid var(--page); }
.runbar > span.COMPLETED { background: var(--ok); } .runbar > span.FAILED { background: var(--bad); } .runbar > span.RUNNING { background: var(--accent); }
/* How a step was decided (T256): one line per decision, its reasons a click away; a deferred call's chatter one line per call. */
ul.decisions { list-style: none; padding: 0; margin: var(--s1) 0 0; } ul.decisions > li { margin: 0; border-top: 1px solid var(--line); padding: var(--s1) 0; }
ul.decisions > li:first-child { border-top: 0; } ul.decisions details > summary { color: var(--fg); } ul.decisions .reasons { margin: var(--s1) 0 0; padding-left: var(--s3); color: var(--muted); }
pre { max-width: 100%; } .answer { white-space: pre-wrap; overflow-wrap: anywhere; margin: var(--s2) 0 0; }
.answer.clamped { max-height: 9em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 60%, transparent); mask-image: linear-gradient(#000 60%, transparent); }
/* The Board: a column per state, a card per task, the projects as aligned rows. */
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s4); margin: var(--s3) 0 0; } .toolbar > p { margin: 0; }
.kanban { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--s3); align-items: start; margin: var(--s3) 0; }
.column { background: var(--sunk); border-radius: var(--radius); padding: var(--s2); }
.column h3 { margin: var(--s1) var(--s1) var(--s2); color: var(--muted); font-size: var(--small); } .column > p { margin: var(--s1); }
.card { border: 1px solid var(--line); border-radius: var(--r2); padding: var(--s2) var(--s3); margin: 0 0 var(--s2); overflow-wrap: anywhere; background: var(--bg); }
.card:last-child { margin-bottom: 0; } .card > * { margin: var(--s1) 0 0; } .card > strong:first-child { display: block; margin: 0; }
.card .actions { margin-top: var(--s2); gap: var(--s2); } .card button { padding: var(--s1) var(--s2); }
.folded { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--s2); } .folded > details { flex: 1 1 240px; } .folded > details[open] { flex-basis: 100%; }
.folded .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr)); gap: var(--s2); margin-top: var(--s2); }
details.column > summary { padding: var(--s1); }
@media (max-width: 900px) { .kanban { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .kanban { grid-template-columns: minmax(0, 1fr); } .kanban .column.waits { order: -1; } }
p.teams { border-left: 3px solid var(--accent); padding-left: var(--s2); }
/* Reviews: the change, the checks, and the verdicts as chips; the long texts under Details. */
pre.diff { font-size: var(--small); overflow-x: auto; border: 1px solid var(--line); border-radius: var(--r2); padding: var(--s2); margin: var(--s2) 0; }
pre.diff .add, .stat .add, .files .add, .change-stat .add { color: var(--ok); } pre.diff .del, .stat .del, .files .del, .change-stat .del { color: var(--bad); } pre.diff .hunk { color: var(--muted); } pre.diff.file { margin: var(--s1) 0; }
pre.report { white-space: pre-wrap; font-size: var(--small); border: 1px solid var(--line); border-radius: var(--r2); padding: var(--s2); overflow-wrap: anywhere; }
ul.files, ul.verdicts { list-style: none; padding: 0; margin: var(--s1) 0; } ul.files li { margin: var(--s1) 0; } ul.verdicts ul { margin: var(--s1) 0 var(--s1) var(--s3); padding: 0; list-style: none; }
.evidence h4 { margin: var(--s3) 0 var(--s1); } p.pending-checks, p.unrun-tests { color: var(--wait); border-left: 3px solid var(--wait); padding-left: var(--s2); }
.change-stat { border: 1px solid var(--line); border-radius: var(--round); padding: 0 var(--s2); font-size: var(--small); font-weight: 600; white-space: nowrap; }
code.exact { display: block; overflow-wrap: anywhere; }
/* Workers: availability as chips, each account a card with its quota in one line, its Workers under one fold. */
.window { color: var(--muted); } .window.limited { color: var(--wait); font-weight: 600; }
meter { width: 64px; height: 8px; margin-right: var(--s2); vertical-align: middle; } .no-bar { display: inline-block; width: 64px; height: 8px; margin-right: var(--s2); vertical-align: middle; border: 1px dashed var(--edge); border-radius: var(--r1); }
details.right-now > summary { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s2); } details.right-now > summary h3 { display: inline; color: var(--fg); }
section.right-now > h3 { margin: var(--s3) 0 0; font-size: var(--small); color: var(--muted); } .right-now ul { margin: var(--s1) 0 0; padding-left: var(--s3); }
ul.alarms { margin: var(--s2) 0 0; padding-left: var(--s2); border-left: 3px solid var(--bad); } ul.alarms > li { margin: var(--s1) 0; }
ul.capacities { list-style: none; padding: 0; margin: var(--s2) 0; } li.capacity { margin: var(--s1) 0; }
section.account > h3 .muted { font-weight: 400; } .quota { margin: var(--s2) 0 0; }
details.facts, details.workers-fold { margin: var(--s2) 0 0; } details.facts > summary { font-size: var(--small); } details.facts dl { margin-top: var(--s1); }
.workers-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); gap: var(--s3); margin-top: var(--s2); } .workers-grid > .panel { margin: 0; }
.panel.worker h4 { margin: 0 0 var(--s1); }
.accounts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(560px, 100%), 1fr)); gap: var(--s3); align-items: start; } .accounts-grid > .panel { margin: 0; }
/* Help and the policy. */
.help-contents ul { padding-left: var(--s3); } ol.flow { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--s1) 0; padding: 0; list-style: none; } ol.flow > li { margin: 0; display: flex; align-items: baseline; } ol.flow > li:not(:last-child)::after { content: '→'; margin: 0 var(--s2); color: var(--muted); } ol.flow > li > details[open] { max-width: 40ch; }
dl.glossary { margin: var(--s2) 0; } dl.glossary dt { margin-top: var(--s1); } dl.glossary dt:focus { outline: 2px solid var(--accent); outline-offset: 2px; } dl.glossary dt button.term { border: 0; min-height: 0; padding: var(--s1) 0; margin: 0; font-weight: 600; color: inherit; background: transparent; } dl.glossary dt button.term::before { content: '▸ '; color: var(--muted); } dl.glossary dt button.term[aria-expanded="true"]::before { content: '▾ '; } dl.glossary dd { margin: 0 0 var(--s2) var(--s3); } dl.glossary [hidden] { display: none; }
table.modes select { max-width: 100%; } details.advanced { margin: var(--s2) 0; }
/* A phone (T239): one column, no horizontal scroll, and buttons large enough to press. */
@media (max-width: 640px) { :root { --safe-right: max(var(--s3), env(safe-area-inset-right)); --safe-left: max(var(--s3), env(safe-area-inset-left)); }
  header { position: sticky; top: 0; z-index: 6; } header h1 { order: 1; } main [id] { scroll-margin-top: calc(var(--safe-top) + var(--s4) * 4); } #status { order: 2; } header nav { order: 3; flex-basis: 100%; justify-content: space-between; } header nav a { padding: var(--s1) var(--s2); } .wide { display: none; } ul.tiles > li > a:first-child { font-size: var(--body); } main { padding-top: var(--s3); }
  button { min-height: 40px; } button.why, button.copy, dl.glossary dt button.term { min-height: 0; } input { min-width: 0; width: 100%; }
  .card .actions > button, .request > .actions > button { flex: 1 1 0; } .actions > button.tips { flex: 0 0 auto; }
  th, td.nowrap { white-space: normal; } th, td { padding: var(--s2); }
  .request dl { grid-template-columns: minmax(0, 1fr); } .request dt { margin-top: var(--s1); }
  /* A detail page's primary action in a bar at the bottom of the screen, above the home indicator, in reach of a thumb (T240). */
  .actions.bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 5; margin: 0; padding: var(--s2) var(--safe-right) var(--safe-bar) var(--safe-left); background: var(--bg); border-top: 1px solid var(--line); }
  .actions.bar > button { flex: 1 1 0; } main:has(.actions.bar) { padding-bottom: var(--bar-room); } }
/* Below 600 px a table is a list of cards, each cell named by its column (T240). */
@media (max-width: 599px) {
  table, tbody, tr, td { display: block; width: 100%; } table { border: 0; background: none; overflow: visible; }
  thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  tbody > tr { background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--s2) var(--s3); margin: 0 0 var(--s2); }
  tbody > tr > td { border: 0; padding: var(--s1) 0; } tbody > tr > td[data-label] { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: var(--s2); align-items: baseline; }
  td[data-label]::before { content: attr(data-label); font-size: var(--small); font-weight: 600; color: var(--muted); } }
/* A touch screen (T240): text at 16 px, so focusing a field never zooms; every target at least 44 by 44 px. */
@media (pointer: coarse) {
  :root { --small: 13px; --body: 16px; --large: 20px; }
  input, select, textarea { font-size: var(--body); }
  button, select, input, summary, header nav a, ul.tiles > li > a:first-child, .actions > a, .head > a, dl.glossary dt button.term { min-height: 44px; }
  button { min-width: 44px; } button.copy { width: 44px; height: 44px; min-height: 44px; margin: 0; }
  summary, header nav a, .actions > a, .head > a, ul.tiles > li > a:first-child { display: flex; align-items: center; } summary { gap: var(--s1); } header nav a, .actions > a, .head > a { display: inline-flex; }
  details.fold.inline > summary { display: inline-flex; }
  section.group > h4 > a, .portfolio h3 > a, a.reports { display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; } }
/* The "?" of a word, and of a row of buttons where nothing hovers: a small circle in a target a finger can press. */
button.why, button.tips { border: 0; background: transparent; padding: 0; min-height: 0; display: inline-block; vertical-align: middle; }
button.why .q, button.tips .q { display: inline-block; min-width: 1.6em; border: 1px solid var(--edge); border-radius: var(--round); font-size: var(--small); line-height: 1.5; color: var(--muted); text-align: center; }
button.why[aria-expanded="true"] .q, button.tips[aria-expanded="true"] .q { color: var(--accent); border-color: var(--accent); }
@media (pointer: coarse) { button.why, button.tips { min-width: 44px; min-height: 44px; } }
@media (hover: hover) { button.tips { display: none; } }
.tips-open > .does, .tips-open > .does.shown { display: block; position: static; order: 2; flex-basis: 100%; max-width: none; padding: 0; background: transparent; color: var(--muted); font-size: var(--small); }
.tips-open > .does::before { content: attr(data-for) ': '; font-weight: 600; color: var(--fg); }
`

export const APP_JS = `'use strict'
;(() => {
  const main = document.getElementById('main')
  const status = document.getElementById('status')
  const hash = new URLSearchParams(location.hash.slice(1))
  if (hash.get('token')) {
    try { sessionStorage.setItem('system.token', hash.get('token')) } catch {}
    history.replaceState(null, '', location.pathname + location.search)
  }
  let token = null
  try { token = sessionStorage.getItem('system.token') } catch {}

  const el = (tag, props, ...children) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') node.className = value
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else node.setAttribute(key, value)
    }
    for (const child of children.flat(Infinity)) if (child !== null && child !== undefined) node.append(child instanceof Node ? child : String(child))
    return node
  }
  // A decision's button (T191), one implementation for every page: its label the concept's one wording
  // (Approve / Deny on approvals, Accept / Send back on reviews, Confirm / Cancel on a confirmation, Stop run,
  // Retry failed step, Propose), and what pressing it does its accessible description (aria-describedby), shown
  // as a tooltip on hover and on keyboard focus (T239), never as text beside every button; Escape hides it.
  // Returns [button, what it does].
  let doesCount = 0
  const decision = (label, consequence, props) => {
    const id = 'does-' + (++doesCount)
    const button = el('button', Object.assign({ type: 'button' }, props, { 'aria-describedby': id }), label)
    const tip = el('span', { id, class: 'does', role: 'tooltip', 'data-for': label }, consequence)
    tooltip(button, tip)
    return [button, tip]
  }
  // A tooltip beside its control, placed in the viewport (never wider than the screen, so a phone does not scroll sideways).
  function tooltip(control, tip) {
    const place = () => {
      tip.classList.add('shown')
      const box = control.getBoundingClientRect()
      const width = tip.offsetWidth, height = tip.offsetHeight
      tip.style.left = Math.max(8, Math.min(box.left, innerWidth - width - 8)) + 'px'
      tip.style.top = (box.bottom + 4 + height > innerHeight ? Math.max(4, box.top - height - 4) : box.bottom + 4) + 'px'
    }
    const hide = () => tip.classList.remove('shown')
    placers.set(tip, place)
    control.addEventListener('mouseenter', place)
    control.addEventListener('mouseleave', () => { if (document.activeElement !== control || !control.matches(':focus-visible')) hide() })
    control.addEventListener('focus', () => { if (control.matches(':focus-visible')) place() })
    control.addEventListener('blur', hide)
    control.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide() })
  }
  // Where nothing hovers, a touch screen (T240): each row of described buttons gets one "?" that shows what each of them
  // does, their tooltips under the row, on a tap; a second tap, a tap outside, or Escape hides them. A tap on a button
  // itself does what it says at once. CSS shows the "?" only where nothing hovers. Every row a render adds gets its own.
  const setTips = (row, open) => {
    row.classList.toggle('tips-open', open)
    const toggle = row.querySelector(':scope > button.tips')
    if (toggle) toggle.setAttribute('aria-expanded', String(open))
  }
  const tapTips = (root) => {
    for (const row of new Set([...root.querySelectorAll('.does')].map((tip) => tip.parentElement))) {
      if (!row || row.querySelector(':scope > button.tips')) continue
      const tips = [...row.querySelectorAll(':scope > .does')]
      const toggle = el('button', { type: 'button', class: 'tips', 'aria-expanded': 'false', 'aria-controls': tips.map((t) => t.id).join(' '),
        'aria-label': tips.length > 1 ? 'What these buttons do' : 'What this button does' }, el('span', { class: 'q', 'aria-hidden': 'true' }, '?'))
      toggle.addEventListener('click', () => setTips(row, !row.classList.contains('tips-open')))
      row.append(toggle)
    }
  }
  for (const root of [document.getElementById('main'), document.getElementById('outcome')]) new MutationObserver(() => tapTips(root)).observe(root, { childList: true, subtree: true })
  // A tap outside closes what a tap opened: the rows' tooltips and the "?" notes.
  document.addEventListener('pointerdown', (e) => {
    for (const row of document.querySelectorAll('.tips-open')) if (!row.contains(e.target)) setTips(row, false)
    for (const button of document.querySelectorAll('button.why[aria-expanded="true"]')) if (!button.parentElement.contains(e.target)) button.click()
  }, true)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const row of document.querySelectorAll('.tips-open')) setTips(row, false) })
  // A shown tooltip follows its control as the page scrolls or resizes.
  const placers = new WeakMap()
  const replace = () => { for (const tip of document.querySelectorAll('.does.shown')) { const place = placers.get(tip); if (place) place() } }
  window.addEventListener('scroll', replace, { passive: true })
  window.addEventListener('resize', replace)
  // What Deny does to a start System proposes (ADR-0064), the same on its request's card and under Starts awaiting
  // approval: nothing starts, and that attempt is never asked about again (T197).
  const DISPATCH_DENY = 'does not start it, and this attempt is not asked again'
  const api = async (path, body) => {
    const response = await fetch('/ui/api/' + path, body === undefined
      ? { headers: { authorization: 'Bearer ' + token } }
      : { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw Object.assign(new Error(value.error || response.statusText), { status: response.status })
    return value
  }
  // The shared building blocks (T172), one implementation each, used by every page.
  // A status chip: a word, a colour, and a symbol of its own shape, so it is never told by colour alone.
  const GLYPH = { ok: '●', warn: '▲', bad: '■', info: '◆', idle: '○' }
  const chip = (word, tone) => el('span', { class: 'chip ' + (GLYPH[tone] ? tone : 'idle') }, el('span', { class: 'glyph', 'aria-hidden': 'true' }, GLYPH[tone] || GLYPH.idle), ' ', word)
  // A number with its unit: "1 task", "3 tasks"; qtyView sets the number apart.
  const unit = (n, one, many) => n === 1 ? one : (many || one + 's')
  const qty = (n, one, many) => n + ' ' + unit(n, one, many)
  const qtyView = (n, one, many) => el('span', { class: 'qty' }, el('span', { class: 'n' }, String(n)), ' ' + unit(n, one, many))
  // A fold for an explanation or a technical fact: closed by default, never deleted.
  const fold = (summary, ...body) => el('details', { class: 'fold' }, el('summary', {}, summary), el('div', { class: 'fold-body' }, body))
  // A card's one fold (T186): closed by default, and, once the operator opens it, kept open through the 5-second refresh.
  const openFolds = new Set()
  // A fold open by default that the operator closed stays closed through the refresh.
  const closedFolds = new Set()
  const keptFold = (key, summary, ...body) => {
    const details = fold(summary, ...body)
    if (openFolds.has(key)) details.open = true
    details.addEventListener('toggle', () => { if (details.open) openFolds.add(key); else openFolds.delete(key) })
    return details
  }
  const cardFold = (key, ...body) => {
    const details = keptFold(key, 'Details', ...body)
    details.classList.add('card-details')
    return details
  }
  // A list of at most LIST_SHOWN rows, and a "Show all N" that shows the rest and stays so through the refresh (T186).
  const LIST_SHOWN = 5
  const expandedLists = new Set()
  const capped = (key, container, items, render) => {
    if (items.length <= LIST_SHOWN) { container.append(...items.map(render)); return [container] }
    const button = el('button', { type: 'button', class: 'show-all', 'aria-expanded': 'false', ...(container.id ? { 'aria-controls': container.id } : {}) })
    const draw = () => {
      const all = expandedLists.has(key)
      container.replaceChildren(...(all ? items : items.slice(0, LIST_SHOWN)).map(render))
      button.textContent = all ? 'Show first ' + LIST_SHOWN : 'Show all ' + items.length
      button.setAttribute('aria-expanded', String(all))
    }
    button.addEventListener('click', () => { if (expandedLists.has(key)) expandedLists.delete(key); else expandedLists.add(key); draw() })
    draw()
    return [container, button]
  }
  // A copy button for an id or a hash: the value is behind it, never the first thing in a row. A small icon (T256), named
  // by its label, the value its tooltip; a check once copied. Without a clipboard the value is shown beside it, selected,
  // to copy by hand.
  const copyId = (label, value) => {
    const button = el('button', { type: 'button', class: 'copy', 'data-copy': value, 'aria-label': label, title: label + ': ' + value })
    button.addEventListener('click', async (e) => {
      e.preventDefault()
      try {
        await navigator.clipboard.writeText(value)
        button.classList.add('done')
        button.setAttribute('aria-label', 'Copied')
        setTimeout(() => { button.classList.remove('done'); button.setAttribute('aria-label', label) }, 2000)
      } catch {
        if (button.nextElementSibling && button.nextElementSibling.classList.contains('copied')) return
        const code = el('code', { class: 'copied' }, value)
        button.after(code)
        const range = document.createRange()
        range.selectNodeContents(code)
        const selection = window.getSelection()
        if (selection) { selection.removeAllRanges(); selection.addRange(range) }
      }
    })
    return button
  }
  // A hash, an id, or a long path as a person reads it first (T256): a path past 32 characters by its last two parts; in
  // anything else, each run of 12 or more hex digits (a content id's "sha256:" dropped) by its first 8, and what is still
  // past 32 characters by its start. The whole is the code's tooltip and behind its copy button.
  const shortText = (value) => {
    if (value.includes('/') && !/[ :@]/.test(value)) return value.length <= 32 ? value : '…/' + value.split('/').filter(Boolean).slice(-2).join('/')
    const short = value.replace(/(?:sha256:)?[0-9a-f]{12,}/g, (hex) => hex.replace(/^sha256:/, '').slice(0, 8) + '…')
    return short.length <= 32 ? short : short.slice(0, 28) + '…'
  }
  const shortId = (value, label) => [el('code', { class: 'short', title: value }, shortText(value)), copyId(label, value)]
  // A span of time in a few words: "40 s", "14 min", "2 h 5 min", "3 days".
  const duration = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60)
    return s < 60 ? s + ' s' : m < 60 ? m + ' min' : h < 48 ? h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '') : Math.floor(h / 24) + ' days'
  }
  // How long something ran (T256): its exact start and end on hover and on keyboard focus.
  const tookView = (from, to) => {
    const exact = absolute(from) + ' – ' + absolute(to)
    return el('span', { class: 'took', tabindex: '0', title: exact, 'data-exact': exact }, duration(Date.parse(to) - Date.parse(from)))
  }
  // How long something has been running, ticking each second (T256): its exact start on hover and on keyboard focus.
  const elapsedView = (since) => {
    const exact = 'since ' + absolute(since)
    return el('span', { class: 'took elapsed', 'data-since': since, tabindex: '0', title: exact, 'data-exact': exact }, duration(Date.now() - Date.parse(since)))
  }
  setInterval(() => {
    for (const span of document.querySelectorAll('.elapsed[data-since]')) {
      const text = duration(Date.now() - Date.parse(span.dataset.since))
      if (span.textContent !== text) span.textContent = text
    }
  }, 1000)
  // A line diff of two texts (longest common subsequence), as lines prefixed '+ ', '- ', or '  '. Bounded by the policy body (128 KiB).
  const lineDiff = (before, after) => {
    const a = before.split('\\n'), b = after.split('\\n')
    const n = a.length, m = b.length
    const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    const out = []
    let i = 0, j = 0
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push(['same', a[i]]); i++; j++ }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(['del', a[i++]])
      else out.push(['add', b[j++]])
    }
    while (i < n) out.push(['del', a[i++]])
    while (j < m) out.push(['add', b[j++]])
    return out
  }
  const subjectText = (s) => s.type + ' ' + s.ref + (s.version ? ' @ ' + s.version : '')
  // A text as a person reads it first: the proposed set for a policy set's hash, a hash in
  // parentheses left out, any other long hash cut to its first 8 characters. The exact text stays folded beside it.
  const LONG_HASH = /(?:sha256:)?[0-9a-f]{16,}/
  const plainly = (text) => text
    .replace(/the set (?:sha256:)?[0-9a-f]{16,}/g, 'the proposed set')
    .replace(/\\s*\\((?:at )?(?:sha256:)?[0-9a-f]{16,}\\)/g, '')
    .replace(/(?:sha256:)?[0-9a-f]{16,}/g, (hash) => hash.replace(/^sha256:/, '').slice(0, 8) + '…')
  const folded = (text, summary) => LONG_HASH.test(text) ? [plainly(text), el('details', {}, el('summary', {}, summary), el('code', { class: 'exact' }, text))] : [text]
  const pretty = (value) => value === undefined ? '' : JSON.stringify(value, null, 2)
  const diffView = (before, after) => el('pre', { class: 'diff' }, lineDiff(pretty(before), pretty(after)).map(([kind, line]) =>
    el('span', kind === 'same' ? {} : { class: kind }, (kind === 'add' ? '+ ' : kind === 'del' ? '- ' : '  ') + line + '\\n')))
  const effectView = (effect) => effect.length
    ? el('ul', {}, effect.map((e) => el('li', {}, (e.projectId ? 'project ' + e.projectId : 'studio') + ': ' + e.actionClass + ' ', el('span', { class: 'state' }, e.from + ' → ' + e.to))))
    : el('p', { class: 'muted' }, 'No effective mode moves: only expiry, batching, commands, or required checks change.')
  const windowText = (seconds) => seconds % 86400 === 0 ? seconds / 86400 + (seconds === 86400 ? ' day' : ' days')
    : seconds % 3600 === 0 ? seconds / 3600 + (seconds === 3600 ? ' hour' : ' hours') : seconds + ' seconds'
  const changeView = (change) => el('div', { class: 'panel' },
    el('p', {}, el('strong', {}, change.policy.id + (change.previous ? ' version ' + change.previous.version + ' → ' + change.policy.version : ' (new, version ' + change.policy.version + ')')),
      copyId('Copy change ID', change.changeId), copyId('Copy request ID', change.requestId)),
    change.note ? el('p', {}, change.note) : null,
    // A change the queue proposed itself says so, and why: never the operator's own proposal (INV-6).
    change.origin ? el('p', {}, el('strong', {}, 'Proposed by the queue, not by you: '), 'you approved ', el('code', {}, change.origin.shape.command),
      ' ' + change.origin.approved + ' times among the requests of the last ' + windowText(change.origin.windowSeconds) + ', and rejected none; decision ', shortId(change.origin.decision, 'Copy decision ID')) : null,
    el('details', {}, el('summary', {}, 'Hashes of both sets'), el('p', { class: 'muted' }, 'Set ', shortId(change.hash, 'Copy set hash'), ', proposed on ', shortId(change.baseHash, 'Copy base hash'))),
    effectView(change.effect),
    diffView(change.previous, change.policy))
  // replaceChildren turns null into the text "null": absent sections are dropped first. A render
  // that lands while a pointer or key is pressed waits for its release: replacing the button under
  // a press would drop the click, and with it the operator's verdict (T84).
  let pressed = false
  let pending = null
  const show = (...parts) => {
    const kept = parts.flat().filter((part) => part !== null && part !== undefined)
    // A page that finished rendering after the operator moved to another one is dropped: a slow read never overwrites the page now shown.
    const head = kept[0]
    if (head && head.dataset && head.dataset.page && head.dataset.page !== shownPage()) return
    if (pressed) pending = kept
    else { pending = null; main.replaceChildren(...kept) }
  }
  const press = () => { pressed = true }
  // After the click the release dispatches, so a deferred render never takes the target away first.
  const release = () => setTimeout(() => {
    pressed = false
    if (pending) { const parts = pending; pending = null; main.replaceChildren(...parts) }
  }, 0)
  document.addEventListener('pointerdown', press, true)
  document.addEventListener('pointerup', release, true)
  document.addEventListener('pointercancel', release, true)
  document.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') press() }, true)
  document.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') release() }, true)
  // Every page opens with its title; where the title alone does not say what the page is for, one short sentence (T239).
  const PAGES = {
    home: ['Home'],
    board: ['Board'],
    workers: ['Workers'],
    policy: ['Autonomy policy', 'Control which actions need approval.'],
    run: ['Run'],
    help: ['How System works', 'Find an answer or look up a term.'],
    reports: ['Reports', 'Run a command where System runs.'],
  }
  // The words a person meets on these pages, each in one plain sentence (T126): the Help page lists
  // them, and every place that shows one has a "?" that opens its sentence in place, by click, tap, or
  // keyboard, never by hover alone, with a link to its entry in Help.
  const GLOSSARY = {
    worker: ['Worker', 'A Worker is one AI helper the system can give work to: one account of a tool, set up for one job.'],
    account: ['account', 'An account is one signed-in subscription or key; the Workers set up on it share its quota.'],
    role: ['role', 'A role is the job an account\\'s Worker is set up for, such as develop or review.'],
    tier: ['tier', 'A tier says how capable a Worker is (economy, standard, or frontier); a step asks for at least one.'],
    kind: ['kind of work', 'A kind of work (code, docs, tests) is a label: a Worker given kinds takes only that work.'],
    quota: ['quota', 'Quota is how much an account may use in a stretch of time, such as 5 hours; the bar shows the share used.'],
    window: ['window', 'A window is the stretch of time a quota counts over, such as 5 hours or 7 days; it starts again at the time shown.'],
    resting: ['resting', 'A Worker rests when its account used up its quota: it takes no work until the time shown, then comes back by itself.'],
    project: ['project', 'A project groups tasks under a charter, what it is for, which you approve before any of its tasks starts.'],
    task: ['task', 'A task is one piece of a project\\'s work: what it should achieve, and how to tell that it did.'],
    run: ['run', 'A run is one go at some work: its steps, one after another, each on a Worker.'],
    start: ['ready task', 'A ready task starts when you press Start on its card or the lead runs it: the run claims the task, and a Worker that can do it takes it.'],
    step: ['step', 'A step is one part of a run, done by one Worker, such as changing the code, reviewing it, or testing it.'],
    attempt: ['attempt', 'An attempt is one try at a task or a step; one that fails can be tried again, up to its limit.'],
    review: ['review', 'A review is a finished task\\'s result waiting for you: you accept it, or send it back for another try.'],
    checks: ['checks', 'Checks are the tests and lint the policy wants passed; one nothing ran counts as passed if you accept.'],
    landing: ['merge progress', 'An accepted result goes into the code in two moves: it is saved on its run\\'s own branch, then merged once you approve.'],
    merge: ['merge', 'A merge brings an accepted change into the main line of the code; nothing merges without your yes.'],
    branch: ['branch', 'A branch is a separate line of changes in the code; each run works on its own, apart from yours.'],
    approval: ['approval request', 'An approval request is a question the system asks you before it does something it may not do alone.'],
    'action-class': ['action type', 'An action type is the kind of thing a request is about, such as a merge, a deploy, or a command.'],
    batch: ['batch', 'A batch is a group of related requests you can approve or deny together.'],
    policy: ['autonomy policy', 'The autonomy policy says which actions run on their own, which tell you after, which ask you first, and which never run.'],
    mode: ['mode', 'A mode is what the policy does with an action: Automatic runs it, Notify runs it then tells you, Ask approval waits for you, Blocked never runs it.'],
    'always-ask': ['always requires approval', 'Some actions always require your approval, whatever the policy says: anything that cannot be undone, spends money, or merges code.'],
    'policy-change': ['policy change', 'A policy change is a proposed new autonomy policy; it applies only once you approve it.'],
    quarantine: ['quarantined', 'A quarantined account is held back because its sign-in is not the one that was set up; it takes no work until that is checked.'],
    stalled: ['stalled', 'A stalled run showed no activity for longer than its limit; nothing is sent to it, and Stop run ends it.'],
    held: ['not known to be gone', 'A run not known to be gone may still be working somewhere; what it holds stays held until it is freed.'],
    derived: ['derived', 'A derived line is what the system could tell about a Worker when no one wrote what it is for.'],
    team: ['team', 'A team is two or more Workers, each of another provider, that answer one step on their own and then vote; you can exclude a Worker from teams in the configuration.'],
    carry: ['continued from earlier work', 'When a task\\'s attempt fails after its code was already changed, the next attempt starts from that change instead of doing it again.'],
    resend: ['retried after a service error', 'When a website answers a team member\\'s question with its own error instead of an answer, the question is sent once more, in a new conversation; never twice.'],
    stale: ['stale', 'Shown data is stale when the last refresh failed: the page keeps what it read before, says when it read it, and tries again every 5 seconds.'],
  }
  const openTerms = new Set()
  let explained = 0
  // A "?" after a word: it opens the word's sentence in place (and closes it), reachable by keyboard and touch.
  const whatIs = (key) => {
    const [word, sentence] = GLOSSARY[key]
    const id = 'explain-' + key + '-' + (++explained)
    const more = el('a', { href: '/ui/?view=help#term-' + key, onclick: (e) => { e.preventDefault(); openHelp(key) } }, 'more in Help')
    const note = el('span', { id, class: 'explain-note', role: 'note' }, sentence + ' ', more)
    const open = openTerms.has(key)
    note.hidden = !open
    const button = el('button', { type: 'button', class: 'why', 'aria-expanded': String(open), 'aria-controls': id, 'aria-label': 'What is ' + word + '?', title: sentence }, el('span', { class: 'q', 'aria-hidden': 'true' }, '?'))
    button.addEventListener('click', () => {
      const opening = note.hidden
      note.hidden = !opening
      button.setAttribute('aria-expanded', String(opening))
      if (opening) openTerms.add(key)
      else openTerms.delete(key)
    })
    return el('span', { class: 'explain' }, ' ', button, ' ', note)
  }

  // Help: how System works, in plain words, with links into the real pages, then the glossary.
  const pageLink = (name, text) => el('a', { href: '/ui/?view=' + name, onclick: (e) => { e.preventDefault(); document.getElementById(name + '-link').click() } }, text)
  const homeLink = (text) => el('a', { href: '/ui/', onclick: (e) => { e.preventDefault(); go() } }, text)
  const termLink = (key, text) => el('a', { href: '#term-' + key, onclick: (e) => { e.preventDefault(); focusTerm(key) } }, text || GLOSSARY[key][0])
  // A link straight to a term opens its definition (a search that hides it is cleared) and focuses it.
  const focusTerm = (key) => {
    const target = document.getElementById('term-' + key)
    if (!target) return
    const search = document.getElementById('glossary-search')
    if (search && search.value) { search.value = ''; filterTerms('') }
    openTerm(key, true)
    history.replaceState(null, '', '?view=help#term-' + key)
    target.scrollIntoView({ block: 'center' })
    target.focus({ preventScroll: true })
  }
  const openTerm = (key, open) => {
    const definition = document.getElementById('def-' + key)
    const button = document.querySelector('#term-' + key + ' button.term')
    if (!definition || !button) return
    definition.hidden = !open
    button.setAttribute('aria-expanded', String(open))
  }
  // The glossary's search: a term shows when its word or its sentence holds what is typed.
  const filterTerms = (query) => {
    const q = query.trim().toLowerCase()
    let shown = 0
    for (const [key, [word, sentence]] of Object.entries(GLOSSARY)) {
      const term = document.getElementById('term-' + key)
      if (!term) continue
      const hit = !q || word.toLowerCase().includes(q) || sentence.toLowerCase().includes(q)
      term.hidden = !hit
      if (!hit) document.getElementById('def-' + key).hidden = true
      else if (term.querySelector('button.term').getAttribute('aria-expanded') === 'true') document.getElementById('def-' + key).hidden = false
      if (hit) shown++
    }
    const none = document.getElementById('glossary-none')
    if (none) none.hidden = shown > 0
  }
  function helpView() {
    const section = (id, title, ...body) => el('section', { class: 'panel help', id, 'aria-labelledby': id + '-title' }, el('h3', { id: id + '-title' }, title), body)
    // Each answer is folded under its question or state: the section's navigation stays in sight (T171).
    const item = (summary, ...body) => el('li', {}, fold(summary, body))
    const search = el('input', { id: 'glossary-search', type: 'search', 'aria-label': 'Search terms', placeholder: 'Search terms', oninput: () => filterTerms(search.value) })
    const term = (key, word, sentence) => {
      const button = el('button', { type: 'button', class: 'term', 'aria-expanded': 'false', 'aria-controls': 'def-' + key }, word)
      button.addEventListener('click', () => openTerm(key, button.getAttribute('aria-expanded') !== 'true'))
      return [el('dt', { id: 'term-' + key, tabindex: '-1' }, button), el('dd', { id: 'def-' + key, hidden: '' }, sentence)]
    }
    show(pageHead('help'),
      el('nav', { class: 'help-contents', 'aria-label': 'On this page' }, el('ul', {},
        [['help-workers', 'Workers'], ['help-flow', 'Task lifecycle'], ['help-waits', 'Your decisions'], ['help-policy', 'Autonomy'], ['help-stuck', 'Troubleshooting'], ['help-glossary', 'Glossary']]
          .map(([id, text]) => el('li', {}, el('a', { href: '#' + id, onclick: (e) => { e.preventDefault(); const t = document.getElementById(id); t.scrollIntoView({ block: 'start' }); t.querySelector('h3').setAttribute('tabindex', '-1'); t.querySelector('h3').focus({ preventScroll: true }) } }, text))))),
      section('help-workers', 'Workers',
        el('p', {}, termLink('worker', 'Workers'), ' develop, review, and test tasks. Workers on one ', termLink('account', 'account'), ' share its ', termLink('quota', 'quota'), '.'),
        el('p', {}, 'Quota resets automatically. ', termLink('resting', 'Resting'), ' Workers return at the shown time.'),
        el('ul', { class: 'plain' },
          item('Accounts and roles', 'Each Worker is one account of a tool set up for one ', termLink('role', 'role'), ', such as developing or reviewing. When an account has used its quota for the current ', termLink('window', 'window'), ' (5 hours, say), its Workers take no work until the time shown, then come back by themselves.'),
          item('Teams and exclusions', 'Some steps are done by a ', termLink('team', 'team'), ': Workers of different providers answer independently, then vote. A Worker excluded from teams still takes every other step; its card says ', el('em', {}, 'Excluded from teams'), '.')),
        el('p', {}, 'Every account, its quota, and what each Worker does now: ', pageLink('workers', 'Workers'), '.')),
      section('help-flow', 'Task lifecycle',
        el('ol', { class: 'flow', 'aria-label': 'Proposed, Ready, Working, Review, Accepted, Merged' },
          item('Proposed', 'The lead proposes a ', termLink('task', 'task'), ' in a ', termLink('project', 'project'), ' whose charter you approved. A project shows on the Board once the lead proposes its charter, and starts once you approve it on Home.'),
          item('Ready', 'Once what it depends on is done and the ', termLink('policy', 'autonomy policy'), ' allows it, it is ready. Start: you press Start on its card on the ', pageLink('board', 'Board'), ', or the lead starts it, and its ', termLink('run', 'run'), ' begins.'),
          item('Working', 'Each ', termLink('step', 'step'), ' runs on a free Worker: for code, it changes the code on its own ', termLink('branch', 'branch'), ', another Worker reviews it, and a third runs the tests.'),
          item('Review', 'The result waits for you on ', homeLink('Home'), ': what changed, what the reviewer said, and what the ', termLink('checks', 'checks'), ' measured. You accept it, or send it back for another ', termLink('attempt', 'attempt'), '.'),
          item('Accepted', 'An accepted change is saved on its branch, and the system asks you to approve its ', termLink('merge', 'merge'), '.'),
          item('Merged', 'Once you approve, it is merged into the main line of the code. Nothing is pushed anywhere.'))),
      section('help-waits', 'Your decisions',
        el('p', {}, 'Home lists what needs your attention, and the window\\'s title counts it: ', el('em', {}, '(3) system'), '.'),
        el('ul', { class: 'plain' },
          item('Approvals: allow or deny an action', 'An ', termLink('approval', 'approval request'), ' asks your yes or no before something the policy does not let run alone; a run, the board, or a Worker asks it. Each button says what it does. No response by its time: denied.'),
          item('Reviews: accept or send back work', 'When a Worker finishes a task, its result waits for you to accept it or send it back. No response by its time: the task waits for input.'),
          item('Runs: approve a plan, break a tie, or inspect a failure', 'A run that waits for your vote or your approval of its plan, or a run outside the board that failed since you last marked Home as seen, says why and what you can do. A board task\\'s failed run is the board\\'s: it decides the next attempt. A tied vote with no response ends inconclusive.')),
        el('p', {}, '“Since you last looked” on Home tells what happened while you were away.')),
      section('help-policy', 'Autonomy',
        table(['Mode', 'What it does'], [['Automatic', 'Runs on its own'], ['Notify', 'Runs, then tells you'], ['Ask approval', 'Waits for your approval'], ['Blocked', 'Never runs']].map(([m, what]) => el('tr', {}, el('td', {}, el('strong', {}, m)), el('td', {}, what))), 'modes'),
        el('p', {}, 'Each action type has a ', termLink('mode', 'mode'), ' in the ', termLink('policy', 'autonomy policy'), '. Some actions ', termLink('always-ask', 'always require approval'), '. ', pageLink('policy', 'Open Policy')),
        el('ul', { class: 'plain' },
          item('Which actions always require approval', 'A merge, a deploy, sending anything out, deleting data, spending, and changing the policy itself, whatever the policy says.'),
          item('Changing the policy', 'A change is a request too: it applies only once you approve it.'))),
      section('help-stuck', 'Troubleshooting',
        el('ul', { class: 'plain' },
          item('Run failed', 'Open it from Home: it says why. ', el('em', {}, 'Retry failed step'), ' runs the failed step again; completed steps are kept.'),
          item('Task retried', 'Its next run says under ', el('em', {}, 'What happened'), ' whether it ', termLink('carry', 'continued from the earlier work'), ' or started over, and whether a step was ', termLink('resend', 'retried after a service error'), '.'),
          item('Run stalled', 'Its page says its last event and how long ago. A ', termLink('stalled', 'stalled'), ' run is flagged; ', el('em', {}, 'Stop run'), ' ends it.'),
          item('Nothing starts', 'On ', pageLink('workers', 'Workers'), ', see whether a Worker is free, or resting until when. On the ', pageLink('board', 'Board'), ', a ready task waits for Start.'),
          item('Account unavailable', 'A ', termLink('quarantine', 'quarantined'), ' or signed-out account\\'s Workers take no work: ask whoever set up the system to sign it in again or check it.'),
          item('Task needs input', 'It used its attempts, or asked a question: its card on the Board says which.'),
          item('Page says stale', 'The last refresh failed: the page shows what it read before, and when (', termLink('stale', 'stale'), '). It tries again every 5 seconds.'))),
      el('section', { class: 'panel help', id: 'help-glossary', 'aria-labelledby': 'help-glossary-title' }, el('h3', { id: 'help-glossary-title' }, 'Glossary'),
        el('p', {}, search),
        el('dl', { class: 'glossary' }, Object.entries(GLOSSARY).sort((a, b) => a[1][0].localeCompare(b[1][0])).flatMap(([key, [word, sentence]]) => term(key, word, sentence))),
        el('p', { id: 'glossary-none', class: 'muted', hidden: '' }, 'No term matches.')))
    const wanted = /^#term-([a-z-]+)$/.exec(location.hash)
    if (wanted) setTimeout(() => focusTerm(wanted[1]), 0)
  }
  function openHelp(key) {
    current = null
    view = 'help'
    confirming = false
    history.pushState(null, '', '?view=help#term-' + key)
    refresh()
  }

  // Idle capacity in numbers; how a ready task gets a Worker is behind the Board's Ready "?" (whatIs('start')).
  const capacityText = (free, ready) => (free === undefined ? 'Free Workers unknown' : qty(free, 'Worker') + ' free') + ' · ' + qty(ready, 'task') + ' ready'
  // An error state with its one next action; the page also tries again by itself every 5 seconds.
  const errorState = (text) => el('div', { class: 'panel bad error-state' }, el('p', { class: 'state failed' }, text), el('button', { type: 'button', onclick: () => refresh() }, 'Try again'))
  const pageHead = (page, title, runId) => [el('h2', { class: 'page', 'data-page': page === 'run' ? 'run:' + runId : page }, title || PAGES[page][0]), PAGES[page][1] ? el('p', { class: 'lead' }, PAGES[page][1]) : null]
  // The page the address names now: what a render must be of to be shown.
  function shownPage() { return view === 'policy' || view === 'board' || view === 'workers' || view === 'help' || view === 'reports' ? view : current ? 'run:' + current : 'home' }
  // A table; below 600 px each row is a card, each cell named by its column (data-label, T240).
  const labelled = (head, row) => { [...row.children].forEach((cell, i) => { if (head[i]) cell.dataset.label = head[i] }); return row }
  const table = (head, rows, cls) => el('table', cls ? { class: cls } : {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows.map((row) => labelled(head, row))))

  // What the operator's last verdict did, outside the refreshed page: it stays until dismissed.
  // A verdict that was not recorded is an alert, never only a line a refresh overwrites (INV-2).
  const outcome = document.getElementById('outcome')
  // ok: true for done, false for refused, pending for asked and not done yet (neither).
  const report = (ok, title, lines) => {
    const dismiss = el('button', { onclick: () => outcome.replaceChildren() }, 'Dismiss')
    outcome.replaceChildren(el('div', { class: 'panel' + (ok === 'pending' ? '' : ok ? ' ok' : ' bad'), role: ok === false ? 'alert' : 'status' },
      el('h3', { class: ok === 'pending' ? 'state running' : ok ? 'state completed' : 'state failed' }, title),
      lines.filter(Boolean).map((line) => line instanceof Element ? line : el('p', {}, line)),
      dismiss))
    outcome.scrollIntoView({ block: 'nearest' })
  }

  // Times as the operator reads them: relative first, the absolute time beside it.
  const absolute = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const relative = (iso) => {
    const ms = Date.parse(iso) - Date.now()
    const past = ms < 0, m = Math.round(Math.abs(ms) / 60000)
    const span = m < 1 ? '<1 min' : m < 60 ? m + ' min' : m < 48 * 60 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' days'
    return past ? span + ' ago' : 'in ' + span
  }
  // A relative time (the shared building block): its exact time on hover (title) and on keyboard focus.
  const ago = (iso) => el('time', { class: 'rel', datetime: iso, title: absolute(iso), 'data-exact': absolute(iso), tabindex: '0' }, relative(iso))
  // A deadline: when it expires, marked within the hour, and what no response means.
  const expires = (iso, noResponse) => el('span', { class: 'expiry ' + (Date.parse(iso) - Date.now() < 3600000 ? 'soon' : 'muted') },
    Date.parse(iso) > Date.now() ? 'Expires ' : 'Expired ', ago(iso), noResponse ? ' · No response: ' + noResponse : '')

  // Every pending decision links to the card it is decided on (an approval request's, on Home).
  let focusRequest = new URLSearchParams(location.search).get('request')
  const focusCard = (requestId) => {
    const card = document.getElementById('request-' + requestId)
    if (!card) return false
    card.scrollIntoView({ block: 'start' })
    card.focus({ preventScroll: true })
    return true
  }
  // Scroll to an element of the page and give it the focus; else to the first that matches \`fallback\`.
  const focusOn = (id, fallback) => {
    const target = document.getElementById(id) || (fallback ? document.querySelector(fallback) : null)
    if (!target) return false
    target.scrollIntoView({ block: 'start' })
    target.focus({ preventScroll: true })
    return true
  }
  // A review's card on Home (T253: in its project's group), else the first Reviews shown.
  const toReview = (taskId) => focusOn('review-' + taskId, 'main section[aria-label="Reviews"]')
  const decideLink = (requestId, text) => el('a', { href: '/ui/?request=' + encodeURIComponent(requestId), onclick: (e) => { e.preventDefault(); if (!focusCard(requestId)) openRequest(requestId) } }, text)

  const VERB = { approved: 'Approved', rejected: 'Denied' }
  const NOUN = { approved: 'approval', rejected: 'denial' }
  // Why a verdict was not applied, in plain words: each leaves its request as it was.
  const REFUSED = {
    'unknown-request': 'the queue does not know this request any more. Nothing was decided.',
    'already-resolved': 'it was already decided, withdrawn, or expired before your verdict arrived. Your verdict was not applied.',
    expired: 'it expired before your verdict arrived; an unanswered request counts as denied. Your verdict was not applied.',
    'subject-changed': 'what it asks about changed since the page showed it. Nothing was decided: read it again, then decide.',
    failed: 'the queue could not store your verdict, and nothing of it changed. Try again.',
  }

  // A request in plain words: what is asked, who asked, and what each verdict does. A request's own
  // consequences, when its requester gave them, are shown as given; otherwise the page says what
  // the board does with a verdict on its own kinds of request (docs/design/board.md).
  const describe = (r, projects) => {
    const ref = r.subject.ref
    const project = (id) => projects.get(id)
    const name = (id) => (project(id) && project(id).title) || id
    const charter = /^project:(.+):charter:(\\d+)$/.exec(ref)
    const task = /^board-task:(.+):attempt:(\\d+)$/.exec(ref)
    const call = /^agent-tool-call:([^:]+):(.+)$/.exec(ref)
    const projectText = r.requester.projectId ? ' of project ' + name(r.requester.projectId) : ''
    // A board task by its title when the board lists it, else by its id.
    const titleOf = (taskId) => { for (const p of projects.values()) { const t = (p.tasks || []).find((x) => x.taskId === taskId); if (t) return t.title } return undefined }
    const taskOf = (taskId) => titleOf(taskId) ? 'the task "' + titleOf(taskId) + '"' : 'task ' + taskId
    const Task = (taskId) => { const t = taskOf(taskId); return t.charAt(0).toUpperCase() + t.slice(1) }
    // The board task a run serves, by its run, when the board lists it.
    const runTask = (runId) => { if (!runId) return undefined; for (const p of projects.values()) { const t = (p.tasks || []).find((x) => x.run && x.run.runId === runId); if (t) return t } return undefined }
    let d
    if (r.action.class === 'charter' && charter) {
      const [, id, v] = charter
      const version = Number(v)
      const founding = r.action.summary.startsWith('Found ') || version === 1
      const p = project(id)
      const proposed = p ? p.open.proposed : undefined
      const open = p ? Object.values(p.open).reduce((a, b) => a + b, 0) : undefined
      d = founding ? {
        title: 'Found project ' + name(id) + ' (charter version 1)',
        subject: 'charter version 1 of project ' + id,
        approve: 'Project ' + name(id) + ' becomes active; ' + (proposed === undefined ? 'its proposed tasks go' : proposed + ' proposed task(s) go') + ' through the autonomy policy. No run starts by itself.',
        deny: 'Project ' + name(id) + ' is closed as abandoned, and ' + (open === undefined ? 'its open tasks are' : open + ' open task(s) are') + ' cancelled. Cannot be undone.',
        more: 'The board activates it on its next sweep, within a minute: the proposed tasks the policy allows become ready for a Worker to claim, the others are asked here.',
        yes: 'activates the project', no: 'abandons the project',
        next: 'The board activates project ' + name(id) + ' on its next sweep, within a minute: see it on the Board page.',
      } : {
        title: 'Amend the charter of project ' + name(id) + ' to version ' + version,
        subject: 'charter version ' + version + ' of project ' + id,
        approve: 'Charter version ' + version + ' replaces version ' + (version - 1) + ' of project ' + name(id) + '.',
        deny: 'The amendment is dropped: charter version ' + (version - 1) + ' stays in force.',
        yes: 'adopts charter version ' + version, no: 'keeps version ' + (version - 1),
        next: 'The board applies it on its next sweep, within a minute.',
      }
    } else if (task) {
      const [, taskId, attempt] = task
      const reason = r.subject.version || ''
      const what = r.action.summary.replace(/^(approval-needed|budget-spent|reconciliation-failed): /, '')
      const subject = taskOf(taskId) + projectText + ', attempt ' + (Number(attempt) + 1)
      d = reason.startsWith('funding') || r.action.class === 'funding' ? {
        title: 'Raise the budget of a task: ' + what.split('; ')[0], subject,
        yes: 'raises the budget', no: 'keeps the budget',
        next: 'The board applies it to ' + taskOf(taskId) + ' on its next sweep, within a minute.',
      } : reason === 'reconciliation-failed' ? {
        title: 'Go on after a failed reconciliation: ' + what, subject,
        approve: Task(taskId) + ' tries again: its next attempt goes through the autonomy policy for ' + r.action.class + '.',
        deny: Task(taskId) + ' does not go on: it waits for your input until it is cancelled or its wait expires.',
        yes: 'tries again', no: 'holds the task',
        next: 'The board applies it to ' + taskOf(taskId) + ' on its next sweep, within a minute.',
      } : {
        title: 'Allow a ' + r.action.class + ' step: ' + what, subject,
        approve: Task(taskId) + ' may do this ' + r.action.class + ' step: it becomes ready on the board\\'s next sweep (within a minute), for a Worker to claim.',
        deny: Task(taskId) + ' does not do it: it waits for your input until it is cancelled or its wait expires.',
        yes: 'allows this ' + r.action.class, no: 'holds the task',
        next: 'The board moves ' + taskOf(taskId) + ' on its next sweep, within a minute.',
      }
    } else if (call) {
      d = { title: 'Allow a tool call: ' + r.action.summary, subject: 'the exact ' + call[2] + ' call of agent run ' + call[1], yes: 'allows this call', no: 'refuses this call',
        next: 'The agent run gets your answer the next time it asks.' }
    } else if (r.action.class === 'policy-change') {
      d = { title: r.action.summary, subject: 'the policy set this change would put in force',
        approve: 'The proposed policy set comes into force at once; open requests are judged again under it.', deny: 'Nothing changes: the policy in force stays.',
        yes: 'puts the change in force', no: 'keeps the policy in force', next: 'See the Autonomy policy page.' }
    } else if (r.action.class === 'merge' && r.requester.component === 'workflow') {
      const landing = /^landing:merge:([0-9a-f]+):([0-9a-f]+)$/.exec(r.subject.version || '')
      const served = runTask(r.requester.runId)
      const what = served ? 'The accepted change of the task "' + served.title + '"' : 'The accepted change'
      // The task first, "not pushed" in sight; the branch and both heads folded (T171).
      d = { title: r.action.summary, subject: (served ? 'the accepted change of "' + served.title + '"' : 'the accepted change on its run\\'s branch') + ' · not pushed',
        approve: what + ' is merged as one merge commit. Not pushed.',
        deny: 'Not merged: the change stays on its branch; the task stays done.',
        more: ['branch ', shortId(ref, 'Copy branch'), ...(landing ? [' at ', shortId(landing[2], 'Copy commit'), ', onto the base at ', shortId(landing[1], 'Copy commit')] : []), '. The run\\'s branch is merged within a few seconds of your approval, as one merge commit; a conflict or a moved branch changes nothing.'],
        yes: 'merges the change', no: 'keeps the branch only',
        next: 'The run\\'s branch is merged within a few seconds, as one merge commit; a conflict or a moved branch changes nothing. Nothing is pushed: see the task on the Board page.' }
    } else if (r.action.class === 'dispatch' && r.requester.component === 'workflow') {
      // A start System proposes (ADR-0064): the task, its attempt, and the Worker its summary names.
      const asked = /^dispatch:(.+):attempt:(\\d+)$/.exec(ref)
      d = { title: r.action.summary, subject: 'attempt ' + (asked ? Number(asked[2]) + 1 : '?') + ' of ' + taskOf(r.requester.taskId) + projectText,
        approve: 'System starts that attempt on the Worker named, at its next look, while the task is still ready and that Worker still free.',
        deny: 'Nothing starts, and System does not ask again for this attempt; you or the lead may still start it from the Board.',
        yes: 'starts it', no: DISPATCH_DENY,
        next: 'System starts the run at its next look, within a minute, on the Worker named: see it under Runs.' }
    } else if (r.action.class === 'remediation' && r.requester.component === 'workflow') {
      d = { title: 'Run a fix: ' + r.action.summary, subject: 'plan ' + ref + ' of run ' + (r.requester.runId || '?'), yes: 'runs the fix', no: 'does not run it',
        next: 'The run goes on with your answer: see it under Runs.' }
    } else {
      d = { title: r.action.summary, subject: r.subject.type + ' ' + ref }
    }
    // Who asked, by a readable name; the run, session, step, and change ids it gave are folded with the request's (T171).
    const by = r.requester.component === 'board' ? 'the board' + (r.requester.taskId ? ', for ' + taskOf(r.requester.taskId) : '') + projectText
      : r.requester.component === 'worker' ? 'an agent run'
      : r.requester.component === 'workflow' ? (runTask(r.requester.runId) ? 'the run of the task "' + runTask(r.requester.runId).title + '"' : 'a run' + (r.requester.nodeId ? ' (' + (stepWords(r.requester.nodeId) || 'step ' + r.requester.nodeId) + ')' : ''))
      : r.requester.component === 'approvals' ? 'the approval queue, for a policy change (Show change says who proposed it)'
      : r.requester.component + projectText
    const ids = [['run', r.requester.runId], ['session', r.requester.sessionId], ['step', r.requester.nodeId], ['task', r.requester.taskId], ['policy change', r.requester.policyChangeId]].filter(([, v]) => v)
    // For which task (else project, else run) it is asked, in the card's one line (T186).
    const served = runTask(r.requester.runId)
    const forWhat = task ? taskOf(task[1]) : r.requester.taskId ? taskOf(r.requester.taskId) : served ? 'the task "' + served.title + '"'
      : charter ? 'project ' + name(charter[1]) : call ? 'an agent run' : r.requester.projectId ? 'project ' + name(r.requester.projectId) : r.requester.runId ? 'a run' : null
    // The project it is for (T253): its requester's, its charter's, its task's, or its run's task's; none for what is in no project.
    const taskHome = (taskId) => { for (const p of projects.values()) if ((p.tasks || []).some((x) => x.taskId === taskId)) return p.projectId; return undefined }
    const runHome = (runId) => { if (!runId) return undefined; for (const p of projects.values()) if ((p.tasks || []).some((x) => x.run && x.run.runId === runId)) return p.projectId; return undefined }
    const home = r.requester.projectId || (charter ? charter[1] : undefined) || (task ? taskHome(task[1]) : undefined) || (r.requester.taskId ? taskHome(r.requester.taskId) : undefined) || runHome(r.requester.runId)
    // yes and no: what approving and denying do, each button's accessible description (its label is Approve or Deny, T191).
    return Object.assign({ yes: 'lets it go ahead as shown', no: 'refuses it', next: '' }, d, { by, ids, for: forWhat, project: home })
  }

  // The approval queue, by batch: each verdict names the exact subject shown (INV-5). Absent when no queue runs.
  const notes = new Map()
  // The open requests, each as a card the operator decides in place: on the home page, and on the
  // page of what a request is about (a policy change on the policy page). Null when no queue runs;
  // {error} when it could not be read.
  async function queue() {
    let batches
    try { ({ batches } = await api('approvals')) } catch (error) { return error.status === 503 ? null : { error } }
    const requests = batches.flatMap((b) => b.requests)
    // The board's projects name what a charter or a task request is about; without a board, ids only.
    const projects = new Map()
    if (requests.some((r) => r.requester.component === 'board' || (r.requester.component === 'workflow' && (r.requester.runId || r.requester.taskId)))) {
      try { for (const p of (await api('projects')).projects) projects.set(p.projectId, p) } catch {}
    }
    const described = new Map(requests.map((r) => [r.requestId, describe(r, projects)]))
    const noteFor = (key, label) => {
      const input = el('input', { id: 'note-' + key, value: notes.get(key) || '', oninput: () => notes.set(key, input.value) })
      return el('label', { for: 'note-' + key }, label, input)
    }
    const noteOf = (key) => (notes.get(key) || '').trim()
    // One call for the verdicts shown; each result is reported, recorded or not, until dismissed.
    const decide = async (verdicts, note, batchId, buttons, clicked) => {
      const labels = buttons.map((b) => b.textContent)
      buttons.forEach((b) => { b.disabled = true })
      clicked.textContent = 'Recording…'
      const many = verdicts.length > 1
      const what = (v) => VERB[v.verdict] + ': ' + described.get(v.requestId).title
      const lost = (v) => 'your ' + NOUN[v.verdict] + ' of ' + described.get(v.requestId).title
      try {
        const { results } = await api('approvals/decide', { verdicts, ...(note ? { note } : {}), ...(batchId ? { batchId } : {}) })
        const refused = results.filter((r) => r.refused)
        const recorded = results.filter((r) => !r.refused)
        for (const v of verdicts) notes.delete(v.requestId)
        if (batchId && !refused.length) notes.delete(batchId)
        // What happens next first, each failure with why; the request and record ids folded (T171).
        const lines = results.map((r) => {
          const v = verdicts.find((x) => x.requestId === r.requestId)
          return r.refused ? 'Not recorded: ' + lost(v) + ': ' + (REFUSED[r.refused] || r.refused)
            : (many ? what(v) + ' — ' : '') + (v.verdict === 'approved' ? described.get(r.requestId).next : 'Nothing of it goes ahead.')
        })
        const ids = fold('Record IDs', results.map((r) => el('div', {}, r.refused ? ['Request ', shortId(r.requestId, 'Copy request ID'), ': not recorded (' + r.refused + ').'] : ['Recorded as your verdict on request ', shortId(r.requestId, 'Copy request ID'), ' (approval record ', shortId(r.approval, 'Copy approval ID'), ').'])))
        const word = VERB[verdicts[0].verdict].toLowerCase()
        report(!refused.length, refused.length ? (many ? recorded.length + ' ' + word + ' · ' + refused.length + ' not recorded' : 'Not recorded: ' + lost(verdicts[0]))
          : many ? recorded.length + ' ' + word : what(verdicts[0]), lines.concat([ids]))
      } catch (error) {
        report(false, 'Not recorded: ' + (many ? 'your ' + verdicts.length + ' verdicts' : lost(verdicts[0])),
          ['The server refused the call (' + (error.status || 'no answer') + '): ' + error.message + '.', 'Nothing was decided: ' + (many ? 'the requests are' : 'the request is') + ' still open in the queue.'])
      }
      buttons.forEach((b, i) => { b.disabled = false; b.textContent = labels[i] })
      await refresh()
    }
    const card = (r) => {
      const d = described.get(r.requestId)
      // Approve / Deny, what each does its accessible description (T191); the card is named by its title.
      const [yes, yesDoes] = decision('Approve', d.yes, { class: 'primary' })
      const [no, noDoes] = decision('Deny', d.no)
      const verdict = (v, clicked) => () => decide([{ requestId: r.requestId, subject: r.subject, verdict: v, ...(noteOf(r.requestId) ? { note: noteOf(r.requestId) } : {}) }], undefined, undefined, [yes, no], clicked)
      yes.addEventListener('click', verdict('approved', yes))
      no.addEventListener('click', verdict('rejected', no))
      // A policy change shows what it changes: its effective modes and the record's diff (INV-5: the subject is its set's hash).
      const shown = el('div', {})
      const showChange = async () => {
        try {
          const { changes } = await api('policy')
          const change = (changes || []).find((c) => c.requestId === r.requestId)
          shown.replaceChildren(change ? changeView(change) : el('p', { class: 'muted' }, 'The change of ' + r.requestId + ' is not among the latest.'))
        } catch (error) { shown.replaceChildren(el('p', { class: 'state failed' }, 'The change could not be read: ' + error.message)) }
      }
      // An irreversible consequence stays in sight, as a chip on the line (T172: never folded).
      const undone = (text) => /Cannot be undone/.test(text || '')
      const irreversible = undone(d.deny) ? 'Deny cannot be undone' : undone(d.approve) ? 'Approve cannot be undone' : undone(r.action.consequences) ? 'Cannot be undone' : null
      // Its title and, as its one chip, an irreversible verdict; one line of context, when it expires; then the two buttons
      // (T239); every other fact (for which task, who asked, what it is about, its exact subject, what each verdict and no
      // response do, how it works, the ids) under one closed Details (T186).
      return el('article', { class: 'panel request', id: 'request-' + r.requestId, tabindex: '-1', 'aria-labelledby': 'title-' + r.requestId },
        el('div', { class: 'line' }, el('h3', { id: 'title-' + r.requestId }, d.title), irreversible ? chip(irreversible, 'warn') : null),
        el('p', { class: 'meta' }, expires(r.expiresAt)),
        // A policy change's own diff stays one press away, beside the verdict buttons: never folded away (T186).
        // Show change has the policy page's wording, what it does its accessible description, as each verdict's (T191).
        el('div', { class: 'actions' }, yes, yesDoes, no, noDoes,
          r.action.class === 'policy-change' && r.requester.policyChangeId ? decision('Show change', 'shows what this request changes, below; decides nothing', { onclick: showChange, 'aria-label': 'Show the change of ' + r.requestId }) : null),
        shown,
        cardFold('request-' + r.requestId,
          el('p', {}, 'Asked by ' + d.by + ' · ', el('span', { class: 'tag' }, r.action.class), whatIs(r.action.class === 'policy-change' ? 'policy-change' : r.action.class === 'merge' ? 'merge' : 'action-class')),
          el('dl', {},
            d.for ? [el('dt', {}, 'For'), el('dd', {}, d.for)] : null,
            el('dt', {}, 'No response'), el('dd', {}, 'denied'),
            d.title === r.action.summary ? null : [el('dt', {}, 'Request'), el('dd', {}, folded(r.action.summary, 'details'))],
            el('dt', {}, 'About'), el('dd', {}, d.subject),
            el('dt', {}, 'Exact subject'), el('dd', {}, el('code', { class: 'subject' }, subjectText(r.subject)), copyId('Copy subject', subjectText(r.subject))),
            // A merge says what each verdict does in words first; the requester's own text, with its paths and hashes, after it (T141).
            r.action.consequences && d.approve && r.action.class === 'merge' ? [el('dt', {}, 'If you approve'), el('dd', {}, d.approve), el('dt', {}, 'If you deny'), el('dd', {}, d.deny),
              el('dt', {}, 'In detail'), el('dd', {}, el('details', {}, el('summary', {}, 'what the system will do, exactly'), el('code', { class: 'exact' }, r.action.consequences)))]
              : r.action.consequences ? [el('dt', {}, 'What a verdict does'), el('dd', {}, folded(r.action.consequences, 'details'))]
              : d.approve ? [el('dt', {}, 'If you approve'), el('dd', {}, d.approve), el('dt', {}, 'If you deny'), el('dd', {}, d.deny)]
              : [el('dt', {}, 'What a verdict does'), el('dd', { class: 'muted' }, 'The requester did not say. Approving lets it go ahead with exactly what is shown; denying refuses it.')],
            r.action.recommendation ? [el('dt', {}, 'Recommended'), el('dd', {}, r.action.recommendation === 'approve' ? 'approve' : 'deny')] : null,
            d.more ? [el('dt', {}, 'How it works'), el('dd', {}, d.more)] : null),
          el('div', { class: 'actions' }, noteFor(r.requestId, 'Note (optional)')),
          el('div', { class: 'muted' }, 'request ', shortId(r.requestId, 'Copy request ID')), el('div', { class: 'muted' }, 'expires ' + absolute(r.expiresAt)),
          d.ids.map(([k, v]) => el('div', { class: 'muted' }, k + ' ' + v))))
    }
    return { batches, requests, described, projects, card, decide, noteFor, noteOf }
  }

  // The approval queue's cards: every batch, or, on Home, a project's (T253: a batch stays whole, in its first request's
  // project). Its section is named by its heading level: a page's own section (h2), or a kind within a project's group (h3).
  async function approvals(q, shown, id = 'approvals', level = 'h2') {
    if (!q) return null
    if (q.error) return el('section', { id, tabindex: '-1', 'aria-label': 'Approval queue' }, el(level, {}, 'Approvals'),
      el('p', { class: 'state failed' }, 'The approval queue could not be read: ' + q.error.message + '. Approvals unknown; retrying every 5 s.'))
    const { card, decide, noteFor, noteOf } = q
    const batches = shown || q.batches
    const requests = batches.flatMap((b) => b.requests)
    const earliest = requests.reduce((min, r) => !min || r.expiresAt < min ? r.expiresAt : min, undefined)
    // Its count is Home's tile; its next expiry, the first card's, or in sight when within the hour (T239).
    return el('section', { id, tabindex: '-1', 'aria-label': 'Approval queue' }, el(level, { class: 'kind' }, 'Approvals', whatIs('approval')),
      !requests.length ? el('p', { class: 'muted' }, 'No approvals needed.')
        : Date.parse(earliest) - Date.now() < 3600000 ? el('p', { class: 'soon' }, 'Next expiry ' + relative(earliest)) : null,
      batches.map((batch) => {
        if (!batch.batchId) return el('div', {}, batches.length > 1 ? el('h3', {}, 'Decided one by one') : null, batch.requests.map((r) => card(r)))
        const [yes, yesDoes] = decision('Approve all ' + batch.requests.length, 'approves each request below as shown', { class: 'primary' })
        const [no, noDoes] = decision('Deny all ' + batch.requests.length, 'denies each request below')
        const all = (v, clicked) => () => decide(batch.requests.map((r) => ({ requestId: r.requestId, subject: r.subject, verdict: v, ...(noteOf(r.requestId) ? { note: noteOf(r.requestId) } : {}) })), noteOf(batch.batchId), batch.batchId, [yes, no], clicked)
        yes.addEventListener('click', all('approved', yes))
        no.addEventListener('click', all('rejected', no))
        // The batch's two buttons in sight; its note for all and its id under its one Details (T239).
        return el('section', { class: 'panel', 'aria-label': 'Batch ' + batch.batchId },
          el('h3', {}, qtyView(batch.requests.length, 'related request'), whatIs('batch')),
          el('div', { class: 'actions' }, yes, yesDoes, no, noDoes),
          cardFold('batch-' + batch.batchId, el('div', { class: 'batch-actions' }, noteFor(batch.batchId, 'Note for all (optional)')),
            el('div', { class: 'muted' }, 'batch ', shortId(batch.batchId, 'Copy batch ID'))),
          batch.requests.map((r) => card(r)))
      }))
  }

  // The board's tasks in review, one card each: the operator's Accept or Send back names the exact
  // result shown (INV-5). Absent when no board runs.
  // Where an accepted result stands on its way into the repository (ADR-0060), in words, each pending step linked to where it is decided.
  const landingLine = (l) => l.state === 'asked' && l.requestId ? el('div', {}, 'Accepted — waiting to merge into ' + (l.base || 'its base') + ': ', decideLink(l.requestId, 'approve'))
    : l.state === 'merged' ? el('div', {}, 'Accepted and merged into ' + (l.base || 'its base') + (l.commit ? ' as ' : ''), l.commit ? shortId(l.commit, 'Copy commit') : null, el('span', { class: 'muted' }, ' · not pushed'))
      : l.state === 'refused' ? el('div', {}, 'Accepted — not merged: ' + (l.reason || 'refused'))
        : l.state === 'rejected' ? el('div', {}, 'Accepted — the merge was not approved; ' + (l.branch || 'its branch') + ' keeps the commit')
          : l.state === 'committed' ? el('div', {}, 'Accepted and committed on ' + (l.branch || 'its run\\'s branch') + (l.head ? ' as ' : ''), l.head ? shortId(l.head, 'Copy commit') : null, '; its merge request comes next')
            : l.state === 'merging' ? el('div', {}, 'Accepted — merging into ' + (l.base || 'its base') + ' now')
              // ADR-0068: the base moved since the result's work started, so it is made again on top of it and checked again first.
              : l.state === 'rebase' ? el('div', {}, 'Accepted — ' + (l.base || 'its base') + ' moved on: rebasing onto it before the merge is asked')
                : l.state === 'resolving' ? el('div', {}, 'Accepted — its rebase onto ' + (l.base || 'its base') + ' conflicts; its Worker is resolving it')
                  : l.state === 'recheck' ? el('div', {}, 'Accepted and rebased onto ' + (l.base || 'its base') + '; its required checks run again')
                    : l.state === 'returning' || l.state === 'returned' ?el('div', {}, 'Accepted, but it cannot land on ' + (l.base || 'its base') + ' as it is now: sent back as another attempt' + (l.reason ? ' — ' + l.reason : ''))
                      : el('div', {}, 'Accepted — being committed on ' + (l.branch || 'its run\\'s branch') + ' to be merged')

  // Where a task's run started its work (ADR-0061), in words: from the change its previous attempt left, or over from the code.
  const carryLine = (c) => {
    const from = c.from ? 'attempt ' + c.from.attempt : 'the previous attempt'
    const link = c.from ? [' (', runLink({ runId: c.from.runId }, 'its run'), ')'] : []
    // The outcome in a line; the worktree and commit mechanics folded (T171).
    return c.state === 'carried' ? el('li', {}, 'Continued from ' + from, link, whatIs('carry'),
      fold('Details', 'That change was already in its worktree' + (c.commit ? ', saved as ' : ''), c.commit ? shortId(c.commit, 'Copy commit') : null, '; its writing step built on it instead of starting over.'))
      : c.state === 'due' ? el('li', {}, 'Continues from ' + from, link, ' · before its first step', whatIs('carry'))
        : el('li', {}, 'Started over' + (c.reason ? ' — ' + c.reason.replace(/\\.$/, '') : ''), link, whatIs('carry'),
          fold('Details', c.from ? 'The work ' + from + ' left was not reused: it started from the code.' : 'It started from the code.'))
  }

  // What the operator reads before a review verdict (T122): the run's change, each reviewer's
  // verdict, and the run's report, read once per run and result (runs/<id>/review). A read that
  // failed is kept too, so the 5-second refresh never reads it again: the operator asks for it
  // again (readAgain), or the result changes.
  const evidenceCache = new Map()
  const reviewOf = async (runId, key) => {
    const kept = evidenceCache.get(runId)
    if (kept && kept.key === key) return kept.value
    let value
    try { value = await api('runs/' + encodeURIComponent(runId) + '/review') } catch (error) { value = { error, runId } }
    if (evidenceCache.size > 50) evidenceCache.clear()
    evidenceCache.set(runId, { key, value })
    return value
  }
  const readAgain = (runId) => {
    const button = el('button', {}, 'Read it again')
    button.addEventListener('click', async () => { button.disabled = true; evidenceCache.delete(runId); await refresh() })
    return button
  }
  const SHOWN_LINES = 200
  // One file's diff as text, each line marked by what it is; a long one shows its first lines and a "show all".
  const diffLines = (text) => {
    const lines = text.split('\\n')
    const line = (l) => el('span', l.startsWith('+') && !l.startsWith('+++') ? { class: 'add' } : l.startsWith('-') && !l.startsWith('---') ? { class: 'del' } : l.startsWith('@@') ? { class: 'hunk' } : {}, l + '\\n')
    const pre = el('pre', { class: 'diff file' }, lines.slice(0, SHOWN_LINES).map(line))
    if (lines.length <= SHOWN_LINES) return pre
    const all = el('button', {}, 'Show all ' + lines.length + ' lines')
    all.addEventListener('click', () => { pre.replaceChildren(...lines.map(line)); all.remove() })
    return el('div', {}, pre, all)
  }
  const STATUS_WORD = { added: 'added', modified: 'changed', deleted: 'deleted', renamed: 'renamed' }
  const workChangeView = (change, runId) => {
    if (!('value' in change)) return el('p', { class: 'unknown' }, 'What changed is unknown (' + change.unknown + '). Do not accept what you could not see. ', readAgain(runId))
    const { changes, unread } = change.value
    return el('div', { class: 'change' },
      unread.map((u) => el('p', { class: 'state failed', role: 'alert' }, 'The change in source ' + u.source + ' could not be read: ' + u.detail + '. Do not accept what you could not see. ', readAgain(runId))),
      !changes.length && !unread.length ? el('p', { class: 'muted' }, 'No worktree of this run holds a change: it wrote no file in one.') : null,
      changes.map((c) => {
        const count = (k) => c.files.reduce((n, f) => n + (f[k] || 0), 0)
        const total = c.files.length + c.more
        return el('div', { role: 'group', 'aria-label': 'Change on ' + c.branch },
          el('p', { class: 'stat' }, el('strong', {}, total + (total === 1 ? ' file' : ' files') + ' changed'), ' ', el('span', { class: 'add' }, '+' + count('added')), ' ', el('span', { class: 'del' }, '−' + count('removed')),
            el('span', { class: 'muted' }, ' · on ', shortId(c.branch, 'Copy branch'), ', against ' + c.base.branch + ' at ', shortId(c.base.sha, 'Copy commit'), c.fromBranch ? ' (its worktree was removed: what its branch holds)' : '')),
          el('ul', { class: 'files' }, c.files.map((f) => el('li', {}, el('details', {},
            el('summary', {}, shortId(f.path, 'Copy path'), ' ' + STATUS_WORD[f.status] + ' ', f.from ? ['from ', shortId(f.from, 'Copy path'), ' '] : null, f.binary || f.note ? el('span', { class: 'muted' }, f.binary ? 'binary' : f.note)
              : f.added === undefined ? el('span', { class: 'muted' }, 'not read') : [el('span', { class: 'add' }, '+' + f.added), ' ', el('span', { class: 'del' }, '−' + (f.removed || 0))]),
            f.diff !== undefined ? diffLines(f.diff) : el('p', { class: 'muted' }, f.binary ? 'A binary file: its content is not shown.' : f.note ? 'Not shown: ' + f.note + '.' : ['Not shown: the change is past what a page shows; read it in ', shortId(c.workspace, 'Copy path'), '.']),
            f.truncated ? el('p', { class: 'muted' }, 'Cut: read the whole file in ', shortId(c.workspace, 'Copy path'), '.') : null)))),
          c.more ? el('p', { class: 'muted' }, c.more + ' more file(s) are not listed: read them in ', shortId(c.workspace, 'Copy path'), '.') : null)
      }))
  }
  // A finding's severity rank (ADR-0075): important first, then pre-existing, then nits; an assessment@1.0's severities read alike.
  const SEVERITY_RANK = { important: 0, blocking: 0, 'pre-existing': 1, nit: 2, warning: 2, info: 2 }
  const findingBlocks = (f) => !f.repeated && (f.severity === 'blocking' || (f.severity === 'important' && !!f.verification && f.verification.vote === 'confirm'))
  const bySeverity = (fs) => fs.map((f, i) => [f, i]).sort((a, b) => (Number(!!a[0].repeated) - Number(!!b[0].repeated)) || ((SEVERITY_RANK[a[0].severity] ?? 3) - (SEVERITY_RANK[b[0].severity] ?? 3)) || (Number(!findingBlocks(a[0])) - Number(!findingBlocks(b[0]))) || a[1] - b[1]).map((p) => p[0])
  const VOTE_WORD = { confirm: 'confirmed', reject: 'rejected', none: 'unverified' }
  const findingView = (f) => el('li', { class: findingBlocks(f) ? 'state failed' : '' }, el('span', { class: 'tag' }, f.severity),
    ' ' + f.title, f.file ? [' (', shortId(f.file, 'Copy path'), f.line ? ':' + f.line : '', ')'] : null, f.class ? ' [class: ' + f.class + ']' : null,
    f.verification ? [' ', el('span', { class: 'tag', title: 'the second reviewer\\'s vote, by ' + f.verification.node }, VOTE_WORD[f.verification.vote] || f.verification.vote)] : null,
    f.repeated ? el('span', { class: 'muted' }, ' repeats ' + f.repeated + ', already answered: not counted') : null,
    f.demoted ? el('span', { class: 'muted' }, ' (read as a nit: no evidence given)') : null,
    f.evidence ? el('div', { class: 'muted' }, 'Evidence: ' + f.evidence) : null,
    f.verification && f.verification.reason ? el('div', { class: 'muted' }, 'Vote: ' + f.verification.reason) : null,
    f.detail ? el('div', { class: 'muted' }, f.detail) : null)
  // Each reviewer's verdict on the exact change, newest first, with its summary and its findings by severity and their votes; how many more there are.
  const verdictsView = (assessments) => !('value' in assessments) ? el('p', { class: 'unknown' }, 'The reviewers\\' verdicts are unknown (' + assessments.unknown + ').')
    : !assessments.value.length ? el('p', { class: 'muted' }, 'No reviewer gave a verdict on this change. When a review step of the run reads it, its verdict appears here.')
      : el('div', {}, el('ul', { class: 'verdicts' }, assessments.value.map((a) => el('li', {},
        el('strong', { class: a.verdict === 'approve' ? 'state completed' : 'state failed' }, a.verdict === 'approve' ? 'Approved' : 'Changes requested'), ' by the review at ' + (a.nodeId || 'a step') + (a.reviewer ? ' (' + a.reviewer + ')' : ''),
        a.summary ? el('div', { class: 'muted' }, a.summary) : null,
        a.findings.length ? el('ul', {}, bySeverity(a.findings).map(findingView)) : el('span', { class: 'muted' }, '; no finding')))),
        assessments.more ? el('p', { class: 'muted' }, 'The newest ' + assessments.value.length + ' verdicts are shown; ' + assessments.more + (assessments.moreAtLeast ? ' or more' : '') + ' older ' + (assessments.more === 1 && !assessments.moreAtLeast ? 'one is' : 'ones are') + ' not.') : null)
  // The run's report in its own words: a line that says a criterion was not met or not measured is marked, the words stay the step's.
  const reportView = (report) => el('div', {},
    el('p', { class: 'muted' }, 'The run\\'s last step, ' + report.nodeId + ', reported this, in its own words:'),
    el('pre', { class: 'report' }, report.text.split('\\n').map((l) => el('span', /\\b(not met|failed|not run)\\b/i.test(l) ? { class: 'state failed' } : /\\bnot measured\\b/i.test(l) ? { class: 'soon' } : /\\bmet\\b/i.test(l) ? { class: 'state completed' } : {}, l + '\\n'))),
    report.truncated ? el('p', { class: 'muted' }, 'Cut at 32,000 characters: the whole report is the run\\'s answer.') : null)
  // On a run's page the report is its answer, already shown: \`report\` false leaves it out.
  const evidenceView = (review, report = true) => review.error ? el('p', { class: 'state failed' }, 'What the run changed and what its steps said could not be read: ' + review.error.message + '. Do not accept what you could not see. ', readAgain(review.runId))
    : el('div', { class: 'evidence' },
      el('h4', {}, 'What changed'), workChangeView(review.change, review.runId),
      el('h4', {}, 'What the reviewers said'), verdictsView(review.assessments),
      review.report && report ? [el('h4', {}, 'What the checks measured'), reportView(review.report)] : null)

  // Each check the policy requires of a review, with its state as the run recorded it (ADR-0063, T160): passed or
  // failed (with its exit code) only on a record, not run and why, or pending; never "passed" without a record. Then
  // the checks the board holds pending, next to the verdict, in warning color: those recorded as failed apart from those not run.
  // Its state as a chip (T172), then the exit code a record gives, or why it has none.
  const CHECK_STATE = { passed: ['Passed', 'ok'], failed: ['Failed', 'bad'], 'not-run': ['Not run', 'warn'], pending: ['Pending', 'warn'] }
  // A pass whose command reported tests it did not run (T247) is never a plain pass: it says so in warning color (T255).
  const stateChip = (c) => c.state === 'passed' && c.notRun ? chip('Passed, browser tests not run', 'warn') : chip(...(CHECK_STATE[c.state] || [c.state, 'idle']))
  const checkLine = (c) => [stateChip(c),
    c.state === 'passed' || c.state === 'failed' ? (c.exitCode !== undefined ? ' · exit code ' + c.exitCode : '') + (c.notRun ? ' — ' + c.notRun + ' did not run' : '') : ' — ' + c.why]
  // The checks that passed without their browser tests: the board's auto-accept rule held the result for them (T255).
  const unrunWarning = (r) => {
    const unrun = (r.checks ? r.checks.value : []).filter((c) => c.state === 'passed' && c.notRun)
    if (!unrun.length) return null
    return el('p', { class: 'unrun-tests', role: 'note' },
      el('strong', {}, 'Checks passed, browser tests not run: ' + unrun.map((c) => c.check + ' (' + c.notRun + ' did not run)').join(', ') + '. '),
      'Their pass says nothing of those tests, so the result was not accepted automatically — run them where a browser is, or accept knowing they did not run.', whatIs('checks'))
  }
  // The warning is derived from the recorded states: a pending check the run recorded as failed is said to have failed, not
  // to be not run (T160 review).
  const pendingWarning = (r) => {
    if (!r.pendingChecks.length) return null
    const failed = r.pendingChecks.filter((c) => (r.checks ? r.checks.value : []).some((s) => s.check === c && s.state === 'failed'))
    const notRun = r.pendingChecks.filter((c) => !failed.includes(c))
    return el('p', { class: 'pending-checks', role: 'note' },
      failed.length ? el('strong', {}, 'Checks that failed: ' + failed.join(', ') + '. ') : null,
      notRun.length ? el('strong', {}, 'Checks not run: ' + notRun.join(', ') + '. ') : null,
      'Accepting counts them as passed — ' + (failed.length ? (notRun.length ? 'fix the failed ones and run the others first.' : 'fix them first.') : 'run them first.'), whatIs('checks'))
  }
  // A review card's first row (T186): the change in numbers, each required check as a chip, each reviewer's verdict as a chip.
  const changeSummary = (change) => {
    if (!('value' in change)) return chip('Change unknown', 'bad')
    const { changes, unread } = change.value
    if (!changes.length) return unread.length ? chip('Change unread', 'bad') : chip('No file changed', 'idle')
    const files = changes.reduce((n, c) => n + c.files.length + c.more, 0)
    const sum = (k) => changes.reduce((n, c) => n + c.files.reduce((m, f) => m + (f[k] || 0), 0), 0)
    return [el('span', { class: 'change-stat', 'aria-label': 'Change summary' }, qty(files, 'file') + ' ', el('span', { class: 'add' }, '+' + sum('added')), ' ', el('span', { class: 'del' }, '−' + sum('removed'))),
      unread.length ? chip('Partly unread', 'bad') : null]
  }
  // A change that could not be read whole stays in sight: never accepted unseen.
  const changeWarning = (change, runId) => 'value' in change && !change.value.unread.length ? null
    : el('p', { class: 'state failed' }, 'What changed could not be read whole. Do not accept what you could not see. ', runId ? readAgain(runId) : null)
  const checkChips = (r) => !r.checks ? null : [
    r.checks.value.length ? el('ul', { class: 'chips', 'aria-label': 'Required checks' }, r.checks.value.map((c) => el('li', {}, el('strong', {}, c.check + ': '), stateChip(c),
      (c.state === 'passed' || c.state === 'failed') && c.exitCode !== undefined ? ' · exit code ' + c.exitCode : ''))) : null,
    r.checks.requiredUnknown ? chip('Required checks unknown', 'warn') : null]
  const verdictChips = (assessments) => !('value' in assessments) ? chip('Verdicts unknown', 'idle')
    : !assessments.value.length ? chip('No reviewer verdict', 'idle')
      : el('ul', { class: 'chips', 'aria-label': 'Reviewers\\' verdicts' }, assessments.value.map((a) => el('li', {},
        chip((a.verdict === 'approve' ? 'Approved' : 'Changes requested') + ' · ' + (a.reviewer || a.nodeId || 'a reviewer'), a.verdict === 'approve' ? 'ok' : 'bad'))),
        assessments.more ? el('li', { class: 'muted' }, '+' + assessments.more + (assessments.moreAtLeast ? ' or more' : '') + ' older') : null)
  // Each required check in full, under the card's Details: its state, and its exit code or why it has none.
  const checksDetail = (r) => {
    if (!r.checks) return el('p', { class: 'muted' }, r.pendingChecks.length ? 'Pending on the board: ' + r.pendingChecks.join(', ') + '; what the checks came to is not known here.' : 'No check is pending on the board; what the checks came to is not known here.')
    const list = r.checks.value
    return el('div', { class: 'checks' },
      list.length ? el('ul', { class: 'checks', 'aria-label': 'Each required check' }, list.map((c) => el('li', {}, el('strong', {}, c.check + ': '), checkLine(c))))
        : el('p', { class: 'muted' }, 'The policy requires no check of this kind of work.'),
      r.checks.requiredUnknown ? el('p', { class: 'unknown' }, 'Which checks the policy requires is unknown (' + r.checks.requiredUnknown + '): those listed are the ones the board holds pending.') : null)
  }

  async function reviews() {
    let listed, accepted
    try { ({ reviews: listed, accepted } = await api('reviews')) } catch (error) {
      return error.status === 503 ? null : { failed: el('section', { id: 'reviews', tabindex: '-1', 'aria-label': 'Reviews' }, el('h2', {}, 'Reviews'), el('p', { class: 'state failed' }, 'The reviews could not be read: ' + error.message + '. The page tries again every 5 seconds.')) }
    }
    const decide = (r, verdict, buttons, clicked) => async () => {
      const labels = buttons.map((b) => b.textContent)
      buttons.forEach((b) => { b.disabled = true })
      clicked.textContent = 'Recording…'
      const key = 'review-' + r.taskId
      try {
        const { task, decision } = await api('reviews/' + encodeURIComponent(r.taskId) + '/decide', { verdict, subject: r.subject, note: (notes.get(key) || '').trim() })
        notes.delete(key)
        report(true, (verdict === 'accept' ? 'Accepted: ' : 'Sent back: ') + r.title, ['Recorded as your acceptance decision ' + decision + '. The task is now ' + task.state + (verdict === 'accept' ? '; tasks that depend on it become ready on the board\\'s next sweep. When its result is a run\\'s worktree, the system commits it on the run\\'s branch and asks you here to merge it: see it under Accepted, on their way in.' : '; it goes back for another attempt if it has one left.')])
      } catch (error) {
        report(false, 'Not recorded: ' + (verdict === 'accept' ? 'Accept' : 'Send back') + ' on ' + r.title, ['The server refused it (' + (error.status || 'no answer') + '): ' + error.message + '. Nothing was decided: the task is still in review.'])
      }
      buttons.forEach((b, i) => { b.disabled = false; b.textContent = labels[i] })
      await refresh()
    }
    const card = (r, evidence) => {
      // Accept / Send back, what each does its accessible description (T191); the card is named by its title.
      const [yes, yesDoes] = decision('Accept', 'marks it done', { class: 'primary' })
      const [no, noDoes] = decision('Send back', 'sends it back for another attempt, if it has one left')
      yes.addEventListener('click', decide(r, 'accept', [yes, no], yes))
      no.addEventListener('click', decide(r, 'reject', [yes, no], no))
      const key = 'review-' + r.taskId
      const input = el('input', { id: 'note-' + key, value: notes.get(key) || '', oninput: () => notes.set(key, input.value) })
      const evidenceRead = evidence && !evidence.error
      // The title; one line of context, when it expires (its project is its group's heading on Home, T256, and under its
      // Details); then the change, the checks, and each reviewer's verdict as chips; the warnings that bear on the verdict;
      // the two buttons; every long text, and what no response does, under one Details (T186, T239).
      return el('article', { class: 'panel request', id: 'review-' + r.taskId, tabindex: '-1', 'aria-labelledby': 'review-title-' + r.taskId },
        el('div', { class: 'line' }, el('h3', { id: 'review-title-' + r.taskId }, r.title)),
        el('p', { class: 'meta' }, !r.expiresAt ? 'No expiry known' : r.heldFor === 'operator' ? expires(r.expiresAt) : ['Its reviewer\\'s until ', ago(r.expiresAt)]),
        el('div', { class: 'summary' }, evidenceRead ? changeSummary(evidence.change) : null, checkChips(r), evidenceRead ? verdictChips(evidence.assessments) : null),
        evidence && evidence.error ? evidenceView(evidence) : null,
        evidenceRead ? changeWarning(evidence.change, r.run && r.run.runId) : null,
        pendingWarning(r),
        unrunWarning(r),
        el('div', { class: 'actions' }, yes, yesDoes, no, noDoes),
        cardFold(key,
          r.goal ? el('p', {}, el('strong', {}, 'Asked: '), r.goal) : null,
          el('p', {}, el('span', { class: 'tag' }, r.actionClass), ' project ' + (r.project.title || r.project.projectId) + ' · task ', shortId(r.taskId, 'Copy task ID'), r.expiresAt ? ' · expires ' + absolute(r.expiresAt) : '',
            r.heldFor === 'operator' && r.expiresAt ? ' · No response: it waits for input' : ''),
          el('p', {}, r.run ? el('a', { href: '?run=' + encodeURIComponent(r.run.runId), onclick: (e) => { e.preventDefault(); go(r.run.runId) } }, 'open the run that made it') : 'no run is named'),
          el('dl', {}, el('dt', {}, 'Exact result'), el('dd', {}, el('div', {}, el('code', { class: 'subject' }, subjectText(r.subject)), copyId('Copy result', subjectText(r.subject))), r.artifacts.map((a) => el('div', {}, shortId(a, 'Copy artifact ID'))))),
          el('h4', {}, 'Required checks'), checksDetail(r),
          evidenceRead ? evidenceView(evidence) : null,
          el('div', { class: 'actions' }, el('label', { for: 'note-' + key }, 'Note with your verdict (optional)', input))))
    }
    // Every card once, its evidence read; Home places each in its project's group (T253).
    const cards = new Map(await Promise.all(listed.map(async (r) => [r.taskId, card(r, r.run ? await reviewOf(r.run.runId, subjectText(r.subject)) : undefined)])))
    // A review held for the operator expires unseen, and its task then waits for input that nothing revives: say when the first does.
    const heldOf = (list) => list.filter((r) => r.heldFor === 'operator' && r.expiresAt)
    // A verdict's consequence stays in sight: each accepted result still on its way into the repository, its project named
    // unless its group's heading or the page's filter already names it (T256).
    const acceptedView = (list, level) => list && list.length ? el('section', { 'aria-label': 'Accepted, on their way in' }, el(level, { class: 'kind' }, 'Accepted, on their way in', whatIs('landing')),
      list.map((a) => el('article', { class: 'panel request', 'aria-label': 'Accepted: ' + a.title }, el('h4', {}, a.title),
        el('p', { class: 'meta' }, level !== 'h4' && !homeProject ? 'Project ' + (a.project.title || a.project.projectId) + ' · task ' : 'Task ', shortId(a.taskId, 'Copy task ID')), landingLine(a.landing),
        a.run ? el('p', {}, el('a', { href: '?run=' + encodeURIComponent(a.run.runId), onclick: (e) => { e.preventDefault(); go(a.run.runId) } }, 'open its run')) : null))) : null
    // The Reviews of some of the listed reviews (all of them by default): a page's own section (h2), or a kind within a project's group (h3).
    const sectionOf = (list = listed, id = 'reviews', level = 'h2', withAccepted = true) => {
      const mine = heldOf(list)
      const first = mine.reduce((min, r) => !min || r.expiresAt < min ? r.expiresAt : min, undefined)
      const section = el('section', { id, tabindex: '-1', 'aria-label': 'Reviews' }, el(level, { class: 'kind' }, 'Reviews', whatIs('review')),
        // When the first held for the operator expires, and what then: in sight within the hour, else folded (T239).
        first ? (() => {
          const said = [mine.length + (mine.length === 1 ? ' review is' : ' reviews are') + ' held for you; the first expires ',
            el('span', { class: Date.parse(first) - Date.now() < 3600000 ? 'soon' : '' }, relative(first) + ' — ' + absolute(first)), '. Unanswered by then, its task waits for input, which nothing revives.']
          return Date.parse(first) - Date.now() < 3600000 ? el('p', {}, said) : keptFold(id + '-expiry', 'When they expire', said)
        })() : null,
        list.length ? list.map((r) => cards.get(r.taskId)) : el('p', { class: 'muted' }, 'No review waits. When a Worker finishes a task, its result waits here for you to accept it or send it back.'),
        withAccepted ? acceptedView(accepted, level === 'h2' ? 'h3' : 'h4') : null)
      if (first) section.dataset.firstExpires = first
      section.dataset.count = String(list.length)
      return section
    }
    // Home's "Needs your attention" names each review held for the operator.
    return { listed, accepted: accepted || [], held: heldOf(listed), sectionOf, acceptedView }
  }

  // A run's progress in one line: "2/3 steps", then the steps that failed, wait, or run, by name.
  const stepsText = (run) => {
    const named = (state) => run.nodes.filter((n) => n.state === state).map((n) => stepWords(n.nodeId) || n.nodeId)
    const list = (ids) => ids.slice(0, 2).join(', ') + (ids.length > 2 ? ' and ' + (ids.length - 2) + ' more' : '')
    const done = named('COMPLETED').length
    const parts = [done + '/' + run.nodes.length + ' steps']
    for (const [state, word] of [['FAILED', 'failed'], ['BLOCKED', 'waiting'], ['RUNNING', 'running']]) if (named(state).length) parts.push(word + ': ' + list(named(state)))
    return parts.join(' · ')
  }
  // A run's state as a chip: Running, Completed, Failed, or Needs your attention (T171's one wording per concept).
  const RUN_STATE = { running: ['Running', 'info'], completed: ['Completed', 'ok'], failed: ['Failed', 'bad'] }
  const runChip = (run) => run.blocked ? chip('Needs your attention', 'warn') : chip(...(RUN_STATE[run.status] || [run.status, 'idle']))
  // What a failure asks of the operator, in words.
  const DISPOSITION = { USER_ACTION: 'it needs you', BACKOFF: 'it is tried again later', CODE_FIX: 'it needs a fix in the code or configuration', NONE: 'nothing more happens' }
  // What a failure's kind means, in words, before the system's own message (T141).
  const KIND_WORDS = {
    reauth_required: 'its account must sign in again', quota_exhausted: 'its account used up its quota', overloaded: 'the site was busy, or answered with its own error',
    timeout: 'it took longer than its limit', session_broken: 'its conversation broke off', provider_stalled: 'its Worker stopped answering', network: 'the network failed',
    challenge: 'the site asked for a human check', config_error: 'something is set up wrong', no_worker: 'no Worker could take it', stopped: 'you stopped it',
    plan_rejected: 'its plan was denied', budget_spent: 'its budget is spent', holder_lost: 'it lost its hold on the task', internal: 'the system failed inside',
  }
  // A failure's reason in plain words, from its kind and its disposition: the one function the run page and Home's
  // "Since you last looked" both lead with (T160); null when neither is known.
  const failureReason = (error) => {
    const kind = KIND_WORDS[error.kind]
    const next = DISPOSITION[error.disposition]
    return kind ? kind + (next ? ' (' + next + ')' : '') : next || null
  }
  // On the run page: the same plain-words reason (failureReason, T160), then the system's own message.
  const failureText = (error) => { const reason = failureReason(error); return reason ? reason + ' — ' + error.message : error.message }
  // A step's id as a person reads it: a team's steps by member ("member 1's answer"), the id beside it.
  const stepWords = (nodeId) => {
    const m = /^(.+):m(\\d+):(propose|ballot:\\d+)$/.exec(nodeId)
    if (m) return 'team member ' + m[2] + (m[3] === 'propose' ? '\\'s answer' : '\\'s vote')
    const t = /^(.+):tally:\\d+$/.exec(nodeId)
    return t ? 'the team\\'s count of the votes' : null
  }
  const runLink = (run, text) => el('a', { href: '?run=' + encodeURIComponent(run.runId), onclick: (e) => { e.preventDefault(); go(run.runId) } }, text || run.runId)
  // Why a run needs the operator's attention, as a label and, for a failure, its reason in plain words; or nothing.
  const lookOf = (run) => run.blocked ? [run.blocked.kind === 'tie' ? 'Team vote tied' : run.blocked.kind === 'tool-call' ? 'Tool call awaiting approval' : run.blocked.approvalRequest ? 'Fix awaiting approval' : 'Plan awaiting approval', '']
    : run.status === 'failed' ? ['Run failed', run.error ? failureText(run.error) : 'no reason was recorded'] : null
  const needsLook = (run) => { const l = lookOf(run); return l ? l[0] + (l[1] ? ' — ' + l[1] : '') : null }
  const RECENT = 15
  // Things "Waiting for you" names one per line; past them it says how many more, and where.
  const WAITING_NAMED = 5
  // What waits for the operator and they can act on, from one read on every page (GET waiting, T127): the
  // window's title counts it ("(3) system — Home"), and Home's "Waiting for you" lists it. A failed run counts
  // until the operator marks Home as seen; a count that could not be read whole is shown as at least, or "?".
  let waits = null
  const readWaiting = async () => {
    const seen = seenOf()
    try { return await api('waiting' + (seen ? '?since=' + encodeURIComponent(seen.at) : '')) } catch (error) { return { unknown: error.message } }
  }
  const badge = () => !waits ? '' : waits.unknown ? '(?) ' : waits.count ? '(' + waits.count + (waits.partial ? '+' : '') + ') ' : waits.partial ? '(?) ' : ''

  // "Since you last looked" (T124): kept in this browser only (localStorage), never on the server: when
  // the operator last marked Home as seen, and each Worker's status then, to tell what changed since.
  const SEEN_KEY = 'system.seen'
  const seenOf = () => { try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null'); return v && typeof v.at === 'string' && !Number.isNaN(Date.parse(v.at)) ? v : null } catch { return null } }
  const markSeen = (workers) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify({ at: new Date().toISOString(), workers })) } catch {} }
  const statusSnapshot = (roster) => Object.fromEntries(roster && 'value' in roster.workers ? roster.workers.value.map((w) => [w.worker, w.availability.state]) : [])
  // One line each, newest first: what happened to runs, tasks, Workers, and requests since then.
  const sinceItems = (activity, roster, seen, titles) => {
    const items = []
    const task = (id) => titles.get(id)
    if ('value' in activity.runs) for (const r of activity.runs.value) {
      const what = task(r.taskId) ? '"' + task(r.taskId) + '"' : 'a ' + r.template + ' run'
      // A failure leads with the run page's plain-words reason (failureReason, T160); the system's own text is folded under it.
      const reason = r.status === 'failed' && r.error ? failureReason(r.failure || {}) || 'no reason in words is known for it' : null
      items.push({ at: r.at, line: el('span', { class: r.status === 'failed' ? 'state failed' : '' }, r.status === 'failed' ? 'Failed: ' + what + (reason ? ' — ' + reason : '') + ' ' : 'Finished: ' + what + ' '), link: runLink({ runId: r.runId }, 'open the run'),
        fold: reason ? fold('What the system said', el('div', { class: 'muted' }, r.error)) : null })
    }
    if ('value' in activity.tasks) for (const t of activity.tasks.value) {
      const l = t.landing
      const line = t.state === 'done' ? (l && l.state === 'merged' ? 'Merged into ' + (l.base || 'its base') + ': "' + t.title + '"' : l && l.state === 'asked' ? 'Accepted, waiting for you to merge: "' + t.title + '"' : l && l.state === 'refused' ? 'Accepted, not merged (' + (l.reason || 'refused') + '): "' + t.title + '"' : 'Accepted: "' + t.title + '"')
        : t.state === 'review' ? 'Waits for your review: "' + t.title + '"'
          : t.state === 'waiting-for-approval' ? 'Waits for your approval: "' + t.title + '"'
            : t.state === 'waiting-for-input' ? 'Waits for input: "' + t.title + '"' + (t.waiting ? ' (' + t.waiting.reason + ')' : '')
              : 'Cancelled: "' + t.title + '"'
      const request = l && l.state === 'asked' && l.requestId ? l.requestId : t.waiting && t.waiting.approvalRequest
      items.push({ at: t.at, line: el('span', {}, line + ' '), link: request ? decideLink(request, 'decide it') : t.state === 'review' ? el('a', { href: '#review-' + t.taskId, onclick: (e) => { e.preventDefault(); toReview(t.taskId) } }, 'review it') : t.run ? runLink({ runId: t.run.runId }, 'open its run') : null })
    }
    if ('value' in activity.expired) for (const x of activity.expired.value) items.push({ at: x.at, line: el('span', { class: 'soon' }, 'Expired unanswered, so counted as denied: ' + (x.summary || 'request ' + x.requestId)), link: null })
    // The Workers whose status moved since then: started resting, back, unavailable, or available again.
    if (roster && 'value' in roster.workers) for (const w of roster.workers.value) {
      const then = seen.workers && seen.workers[w.worker]
      const now = w.availability.state
      if (!then || then === now) continue
      const back = (s) => s === 'ready' || s === 'busy'
      const line = now === 'resting' ? w.name + ' started resting' + ('value' in w.availability.until ? ' until ' + clockOf(w.availability.until.value) : '')
        : (then === 'resting' && back(now)) ? w.name + ' is back from its rest: ' + (now === 'ready' ? 'free' : 'working')
          : now === 'unavailable' || now === 'quarantined' ? w.name + ' became ' + now + ': ' + w.availability.summary
            : back(now) && (then === 'unavailable' || then === 'quarantined') ? w.name + ' is available again' : null
      if (line) items.push({ at: roster.asOf, line: el('span', {}, line), link: null })
    }
    return items.sort((a, b) => b.at.localeCompare(a.at))
  }
  const sinceView = async (roster, titles) => {
    const seen = seenOf()
    const snapshot = statusSnapshot(roster)
    if (!seen) {
      markSeen(snapshot)
      return el('section', { class: 'panel', 'aria-label': 'Since you last looked' }, el('h3', {}, 'Since you last looked'),
        el('p', { class: 'muted' }, 'This is your first look from this browser: from now on, what happens while you are away is listed here.'))
    }
    let activity
    try { activity = await api('activity?since=' + encodeURIComponent(seen.at)) } catch (error) {
      return el('section', { class: 'panel', 'aria-label': 'Since you last looked' }, el('h3', {}, 'Since you last looked'), el('p', { class: 'state failed' }, 'What happened since could not be read: ' + error.message + '.'))
    }
    const items = sinceItems(activity, roster, seen, titles)
    const mark = el('button', {}, 'Mark as seen')
    mark.addEventListener('click', () => { markSeen(snapshot); refresh() })
    return el('section', { class: 'panel', 'aria-label': 'Since you last looked' },
      el('h3', {}, 'Since you last looked ', el('span', { class: 'muted' }, relative(seen.at) + ' (' + clockOf(seen.at) + ')')),
      // The latest 5, then "Show all N" for the rest (T186): every line read stays reachable.
      items.length ? capped('since', el('ul', { class: 'since', id: 'since-list' }), items, (i) => el('li', {}, i.line, i.link, ' ', el('span', { class: 'muted' }, relative(i.at)), i.fold || null))
        : el('p', { class: 'muted' }, 'Nothing happened that needs you.'),
      'value' in activity.runs ? null : el('p', { class: 'unknown' }, 'The runs that ended are unknown (' + activity.runs.unknown + ').'),
      'value' in activity.tasks ? null : el('p', { class: 'unknown' }, 'The tasks that moved are unknown (' + activity.tasks.unknown + ').'),
      'value' in activity.expired ? null : el('p', { class: 'unknown' }, 'The requests that expired are unknown (' + activity.expired.unknown + ').'),
      // A part that holds more than it lists, or than one read goes through, says so (T127).
      [['runs', 'runs ended'], ['tasks', 'tasks moved'], ['expired', 'requests may have expired']].filter(([k]) => activity[k].more)
        .map(([k, words]) => el('p', { class: 'muted' }, 'More ' + words + ' than the ' + activity[k].value.length + ' read here.')),
      el('div', { class: 'actions' }, mark, el('span', { class: 'muted' }, 'kept in this browser only')))
  }

  // A running run as it moves (T124): its steps, their Workers and for how long, its last event, and a stall its source told.
  const EVENT_WORDS = {
    'workflow.node.started': 'a step started', 'workflow.node.completed': 'a step finished', 'workflow.node.retry': 'a step is tried again', 'workflow.node.waiting': 'a step waits',
    'workflow.node.resent': 'a step is sent again in a new conversation',
    'workflow.node.blocked': 'a step waits for you', 'agent-workers.tool.notified': 'a tool call ran', 'agent-workers.tool.checks-pending': 'a tool call ran, its checks pending',
    'agent-workers.tool.denied': 'a tool call was denied', 'agent-workers.tool.deferred': 'a tool call waits for your verdict', 'agent-workers.tool.web': 'a web call was judged', 'agent-workers.run.stalled': 'its agent stalled',
  }
  // The running runs as they move, by id, or why they are unknown: a failed read is said, never shown as nothing running (T127).
  const liveOf = async () => {
    try { const { runs } = await api('runs/live'); return 'value' in runs ? { runs: new Map(runs.value.map((r) => [r.runId, r])) } : { unknown: runs.unknown } } catch (error) { return { unknown: error.message } }
  }
  const lastText = (r) => 'value' in r.lastEvent ? 'last event: ' + (EVENT_WORDS[r.lastEvent.value.type] || r.lastEvent.value.type) + ', ' + relative(r.lastEvent.value.at) : 'last event unknown (' + r.lastEvent.unknown + ')'
  const stalledOf = (r) => 'value' in r.stalled && r.stalled.value ? el('div', { class: 'state failed', role: 'alert' }, 'Stalled since ' + clockOf(r.stalled.value.since) + ': no activity past its source\\'s bound. Stop run ends it.') : null


  // Home's "Starts awaiting approval" (ADR-0064): each start System proposes, with its Worker and the quota it
  // would draw on, approved or denied by the queue's own verdict on the request's exact subject (INV-5);
  // whether dispatch is off or paused; and, folded, why each ready task did not start at the last look.
  const dispatchOf = async () => { try { return await api('dispatch') } catch (error) { return error.status === 404 || error.status === 503 ? null : { error } } }
  const goWindow = (w) => (w.seconds ? span(w.seconds) : w.window) + ' · used ' + (w.used === undefined ? 'unknown' : w.used + ' %') + ' · reserve ' + w.reserve + ' %'
    + (w.resets ? ' · resets ' + clockOf(w.resets) : '')
  const goView = (dispatch, q, names, jump) => {
    if (!dispatch) return null
    const panel = (...parts) => el('section', { class: 'panel', 'aria-label': 'Starts awaiting approval' }, el('h3', {}, 'Starts awaiting approval'), ...parts)
    if (dispatch.error) return panel(el('p', { class: 'state failed' }, 'The starts System proposes could not be read: ' + dispatch.error.message + '.'))
    const requests = new Map(q && !q.error ? q.requests.map((r) => [r.requestId, r]) : [])
    const asked = dispatch.asks.filter((a) => a.state === 'asked' && a.requestId && requests.has(a.requestId))
    // Without the queue no verdict can be given here: the starts it waits on are named, never shown as none.
    const unread = !q || q.error ? dispatch.asks.filter((a) => a.state === 'asked') : []
    const approved = dispatch.asks.filter((a) => a.state === 'approved' || a.state === 'starting')
    // Off or paused in a few words (a pause's reason kept in sight); the setting and the command that resumes it folded (T171).
    const state = !dispatch.enabled ? [el('p', { class: 'muted' }, 'Automatic starts off'), fold('How to turn them on', 'Dispatch is off (dispatch.enabled: false) in the configuration: System proposes no start by itself.')]
      : dispatch.paused ? [el('p', { class: 'soon' }, 'Automatic starts paused' + (dispatch.paused.reason ? ' · ' + dispatch.paused.reason : '') + ' · since ' + when(dispatch.paused.since)),
        fold('How to resume', 'System proposes no start until you resume it: system dispatch resume.')]
        : (dispatch.pausedProjects || []).length ? (dispatch.pausedProjects || []).map((p) => el('p', { class: 'soon' }, 'Automatic starts paused in project ' + p.projectId + (p.reason ? ' · ' + p.reason : '') + ' · since ' + when(p.since) + ' · resume: system dispatch resume --project ' + p.projectId))
        : null
    const name = (worker) => names.get(worker) || worker
    const item = (a) => {
      const r = requests.get(a.requestId)
      // Approve / Deny, as on its request's card (T191); the item is named by its task. A Deny is final for
      // this attempt (System does not ask about it again, T197): its accessible description says so, and a
      // short note beside the buttons keeps it in sight.
      const [yes, yesDoes] = decision('Approve', 'starts it on ' + name(a.worker), { class: 'primary' })
      const [no, noDoes] = decision('Deny', DISPATCH_DENY)
      const verdict = (v, clicked) => () => q.decide([{ requestId: r.requestId, subject: r.subject, verdict: v }], undefined, undefined, [yes, no], clicked)
      yes.addEventListener('click', verdict('approved', yes))
      no.addEventListener('click', verdict('rejected', no))
      const read = a.windows.filter((w) => w.observedAt).map((w) => (w.seconds ? span(w.seconds) : w.window) + ' read ' + clockOf(w.observedAt))
      return el('li', { class: 'go', 'aria-label': 'Start of ' + a.title },
        el('div', {}, el('strong', {}, a.title), el('span', { class: 'muted' }, ' · attempt ' + a.attempt + ' · ' + name(a.worker))),
        a.windows.map((w) => el('div', { class: 'window' }, w.used !== undefined ? el('meter', { min: '0', max: '100', low: '60', high: '85', optimum: '0', value: String(w.used), 'aria-hidden': 'true' }) : null, el('span', {}, goWindow(w)))),
        fold('Why this Worker?', el('div', {}, a.why), read.length ? el('div', { class: 'muted' }, read.join(' · ')) : null, el('div', { class: 'muted' }, 'project ' + a.projectId)),
        el('div', { class: 'actions' }, yes, yesDoes, no, noDoes, expires(r.expiresAt, 'denied'), ' ',
          el('a', { href: '#request-' + r.requestId, onclick: jump('request-' + r.requestId) }, 'Review request')),
        el('p', { class: 'muted deny-note' }, 'Deny is final for attempt ' + a.attempt + ': it is not asked again.'))
    }
    const last = dispatch.lastPass
    const reasons = last && last.tasks.length ? fold('Why ready tasks did not start (' + relative(last.at) + ')',
      el('ul', {}, last.tasks.map((t) => el('li', {}, '"' + t.title + '": ' + t.reason))), last.more ? el('p', { class: 'muted' }, qty(last.more, 'more ready task') + ' not listed.') : null)
      : last && last.reason ? keptFold('dispatch-last', 'Last look, ' + relative(last.at), last.reason + '.') : null
    return panel(state,
      unread.length ? el('p', { class: 'state failed' }, 'Approvals unreadable, so these starts cannot be decided here now: ' + unread.map((a) => '"' + a.title + '" on ' + name(a.worker)).join(', ') + '.')
        : asked.length ? el('ul', { class: 'goes plain' }, asked.map(item))
          : el('p', { class: 'muted' }, 'No starts awaiting approval.'),
      approved.length ? el('p', {}, qty(approved.length, 'approved start') + ' waiting for a free Worker: ' + approved.map((a) => '"' + a.title + '" on ' + name(a.worker)).join(', ') + '.') : null,
      reasons)
  }

  // Home's "Started by itself" (PROP-0014 D2, T256): what dispatch started in the last 24 h, at the bottom of Home, as a
  // table: one row per task, its newest attempt's run state as a chip, its Worker, how long its run ran (ticking while it
  // runs), and when it started; every attempt, with how it was let start, folded into the task's row. The newest 5 tasks,
  // then "Show all N".
  const STARTED_HOW = { auto: 'by policy (auto)', notify: 'by policy (notify)', ask: 'on your approval', board: 'approved on the board' }
  const STARTED_TONE = { running: 'info', completed: 'ok', failed: 'bad', cancelled: 'idle' }
  const STARTED_HEAD = ['Task', 'State', 'Worker', 'Run time', 'Started']
  const startedView = (dispatch, names, runs) => {
    if (!dispatch || dispatch.error || !dispatch.started || !dispatch.started.length) return null
    const byRun = new Map((runs || []).map((r) => [r.runId, r]))
    const tasks = new Map()
    for (const s of [...dispatch.started].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
      if (!tasks.has(s.taskId)) tasks.set(s.taskId, [])
      tasks.get(s.taskId).push(s)
    }
    const name = (worker) => names.get(worker) || worker
    // How long its run ran, from the runs Home read; a run it did not read is said unknown, never 0.
    const runTime = (s) => {
      const run = byRun.get(s.runId)
      if (!run) return el('span', { class: 'muted', title: 'its run is not among the latest read' }, '—')
      return run.status === 'running' ? elapsedView(run.createdAt) : tookView(run.createdAt, run.updatedAt)
    }
    const row = ([, attempts]) => {
      const s = attempts[0]
      return labelled(STARTED_HEAD, el('tr', { 'aria-label': 'Started by itself: ' + s.title },
        el('td', {}, runLink({ runId: s.runId }, s.title), ' ',
          el('details', { class: 'fold inline' }, el('summary', {}, attempts.length === 1 ? 'attempt ' + s.attempt : qty(attempts.length, 'attempt')),
            attempts.map((a) => el('div', { class: 'muted' }, 'attempt ' + a.attempt + ' · ' + a.runStatus + ' · ' + name(a.worker) + ' · ' + (STARTED_HOW[a.mode] || a.mode) + ' · ', ago(a.startedAt), ' ', runLink({ runId: a.runId }, 'open run'))))),
        el('td', { class: 'nowrap' }, chip(s.runStatus, STARTED_TONE[s.runStatus] || 'idle')),
        el('td', {}, name(s.worker)),
        el('td', { class: 'num' }, runTime(s)),
        el('td', { class: 'nowrap muted' }, ago(s.startedAt))))
    }
    const [body, more] = capped('started', el('tbody', { id: 'started-list' }), [...tasks.entries()], row)
    return el('section', { class: 'page-bottom', 'aria-label': 'Started by itself' }, el('h2', {}, 'Started by itself'),
      el('table', { class: 'started' }, el('thead', {}, el('tr', {}, STARTED_HEAD.map((h) => el('th', {}, h)))), body), more)
  }

  // A project's weekly report and its maturity metrics (T253, T256): a small page of their own, linked from the project's
  // group on Home and from its board, with the commands that print them, each behind its copy button.
  const reportsLink = (projectId, title) => el('a', { class: 'reports', href: '/ui/?view=reports&project=' + encodeURIComponent(projectId), 'aria-label': 'Reports of ' + title,
    onclick: (e) => { e.preventDefault(); openReports(projectId) } }, 'Reports')
  const REPORTS = [
    ['Weekly report', 'The week of the project, from its records', 'system report --project '],
    ['Maturity metrics', 'How far it runs by itself, from its records', 'system metrics --project '],
  ]
  async function reportsView() {
    const projectId = new URLSearchParams(location.search).get('project') || ''
    let title = projectId
    try { const p = (await api('projects')).projects.find((x) => x.projectId === projectId); if (p) title = p.title } catch {}
    const head = ['Report', 'What it says', 'Command']
    show(pageHead('reports', 'Reports · ' + title),
      table(head, REPORTS.map(([what, says, command]) => el('tr', {}, el('td', {}, el('strong', {}, what)), el('td', {}, says),
        el('td', {}, el('code', {}, command + projectId), copyId('Copy command', command + projectId)))), 'reports'),
      el('p', {}, el('a', { href: '/ui/?project=' + encodeURIComponent(projectId), onclick: (e) => { e.preventDefault(); filterHome(projectId) } }, title + ' on Home')))
  }
  function openReports(projectId) {
    current = null
    view = 'reports'
    confirming = false
    history.pushState(null, '', '?view=reports&project=' + encodeURIComponent(projectId))
    refresh()
  }
  // Home shows every project, or the one the address names (T253: ?project=<id>), until "All projects".
  let homeProject = (() => { const query = new URLSearchParams(location.search); return !query.get('view') && !query.get('run') ? query.get('project') : null })()
  function filterHome(projectId) {
    homeProject = projectId || null
    current = null
    view = null
    history.pushState(null, '', homeProject ? '?project=' + encodeURIComponent(homeProject) : '/ui/')
    refresh()
  }
  const HOUR = 3600000

  // Home: what waits for the operator, by project (T253), the Workers at a glance, the decisions themselves, and the latest runs.
  async function list() {
    const { runs } = await api('runs')
    const q = await queue()
    const reviewed = await reviews()
    let roster = null
    try { roster = await api('roster') } catch {}
    let projects
    try { ({ projects } = await api('projects')) } catch {}
    const ready = projects ? projects.reduce((n, p) => n + (p.open.ready || 0), 0) : undefined
    // A run's task by its title, from the Board's cards.
    const titles = new Map((projects || []).flatMap((p) => (p.tasks || []).map((t) => [t.taskId, t.title])))
    // Each board task's project, for the group of a run that serves it; each project's name (T253).
    const taskProject = new Map((projects || []).flatMap((p) => (p.tasks || []).map((t) => [t.taskId, p.projectId])))
    const projectTitles = new Map((projects || []).map((p) => [p.projectId, p.title]))
    if (q && !q.error) for (const [id, p] of q.projects) if (!projectTitles.has(id) && p.title) projectTitles.set(id, p.title)
    if (reviewed && !reviewed.failed) for (const r of [...reviewed.listed, ...reviewed.accepted]) if (!projectTitles.has(r.project.projectId) && r.project.title) projectTitles.set(r.project.projectId, r.project.title)
    const projectName = (id) => projectTitles.get(id) || id
    const names = new Map(roster && 'value' in roster.workers ? roster.workers.value.map((w) => [w.worker, w.name]) : [])
    const dispatch = await dispatchOf()
    waits = await readWaiting()
    const part = (name) => waits.unknown ? { unknown: waits.unknown } : waits[name]
    const look = 'value' in part('runs') ? part('runs').value : []
    const unread = ['requests', 'reviews', 'runs'].filter((name) => 'unknown' in part(name))
    const since = await sinceView(roster, titles)
    const jump = (id) => (e) => { e.preventDefault(); const target = document.getElementById(id); if (target) { target.scrollIntoView({ block: 'start' }); target.focus({ preventScroll: true }) } }
    // Each thing that waits, by name under its count, one link from where it is decided (T141); the count in sight, the
    // names folded under it and kept open through the refresh (T239: Home's top shows only counts). At most WAITING_NAMED names a group.
    const expiry = (iso) => el('span', { class: Date.parse(iso) - Date.now() < 3600000 ? 'soon' : 'muted' }, ' · expires ' + relative(iso))
    const nameList = (key, items, total, more) => items.length ? keptFold('names-' + key, 'Names',el('ul', { class: 'named' }, items.slice(0, WAITING_NAMED).map((line) => el('li', {}, line)),
      total > Math.min(items.length, WAITING_NAMED) ? el('li', { class: 'muted' }, 'and ' + (total - Math.min(items.length, WAITING_NAMED)) + ' more: ', more) : null)) : null
    // A run by its task's title, else its template.
    const runTitle = (run, article) => (run.task && titles.get(run.task.taskId)) || (article ? (/^[aeiou]/.test(run.template) ? 'an ' : 'a ') : '') + run.template + ' run'
    // What needs the operator, by project (T253): each request (a batch whole, in its first request's project), each
    // review, and each run needing attention in its project's group; what is in no project in a group of its own.
    const groups = new Map()
    const groupOf = (key) => {
      if (!groups.has(key)) groups.set(key, { key, slug: key ? 'p-' + key : 'other', name: key ? projectName(key) : 'Other', batches: [], loose: [], requests: [], reviews: [], held: [], runs: [] })
      return groups.get(key)
    }
    if (q && !q.error) for (const batch of q.batches) {
      if (batch.batchId) {
        const g = groupOf(q.described.get(batch.requests[0].requestId).project || '')
        g.batches.push(batch)
        g.requests.push(...batch.requests)
      } else for (const r of batch.requests) {
        const g = groupOf(q.described.get(r.requestId).project || '')
        g.loose.push(r)
        g.requests.push(r)
      }
    }
    if (reviewed && !reviewed.failed) for (const r of reviewed.listed) {
      const g = groupOf(r.project.projectId)
      g.reviews.push(r)
      if (r.heldFor === 'operator' && r.expiresAt) g.held.push(r)
    }
    for (const run of look) groupOf((run.task && taskProject.get(run.task.taskId)) || '').runs.push(run)
    // Every project not closed has its group, whatever waits in it, so its reports stay reachable from it; one with nothing
    // waiting sorts after those that need you.
    for (const p of projects || []) if (p.state !== 'closed') groupOf(p.projectId)
    // The most urgent first: what expires within the hour, then the most that waits, then the earliest deadline, then by name.
    const deadlines = (g) => [...g.requests, ...g.held].map((x) => x.expiresAt).sort()
    const total = (g) => g.requests.length + g.held.length + g.runs.length
    const soonOf = (g) => deadlines(g).filter((d) => Date.parse(d) - Date.now() < HOUR).length
    const ordered = [...groups.values()].sort((a, b) => soonOf(b) - soonOf(a) || total(b) - total(a)
      || (deadlines(a)[0] || '~').localeCompare(deadlines(b)[0] || '~') || Number(!a.key) - Number(!b.key) || a.name.localeCompare(b.name))
    // Filtered to one project (?project=<id>): only its group, said even when nothing of it waits.
    const shownGroups = homeProject ? [groups.get(homeProject) || groupOf(homeProject)] : ordered
    // Each group headed by its project's name, which filters Home to it, and its own counts as tiles: a label and its count
    // (T171: "Approvals · 3"), its names folded under it (T239), each linked to its card.
    const tilesOf = (g) => {
      const s = g.slug
      const link = (id, text) => el('a', { href: '#' + id, onclick: jump(id) }, text)
      const requestNames = [...g.requests].sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : 1)).map((r) => [link('request-' + r.requestId, q.described.get(r.requestId).title), expiry(r.expiresAt)])
      const reviewNames = g.held.map((r) => [link('review-' + r.taskId, r.title), expiry(r.expiresAt)])
      const runNames = g.runs.map((run) => [runLink(run, runTitle(run, true)), el('span', { class: 'muted' }, ' · ' + needsLook(run))])
      const firstReview = g.held.reduce((min, r) => !min || r.expiresAt < min ? r.expiresAt : min, undefined)
      return [
        g.requests.length ? el('li', {}, link('approvals-' + s, 'Approvals · ' + g.requests.length),
          nameList('requests-' + s, requestNames, g.requests.length, link('approvals-' + s, 'See all'))) : null,
        g.held.length ? el('li', {}, link('reviews-' + s, 'Reviews · ' + g.held.length),
          // When the first expires: in sight within the hour, else beside each name under Names (T239, T256).
          firstReview && Date.parse(firstReview) - Date.now() < HOUR ? el('div', { class: 'soon' }, 'first expires ' + relative(firstReview)) : null,
          nameList('reviews-' + s, reviewNames, g.held.length, link('reviews-' + s, 'See all'))) : null,
        g.runs.length ? el('li', {}, link('needs-look-' + s, 'Runs needing attention · ' + g.runs.length + (part('runs').more ? '+' : '')),
          nameList('runs-' + s, runNames, g.runs.length, link('needs-look-' + s, 'See all'))) : null,
      ].filter(Boolean)
    }
    const groupTitle = (g) => g.key ? el('a', { href: '/ui/?project=' + encodeURIComponent(g.key), 'aria-label': 'Show only ' + g.name, onclick: (e) => { e.preventDefault(); filterHome(g.key) } }, g.name) : g.name
    const waiting = shownGroups.filter((g) => total(g) || homeProject).map((g) => el('section', { class: 'group', 'aria-label': 'Needs you in ' + (g.key ? g.name : 'no project') },
      el('h4', {}, groupTitle(g)),
      total(g) ? el('ul', { class: 'tiles' }, tilesOf(g)) : el('p', { class: 'muted' }, 'Nothing needs you here.')))
    const unknownWaits = unread.length ? el('p', { class: 'unknown' }, 'What else needs you is unknown: ' + unread.map((name) => part(name).unknown).join('; ')) : null
    const c = roster && roster.counts
    // A source still describing its Workers for the first time: the counts are incomplete.
    const describing = roster && roster.sources && 'value' in roster.sources ? roster.sources.value.filter((s) => s.describing).map((s) => s.source) : []
    // The Worker a run is on now (the running step's, else the last that had one).
    const workerOf = (run) => { const n = run.nodes.find((x) => x.state === 'RUNNING' && x.worker) || [...run.nodes].reverse().find((x) => x.worker); return n ? names.get(n.worker) || n.worker : undefined }
    const availability = c ? availabilityChips(roster, describing) : el('p', { class: 'unknown' }, 'Workers unknown: the roster could not be read.')
    // Recent runs: the newest 5 rows, then "Show all N" (T239, as T186's lists).
    const RECENT_HEAD = ['Run', 'Status', 'Progress', 'Started']
    // Filtered to one project (T253), only the runs of its board tasks.
    const recent = homeProject ? runs.filter((run) => run.task && taskProject.get(run.task.taskId) === homeProject) : runs
    const [recentBody, recentMore] = capped('recent', el('tbody', { id: 'recent-list' }), recent.slice(0, RECENT), (run) => labelled(RECENT_HEAD, el('tr', {},
      el('td', {}, runLink(run, runTitle(run))),
      el('td', { class: 'nowrap' }, runChip(run)),
      el('td', {}, el('div', {}, stepsText(run), workerOf(run) ? el('span', { class: 'muted' }, ' · ' + workerOf(run)) : null),
        fold('Steps', run.nodes.filter((n) => n.worker).map((n) => el('div', { class: 'muted' }, n.nodeId + ': ' + (names.get(n.worker) || n.worker))), el('div', { class: 'muted' }, 'template ' + run.template + ' · run ', shortId(run.runId, 'Copy run ID')))),
      el('td', { class: 'nowrap muted' }, ago(run.createdAt)))))
    // What needs the operator first, as count tiles beside the Workers' availability; then the decisions themselves;
    // then what happened, the Workers in full, and the recent runs (T239).
    // Right now by name, from the same capacity summary the Workers page renders (T152), by the same function (T160).
    const rightNow = roster && roster.now && 'value' in roster.workers && roster.workers.value.length
      ? glanceView(roster.now, readyNow(roster.now) !== undefined ? readyNow(roster.now) : ready, roster.workers.value) : null
    // What needs the operator first, as count tiles beside the Workers' availability as chips (T239); then the decisions
    // themselves; then what happened, the Workers in full (their counts said once, in the chips), and the recent runs.
    // A run that needs attention: its task's title first, the reason as a chip, one action; the run id behind its copy
    // button (T171). At most 5 a group, then "Show all N" for the rest (T186).
    const runCard = (run) => el('article', { class: 'panel request', 'aria-label': runTitle(run) },
      el('div', { class: 'line' }, el('h4', {}, runTitle(run)), chip(lookOf(run)[0], run.status === 'failed' ? 'bad' : 'warn')),
      el('p', { class: 'meta' }, lookOf(run)[1] ? lookOf(run)[1] + ' · ' : '', 'started ', ago(run.createdAt)),
      el('div', { class: 'actions' }, runLink(run, 'Open run'), copyId('Copy run ID', run.runId)))
    // Each group's cards (T253), headed by its project's name: its approvals, its reviews, its runs needing attention, and,
    // for a project, its weekly report and its metrics, under Reports.
    const cardGroups = []
    const breakerNotes = (key) => {
      const p = (projects || []).find((x) => x.projectId === key)
      return ((p && p.autoAcceptBreakers) || []).map((b) => el('p', { class: 'state failed', role: 'status', 'aria-label': 'Auto-accept is off on ' + b.branch },
        'Auto-accept is off on ' + b.branch + ': ' + qty(b.escapes.length, 'escaped defect') + ' counted (the line is ' + b.line.escapes + ' in ' + b.line.days + ' days). Results are held for you. It turns on again only by you or the lead, once the line holds' + (b.now && b.now.lineHolds ? ' (it holds now).' : '.'),
        el('span', { class: 'muted' }, ' ' + b.escapes.map((e) => e.taskId).join(', '))))
    }
    for (const g of shownGroups) {
      const calm = !g.requests.length && !g.reviews.length && !g.runs.length
      // What is in no project has a group only while something of it waits; a project's group stays, its Reports with it.
      if (calm && !g.key) continue
      const s = g.slug
      cardGroups.push(el('section', { class: 'group', id: 'group-' + s, tabindex: '-1', 'aria-label': g.key ? 'Project ' + g.name : 'Not in a project' },
        g.key ? el('div', { class: 'line group-head' }, el('h2', { class: 'group-title' }, g.name), reportsLink(g.key, g.name)) : el('h2', { class: 'group-title' }, g.name),
        // Auto-accept turned off by its circuit breaker (D93): each branch, the escaped defects it counted, and who turns it on again.
        g.key ? breakerNotes(g.key) : null,
        calm ? el('p', { class: 'muted' }, 'Nothing needs you here.') : null,
        g.requests.length ? await approvals(q, [...g.batches, ...(g.loose.length ? [{ requests: g.loose }] : [])], 'approvals-' + s, 'h3') : null,
        g.reviews.length ? reviewed.sectionOf(g.reviews, 'reviews-' + s, 'h3', false) : null,
        g.runs.length ? el('section', { id: 'needs-look-' + s, tabindex: '-1', 'aria-label': 'Runs needing attention' }, el('h3', { class: 'kind' }, 'Runs needing attention'),
          capped('needs-look-' + s, el('div', { id: 'needs-look-list-' + s }), g.runs, runCard)) : null))
    }
    const shownIn = (kind) => shownGroups.some((g) => g[kind].length)
    // A kind with nothing in any group shown keeps its own short line (or why it is unknown); filtered to one project, its
    // group says when nothing of it waits. The accepted results on their way in after the groups.
    const queueAlone = !q ? null : q.error ? await approvals(q) : shownIn('requests') || homeProject ? null : await approvals(q, [])
    const accepted = reviewed && !reviewed.failed ? reviewed.accepted.filter((a) => !homeProject || a.project.projectId === homeProject) : []
    const reviewsAlone = !reviewed ? null : reviewed.failed ? reviewed.failed
      : shownIn('reviews') || homeProject ? reviewed.acceptedView(accepted, 'h2') : (() => { const s = reviewed.sectionOf([], 'reviews', 'h2', false); const a = reviewed.acceptedView(accepted, 'h3'); if (a) s.append(a); return s })()
    // On the page's grid (T256): what needs the operator and its cards in the main column; the Workers' availability beside
    // it; the starts awaiting approval, what happened, the Workers in full, and the recent runs below the cards (a third
    // column on a wide screen); what dispatch started by itself at the page's bottom.
    show(pageHead('home'),
      el('div', { class: 'page-grid three' },
        el('div', { class: 'col-main overview' },
          el('section', { class: 'panel', 'aria-label': 'Needs your attention' },
            el('div', { class: 'head' }, el('h3', {}, 'Needs your attention'),
              homeProject ? el('a', { href: '/ui/', onclick: (e) => { e.preventDefault(); filterHome(null) } }, 'All projects') : null),
            waiting.length ? el('div', { class: 'groups' }, waiting) : unknownWaits ? null : el('p', { class: 'muted' }, 'You’re all caught up.'), unknownWaits),
          cardGroups,
          queueAlone,
          reviewsAlone),
        el('div', { class: 'col-side overview' },
          el('section', { class: 'panel', 'aria-label': 'Workers availability' },
            el('div', { class: 'head' }, el('h3', {}, 'Workers'), pageLink('workers', 'Open Workers')), availability),
          el('div', { class: 'side-extra' },
      goView(dispatch, q, names, jump),
      el('section', { class: 'panel', 'aria-label': 'Workers at a glance' }, el('h3', {}, 'Capacity'),
        c ? null : el('p', { class: 'unknown' }, 'Workers unknown: the roster could not be read.'),
        // Each account's capacity in one line, its 5 h bar beside it (the CEO's view of what is left).
        roster && 'value' in roster.workers && accountsOf(roster.workers.value).some((g) => g.account)
          ? el('ul', { class: 'capacities', 'aria-label': 'Capacity of each account' }, accountsOf(roster.workers.value).filter((g) => g.account).map(capacityLine)) : null,
        rightNow,
        // Without Right now, the free Workers and the ready tasks in numbers.
        !rightNow && ready !== undefined ? el('p', { 'aria-label': 'Capacity' }, capacityText(c ? c.ready : undefined, ready), ' ', pageLink('board', 'Open Board')) : null))),
        el('div', { class: 'col-more' },
      since,
      // Each run by its task's title (else its template), its state, its progress and current Worker; every step's Worker, its template, and its id folded (T124, T171).
      el('section', { 'aria-label': 'Recent runs' }, el('h2', {}, 'Recent runs'),
        recent.length ? [el('table', {}, el('thead', {}, el('tr', {}, RECENT_HEAD.map((h) => el('th', {}, h)))), recentBody), recentMore]
          : el('p', { class: 'muted' }, 'No runs yet · ', pageLink('board', 'Open Board')),
        recent.length > RECENT ? el('p', { class: 'muted' }, qty(recent.length - RECENT, 'older run') + ' not listed; open one by its link, or ask with system status.') : null))),
      startedView(dispatch, names, runs))
    if (focusRequest) {
      const id = focusRequest
      focusRequest = null
      setTimeout(() => { if (!focusCard(id)) report(false, 'Request ' + id + ' no longer waits', ['It was decided, withdrawn, or expired since the link was made: nothing waits for your verdict on it.']) }, 0)
    }
  }

  // A step's state in words, and what it means for the run.
  const STEP = {
    COMPLETED: ['done', 'completed'], RUNNING: ['running', 'running'], FAILED: ['failed', 'failed'], BLOCKED: ['waiting for you', 'running'],
    WAITING: ['waiting for earlier steps', 'unknown'], READY: ['ready to start', 'ready'], RETIRED: ['dropped from the plan', 'unknown'],
  }
  async function detail(runId) {
    const { run, explain, timings } = await api('runs/' + encodeURIComponent(runId))
    // When each step started and ended (T256), from the event log; none when it could not be read (its step lines say only their state).
    const timed = timings && 'value' in timings ? timings.value : {}
    // Its change, its reviewers' verdicts, and its report, read again only when the run moved (T122).
    const evidence = run.status === 'running' ? undefined : await reviewOf(runId, run.updatedAt)
    const landing = evidence && !evidence.error ? evidence.landing : undefined
    const moving = run.status === 'running' ? await liveOf() : undefined
    const now = moving && moving.runs && moving.runs.get(runId)
    let roster = null
    try { roster = await api('roster') } catch {}
    const names = new Map(roster && 'value' in roster.workers ? roster.workers.value.map((w) => [w.worker, w.name]) : [])
    const nameOf = (worker) => names.get(worker) || worker
    // The board task it serves, by title and project, from the Board's cards (T141).
    let served
    if (run.task) {
      try { for (const p of (await api('projects')).projects) { const t = (p.tasks || []).find((x) => x.taskId === run.task.taskId); if (t) served = { title: t.title, project: p.title, attempts: t.attempts } } } catch {}
    }
    const act = (action, body) => async () => {
      try { await api('runs/' + encodeURIComponent(runId) + '/' + action, body()) } catch (error) {
        report(false, 'Not done: ' + action + ' of run ' + runId, ['The server refused it (' + (error.status || 'no answer') + '): ' + error.message + '. Nothing changed.'])
      }
      await detail(runId).catch((error) => { say('could not refresh: ' + error.message) })
    }
    const note = el('input', { id: 'plan-note' })
    const rationale = el('input', { id: 'vote-rationale' })
    const tie = run.blocked && run.blocked.kind === 'tie' ? run.blocked : null
    const vote = (option) => act('vote', () => ({ decision: tie.decision, option, rationale: rationale.value }))
    const decisions = new Map((explain ? explain.nodes : []).map((n) => [n.nodeId, n.decisions]))
    const failed = run.nodes.find((n) => n.state === 'FAILED')
    const running = run.nodes.filter((n) => n.state === 'RUNNING')
    // Where it is, after its state chip: the current step and Worker, a failure's reason in plain words, or what it waits on.
    const where = run.status === 'completed' ? 'every step done'
      : run.status === 'failed' ? (failed ? 'at ' + (stepWords(failed.nodeId) || failed.nodeId) + ': ' : '') + (run.error ? failureText(run.error) : failed && failed.error ? failureText(failed.error) : 'no reason was recorded')
      : run.blocked ? needsLook(run)
      : running.length ? running.map((n) => (stepWords(n.nodeId) || n.nodeId) + (n.worker ? ' on ' + nameOf(n.worker) : '')).join(', ')
      : run.status
    // Stop ends the run: behind a confirmation, the one destructive move on this page (T170).
    // Its confirmation is Confirm / Cancel, as every confirmation's (T191).
    const stopping = el('span', {})
    const [stop, stopDoes] = decision('Stop run', 'ends this run, after you confirm')
    stop.addEventListener('click', () => {
      confirming = true
      const [cancel, cancelDoes] = decision('Cancel', 'the run goes on', { onclick: () => { confirming = false; stopping.replaceChildren(); stop.focus() } })
      const [sure, sureDoes] = decision('Confirm', 'stops this run: nothing more of it runs', { class: 'primary', onclick: () => { confirming = false; act('stop', () => ({ reason: 'stopped from the web UI' }))() } })
      stopping.replaceChildren(el('span', { role: 'group', 'aria-label': 'Confirm stop' }, ' Stop this run? ', sure, sureDoes, cancel, cancelDoes))
      sure.focus()
    })
    const [retry, retryDoes] = decision('Retry failed step', 'runs the failed step again; completed steps are kept', { class: 'primary', onclick: act('continue', () => ({})) })
    // What happened to it, in plain words (T141): where its worktree started (ADR-0061), a step sent again
    // after a site's own error (ADR-0062), and where its accepted result stands (ADR-0060).
    const carry = run.task && run.task.carry
    const resent = (explain ? explain.nodes : []).flatMap((n) => n.decisions.filter((d) => d.type === 'recovery' && d.outcome === 'resend').map(() => n.nodeId))
    // A step that ran on the family it should differ from, for want of another (D89): a chip beside its state, never folded.
    const singleFamily = (explain ? explain.nodes : []).filter((n) => n.decisions.some((d) => d.type === 'admission' && d.outcome === 'single-family')).map((n) => n.nodeId)
    // Its risk tier, by the paths its change touches, and why (ADR-0071): light, normal, or heavy.
    const risk = explain && explain.risk
    const happened = [
      risk ? el('li', {}, 'Risk tier: ' + risk.tier + (risk.tier === 'heavy' ? ' (a second review by another provider family; never accepted automatically)' : risk.tier === 'light' ? ' (may skip its validation once its required checks pass)' : '') + '.',
        fold('Why', el('ul', {}, risk.reasons.map((r) => el('li', {}, r))), el('div', {}, 'decision ', shortId(risk.decision, 'Copy decision ID')))) : null,
      carry ? carryLine(carry) : null,
      ...resent.map((nodeId) => {
        const node = run.nodes.find((x) => x.nodeId === nodeId)
        return el('li', {}, (stepWords(nodeId) ? 'T' + stepWords(nodeId).slice(1) : 'Step ' + nodeId) + ': retried once after a service error.'
          + (node && node.state === 'FAILED' ? ' Retry failed; no further automatic resend.' : ''), whatIs('resend'),
          fold('Details', 'The site answered with its own error instead of an answer, so it was sent again once, in a new conversation on the same Worker; never a third time.'))
      }),
      // The run view's landing names its base as {branch, sha}; a card's names the branch.
      run.task && run.task.landing && run.task.landing.state !== 'none' ? el('li', {}, landingLine(Object.assign({}, run.task.landing, { base: run.task.landing.base && run.task.landing.base.branch }))) : null,
    ].filter(Boolean)
    // A step's readable name; its id is folded (T171).
    const stepName = (nodeId) => stepWords(nodeId) || nodeId
    const blockedIds = (b, ...more) => keptFold('blocked-' + runId, 'Details', el('div', {}, 'step ' + stepName(b.nodeId) + (stepWords(b.nodeId) ? ' (' + b.nodeId + ')' : '')), b.approvalRequest ? el('div', {}, 'request ', shortId(b.approvalRequest, 'Copy request ID')) : null,
      b.until ? el('div', {}, 'until ' + absolute(b.until)) : null, more)
    const planWaits = run.blocked && !tie && !run.blocked.approvalRequest
    // A long answer shows its first lines, then "Show all", kept through the refresh (T239).
    const answerView = (text) => {
      const long = text.split('\\n').length > 6 || text.length > 480
      const pre = el('pre', { class: 'answer' + (long && !expandedLists.has('answer-' + runId) ? ' clamped' : ''), id: 'answer-' + runId }, text)
      if (!long) return [pre]
      const all = el('button', { type: 'button', class: 'show-all', 'aria-controls': 'answer-' + runId, 'aria-expanded': String(expandedLists.has('answer-' + runId)) }, expandedLists.has('answer-' + runId) ? 'Show less' : 'Show all')
      all.addEventListener('click', () => {
        const open = !expandedLists.has('answer-' + runId)
        if (open) expandedLists.add('answer-' + runId); else expandedLists.delete('answer-' + runId)
        pre.classList.toggle('clamped', !open)
        all.textContent = open ? 'Show less' : 'Show all'
        all.setAttribute('aria-expanded', String(open))
      })
      return [pre, all]
    }
    // Its run time (T256): from its start to its last change once it ended; while it runs, so far.
    const ended = run.status !== 'running' ? run.updatedAt : undefined
    // A step's timing (T256): how long it ran, and when it ended ("14 min · done 07:42"); a running step's time ticks.
    const timingOf = (n) => {
      const t = timed[n.nodeId]
      if (!t) return null
      if (t.endedAt) return { took: tookView(t.startedAt, t.endedAt), at: el('time', { datetime: t.endedAt, title: absolute(t.endedAt) }, clockOf(t.endedAt)), t }
      return n.state === 'RUNNING' ? { took: elapsedView(t.startedAt), t } : { t }
    }
    // The run's timeline (T256): one bar, a segment per step that ran, placed by when it ran; its words its accessible name.
    const timelineBar = () => {
      const start = Date.parse(run.createdAt), end = ended ? Date.parse(ended) : Date.now()
      const ran = run.nodes.filter((n) => timed[n.nodeId])
      if (!ran.length || end <= start) return null
      const share = (ms) => Math.max(0, Math.min(100, (ms - start) / (end - start) * 100))
      const said = (n) => { const t = timed[n.nodeId]; return stepName(n.nodeId) + ' ' + duration((t.endedAt ? Date.parse(t.endedAt) : end) - Date.parse(t.startedAt)) }
      return el('div', { class: 'runbar', role: 'img', 'aria-label': 'Timeline: ' + ran.map(said).join(', ') + '; ' + duration(end - start) + (ended ? ' in all' : ' so far') },
        ran.map((n) => {
          const t = timed[n.nodeId]
          const from = share(Date.parse(t.startedAt)), to = share(t.endedAt ? Date.parse(t.endedAt) : end)
          // Placed through the style object: the page's content security policy refuses a style attribute.
          const segment = el('span', { class: n.state, title: said(n) })
          segment.style.left = from.toFixed(2) + '%'
          segment.style.width = Math.max(0, to - from).toFixed(2) + '%'
          return segment
        }))
    }
    // How a step was decided (T256): one line per decision, its type, outcome, and when; its reasons and id a click away.
    // A deferred tool call's chatter (its wait, then its continue or deny) is one line per call, naming its verdict and how
    // long it waited.
    const REQUEST_NAMED = /\\b(?:approval )?request ([A-Za-z0-9][A-Za-z0-9._:-]*[A-Za-z0-9])/
    const decisionsView = (made) => {
      const lines = []
      const calls = new Map()
      for (const d of made) {
        const named = d.type === 'recovery' && ['wait', 'continue', 'deny'].includes(d.outcome) ? REQUEST_NAMED.exec(d.reasons.join(' ')) : null
        if (!named) { lines.push({ decision: d }); continue }
        if (!calls.has(named[1])) { const call = { requestId: named[1], decisions: [] }; calls.set(named[1], call); lines.push(call) }
        calls.get(named[1]).decisions.push(d)
      }
      const when = (iso) => iso ? [' · ', el('time', { datetime: iso, title: absolute(iso) }, relative(iso))] : null
      const body = (d) => [el('ul', { class: 'reasons' }, d.reasons.map((r) => el('li', {}, r))),
        el('div', { class: 'muted' }, 'decision ', shortId(d.id, 'Copy decision ID'), d.at ? ' · ' + absolute(d.at) : '')]
      return el('ul', { class: 'decisions', 'aria-label': 'How it was decided' }, lines.map((line) => {
        if (line.decision) {
          const d = line.decision
          return el('li', {}, el('details', { class: 'decision' }, el('summary', {}, el('strong', {}, d.type), ' · ' + d.outcome, when(d.at)), body(d)))
        }
        const said = line.decisions.map((d) => d.outcome)
        const last = line.decisions[line.decisions.length - 1]
        const verdict = said.includes('deny') ? 'denied' : said.includes('continue') ? 'approved' + (/\\bthe lead approved\\b/.test(last.reasons.join(' ')) ? ' by the lead' : /\\bthe operator approved\\b/.test(last.reasons.join(' ')) ? ' by you' : '') : 'waiting for a verdict'
        const first = line.decisions[0]
        const waited = first.at && last.at && last !== first ? ' · ' + duration(Date.parse(last.at) - Date.parse(first.at)) : ''
        return el('li', {}, el('details', { class: 'decision call' }, el('summary', {}, el('strong', {}, '1 tool call'), ' ' + verdict + waited, waited ? null : when(last.at)),
          el('div', { class: 'muted' }, 'request ', shortId(line.requestId, 'Copy request ID')),
          line.decisions.map((d) => el('div', {}, el('strong', {}, d.type + ' · ' + d.outcome), when(d.at), body(d)))))
      }))
    }
    show(
      // Headed by its task's title (else its template); its project and attempt below, its id under Technical details (T171, T239).
      pageHead('run', served ? served.title : run.template + ' run', run.runId),
      served ? el('p', { class: 'muted' }, served.project + (carry && carry.from ? ' · Attempt ' + (carry.from.attempt + 1) + ' of ' + served.attempts.max : '')) : null,
      // Its state as a chip, where it is (unless a card below says what it waits on), when it started, how long it took once
      // it ended (T256), and Stop run or Retry.
      el('div', { class: 'status-line' }, runChip(run), singleFamily.length ? [' ', el('span', { title: singleFamily.map(stepName).join(', ') + ': on one provider family, no Worker of another could take it' }, chip('single family', 'warn'))] : null,
        run.blocked ? null : el('span', {}, where), el('span', { class: 'muted' }, 'started ', ago(run.createdAt)),
        ended ? el('span', { class: 'muted' }, 'took ', tookView(run.createdAt, ended)) : null),
      // Stop run or Retry failed step under it; on a phone the page's primary action is a bar at the bottom of the screen,
      // in reach of a thumb (T240): the plan's verdict when it waits on one, else this row.
      run.status === 'running' || run.status === 'failed' ? el('div', { class: 'actions run-actions' + (planWaits ? '' : ' bar') },
        run.status === 'running' ? [stop, stopDoes, stopping] : null,
        run.status === 'failed' ? [retry, retryDoes] : null) : null,
      // On the page's grid (T256): what it waits on, its answer, its change, and its steps in the main column; where it is
      // now and what happened to it beside them.
      el('div', { class: 'page-grid' }, el('div', { class: 'col-main' },
      tie ? el('div', { class: 'panel' },
        el('p', {}, chip('Team vote tied', 'warn'), ' · Decide within ' + relative(tie.until).replace(/^in /, ''), el('span', { class: 'muted' }, ' · No response: inconclusive')),
        el('ul', {}, tie.options.map((o) => el('li', {}, el('strong', {}, o.option + ': '), o.summary))),
        el('div', { class: 'actions' }, el('label', { for: 'vote-rationale' }, 'Why (required)', rationale),
          tie.options.map((o) => el('button', { onclick: vote(o.option) }, 'Vote ' + o.option)),
          el('button', { onclick: vote('inconclusive') }, 'Leave inconclusive')),
        fold('Details', 'The team tied at ' + stepName(tie.nodeId) + ' (' + tie.nodeId + '); it waits for your deciding vote until ' + absolute(tie.until) + ', then ends inconclusive.')) : null,
      run.blocked && run.blocked.kind === 'tool-call' ? el('div', { class: 'panel' },
        el('p', {}, chip('Tool call awaiting approval', 'warn'), run.blocked.until ? [' · ', expires(run.blocked.until)] : null, ' · ', decideLink(run.blocked.approvalRequest, 'Review request')),
        el('p', { class: 'muted' }, 'Approve: continue; deny or expire: end this attempt.'),
        fold('How it works', 'The step\\'s Worker stopped at a tool call. Approved, the step goes on in the same session and makes that call once.'), blockedIds(run.blocked)) : null,
      run.blocked && !tie && run.blocked.kind !== 'tool-call' && run.blocked.approvalRequest ? el('div', { class: 'panel' },
        el('p', {}, chip('Fix awaiting approval', 'warn'), run.blocked.until ? [' · ', expires(run.blocked.until)] : null, ' · ', decideLink(run.blocked.approvalRequest, 'Review request')),
        blockedIds(run.blocked)) : null,
      // A card: what it waits on as its title, Approve / Deny (T191); its step, the plan id, and an optional note under Details (T239).
      planWaits ? el('section', { class: 'panel request', 'aria-label': 'Plan awaiting approval' },
        el('h3', {}, 'Plan awaiting approval'),
        el('div', { class: 'actions bar' },
          decision('Approve', 'the step goes on with this plan', { class: 'primary', onclick: act('approve', () => ({ verdict: 'approved', note: note.value, plan: run.blocked.plan })) }),
          decision('Deny', 'this plan does not run', { onclick: act('approve', () => ({ verdict: 'rejected', note: note.value, plan: run.blocked.plan })) })),
        blockedIds(run.blocked, el('div', {}, 'plan ', shortId(run.blocked.plan, 'Copy plan ID')),
          el('div', { class: 'actions' }, el('label', { for: 'plan-note' }, 'Note (optional)', note)))) : null,
      run.answer ? el('section', { class: 'panel', 'aria-label': 'Answer' }, el('h3', {}, 'Answer'), answerView(run.answer))
        : run.status === 'completed' ? el('p', { class: 'muted' }, 'No answer text.') : null,
      evidence && (evidence.error || ('value' in evidence.change && (evidence.change.value.changes.length || evidence.change.value.unread.length)) || ('value' in evidence.assessments && evidence.assessments.value.length) || landing)
        ? el('section', { class: 'panel request', 'aria-label': 'Changes and reviews' }, el('h3', {}, 'Changes and reviews'), landing && !(run.task && run.task.landing) ? landingLine(landing) : null, evidenceView(evidence, false)) : null,
      el('section', { 'aria-label': 'Steps' }, el('h2', {}, 'Steps'),
        // Step times that could not be read are said, in two words, why folded under them (INV-2): never just absent.
        timings && 'unknown' in timings ? keptFold('timings-' + runId, 'Times unknown', el('span', { class: 'unknown' }, timings.unknown)) : null,
        timelineBar(),
        // Each step by its readable name, how long it ran and when it ended (a running one's time ticking, T256), its state,
        // and its Worker; when it started and ended, what it needs, its id, how it was decided (a line a decision), and an
        // earlier attempt's error folded, a current failure in sight (T171, T239).
        el('ol', { class: 'timeline' }, run.nodes.map((n) => {
          const [word, cls] = STEP[n.state] || [n.state.toLowerCase(), 'unknown']
          const made = decisions.get(n.nodeId) || []
          const time = timingOf(n)
          return el('li', { class: 'step ' + n.state, 'data-step': n.nodeId },
            el('div', {}, el('strong', {}, stepName(n.nodeId)), time && time.took ? [' · ', time.took, ' · '] : ' ', el('span', { class: 'state ' + cls }, word),
              time && time.at ? [' ', time.at] : null,
              n.worker ? el('span', { class: 'muted' }, ' · ' + nameOf(n.worker) + (n.attempt > 1 ? ' · attempt ' + n.attempt : '')) : null),
            // An earlier attempt's error on a step that goes on is history, never shown as its failure now.
            n.error && n.state === 'FAILED' ? el('div', { class: 'state failed' }, failureText(n.error)) : null,
            n.error && n.state !== 'FAILED' ? fold('Attempt history', el('div', { class: 'muted' }, 'An earlier attempt failed: ' + failureText(n.error))) : null,
            keptFold('step-' + runId + '-' + n.nodeId, 'Details', stepWords(n.nodeId) ? el('div', {}, 'step ', el('code', {}, n.nodeId)) : null,
              time ? el('div', { class: 'muted' }, 'started ' + absolute(time.t.startedAt) + (time.t.endedAt ? ' · ended ' + absolute(time.t.endedAt) : '')) : null,
              el('div', { class: 'muted' }, n.worker ? (n.tier || n.minTier) + ' tier' + (n.model ? ', model ' + n.model : '') : 'needs ' + (/^[aeiou]/.test(n.minTier) ? 'an ' : 'a ') + n.minTier + ' tier Worker'),
              made.length ? [el('div', {}, 'How it was decided (' + made.length + ')'), decisionsView(made)] : null))
        }))),
      keptFold('tech-' + runId, 'Technical details', el('p', { class: 'muted' }, 'Template ' + run.template + ' · last changed ', ago(run.updatedAt), ' · spec ', shortId(run.specHash, 'Copy spec hash'), run.sessionId ? [' · session ', shortId(run.sessionId, 'Copy session ID')] : null),
        el('p', { class: 'muted' }, 'run ', shortId(run.runId, 'Copy run ID')))),
      el('div', { class: 'col-side' },
      // Where it is now, refreshed with the page: each running step on its Worker and for how long, its last event, and a stall.
      now ? el('section', { class: 'panel', 'aria-label': 'Now' }, el('h3', {}, 'Now', whatIs('step')),
        now.steps.map((st) => el('div', {}, (stepWords(st.nodeId) ? 'T' + stepWords(st.nodeId).slice(1) : 'Step ' + st.nodeId) + (st.worker ? ' on ' + nameOf(st.worker) : '') + (st.since ? ', for ' + relative(st.since).replace(/ ago$/, '') : '') + (st.attempt > 1 ? ' (attempt ' + st.attempt + ')' : ''))),
        // Its last event; one that cannot be told says so, why folded (T239).
        'value' in now.lastEvent ? el('div', { class: 'muted' }, lastText(now)) : el('div', { class: 'muted' }, 'Last event unknown', keptFold('last-event-' + runId, 'Why', now.lastEvent.unknown)),
        stalledOf(now) ? [stalledOf(now), whatIs('stalled')] : null) : null,
      moving && moving.unknown ? el('p', { class: 'unknown' }, 'Where it is now is unknown (' + moving.unknown + ').') : null,
      happened.length ? el('section', { class: 'panel', 'aria-label': 'What happened' }, el('h3', {}, 'What happened'), el('ul', {}, happened)) : null,
      // A check of its result that printed nothing for its bound: told now, long before its deadline (T235).
      explain && explain.stalledChecks && explain.stalledChecks.length ? el('section', { class: 'panel', 'aria-label': 'Checks' }, el('h3', {}, 'Checks'),
        explain.stalledChecks.map((c) => el('div', {}, chip('Check stalled', 'warn'), ' ' + c.check + ': no output since ', ago(c.quietSince),
          el('span', { class: 'muted' }, ' · it goes on until its deadline'),
          fold('Details', el('div', {}, 'command ', el('code', {}, c.command)), el('div', {}, 'stalled at ' + absolute(c.since) + ', after ' + c.stallSeconds + ' s with no output'))))) : null,
      // A research Worker's web calls (T262): how many, unasked, asked, or denied, and each query or URL with its egress verdict.
      explain && explain.webCalls && explain.webCalls.count ? el('section', { class: 'panel', 'aria-label': 'Web calls' },
        el('h3', {}, 'Web calls (' + explain.webCalls.count + ')'),
        el('p', { class: 'muted' }, explain.webCalls.auto + ' ran unasked under the web access grant, ' + explain.webCalls.asked + ' asked you' + (explain.webCalls.denied ? ', ' + explain.webCalls.denied + ' denied in their session' : '')),
        fold('Queries and URLs', el('table', { class: 'web-calls' },
          el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Tool'), el('th', {}, 'Query or URL'), el('th', {}, 'Verdict'), el('th', {}, 'Egress'))),
          el('tbody', {}, explain.webCalls.calls.map((c) => el('tr', {},
            el('td', {}, ago(c.at)), el('td', {}, c.tool), el('td', {}, el('code', {}, c.target)),
            el('td', {}, c.verdict === 'auto' ? chip('Unasked', 'ok') : c.verdict === 'deny' ? chip('Denied in its session', 'bad') : chip('Asked' + (c.reason ? ' (' + c.reason + ')' : ''), 'warn')),
            el('td', {}, c.egress === 'allow' ? 'passed' : c.egress === 'deny' ? 'refused' : 'not checked'))))))) : null)),
    )
  }

  // The board's projects, and the operator's pause, resume, and close: each behind a confirmation
  // that says what the move does, sent with the project revision shown, so a project changed since
  // is refused and nothing moves. The page does not refresh while a confirmation is open.
  const OPEN = ['proposed', 'ready', 'claimed', 'running', 'review', 'waiting-for-input', 'waiting-for-approval']
  let confirming = false
  // The project the Board shows (T253), or 'all' for every project's counts; null until chosen: the one project when there
  // is one, else all. Kept in the address as &project=<id>.
  let boardProject = (() => { const query = new URLSearchParams(location.search); return query.get('view') === 'board' ? query.get('project') : null })()
  const READY_PREVIEWS = 8
  async function boardView() {
    let projects
    try { ({ projects } = await api('projects')) } catch (error) {
      show(pageHead('board'), error.status === 503 ? el('p', { class: 'muted' }, 'The board is not running, so there are no projects to show.') : errorState('The board could not be read: ' + error.message + '.'))
      return
    }
    const count = (p, states) => states.reduce((n, s) => n + (p.open[s] || 0), 0)
    const shown = el('div', {})
    const settle = async () => { confirming = false; await boardView().catch((error) => { say('could not refresh: ' + error.message) }) }
    const send = (p, action, body) => async () => {
      try {
        const { project, decision } = await api('projects/' + encodeURIComponent(p.projectId) + '/' + action, Object.assign({ revision: p.revision }, body()))
        report(true, p.title + ' is ' + project.state, ['Recorded as board decision ' + decision + '.'])
      } catch (error) {
        report(false, 'Not done: ' + action + ' of ' + p.title, ['The board refused it (' + (error.status || 'no answer') + '): ' + error.message + '. Nothing moved.'])
      }
      await settle()
    }
    const confirm = (p, action) => () => {
      confirming = true
      const busy = count(p, ['running', 'review'])
      const refused = action === 'close' && busy > 0
      const outcome = el('select', { 'aria-label': 'Outcome of ' + p.projectId }, el('option', { value: 'achieved' }, 'achieved: its criteria are met'), el('option', { value: 'stopped' }, 'stopped: it ends without them'))
      const asked = [p.open['waiting-for-approval'] ? p.open['waiting-for-approval'] + ' task(s) waiting for approval' : null, p.amendment ? 'the pending amendment (charter version ' + p.amendment + ')' : null].filter(Boolean)
      const what = action === 'pause' ? [
        'Until you resume it, no task of it is claimed or started, and no proposed task is put to the policy.',
        busy ? busy + ' task(s) running or in review go on to their outcome.' : 'No task of it is running or in review.',
        'Every wait keeps its expiry, and a request you answer meanwhile still applies.',
      ] : action === 'resume' ? [
        'Its proposed tasks go through the gate on the next sweep of the board, and its ready tasks may be claimed again.',
      ] : refused ? [
        'It cannot close while a task runs or is in review: ' + busy + ' do. Stop the run, or decide the review, first.',
      ] : [
        count(p, OPEN) + ' open task(s) are cancelled (project-closed)' + (p.open.claimed ? ', and the lease of ' + p.open.claimed + ' claimed one(s) released' : '') + '.',
        asked.length ? 'The approval requests of ' + asked.join(' and of ') + ' are withdrawn.' : 'No approval request waits on it.',
        'A closed project takes no task again. This cannot be undone.',
      ]
      // Confirm / Cancel, as every confirmation's (T191): Confirm described by what the move does, the list above it.
      const [confirmButton, confirmDoes] = decision('Confirm', (action === 'pause' ? 'pauses ' : action === 'resume' ? 'resumes ' : 'closes ') + p.title + ', as listed above',
        { class: 'primary', onclick: send(p, action, () => (action === 'close' ? { outcome: outcome.value } : {})) })
      const [cancelButton, cancelDoes] = decision('Cancel', 'nothing moves', { onclick: () => { confirming = false; shown.replaceChildren() } })
      shown.replaceChildren(el('div', { class: 'panel', role: 'group', 'aria-label': 'Confirm ' + action + ' of ' + p.projectId },
        el('h3', {}, (action === 'pause' ? 'Pause ' : action === 'resume' ? 'Resume ' : 'Close ') + p.title),
        el('ul', {}, what.map((line) => el('li', {}, line))),
        action === 'close' && !refused ? el('p', {}, 'Outcome: ', outcome) : null,
        refused ? null : [confirmButton, confirmDoes],
        cancelButton, cancelDoes))
      ;(refused ? cancelButton : confirmButton).focus()
    }
    // A project's state at a glance, in words with counts (T141): what waits for the operator (reviews, answers,
    // approvals, merges), what works, what is ready, and what is proposed.
    // A project's state as counts (T171: "Needs you 3 · Working 1 · Ready 1 · Proposed 0"); what needs you, by kind, on demand.
    const glanceOf = (p) => {
      const merges = (p.tasks || []).filter((t) => t.state === 'done' && t.landing && t.landing.state === 'asked').length
      const yours = [[p.open.review, 'review'], [p.open['waiting-for-approval'], 'approval'], [p.open['waiting-for-input'], 'answer'], [merges, 'merge']].filter(([n]) => n)
      const total = yours.reduce((n, [k]) => n + k, 0)
      const counted = (label, n, cls) => el('span', { class: cls || '' }, label + ' ', el('span', { class: 'n' }, String(n)))
      return [el('div', { class: 'glance', 'aria-label': 'State of ' + p.title },
        counted('Needs you', total, total ? 'soon' : ''), ' · ', counted('Working', count(p, ['claimed', 'running'])), ' · ', counted('Ready', p.open.ready || 0), ' · ', counted('Proposed', p.open.proposed || 0)),
        total ? fold('What needs you', yours.map(([n, w]) => qty(n, w)).join(', ')) : null]
    }
    const moves = (p) => p.state === 'active' ? ['pause', 'close'] : p.state === 'paused' ? ['resume', 'close'] : []
    const label = { pause: 'Pause', resume: 'Resume', close: 'Close' }
    // What each move does, its button's accessible description (T191); nothing moves before its confirmation.
    const MOVE_DOES = { pause: 'asks you to confirm, then no task of it starts until you resume it', resume: 'asks you to confirm, then its tasks may start again', close: 'asks you to confirm, then ends the project and cancels its open tasks' }
    // What waits for the operator in each project, each linked to the card it is decided on.
    const q = await queue()
    const open = q && !q.error ? q.requests : []
    const charterOf = (p) => open.find((r) => r.action.class === 'charter' && r.subject.ref.startsWith('project:' + p.projectId + ':charter:'))
    const asksOf = (p) => open.filter((r) => r.requester.component === 'board' && r.requester.projectId === p.projectId && r.requester.taskId)
    // What of it needs the operator: a chip each, linked to its card; past three task approvals, the rest folded.
    const stateOf = (p) => {
      const charter = charterOf(p)
      const asks = asksOf(p)
      const links = (list) => list.flatMap((r, i) => [i ? ', ' : '', decideLink(r.requestId, q.described.get(r.requestId).title)])
      return el('div', {},
        charter ? el('div', {}, chip(p.state === 'proposed' ? 'Charter approval needed' : 'Amendment approval needed', 'warn'), ' ', decideLink(charter.requestId, 'Review request')) : null,
        // Under All projects only the count (T253); each task approval by name is on the project's own board.
        asks.length ? el('div', {}, chip(qty(asks.length, 'task approval'), 'warn'), all ? null : [' ', links(asks.slice(0, 3)),
          asks.length > 3 ? fold((asks.length - 3) + ' more', links(asks.slice(3))) : null]) : null)
    }
    // Who works on a task: the Worker the engine runs its run's step on, by its name, and since when.
    let roster = null
    try { roster = await api('roster') } catch {}
    const moving = await liveOf()
    const working = new Map()
    if (roster && 'value' in roster.workers) for (const w of roster.workers.value) if ('value' in w.work) for (const i of w.work.value.items) working.set(i.runId, { name: w.name, worker: w.worker, since: i.since })
    // One project at a time (T253), or every project's counts under All projects; a project no longer listed shows the default.
    const shownId = boardProject === 'all' || projects.some((p) => p.projectId === boardProject) ? boardProject : projects.length === 1 ? projects[0].projectId : 'all'
    const all = shownId === 'all'
    const shownProjects = all ? projects : projects.filter((p) => p.projectId === shownId)
    // The switcher: its choice in the address, so a reload or a link keeps it.
    const pick = el('select', { id: 'board-project', onchange: () => {
      boardProject = pick.value
      history.replaceState(null, '', '?view=board&project=' + encodeURIComponent(boardProject))
      boardView()
    } },
      el('option', { value: 'all' }, 'All projects (' + projects.length + ')'), projects.map((p) => el('option', { value: p.projectId }, p.title)))
    pick.value = shownId
    const ready = shownProjects.reduce((n, p) => n + (p.open.ready || 0), 0)
    // A project's card: its title and its state as a chip; its open tasks; its state as counts; what of it needs you; its
    // moves; its id and charter version folded (T171, T239).
    // Under All projects (T253) its title opens its own board.
    const switchTo = (p) => el('a', { href: '/ui/?view=board&project=' + encodeURIComponent(p.projectId), onclick: (e) => {
      e.preventDefault()
      boardProject = p.projectId
      history.pushState(null, '', '?view=board&project=' + encodeURIComponent(p.projectId))
      boardView()
    } }, p.title)
    const head = (p) => el('article', { class: 'panel request', 'aria-labelledby': 'project-' + p.projectId },
      el('div', { class: 'line' }, el('h3', { id: 'project-' + p.projectId }, all ? switchTo(p) : p.title),
        chip(p.closure ? 'closed (' + p.closure.outcome + ')' : p.state, p.state === 'active' ? 'ok' : p.state === 'paused' ? 'warn' : 'idle')),
      el('p', { class: 'meta' }, qty(count(p, OPEN), 'open task'), p.amendment ? ' · Amendment awaiting approval' : ''),
      glanceOf(p),
      stateOf(p),
      moves(p).length ? el('div', { class: 'actions' }, moves(p).map((m) => decision(label[m] + '…', MOVE_DOES[m], { onclick: confirm(p, m), 'aria-label': label[m] + ' ' + p.projectId }))) : null,
      fold('Details', 'project ' + p.projectId + ' · charter version ' + p.charter.version + (p.amendment ? ' · amendment ' + p.amendment + ' awaiting approval' : ''), copyId('Copy project ID', p.projectId),
        el('div', {}, reportsLink(p.projectId, p.title))))
    // What a waiting task needs, in the cross-page words (T171): Approval needed, Review needed, Input needed.
    const WAITS = {
      'approval-needed': 'Approval needed', 'budget-spent': 'Approval needed — budget spent', 'reconciliation-failed': 'Approval needed — run not settled',
      'retries-spent': 'Input needed — attempts used up', question: 'Input needed — it asked a question', rejected: 'Input needed — sent back', 'review-expired': 'Input needed — review expired', 'operator-review': 'Review needed',
    }
    // Where a done task's accepted result stands on its way into the repository (ADR-0060).
    // The operator starts a ready task's run, as the lead does (MCP run with task): behind a
    // confirmation that says what runs and on which kind of Worker, bound to the task and template shown.
    // A step's requirement as a short label (T171: "standard+ · reason"): its tier or above, what it must do, its kind of work.
    const needs = (step) => step.source ? 'read by the system, on no Worker'
      : (step.team ? 'team of ' + step.team.members + ', each of another provider · ' : '') + step.tier + '+ · ' + step.capabilities.join(', ')
        + (step.kind ? ' · ' + step.kind : '') + (step.plans ? ' · plans further steps, which may ask for your approval' : '')
    // Who would likely take a step now, by display name with its account's 5 h quota, from the Workers
    // that can do it (the preview's): routing decides when the run starts, so it reads "likely".
    const entries = new Map(roster && 'value' in roster.workers ? roster.workers.value.map((w) => [w.worker, w]) : [])
    const quotaOf = (w) => {
      const pools = w && 'value' in w.pools ? w.pools.value : []
      const win = pools.flatMap((p) => p.windows.filter((x) => x.seconds)).sort((a, b) => a.seconds - b.seconds)[0]
      return !win ? '' : ' — ' + span(win.seconds) + ' ' + ('value' in win.used ? 'used ' + win.used.value + ' %' : 'no reading yet')
    }
    const nameOf = (id) => (entries.get(id) ? entries.get(id).name : id) + quotaOf(entries.get(id))
    const likely = (step) => {
      if (step.source) return null
      const w = step.workers
      if (!w || !('free' in w)) return el('div', { class: 'unknown' }, 'Who would take it is unknown (' + (w ? w.unknown : 'not read') + ')')
      if (w.free.length) return el('div', { class: 'likely' }, 'Likely: ' + w.free.slice(0, 3).map(nameOf).join('; ') + (w.free.length > 3 ? '; or ' + (w.free.length - 3) + ' more' : ''))
      return el('div', { class: 'soon' }, w.busy.length ? 'None free: it waits for ' + w.busy.slice(0, 3).map(nameOf).join('; ') : 'No Worker can take it now: it waits until one can')
    }
    // Who a ready card's first step would likely go to (T141), from its start's preview, read for the
    // first READY_PREVIEWS ready cards shown; a preview that cannot be read leaves the card as it was.
    const previews = new Map()
    const readyShown = all ? [] : shownProjects.flatMap((p) => (p.tasks || []).filter((t) => t.state === 'ready' && t.template)).slice(0, READY_PREVIEWS)
    await Promise.all(readyShown.map(async (t) => { try { previews.set(t.taskId, await api('tasks/' + encodeURIComponent(t.taskId) + '/start')) } catch {} }))
    const goesTo = (preview) => {
      const step = preview.steps.find((s) => !s.source)
      const w = step && step.workers
      if (!w || !('free' in w) || !w.free.length) return step ? likely(step) : null
      // The likely Worker in sight, the alternatives folded (T171).
      return el('div', { class: 'likely' }, 'Likely Worker: ' + nameOf(w.free[0]),
        w.free.length > 1 ? el('details', { class: 'fold inline' }, el('summary', {}, '+' + qty(w.free.length - 1, 'other')), w.free.slice(1).map((id) => el('div', {}, nameOf(id)))) : null)
    }
    // A request the queue lists, decided on the card with its own buttons (approve by button, T141).
    const askOf = (requestId) => open.find((r) => r.requestId === requestId)
    const decideHere = (r, ...more) => {
      const d = q.described.get(r.requestId)
      // Approve / Deny, as on its card on Home (T191); the card is named by its task.
      const [yes, yesDoes] = decision('Approve', d.yes, { class: 'primary' })
      const [no, noDoes] = decision('Deny', d.no)
      const verdict = (v, clicked) => () => q.decide([{ requestId: r.requestId, subject: r.subject, verdict: v }], undefined, undefined, [yes, no], clicked)
      yes.addEventListener('click', verdict('approved', yes))
      no.addEventListener('click', verdict('rejected', no))
      return el('div', { class: 'actions decide' }, yes, yesDoes, no, noDoes, more)
    }
    const start = (t) => async () => {
      confirming = true
      // Confirm / Cancel, as every confirmation's (T191).
      const [close, closeDoes] = decision('Cancel', 'nothing starts', { onclick: () => { confirming = false; shown.replaceChildren() } })
      let preview
      try { preview = await api('tasks/' + encodeURIComponent(t.taskId) + '/start') } catch (error) {
        shown.replaceChildren(el('div', { class: 'panel bad', role: 'alert', 'aria-label': 'Cannot start ' + t.title },
          el('h3', {}, 'It cannot start from here: "' + t.title + '"'), el('p', {}, error.message.replace(/^[a-z_]+: /, '')), close, closeDoes))
        close.focus()
        return
      }
      const { task, steps } = preview
      const [yes, yesDoes] = decision('Confirm', 'starts the run now', { class: 'primary' })
      yes.addEventListener('click', async () => {
        yes.disabled = true
        close.disabled = true
        yes.textContent = 'Starting…'
        try {
          const answer = await api('tasks/' + encodeURIComponent(t.taskId) + '/start', { revision: task.revision, template: task.template })
          // Admitted, and the board did not answer when asked to record it: nothing of it ran yet, and it is not refused (T127).
          if (answer.pending) report('pending', 'Not started yet: ' + t.title, [['Run ', runLink(answer.pending), ' of the ' + task.template + ' template took the task, and the board did not answer when asked to record it, so nothing of it has run. It starts once the board shows it recorded, and the task then moves to Working; if the board never records it, the run is dropped with nothing run. Nothing more is needed from you.'], 'What the system said: ' + answer.pending.reason])
          else report(true, 'Started: ' + t.title, [['Run ', runLink(answer.run), ' of the ' + task.template + ' template claimed the task: it is under Working on the Board, and its page shows each step as it runs.']])
        } catch (error) {
          report(false, 'Not started: ' + t.title, ['The server refused it (' + (error.status || 'no answer') + '): ' + error.message + '. Nothing was started: the task is still ready.'])
        }
        await settle()
      })
      shown.replaceChildren(el('div', { class: 'panel', role: 'group', 'aria-label': 'Confirm start of ' + t.title },
        el('h3', {}, 'Start "' + t.title + '"'),
        // What runs in numbers and labels, the likely Worker of each step in sight; the mechanics and assurances folded (T171).
        el('p', {}, el('span', { class: 'tag' }, task.template + ' template'), ' · attempt ' + (task.attempts.count + 1) + ' of ' + task.attempts.max + ' · ' + qty(steps.length, 'step'), whatIs('attempt'), whatIs('tier')),
        el('ol', {}, steps.map((step) => el('li', {}, step.objective + ': ' + needs(step), likely(step)))),
        el('p', { class: 'muted' }, idle === undefined ? 'Free Workers unknown' : qty(idle, 'Worker') + ' free now'),
        fold('What happens on start', el('p', {}, 'The run claims the task, which moves to Working; each step runs in order on a Worker that can do it, and a step no free Worker can take waits for one.'),
          el('p', {}, 'Routing picks each step\\'s Worker when the run starts: the names above are likely, not promised.'),
          el('p', {}, 'Nothing runs until you confirm. Once it runs, its page has Stop run.')),
        yes, yesDoes, close, closeDoes))
      // On a narrow screen the confirmation is far above the card pressed: bring it into sight.
      shown.scrollIntoView({ block: 'nearest' })
      yes.focus()
    }
    // A card (T239): its title; one line of context, its project when several show and when it changed; what it needs as its
    // one chip, or who works on it; its primary action (Start…, Approve / Deny, Review) and its run; every other fact (its
    // action type, its template and likely Worker, its last event) under its Details.
    const cardOf = (p, t) => {
      const run = t.run ? working.get(t.run.runId) : undefined
      const since = t.updatedAt || t.createdAt
      const live = (t.state === 'running' || t.state === 'claimed') && t.run && moving.runs ? moving.runs.get(t.run.runId) : undefined
      const asked = t.waiting && t.waiting.approvalRequest && askOf(t.waiting.approvalRequest) ? askOf(t.waiting.approvalRequest)
        : t.landing && t.landing.state === 'asked' && t.landing.requestId && askOf(t.landing.requestId) ? askOf(t.landing.requestId) : undefined
      const openRun = t.run ? el('a', { href: '?run=' + encodeURIComponent(t.run.runId), onclick: (e) => { e.preventDefault(); go(t.run.runId) }, 'aria-label': 'Open the run of ' + t.title }, 'Open run') : null
      // Its meta line (T256): only who works on it and when it last changed; its project, kind of work, template, and attempts
      // are the line's tooltip, and under its Details.
      const about = [p.title, t.actionClass, t.template ? t.template + ' template' : null, 'attempt ' + Math.max(1, t.attempts.count) + ' of ' + t.attempts.max].filter(Boolean).join(' · ')
      return el('article', { class: 'card', 'aria-label': t.title },
        el('strong', {}, t.title),
        el('div', { class: 'muted meta', title: about }, run ? [el('span', { class: 'taken' }, run.name), ' · '] : null, ago(since)),
        // A label each, the lifecycle explained once in Help (T171).
        t.state === 'proposed' ? el('div', { class: 'muted' }, 'Pending prerequisites') : null,
        t.state === 'ready' && !t.template ? el('div', { class: 'muted' }, 'No template: the lead starts it') : null,
        (t.state === 'claimed' || t.state === 'running') && !run ? el('div', { class: 'taken' }, t.state === 'claimed' ? 'Claimed; no step runs yet' : 'Running; its Worker is not known now') : null,
        (t.state === 'claimed' || t.state === 'running') && run && 'value' in run.since ? el('div', { class: 'muted' }, 'for ', elapsedView(run.since.value)) : null,
        live ? stalledOf(live) : null,
        t.waiting && t.state.startsWith('waiting') ? el('div', {}, chip(WAITS[t.waiting.reason] || t.waiting.reason, 'warn'), ' ', expires(t.waiting.expiresAt)) : null,
        t.landing ? (t.landing.state === 'asked' && t.landing.requestId && askOf(t.landing.requestId) ? el('div', {}, chip('Merge approval needed', 'warn'), ' · into ' + (t.landing.base || 'its base')) : landingLine(t.landing)) : null,
        // Approve by button where the operator sees it (T141): the request's own verdict buttons, on its exact subject.
        asked ? decideHere(asked, openRun)
          : t.state === 'ready' ? el('div', { class: 'actions' }, el('button', { type: 'button', class: 'primary', onclick: start(t), 'aria-label': 'Start ' + t.title }, 'Start…'))
            : t.state === 'review' ? el('div', { class: 'actions' }, el('a', { href: '/ui/', 'aria-label': 'Review ' + t.title, onclick: (e) => { e.preventDefault(); homeProject = null; go(); setTimeout(() => toReview(t.taskId), 300) } }, 'Review'))
              : t.waiting && t.waiting.approvalRequest ? el('div', { class: 'actions' }, decideLink(t.waiting.approvalRequest, 'Review request'), openRun)
                : openRun ? el('div', { class: 'actions' }, openRun) : null,
        keptFold('task-' + t.taskId, 'Details', el('div', {}, el('span', { class: 'tag' }, t.actionClass), t.template ? [' ', el('span', { class: 'tag' }, t.template + ' template')] : null),
          el('div', { class: 'muted' }, p.title + ' · attempt ' + Math.max(1, t.attempts.count) + ' of ' + t.attempts.max),
          t.state === 'review' ? el('div', {}, openRun) : null,
          t.state === 'ready' && previews.has(t.taskId) ? goesTo(previews.get(t.taskId)) : null,
          live ? el('div', { class: 'muted' }, lastText(live)) : null))
    }
    // A done task whose merge waits for the operator is also shown where the operator looks for what waits (ADR-0060).
    const waitsToMerge = (t) => t.state === 'done' && t.landing && t.landing.state === 'asked'
    const tasksIn = (states) => shownProjects.flatMap((p) => (p.tasks || []).filter((t) => states.includes(t.state) || (states.includes('waiting-for-approval') && waitsToMerge(t))).map((t) => [p, t]))
    const moreIn = (states) => shownProjects.reduce((n, p) => n + states.reduce((m, s) => m + ((p.more || {})[s] || 0), 0), 0)
    const column = (name, states, hint, help) => {
      const cards = tasksIn(states)
      return el('section', { class: 'column' + (states.includes('waiting-for-approval') ? ' waits' : ''), 'aria-label': name },
        el('h3', {}, name + ' (' + (cards.length + moreIn(states)) + ')', help || null),
        cards.length ? cards.map(([p, t]) => cardOf(p, t)) : el('p', { class: 'muted' }, hint),
        moreIn(states) ? el('p', { class: 'muted' }, moreIn(states) + ' older not shown') : null)
    }
    const folded = (name, states) => {
      const cards = tasksIn(states)
      return el('details', { class: 'column' }, el('summary', {}, name + ' (' + (cards.length + moreIn(states)) + ')'),
        cards.length ? el('div', { class: 'cards' }, cards.map(([p, t]) => cardOf(p, t))) : el('p', { class: 'muted' }, name === 'Done' ? 'None yet.' : 'None.'))
    }
    const idle = roster ? roster.counts.ready : undefined
    // The projects under one fold, kept open through the refresh once opened; its summary says what of them needs you (T239).
    const charters = shownProjects.filter((p) => charterOf(p)).length
    const projectsFold = () => {
      const details = keptFold('projects', ['Projects (' + shownProjects.length + ')', charters ? [' ', chip(qty(charters, 'charter approval'), 'warn')] : null],
        el('div', { class: 'projects' }, shownProjects.map(head)))
      details.className = 'column'
      return details
    }
    // Each empty state one short line; how tasks move between columns is in Help's Task lifecycle (T171), how a ready task
    // starts behind its column's "?" (T239). The tasks first, Needs your attention leading on a phone; then, folded, the
    // projects with their state and moves, and the done and cancelled tasks.
    show(
      pageHead('board'),
      projects.length ? null : el('p', { class: 'muted' }, 'No projects yet · ', pageLink('help', 'How projects start')),
      projects.length ? el('div', { class: 'toolbar' }, el('p', {}, el('label', { for: 'board-project' }, 'Show ', pick)),
        el('p', { 'aria-label': 'Capacity' }, capacityText(idle, ready), whatIs('task'))) : null,
      shown,
      // All projects (T253): each project's counts only, what of it needs you, and its moves; its tasks on its own board.
      projects.length && all ? el('section', { class: 'portfolio', 'aria-label': 'All projects' }, el('h2', {}, 'All projects', whatIs('project'), charters ? [' ', chip(qty(charters, 'charter approval'), 'warn')] : null),
        el('div', { class: 'projects' }, projects.map(head))) : null,
      projects.length && !all ? el('div', { class: 'kanban' },
        column('Proposed', ['proposed'], 'None'),
        column('Ready', ['ready'], 'None', whatIs('start')),
        column('Working', ['claimed', 'running'], 'None'),
        column('Review', ['review'], 'None'),
        column('Needs your attention', ['waiting-for-input', 'waiting-for-approval'], 'Nothing needs you')) : null,
      projects.length && !all ? el('div', { class: 'folded' }, projectsFold(), folded('Done', ['done']), folded('Cancelled', ['cancelled'])) : null)
  }

  // A time as its clock time ("14:20"), with the day when it is not today.
  const clockOf = (iso) => {
    const d = new Date(iso)
    return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : absolute(iso)
  }
  // Tasks ready across the board's projects, or undefined when the board cannot be read.
  const readyTasks = async () => {
    try { return (await api('projects')).projects.reduce((n, p) => n + (p.open.ready || 0), 0) } catch { return undefined }
  }
  // A time as "in 2 h (11:40)": relative, then the clock time, with the day when it is not today.
  const when = (iso) => relative(iso) + ' (' + clockOf(iso) + ')'
  // A window's length as "5 h" or "7 d" (ADR-0059's "used 42 % of 5 h").
  const span = (seconds) => seconds % 86400 === 0 ? seconds / 86400 + ' d' : seconds % 3600 === 0 ? seconds / 3600 + ' h' : seconds % 60 === 0 ? seconds / 60 + ' min' : seconds + ' s'
  // One window of a pool, as it reads after the per-account limits (ADR-0059): "5 h: used 9 % — resets
  // 23:30 (read 22:05)" with a small bar, from its latest reading (an account's usage report, or a run's
  // own); "5 h: no reading yet: <why>" before any; at its limit said first. What a reading does not
  // give stays unknown, with why.
  const ISO_TIME = /\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d(?::\\d\\d(?:\\.\\d+)?)?(?:Z|[+-]\\d\\d:\\d\\d)/g
  const clocked = (text) => text.replace(ISO_TIME, (iso) => Number.isNaN(Date.parse(iso)) ? iso : clockOf(iso))
  // "5 h · used 42 % · resets 14:20" (T171); when it was read is under the account's details (readTimes).
  const windowLine = (win, label) => {
    const limited = win.state === 'limited'
    if (!('value' in win.used) && /^no reading yet/.test(win.used.unknown)) return label + ' · ' + clocked(win.used.unknown)
    return label + ' · ' + (limited ? 'at its limit · ' : '') + ('value' in win.used ? 'used ' + win.used.value + ' %' : 'used unknown (' + win.used.unknown + ')')
      + ' · resets ' + ('value' in win.resets ? clockOf(win.resets.value) : 'unknown (' + win.resets.unknown + ')')
  }
  // When each window of these pools was last read, for the details: "5 h read 09:29; 7 d read 09:29".
  const readTimes = (pools) => pools.flatMap((p) => p.windows.filter((w) => w.observedAt).map((w) => (pools.length > 1 ? p.pool + ' ' : '') + (w.seconds ? span(w.seconds) : w.id) + ' read ' + clockOf(w.observedAt))).join('; ')
  // A pool's windows, the ones at their limit first, each named by its length ("5 h"; its id when it has none, or beside a twin).
  const windowsView = (p) => {
    const named = (win) => win.seconds ? span(win.seconds) + (p.windows.filter((w) => w.seconds === win.seconds).length > 1 ? ' (' + win.id + ')' : '') : win.id
    const order = [...p.windows].sort((x, y) => Number(y.state === 'limited') - Number(x.state === 'limited'))
    // Windows with no reading yet for the same reason read as one line ("5 h, 7 d: no reading yet: …").
    const lines = []
    for (const win of order) {
      const none = !('value' in win.used) && /^no reading yet/.test(win.used.unknown) ? win.used.unknown : undefined
      const same = none && lines.find((l) => l.none === none)
      if (same) same.windows.push(win)
      else lines.push({ none, windows: [win] })
    }
    return lines.map(({ windows: [win, ...more] }) => el('div', { class: 'window' + (win.state === 'limited' ? ' limited' : ''), 'aria-label': 'window ' + [win, ...more].map((w) => w.id).join(', ') + ' of ' + p.pool },
      'value' in win.used ? el('meter', { min: '0', max: '100', low: '60', high: '85', optimum: '0', value: String(win.used.value), 'aria-hidden': 'true' }) : null,
      el('span', {}, windowLine(win, [win, ...more].map(named).join(', ')))))
  }
  // The Workers by account (docs/design/roster.md): each account once, under a small header with its
  // quota, then its Workers (its roles), each card calm: what it is for, its status (a reason that
  // blocks work always shown), and what it does now; every unknown, derived, or technical fact is
  // folded under the card's details, never dropped and never a default.
  const isKnown = (k) => 'value' in k
  const textOf = (k, render) => isKnown(k) ? (render ? render(k.value) : String(k.value)) : 'unknown (' + k.unknown + ')'
  // A display name is "<runtime> · <account> · <work>": the account's name is all but the work.
  const cut = (name) => { const i = name.lastIndexOf(' · '); return i > 0 ? [name.slice(0, i), name.slice(i + 3)] : [name, name] }
  // Each account once, with its Workers in roster order; the Workers of no account last, each on its own.
  const accountsOf = (workers) => {
    const groups = new Map()
    for (const w of workers) {
      const key = isKnown(w.account) ? 'account:' + w.account.value.id : 'worker:' + w.worker
      if (!groups.has(key)) groups.set(key, { key, name: isKnown(w.account) ? cut(w.name)[0] : w.name, account: isKnown(w.account) ? w.account.value : undefined, workers: [] })
      const g = groups.get(key)
      g.workers.push(w)
      // The account rests when any of its Workers says it does.
      if (g.account && !g.account.limitUntil && w.account.value.limitUntil) g.account = w.account.value
    }
    const all = [...groups.values()]
    return all.filter((g) => g.account).concat(all.filter((g) => !g.account))
  }
  // An account's pools, read once from the first of its Workers that has them.
  const poolsOf = (g) => { const w = g.workers.find((x) => isKnown(x.pools)); return w ? w.pools.value : undefined }
  // Resting until when, in the operator's words.
  const restingText = (until) => 'resting until ' + clockOf(until) + ' (' + relative(until) + ')'
  // An account's capacity in one line, as Home shows it: its shortest window (the 5 h one) with a small
  // bar, and, when it rests at a limit, until when; or that it has no reading yet.
  // Its shortest window (the 5 h one) as a small bar and a few words, the same pick on Home and on its account's card.
  const shortestOf = (g) => {
    const pools = poolsOf(g) || []
    const pick = pools.flatMap((p) => p.windows.filter((win) => win.seconds).map((win) => ({ p, win }))).sort((x, y) => x.win.seconds - y.win.seconds)[0]
    const bar = pick && 'value' in pick.win.used ? el('meter', { min: '0', max: '100', low: '60', high: '85', optimum: '0', value: String(pick.win.used.value), 'aria-hidden': 'true' }) : el('span', { class: 'no-bar', 'aria-hidden': 'true' })
    const text = pick ? span(pick.win.seconds) + ' ' + (pick.win.state === 'limited' ? 'at its limit, ' : '') + ('value' in pick.win.used ? 'used ' + pick.win.used.value + ' %' + ('value' in pick.win.resets ? ', resets ' + clockOf(pick.win.resets.value) : '') : /^no reading yet/.test(pick.win.used.unknown) ? 'no reading yet' : 'used unknown') : null
    return { bar, text }
  }
  const capacityLine = (g) => {
    const pools = poolsOf(g) || []
    const { bar, text } = shortestOf(g)
    const resting = g.account && g.account.limitUntil ? g.account.limitUntil : pools.filter((p) => !p.available && p.until).map((p) => p.until).sort().at(-1)
    return el('li', { class: 'capacity', 'aria-label': 'Capacity of ' + g.name }, bar,
      el('span', {}, g.name + ': ' + ([resting ? restingText(resting) : null, text].filter(Boolean).join('; ') || (poolsOf(g) ? 'quota not tracked' : 'quota unknown'))))
  }
  // The Workers' availability as chips (T239), the same on Home and on Workers: a count and a word each, its tone and shape
  // from what it means; free always, the others when there are any (until when each rests is on its account's card).
  const AVAILABLE = [['ready', 'free', 'ok'], ['busy', 'working', 'info'], ['resting', 'resting', 'warn'], ['unavailable', 'unavailable', 'bad'], ['quarantined', 'quarantined', 'bad']]
  const availabilityChips = (roster, describing) => {
    const c = roster.counts
    return el('ul', { class: 'chips availability', 'aria-label': 'Worker counts' },
      AVAILABLE.filter(([k]) => k === 'ready' || c[k]).map(([k, word, tone]) => el('li', {}, chip(c[k] + ' ' + word, c[k] ? tone : 'idle'))),
      roster.unlisted ? el('li', { class: 'muted' }, roster.unlisted + ' more not listed') : null,
      describing.length ? el('li', { class: 'unknown' }, 'counts incomplete: ' + describing.join(', ') + ' loading') : null)
  }
  // A Worker's status in the cross-page words (T171): Free, Working · 1/2 slots, Resting until 14:20, Unavailable — why,
  // Quarantined — why; a reason that blocks work is never folded.
  const statusOf = (w) => {
    const a = w.availability
    if (a.state === 'busy') return a.slots !== undefined ? 'Working · ' + a.running + '/' + a.slots + ' slots' + (a.running < a.slots ? ' · ' + qty(a.slots - a.running, 'slot') + ' free' : '') : 'Working'
    if (a.state === 'ready') return 'Free'
    if (a.state === 'resting') return isKnown(a.until) ? 'Resting until ' + clockOf(a.until.value) + ' (' + relative(a.until.value) + ')' : 'Resting: no reset is known (' + a.until.unknown + ')'
    if (a.state === 'unavailable') return 'Unavailable — ' + textOf(a.reason)
    return 'Quarantined — its account ' + ({ changed: 'signed in as someone else', ambiguous: 'could not be told apart from another', duplicate: 'is the same person as another', unverified: 'is not verified' }[a.reason] || a.reason) + (a.detail ? ' (' + a.detail + ')' : '') + ', since ' + when(a.since)
  }
  // One step it runs, in words (T141): the task by its title, else the run's template and the step; for how long. The roster's own sentence stays in its details.
  const doingText = (i) => {
    const task = i.task && 'value' in i.task.board ? i.task.board.value : undefined
    const long = 'value' in i.since ? ', for ' + relative(i.since.value).replace(/ ago$/, '') : ''
    return task ? 'Working on "' + task.title + '"' + long : 'Running ' + (stepWords(i.nodeId) ? stepWords(i.nodeId) + ' in a team run' : 'step ' + i.nodeId + ' of a ' + i.template + ' run') + long
  }
  const runOpen = (runId) => el('a', { href: '?run=' + encodeURIComponent(runId), onclick: (e) => { e.preventDefault(); go(runId) }, 'aria-label': 'Open run ' + runId }, 'open run')
  // What it does now, when it does something; its runs whose liveness needs a look (PROP-0013) are never folded.
  // Which project a step's run is for (T253: Workers serve every project): its board task's, by the project's name; a run
  // outside the board is in no project; a task the roster could not read leaves its project unknown.
  const projectTag = (i, projectName) => !i.task ? el('span', { class: 'tag project' }, 'no project')
    : 'value' in i.task.board ? el('span', { class: 'tag project', title: 'project ' + i.task.board.value.projectId }, projectName(i.task.board.value.projectId))
      : el('span', { class: 'tag project unknown' }, 'project unknown')
  const doingOf = (w, projectName = (id) => id) => {
    const items = isKnown(w.work) ? w.work.value.items : []
    const live = w.liveness && isKnown(w.liveness) ? w.liveness.value : []
    if (!items.length && !live.length) return null
    return el('div', { class: 'doing' },
      items.length ? el('ul', { 'aria-label': 'Doing now' }, items.map((i) => el('li', { 'data-project': i.task && 'value' in i.task.board ? i.task.board.value.projectId : '' }, doingText(i), ' ', projectTag(i, projectName), ' ', i.startedBy === 'dispatch' ? [chip('started by itself', 'info'), ' '] : null, runOpen(i.runId)))) : null,
      isKnown(w.work) && w.work.value.more ? el('div', { class: 'muted' }, w.work.value.more + ' more step(s) not listed') : null,
      live.length ? el('ul', { 'aria-label': 'Runs whose liveness needs a look' }, live.map((r) => el('li', { class: r.state === 'unknown' ? 'state failed' : 'unknown' }, r.summary, r.runId ? [' ', runOpen(r.runId)] : null, whatIs(r.state === 'unknown' ? 'held' : 'stalled')))) : null)
  }
  // Its pools' windows, the closed pools first; a pool's own name only when there are several.
  // A closed pool says it rests, unless its account already says so (\`rested\`).
  const poolsView = (pools, rested) => [...pools].sort((x, y) => Number(x.available) - Number(y.available)).map((p) => el('div', { class: 'pool' },
    pools.length > 1 || (!p.available && !rested) ? el('div', {}, pools.length > 1 ? el('strong', {}, p.pool + ' ') : null, p.available || rested ? null : el('span', { class: 'state resting' }, p.until ? restingText(p.until) : 'resting; no reset is known')) : null,
    windowsView(p),
    isKnown(p.unknownUsage) && p.unknownUsage.value.runs ? el('div', { class: 'unknown' }, p.unknownUsage.value.runs + ' run(s) with usage it could not count') : null))
  // The facts of a Worker or an account a person rarely needs, folded: what could not be read stays here, with why.
  const detailsOf = (rows) => el('details', { class: 'facts' }, el('summary', {}, 'Details'), el('dl', {}, rows.filter(Boolean).flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)])))
  const recordText = (a) => a.id + (isKnown(a.record) ? ' · ' + a.record.value.kind + ' account, ' + a.record.value.status + (a.record.value.slot !== undefined ? ', slot ' + a.record.value.slot : '') : ' · its record is unknown (' + a.record.unknown + ')')
  // Right now, by name (T141), rendered as the server made it (the roster's now, T152; docs/design/roster.md#capacity-now),
  // never computed again here: who is free, the quota that would be lost unused first; whose quota is unknown (never
  // counted free); who is stuck; which accounts have no quota left; who cannot work; and the ready tasks with the Worker
  // each would likely go to. Each said in words (never by colour alone); a free Worker while tasks are ready is waste the
  // operator can end on the Board.
  // The ready tasks as capacity now read them, when it could read every active project; else undefined (the caller counts the board's).
  const readyNow = (now) => (now && isKnown(now.ready) && !now.ready.value.unread ? now.ready.value.items.length + now.ready.value.more : undefined)
  // The Workers page and Home both render it (T160), from the same roster read, so they name the same Workers; a free
  // Worker the operator keeps out of teams (D58, the roster's \`teams\`) is said free for every other step, not for team work.
  const glanceView = (now, ready, workers, folded = false, asOf) => {
    const keptOut = new Set((workers || []).filter((w) => w.teams && isKnown(w.teams)).map((w) => w.worker))
    const has = (k) => isKnown(k) && k.value.items.length > 0
    const SHOWN = 3
    // "Label: N — a; b; c" (T171): a count first, the names that need acting on after it, past the first three folded;
    // what could not be read is unknown with why, never 0.
    const row = (label, k, line, extra) => {
      if (!isKnown(k)) return el('li', {}, el('strong', {}, label + ': '), el('span', { class: 'unknown' }, 'unknown (' + k.unknown + ')'), extra)
      const items = k.value.items
      const named = (list) => list.map((x, i) => [i ? '; ' : '', line(x)])
      return el('li', {}, el('strong', {}, label + ': '), String(items.length + (k.value.more || 0)),
        items.length ? [' — ', named(items.slice(0, SHOWN)), items.length > SHOWN ? fold((items.length - SHOWN) + ' more', named(items.slice(SHOWN))) : null, k.value.more ? ' · ' + k.value.more + ' not listed' : null] : null, extra)
    }
    const quota = (q) => q ? q.left + ' % of ' + (q.seconds ? span(q.seconds) : q.window) + ' left' + (q.headroom !== undefined ? ' (headroom ' + q.headroom + ' above the reserve)' : '') + (q.resetsAt ? ', resets ' + clockOf(q.resetsAt) : ', reset unknown') : 'quota not tracked'
    const likely = (t) => isKnown(t.likely) ? (t.likely.value ? 'likely ' + t.likely.value.name : 'no Worker that takes work now can take it') : 'its Worker is unknown (' + t.likely.unknown + ')'
    const stalled = now.stalled
    const rows = el('ul', {},
        row('Free', now.free, (f) => f.name + ' (' + quota(f.quota) + (keptOut.has(f.worker) ? '; excluded from teams: free for other steps, not team work' : '') + ')', has(now.free) && ready ? [' · ' + qty(ready, 'task') + ' ready: ', pageLink('board', 'Open Board')] : null),
        // Who has no reading by name; why, and that they are not counted free, folded (T239).
        has(now.quotaUnknown) ? row('Quota unknown', now.quotaUnknown, (u) => u.name, keptFold('quota-unknown', 'Why', 'Not counted free: ', now.quotaUnknown.value.items.map((u, i) => [i ? '; ' : '', u.name + ' (' + u.why + ')']))) : null,
        row('Stalled', stalled, (s) => [s.name + ' ', s.runId ? runOpen(s.runId) : null], [has(stalled) ? whatIs('stalled') : null,
          isKnown(stalled) && stalled.value.unread ? el('span', { class: 'unknown' }, ' ' + stalled.value.unread) : null]),
        row('No quota left', now.noQuota, (n) => n.name + (isKnown(n.until) ? ' until ' + clockOf(n.until.value) + ' (' + relative(n.until.value) + ')' : ', no reset known')),
        has(now.cannotWork) ? row('Cannot work', now.cannotWork, (w) => w.name + ' (' + w.reason + ')') : null,
        has(now.ready) ? row('Ready', now.ready, (t) => '"' + t.title + '": ' + likely(t)) : null)
    if (!folded) return el('section', { class: 'right-now', 'aria-label': 'Right now' }, el('h3', {}, 'Right now'), rows)
    // On the Workers page, beside the accounts that say the same by account (T239): folded under its heading, each row that
    // names someone a chip there; open while someone is stalled or cannot work, which is never folded away.
    const count = (k) => isKnown(k) ? k.value.items.length + (k.value.more || 0) : 0
    // The rows the counts and the accounts' cards above and below do not already say: who is stalled, cannot work, or has no reading, and the ready tasks.
    const chips = [[stalled, 'stalled', 'bad'], [now.cannotWork, 'cannot work', 'bad'], [now.quotaUnknown, 'quota unknown', 'warn'], [now.ready, 'ready', 'info']]
      .filter(([k]) => k && count(k)).map(([k, word, tone]) => [' ', chip(count(k) + ' ' + word, tone)])
    const details = el('details', { class: 'right-now' }, el('summary', {}, el('h3', {}, 'Right now'), chips), rows, asOf ? el('p', { class: 'muted' }, 'Roster read ', ago(asOf)) : null)
    keepOpen(details, 'right-now', has(stalled) || has(now.cannotWork))
    return el('section', { class: 'panel', 'aria-label': 'Right now' }, details)
  }
  // A fold the operator opens or closes stays so through the refresh; until they do, it is open while \`alarm\` holds.
  const keepOpen = (details, key, alarm) => {
    if (openFolds.has(key) || (!closedFolds.has(key) && alarm)) details.open = true
    details.addEventListener('toggle', () => { if (details.open) { openFolds.add(key); closedFolds.delete(key) } else { openFolds.delete(key); closedFolds.add(key) } })
  }
  async function workersView() {
    const roster = await api('roster')
    // The ready tasks as capacity now read them, when it could read every active project; else the board's own count.
    const now = roster.now
    const counted = readyNow(now)
    const ready = counted !== undefined ? counted : await readyTasks()
    // Workers serve every project (T253): each step's project by its name, from the board when it can be read, else by its id.
    let titles = new Map()
    try { titles = new Map((await api('projects')).projects.map((p) => [p.projectId, p.title])) } catch {}
    const projectName = (id) => titles.get(id) || id
    // One Worker's card; inside its account's section it is headed by its work (its role or tier).
    const card = (w, inAccount) => el('article', { class: 'panel request worker', 'aria-label': w.name + ' (' + w.worker + ')' },
      el('h4', {}, inAccount ? cut(w.name)[1] : w.name),
      isKnown(w.description) ? el('p', {}, w.description.value) : null,
      el('p', { class: 'status-line' }, chip(statusOf(w), (TONE[w.availability.state] || [w.availability.state, 'idle'])[1]), w.availability.state === 'resting' ? whatIs('resting') : w.availability.state === 'quarantined' ? whatIs('quarantine') : null),
      doingOf(w, projectName),
      w.limits.length ? el('div', {}, w.limits.map((l) => el('div', { class: 'state resting' }, l.capability + ' is held off until ' + clockOf(l.until) + ' (' + relative(l.until) + ')'))) : null,
      // The operator's own choice (D58): a chip where they look for the Worker, never folded; what it means is behind its "?".
      w.teams && isKnown(w.teams) ? el('p', { class: 'teams' }, chip('Excluded from teams', 'info'), whatIs('team')) : null,
      detailsOf([
        ['Worker id', shortId(w.worker, 'Copy Worker ID')],
        isKnown(w.work) && w.work.value.items.length ? ['Steps, as recorded', el('div', {}, w.work.value.items.map((i) => el('div', {}, i.summary)))] : null,
        w.teams && isKnown(w.teams) ? ['Teams', w.teams.value.summary] : w.teams ? ['Teams', el('span', { class: 'unknown' }, 'unknown (' + w.teams.unknown + ')')] : null,
        isKnown(w.description) ? null : ['What it is', el('span', {}, el('span', { class: 'tag' }, 'derived'), ' ' + w.derived + ' (no description is configured)', whatIs('derived'))],
        isKnown(w.work) ? (w.work.value.unread ? ['Doing now', el('span', { class: 'unknown' }, w.work.value.unread)] : null) : ['Doing now', el('span', { class: 'unknown' }, 'unknown (' + w.work.unknown + ')')],
        w.liveness && !isKnown(w.liveness) ? ['Liveness', el('span', { class: 'unknown' }, 'unknown (' + w.liveness.unknown + ')')] : null,
        ['Account', isKnown(w.account) ? recordText(w.account.value) : el('span', { class: 'unknown' }, 'unknown (' + w.account.unknown + ')')],
        ['Serves', w.tier + ' tier, ' + w.quotaClass + ', ' + w.locality + '; provider ' + w.provider + ', family ' + textOf(w.family) + ', role ' + textOf(w.role, (r) => r === null ? 'none' : r)],
        inAccount ? null : ['Quota', isKnown(w.pools) ? (w.pools.value.length ? el('div', {}, poolsView(w.pools.value)) : 'no pool on its account') : el('span', { class: 'unknown' }, 'unknown (' + w.pools.unknown + ')')],
        !inAccount && isKnown(w.pools) && readTimes(w.pools.value) ? ['Quota read', readTimes(w.pools.value)] : null,
        ['Load', textOf(w.load, (l) => l.running + ' of ' + l.slots + ' running, ' + l.queued + ' queued, ' + l.pending + ' routed and not started')],
      ]))
    // An account once: its name, its Workers' roles, what stops it (resting, signed out, quarantined, one person on two accounts), and its quota.
    const accountView = (g) => {
      const a = g.account
      const record = isKnown(a.record) ? a.record.value : undefined
      const pools = poolsOf(g)
      const unknownPools = g.workers.find((w) => !isKnown(w.pools))
      // A card: its name and how many Workers; what stops it, in sight; its quota as one line, its shortest window, every
      // window under Quota (T239); its facts and its Workers' cards folded.
      const shortest = pools && pools.length ? shortestOf(g) : undefined
      return el('section', { class: 'panel account', 'aria-label': 'Account ' + g.name },
        // Its name and how many Workers; their roles are their cards' headings, and listed under its details (T171); its rest as its chip.
        el('div', { class: 'line' }, el('h3', {}, g.name, el('span', { class: 'muted' }, ' · ' + qty(g.workers.length, 'Worker')), whatIs('account')),
          a.limitUntil ? chip('Resting until ' + clockOf(a.limitUntil) + ' (' + relative(a.limitUntil) + ')', 'warn') : null),
        record && record.status !== 'ready' ? el('p', { class: 'state ' + (record.status === 'quarantined' || record.status === 'signed-out' ? 'unavailable' : 'unknown') }, 'Its account is ' + record.status.replace('-', ' ') + (record.quarantine ? ' (' + record.quarantine.reason + (record.quarantine.detail ? ': ' + record.quarantine.detail : '') + ')' : '')) : null,
        record && record.sameAs ? el('p', { class: 'state failed' }, 'Signed in as the same person as ' + record.sameAs.join(', ')) : null,
        shortest ? el('div', { class: 'quota-line' }, shortest.bar, shortest.text || 'quota not tracked', whatIs('quota')) : null,
        pools && !pools.length ? el('p', { class: 'muted' }, 'Quota not tracked') : null,
        // Every window of its quota first under its details, the ones at their limit first.
        detailsOf([
          pools && pools.length ? ['Quota', el('div', { class: 'quota' }, poolsView(pools, !!a.limitUntil))] : null,
          ['Account', recordText(a)],
          ['Roles', g.workers.map((w) => cut(w.name)[1]).join(', ')],
          pools ? (pools.length ? null : ['Quota', 'no pool on its account']) : ['Quota', el('span', { class: 'unknown' }, 'unknown (' + (unknownPools ? unknownPools.pools.unknown : 'not read') + ')')],
          pools && readTimes(pools) ? ['Quota read', readTimes(pools)] : null,
        ]),
        alarmsOf(g.workers, true),
        workersFold(g.key, g.workers, (w) => card(w, true)))
    }
    // An account's Worker cards under one fold (T239), its summary their availability as chips. What of them blocks work
    // (unavailable, quarantined, a capability held off) and each run whose liveness needs a look are never folded (T172,
    // PROP-0013): each is a line on the account's card, by its Worker's work, above the fold (alarmsOf).
    const TONE = { ready: ['free', 'ok'], busy: ['working', 'info'], resting: ['resting', 'warn'], unavailable: ['unavailable', 'bad'], quarantined: ['quarantined', 'bad'] }
    const LIVE = { stalled: 'Stalled', looking: 'Being looked at', unknown: 'Not known to be gone' }
    const alarmsOf = (workers, inAccount) => {
      const lines = workers.flatMap((w) => {
        const who = el('strong', {}, (inAccount ? cut(w.name)[1] : w.name) + ': ')
        const a = w.availability
        return [
          a.state === 'unavailable' || a.state === 'quarantined' ? el('li', {}, who, chip(statusOf(w), 'bad')) : null,
          ...w.limits.map((l) => el('li', { class: 'state resting' }, who, l.capability + ' is held off until ' + clockOf(l.until) + ' (' + relative(l.until) + ')')),
          ...(w.liveness && isKnown(w.liveness) ? w.liveness.value : []).map((r) => el('li', {}, who, chip(LIVE[r.state] || r.state, r.state === 'unknown' ? 'bad' : 'warn'),
            r.runId ? [' ', runOpen(r.runId)] : null, whatIs(r.state === 'unknown' ? 'held' : 'stalled'), keptFold('live-' + r.execution, 'What to do', r.summary))),
        ].filter(Boolean)
      })
      return lines.length ? el('ul', { class: 'plain alarms', 'aria-label': 'Needs a look' }, lines) : null
    }
    const workersFold = (key, workers, render) => {
      const by = new Map()
      for (const w of workers) by.set(w.availability.state, (by.get(w.availability.state) || 0) + 1)
      const details = el('details', { class: 'workers-fold' },
        el('summary', {}, workers.length === 1 ? 'Worker' : 'Workers', [...by].map(([state, n]) => [' ', chip(n + ' ' + (TONE[state] || [state])[0], (TONE[state] || [state, 'idle'])[1])])),
        el('div', { class: 'workers-grid' }, workers.map(render)))
      keepOpen(details, 'workers-' + key, false)
      return details
    }
    const unheard = isKnown(roster.sources) ? roster.sources.value.filter((s) => s.state !== 'described') : []
    // On the page's grid (T256): the accounts in the main column, Right now and the sources beside them.
    const accounts = isKnown(roster.workers) ? (roster.workers.value.length ? (() => {
      const groups = accountsOf(roster.workers.value)
      const lone = groups.filter((g) => !g.account)
      return el('section', { 'aria-label': 'Accounts' }, el('h2', {}, 'Accounts'), el('div', { class: 'accounts-grid' }, groups.filter((g) => g.account).map(accountView),
        lone.length ? el('section', { class: 'panel account', 'aria-label': 'Workers of no account' }, el('h3', {}, 'Workers of no account'),
          alarmsOf(lone.map((g) => g.workers[0]), false), workersFold('lone', lone.map((g) => g.workers[0]), (w) => card(w, false))) : null))
    })() : el('p', { class: 'muted' }, 'No Workers set up yet · ', pageLink('help', 'How Workers work'))) : el('p', { class: 'unknown' }, 'The Workers are unknown (' + roster.workers.unknown + ').')
    show(
      pageHead('workers'),
      // The counts as Home's chips (T239); a source still loading is said below them.
      availabilityChips(roster, []),
      el('div', { class: 'page-grid' }, el('div', { class: 'col-main' }, accounts), el('div', { class: 'col-side' },
      now && isKnown(roster.workers) && roster.workers.value.length ? glanceView(now, ready, roster.workers.value, true, roster.asOf) : fold('Roster read', ago(roster.asOf)),
      isKnown(roster.sources) ? null : el('p', { class: 'unknown' }, 'Worker sources: unknown (' + roster.sources.unknown + ')'),
      // A source that has not answered: its impact on the counts in sight, a blocking reason too; its times folded (T171).
      unheard.length ? el('div', {}, unheard.map((s) => s.describing
        ? el('div', { class: 'muted' }, s.source + ' loading — counts incomplete', fold('Details', 'Its first read since it started has not landed (' + relative(s.at) + '); its Workers are not listed yet.'))
        : el('div', { class: 'state failed' }, s.source + ' unavailable — counts incomplete' + (s.detail ? ': ' + s.detail : ''), fold('Details', 'It was ' + s.state + ' ' + relative(s.at) + '; its Workers are not listed.')))) : null)))
  }

  // The autonomy policy in force, its history, and a proposed change with its diff. A proposal is
  // asked in the approval queue as a policy-change request; only the operator's approval there applies it.
  async function policyView() {
    let value
    try { value = await api('policy') } catch (error) {
      show(pageHead('policy'), error.status === 503 ? el('p', { class: 'muted' }, 'The approval queue is not running, so there is no autonomy policy to show.') : errorState('The policy could not be read: ' + error.message + '.'))
      return
    }
    const { set, policies, effective, changes, proposals } = value
    // An asked change is decided here, on its own card, as on Home (T95).
    const q = await queue()
    const askedCards = (changes || []).filter((c) => c.state === 'asked').flatMap((c) => {
      const r = q && !q.error ? q.requests.find((x) => x.requestId === c.requestId) : undefined
      return r ? [q.card(r)] : []
    })
    const columns = effective.map((e) => e.projectId ? 'project ' + e.projectId : 'studio')
    const classes = effective[0].effective.map((e) => e.actionClass)
    // The proposed record, edited as a form (a mode per action class, the commands as lines, the
    // expiry and batch numbers) or, folded under Advanced, as JSON; both edit one draft. The queue
    // validates the proposal as it always did: the page refuses nothing the queue would take.
    const fixed = new Set(value.alwaysAsk || [])
    const editor = el('textarea', { 'aria-label': 'Proposed policy record (JSON)', spellcheck: 'false' })
    const note = el('input', { placeholder: 'why (optional)', 'aria-label': 'Note for the proposed change' })
    const preview = el('div', {})
    const form = el('div', {})
    const NEW = '(a new project policy)'
    const pick = el('select', { 'aria-label': 'Policy to change' }, policies.map((p) => el('option', { value: p.id }, p.id)), el('option', { value: NEW }, NEW))
    const selected = () => policies.find((p) => p.id === pick.value)
    let draft
    // The JSON shown under Advanced follows the form; an edit there that is not JSON leaves the form as it was.
    const sync = () => { editor.value = pretty(draft); preview.replaceChildren() }
    const edit = (change) => { change(draft); sync() }
    const hours = (seconds) => String(Math.round(seconds / 36) / 100)
    const minutes = (seconds) => String(Math.round(seconds / 0.6) / 100)
    const number = (label, id, shown, onvalue, extra) => {
      const input = el('input', Object.assign({ id, type: 'number', value: shown, min: '0', step: 'any', class: 'number' }, extra || {}))
      input.addEventListener('input', () => onvalue(input.value === '' ? undefined : Number(input.value)))
      return el('label', { for: id }, label, input)
    }
    // Each mode by its display name (T171); the stored value (auto, notify, ask, forbid) is under About modes and in the JSON.
    const MODE = { auto: 'Automatic', notify: 'Notify', ask: 'Ask approval', forbid: 'Blocked' }
    const modeChip = (m) => chip(MODE[m] || m, m === 'auto' ? 'ok' : m === 'notify' ? 'info' : m === 'ask' ? 'warn' : m === 'forbid' ? 'bad' : 'idle')
    const WHY ={ merge: 'an accepted result lands only on your approval', 'external-send': 'it cannot be undone', deploy: 'it cannot be undone', 'delete-data': 'it cannot be undone', spend: 'it is your decision', charter: 'it is your decision', funding: 'it is your decision', 'policy-change': 'it is your decision', remediation: 'a fix that writes, or a lost run going on, is yours to allow', promotion: 'the system never approves its own change' }
    const buildForm = () => {
      const p = draft
      const studio = p.scope !== 'project'
      const ruleOf = (c) => (p.rules || []).find((r) => r.actionClass === c)
      const modeRow = (c) => {
        const rule = ruleOf(c)
        // A class that always asks: "Approval required" (or "Blocked" prominently when the record forbids it), why on demand.
        if (fixed.has(c)) return el('tr', {}, el('td', {}, c), el('td', {}, el('strong', {}, rule && rule.mode === 'forbid' ? 'Blocked' : 'Approval required')),
          el('td', { class: 'muted' }, rule && rule.mode === 'forbid' ? el('div', { class: 'state failed' }, 'Blocked here; change it under Advanced') : null,
            el('details', { class: 'fold inline' }, el('summary', {}, 'Why always'), 'It always asks, whatever a rule says: ' + (WHY[c] || 'the queue always asks for it') + '.'), whatIs('always-ask')))
        const select = el('select', { id: 'mode-' + c, 'aria-label': 'Mode of ' + c },
          el('option', { value: '' }, studio ? 'Use default (' + MODE[p.default] + ')' : 'Use studio policy'),
          ['auto', 'notify', 'ask', 'forbid'].map((m) => el('option', { value: m }, MODE[m])))
        select.value = rule ? rule.mode : ''
        select.addEventListener('change', () => edit((d) => {
          const kept = (d.rules || []).filter((r) => r.actionClass !== c)
          const old = ruleOf(c)
          d.rules = select.value ? (old ? d.rules.map((r) => r.actionClass === c ? Object.assign({}, r, { mode: select.value }) : r) : kept.concat([{ actionClass: c, mode: select.value }])) : kept
          buildForm()
          document.getElementById('mode-' + c).focus()
        }))
        // Only what the select does not say: the checks its rule requires, and its requests' expiry (T171).
        return el('tr', {}, el('td', {}, el('label', { for: 'mode-' + c }, c)), el('td', {}, select),
          el('td', { class: 'muted' }, rule ? [rule.requires && rule.requires.length ? 'Requires: ' + rule.requires.join(', ') : null, rule.expiresSeconds ? 'Expires: ' + hours(rule.expiresSeconds) + ' h' : null].filter(Boolean).join(' · ') : ''))
      }
      const fallback = el('select', { id: 'policy-default', 'aria-label': 'Default mode' }, el('option', { value: 'ask' }, MODE.ask), el('option', { value: 'forbid' }, MODE.forbid))
      fallback.value = p.default
      fallback.addEventListener('change', () => edit((d) => { d.default = fallback.value; buildForm(); document.getElementById('policy-default').focus() }))
      const commands = el('textarea', { id: 'policy-commands', class: 'lines', 'aria-label': 'Workspace-write commands, one per line', spellcheck: 'false' })
      commands.value = (p.commands || []).join('\\n')
      commands.addEventListener('input', () => edit((d) => {
        const lines = commands.value.split('\\n').map((l) => l.trim()).filter(Boolean)
        if (lines.length) d.commands = lines
        else delete d.commands
      }))
      const project = studio ? null : el('input', { id: 'policy-project', value: p.projectId || '', 'aria-label': 'Project of the new policy' })
      if (project) project.addEventListener('input', () => edit((d) => { d.projectId = project.value.trim(); if (!selected()) d.id = project.value.trim() + '.policy' }))
      const batch = p.batch || {}
      form.replaceChildren(
        el('p', {}, el('strong', {}, p.id), ' · ' + (selected() ? 'Version ' + selected().version + ' → ' + p.version : 'New project policy · Version ' + p.version),
          project ? el('span', {}, ' · ', el('label', { for: 'policy-project' }, 'project ', project)) : null),
        table(['Action type', 'Mode', 'Notes'], classes.map(modeRow), 'modes'),
        el('div', { class: 'batch-actions' },
          studio ? el('label', { for: 'policy-default' }, 'Default mode', fallback) : null,
          number('Request expiry (h)', 'policy-expiry', hours(p.expiry.defaultSeconds), (h) => edit((d) => { d.expiry = Object.assign({}, d.expiry, { defaultSeconds: h === undefined ? undefined : Math.round(h * 3600) }) })),
          number('Maximum expiry (h)', 'policy-expiry-max', hours(p.expiry.maxSeconds), (h) => edit((d) => { d.expiry = Object.assign({}, d.expiry, { maxSeconds: h === undefined ? undefined : Math.round(h * 3600) }) })),
          number('Batch size (requests)', 'policy-batch-size', batch.maxSize === undefined ? '' : String(batch.maxSize), (n) => edit((d) => {
            const next = Object.assign({}, d.batch, { maxSize: n })
            if (next.maxSize === undefined && next.maxWaitSeconds === undefined) delete d.batch; else d.batch = next
          }), { step: '1' }),
          number('Batch delay (min)', 'policy-batch-wait', batch.maxWaitSeconds === undefined ? '' : minutes(batch.maxWaitSeconds), (m) => edit((d) => {
            const next = Object.assign({}, d.batch, { maxWaitSeconds: m === undefined ? undefined : Math.round(m * 60) })
            if (next.maxSize === undefined && next.maxWaitSeconds === undefined) delete d.batch; else d.batch = next
          }))),
        el('label', { for: 'policy-commands' }, 'Workspace-write commands', commands),
        fold('How commands match', 'One command per line; a command a Worker runs is judged a workspace write when it matches a line word for word.'))
    }
    const fill = () => {
      const p = selected()
      draft = p ? Object.assign({}, p, { version: p.version + 1 })
        : { schema: 'autonomy-policy@1.0', id: 'project-id.policy', version: 1, scope: 'project', projectId: 'project-id', narrows: policies[0].id, rules: [{ actionClass: 'merge', mode: 'ask' }], default: 'ask', expiry: { defaultSeconds: 86400, maxSeconds: 1209600 } }
      sync()
      buildForm()
    }
    pick.addEventListener('change', fill)
    const parsed = () => {
      try { return JSON.parse(editor.value) } catch (error) { preview.replaceChildren(el('p', { class: 'state failed' }, 'Not JSON: ' + error.message)); return undefined }
    }
    // An edit of the JSON that parses to a record is the draft, and the form shows it.
    editor.addEventListener('input', () => {
      let next
      try { next = JSON.parse(editor.value) } catch { return }
      if (next && typeof next === 'object' && !Array.isArray(next) && Array.isArray(next.rules) && next.expiry && typeof next.expiry === 'object') { draft = next; buildForm() }
    })
    const showDiff = () => {
      const proposed = parsed()
      if (proposed !== undefined) preview.replaceChildren(el('p', { class: 'muted' }, selected() ? 'Changes to ' + selected().id + ' version ' + selected().version + ':' : 'A new policy:'), diffView(selected(), proposed))
    }
    const propose = async () => {
      const proposed = parsed()
      if (proposed === undefined) return
      try {
        const { change, request } = await api('policy/propose', { policy: proposed, note: note.value })
        say('proposed ' + change.changeId + ': decide request ' + request.requestId + ' in the approval queue')
        report(true, 'Proposed: ' + change.policy.id + ' version ' + change.policy.version, ['Approval needed — nothing changes until you approve it, at the top of this page or on Home.',
          fold('Record IDs', el('div', {}, 'Recorded as change ', shortId(change.changeId, 'Copy change ID'), '; request ', shortId(request.requestId, 'Copy request ID'), '.'))])
        await policyView()
      } catch (error) { preview.replaceChildren(el('p', { class: 'state failed', role: 'alert' }, 'Not proposed: ' + error.message)) }
    }
    const when = (t) => t ? ago(t) : '-'
    show(
      pageHead('policy'),
      askedCards.length ? el('section', { 'aria-label': 'Changes awaiting approval' },
        el('h3', {}, 'Changes awaiting approval · ' + askedCards.length),
        askedCards) : null,
      // The source of the policy in force in two words; its change id, what keeps it, and the hashes folded (T171).
      set ? el('div', {}, el('p', {}, 'Active policy · ' + (set.source === 'store' ? 'Approved change' : 'Configuration')),
        el('details', { class: 'fold' }, el('summary', {}, 'Exact set'),
          set.source === 'store' ? el('div', {}, 'The change ', shortId(set.changeId, 'Copy change ID'), ' you approved, kept while the configuration it came from is unchanged.') : el('div', {}, 'The configuration in force.'),
          el('div', {}, 'set ', shortId(set.hash, 'Copy set hash')), set.configHash ? el('div', { class: 'muted' }, 'configuration ', shortId(set.configHash, 'Copy configuration hash')) : null)) : null,
      el('p', {}, ['auto', 'notify', 'ask', 'forbid'].map((m) => [modeChip(m), ' ']), whatIs('mode')),
      fold('About modes', 'Automatic: it runs on its own · Notify: it runs, then tells you · Ask approval: it waits for your approval on Home · Blocked: it never runs. Stored as auto, notify, ask, and forbid.'),
      table(['Action type'].concat(columns), classes.map((c) => el('tr', {}, el('td', {}, c), effective.map((e) => {
        const m = (e.effective.find((x) => x.actionClass === c) || {}).mode
        return el('td', m ? { title: m } : {}, m ? MODE[m] || m : '-')
      }))), 'queue'),
      el('h3', {}, 'Policies'),
      table(['Policy', 'Scope', 'Version'], policies.map((p) => el('tr', {}, el('td', {}, el('code', {}, p.id)), el('td', {}, p.scope + (p.projectId ? ' ' + p.projectId : '')), el('td', {}, String(p.version))))),
      proposals ? el('section', { class: 'panel', 'aria-label': 'Propose a change' },
        el('h3', {}, 'Propose a change'),
        el('p', { class: 'muted' }, 'Preview your changes, then submit for approval.'),
        el('p', {}, el('label', {}, 'Policy ', pick)),
        form,
        el('details', { class: 'advanced' }, el('summary', {}, 'Advanced: the record as JSON'), el('p', { class: 'muted' }, 'Every field of the record, as the form edits it; an edit here shows in the form once it is valid JSON. Nothing changes until you approve the change in the approval queue, and the whole set must load as a configuration would.'), editor),
        el('p', {}, note),
        // What each does, its accessible description (T191): a proposal is decided by Approve / Deny on its card.
        el('div', { class: 'actions' }, decision('Show change', 'shows what your edit changes, below; proposes nothing', { onclick: showDiff }),
          decision('Propose', 'asks for your approval; nothing changes until you approve it', { class: 'primary', onclick: propose })),
        preview) : el('p', { class: 'muted' }, 'This approval queue changes its policy by configuration and a restart only.'),
      changes ? el('h3', {}, 'History') : null,
      changes && !changes.length ? el('p', { class: 'muted' }, 'No policy changes yet.') : null,
      // Each change by its policy and version, its state as a chip, and when; its effect counted, its id behind a copy button (T171).
      changes && changes.length ? table(['Policy', 'State', 'Proposed', 'In force from', 'Effect'], changes.map((c) => el('tr', {},
        el('td', {}, c.policy.id + ' ' + (c.previous ? c.previous.version + ' → ' : '') + c.policy.version + (c.origin ? ' (proposed by the queue)' : '')),
        el('td', { class: 'nowrap' }, c.state === 'asked' ? decideLink(c.requestId, 'Approval needed')
          : chip(c.state + (c.declined ? ' (' + c.declined.cause + ')' : ''), c.state === 'applied' ? 'ok' : c.state === 'declined' ? 'bad' : 'idle')),
        el('td', { class: 'muted' }, when(c.proposedAt)),
        el('td', { class: 'muted' }, c.applied ? [when(c.applied.at), c.retired ? [' until ', when(c.retired.at)] : null] : '-'),
        el('td', {}, c.effect.length ? fold(qty(c.effect.length, 'action') + ' changed', c.effect.map((e) => el('div', {}, (e.projectId || 'studio') + ' ' + e.actionClass + ' ' + e.from + '→' + e.to))) : '-',
          copyId('Copy change ID', c.changeId)),
      ))) : null,
      changes && changes.length ? el('details', {}, el('summary', {}, 'Diffs'), changes.map(changeView)) : null)
    fill()
  }

  let current = new URLSearchParams(location.search).get('run')
  let view = new URLSearchParams(location.search).get('view')
  function go(runId) {
    current = runId || null
    view = null
    confirming = false
    // Home keeps the project it was filtered to in its address (T253).
    history.pushState(null, '', runId ? '?run=' + encodeURIComponent(runId) : homeProject ? '?project=' + encodeURIComponent(homeProject) : '/ui/')
    refresh()
  }
  // Home, scrolled to one request's card, which takes the focus: every project shown, so the card is there.
  function openRequest(requestId) {
    focusRequest = requestId
    homeProject = null
    current = null
    view = null
    confirming = false
    history.pushState(null, '', '?request=' + encodeURIComponent(requestId))
    refresh()
  }
  const nav = (id, name) => document.getElementById(id).addEventListener('click', (e) => {
    e.preventDefault()
    current = null
    view = name
    confirming = false
    // The Board's address names the project it shows (T253), so a reload shows the same board.
    history.pushState(null, '', '?view=' + name + (name === 'board' && boardProject ? '&project=' + encodeURIComponent(boardProject) : ''))
    refresh()
  })
  document.getElementById('home-link').addEventListener('click', (e) => { e.preventDefault(); go() })
  nav('board-link', 'board')
  nav('workers-link', 'workers')
  nav('policy-link', 'policy')
  nav('help-link', 'help')
  window.addEventListener('popstate', () => {
    const query = new URLSearchParams(location.search)
    current = query.get('run')
    view = query.get('view')
    // The project each page shows is in its address (T253): Home's filter, the Board's project.
    if (view === 'board') boardProject = query.get('project')
    else if (!view && !current) homeProject = query.get('project')
    confirming = false
    refresh()
  })
  // The page shown is marked in the navigation and named in the window's title.
  const mark = () => {
    const page = view === 'policy' || view === 'board' || view === 'workers' || view === 'help' || view === 'reports' ? view : current ? 'run' : 'home'
    for (const [id, name] of [['home-link', 'home'], ['board-link', 'board'], ['workers-link', 'workers'], ['policy-link', 'policy'], ['help-link', 'help']]) {
      const link = document.getElementById(id)
      if (name === page || ((page === 'run' || page === 'reports') && name === 'home')) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    document.title = badge() + 'system — ' + PAGES[page][0] + (current ? ' ' + current : '')
  }
  // Production states (T170): a skeleton while a page first loads; "updated 12 s ago" in the header, ticking without
  // being announced; and, when a refresh fails over a page already shown, a stale banner that says when the data
  // shown was read. A page that never loaded shows its error with one next action, Try again.
  const stale = document.getElementById('stale')
  let readAt = 0
  // A message in the header ("proposed …", "could not refresh: …") stays until the next refresh that succeeds.
  const say = (text) => { status.textContent = text; status.dataset.message = '1' }
  const freshness = () => {
    if (status.dataset.message || !readAt) return
    const s = Math.max(0, Math.round((Date.now() - readAt) / 1000))
    const text = 'updated ' + (s < 60 ? s + ' s' : Math.round(s / 60) + ' min') + ' ago'
    if (status.textContent !== text) status.textContent = text
  }
  setInterval(freshness, 1000)
  // Whether the page the address names is on screen, read whole at least once.
  const pageShown = () => { const head = main.querySelector('[data-page]'); return !!head && head.dataset.page === shownPage() && !head.dataset.failed }
  async function refresh() {
    mark()
    // Help reads nothing from the server: it shows with or without a token.
    if (view === 'help') { stale.hidden = true; helpView(); if (token) waits = await readWaiting(); mark(); return }
    if (!token) { show(el('p', {}, 'Open the link that ', el('code', {}, 'system ui'), ' prints.')); return }
    const want = shownPage()
    if (!pageShown() && !main.querySelector('.loading')) {
      stale.hidden = true
      main.setAttribute('aria-busy', 'true')
      main.replaceChildren(el('p', { class: 'loading' }, 'Loading…'))
    }
    try {
      await (view === 'policy' ? policyView() : view === 'board' ? boardView() : view === 'workers' ? workersView() : view === 'reports' ? reportsView() : current ? detail(current) : list())
      readAt = Date.now()
      stale.hidden = true
      delete status.dataset.message
      freshness()
    } catch (error) {
      if (want === shownPage()) {
        if (pageShown()) {
          const text = 'Stale: the last refresh failed (' + error.message + '). Showing what was read at ' + new Date(readAt).toLocaleTimeString() + '; trying again every 5 s.'
          if (stale.textContent !== text) stale.textContent = text
          stale.hidden = false
        } else {
          const failed = errorState('This page could not be loaded: ' + error.message + '.')
          failed.dataset.page = want
          failed.dataset.failed = '1'
          main.replaceChildren(failed)
        }
        say('could not refresh: ' + error.message)
      }
    }
    main.removeAttribute('aria-busy')
    // Home reads what waits as it renders; any other page reads the same.
    if (view || current) waits = await readWaiting()
    mark()
  }
  refresh()
  // The policy page holds an edit in progress, and an open confirmation a move not yet made: neither is refreshed away.
  setInterval(() => { if (view !== 'policy' && view !== 'help' && !confirming && !document.hidden && !main.contains(document.activeElement)) refresh() }, 5000)
})()
`
