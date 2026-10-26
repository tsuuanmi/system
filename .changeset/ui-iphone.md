---
"@tsuuanmi/system-web-ui": minor
---

The operator's web UI on their iPhone 16 Pro (T240; rules in `docs/design/web-ui.md`):
- The page lays itself under the Dynamic Island and the home indicator (`viewport-fit=cover`) and keeps its content clear of both with safe-area tokens made of the spacing scale; the header is sticky at the top on a phone.
- Where a finger points, every button, fold, field, navigation link, and action link is at least 44 by 44 px; a word's "?" is a small circle in a 44 px target.
- Nothing hovers on a phone: each row of buttons whose effect is a tooltip has one "?" that shows what each does under the row on a tap; a second tap, a tap outside, or Escape hides it. A word's "?" also closes on a tap outside.
- On a touch screen the type scale is 13, 16, and 20 px and every field is 16 px, so Safari never zooms into a field it focuses.
- A run's primary action (the plan's Approve and Deny, else Stop run or Retry failed step) is a bar at the bottom of the screen on a phone, above the home indicator; Stop run and Retry sit in their own row under the run's status line.
- Below 600 px a table is a card per row, each cell named by its column. Safari's bars follow light and dark (`theme-color`).
