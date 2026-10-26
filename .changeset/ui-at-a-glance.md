---
"@tsuuanmi/system-web-ui": minor
---

The operator's web UI at a glance (T239; rules, word counts, and screenshots in `docs/design/web-ui.md`): less text on each page, what needs you first as cards, and a layout that works on a phone.
- A button's effect (its accessible description, T191) is its tooltip, shown on hover and on keyboard focus and hidden by Escape, not text beside every button. Its label stays the concept's one wording (Approve / Deny, Accept / Send back, Confirm / Cancel).
- A card is its title, one status chip, one line of context, and its primary action; for which task, what no response does, and every other fact are under its Details. A batch's note and id are under its Details.
- Home leads with count tiles (Approvals · 3, Reviews · 1, Runs needing attention · 1), their names folded, beside the Workers' availability as chips; the Workers' counts are said once. Then the cards, then what happened, the Workers' capacity, and the recent runs, 5 rows then Show all N.
- The Board leads with its columns; a card's action type, template, and likely Worker are under its Details; the projects, their state, and their moves are under one Projects fold, its summary saying what of them needs you. How a ready task starts is behind the Ready column's "?". An empty column says None.
- A run's page: its state, when it started, and Stop run or Retry in one line; what it waits on as a card; a long answer's first lines and Show all; each step's tier, decisions, and id under its Details; the run's id under Technical details.
- Workers: the counts as Home's chips; Right now folded, the rows that need a look as chips on its summary; each account a card with its rest as a chip, its shortest window as a bar, every window under Details, what of its Workers blocks work or needs a look as a line, and its Workers' cards under one fold.
- Page headers keep a sentence only where the title does not say what the page is for. Relative times read "<1 min ago".
- One spacing scale (4, 8, 16, 24 px), one type scale (12, 14, 18 px), filled primary and outlined secondary buttons, cards on a quiet page, aligned grids, light and dark from the system. At 360 px nothing scrolls sideways, the navigation is one row, and a card's buttons share its width.
