---
---

The web UI's page is files, not strings: `packages/plugins/web-ui/client/` holds `index.html`, `app.css`, and `app.ts` (TypeScript, the DOM lib), built with `tsc` to `lib/client/` and served by the plugin (new optional `clientDir` config) as their bytes with their sha256 as `ETag`, under the same headers and content security policy. `assets.ts` is gone; `pnpm typecheck` and `pnpm lint` cover the client. The page shows and does what it did (PROP-0018 T15, T303c, part 1; T304 types the script).
