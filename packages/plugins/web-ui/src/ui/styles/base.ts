import { css } from './css.ts'
import { ROOT } from './tokens.ts'

/** The tokens, the page, its header and grid, the building blocks shared by every page: buttons, fields, tables, folds, chips. */
export const BASE = css`/* The visual system (T239, T256, docs/design/web-ui.md#visual-system): every colour, space, type size, and radius is one of
   the tokens below, written once here. Neutral surfaces and one accent colour (the status colours only ever in a chip, with
   their shapes); thin borders and no shadows; an 8 px grid (--s2, with --s1 its half step); three type sizes in the system's
   own font; a filled primary and an outlined secondary button; light or dark as the system prefers; a full-width grid that
   is one column below 900 px and scrolls no page sideways from 360 px. */
${ROOT}
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
/* Home (T256, T274): its Workers in a narrow column beside the cards from 900 px, what else it says below them; from 1600 px
   the starts awaiting approval, what happened and the recent runs a middle column, the Workers' availability and capacity the last. */
.page-grid.three { grid-template-areas: "main" "side" "extra" "more"; } .page-grid.three > .col-side { display: contents; }
.page-grid.three > .col-side > * { min-width: 0; } .page-grid.three > .col-side > .panel { grid-area: side; margin: 0; } .page-grid.three > .col-side > .side-extra { grid-area: extra; display: flex; flex-direction: column; gap: var(--s3); } .page-grid.three .side-extra > * { margin: 0; }
@media (min-width: 900px) { .page-grid.three { grid-template-areas: "main side" "extra side" "more side"; grid-template-rows: auto auto 1fr; } .page-grid.three > .col-side > .panel { position: sticky; top: var(--s3); } }
@media (min-width: 1600px) { .page-grid.three { grid-template-columns: minmax(0, 5fr) minmax(0, 4fr) minmax(0, 3fr); grid-template-areas: "main more side"; grid-template-rows: auto; }
  .page-grid.three > .col-side { display: flex; flex-direction: column; gap: var(--s3); } .page-grid.three > .col-side .panel { margin: 0; } .page-grid.three > .col-side > .panel { position: static; } }
/* A run's Summary (T274) fills the right column's empty room from 1600 px; below it the page keeps its few words. */
@media (max-width: 1599px) { .panel.summary { display: none; } }
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
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }`
