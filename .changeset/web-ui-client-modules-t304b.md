---
'@tsuuanmi/system-web-ui': patch
---

The web UI's script is typed modules: `client/app.ts`, 2,692 lines with about 460 `any`, is split by page and concern into modules of under 600 lines each with no `any` (`app.ts` is now a classic entry that loads `boot.js`; the server serves every compiled `.js` file of `clientDir`), the API's response types are one declaration file, `src/api.d.ts`, imported by the server and the client, and the client is compiled with unused locals refused. The page shows and does what it did (PROP-0018 T15, T304b).
