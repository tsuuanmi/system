---
"@tsuuanmi/system-web-ui": patch
---

The web UI's page shell and styles are TypeScript: `client/index.html` is `renderShell` (`src/ui/shell.ts`, scripts and stylesheets with optional integrity hashes and CSP nonces as typed inputs) and `client/app.css` is typed style modules (`src/ui/styles/`: design tokens as typed constants, a `css` helper). The server renders both at start and serves the same bytes with their sha256 `ETag`; `clientDir` now holds only `app.js`. No hand-written HTML or CSS is left in the package; the page shows and does what it did (PROP-0018 T15, T304a).
