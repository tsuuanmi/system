---
paths:
  - packages/plugins/web-ui/
  - packages/ui-ops/
owner: lead
version: 1
---
# Review guide: the web UI

## What failure looks like here
- A page that shows a state the system does not hold: a count computed in the browser from a truncated list, a time shown in the wrong zone, a status that reads as success while the record says failed.
- A control that acts without the approval it implies (a button that approves, merges, or retries), or that acts on a stale subject (the page was loaded before the tree moved).
- A secret, a credential path, or a private classification rendered into a page or its JSON (INV-8, INV-12).
- An unbounded list, a poll with no back-off, or a page that fetches the world on load (INV-9).
- A test that needs a real browser and silently skips when none runs: say what ran. A browser launched in a confined sandbox is not available; such tests are marked as not run, with why, never reported as passed.
- A script or style that does not work with the page's content security policy, or HTML built by string concatenation of record text (injection).

## What to check first
1. Every value rendered from a record: is it escaped, bounded, and shown with the unit and time zone it has?
2. Every action: what request it sends, whether the server checks the subject and the policy, never the page.
3. The empty, the failed, and the very large state, each rendered.

## Paths to skip
- `assets.ts` bundles of CSS and icons unless a rule or a string changed; screenshots.

## Nit cap
At most 5 nits in all (visual wording is cheap), then "and N more nits". A nit is never `important`.

## Evidence rule
Every finding names a file and a line and the state of the record that shows it ("`index.ts:1204`: a run with 0 steps renders `NaN%`"). A visual finding says what to look at and where.

## Summary rule
Open with the count: "0 important, 4 nits, 0 pre-existing". If a browser check did not run, say so in the second sentence.
