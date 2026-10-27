import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderShell } from '../src/ui/shell.ts'
import { APP_CSS } from '../src/ui/styles/index.ts'

/** The client's sources: `packages/plugins/web-ui/client/` (the script); the page and the stylesheet are `src/ui/`. */
const CLIENT_SOURCE = fileURLToPath(new URL('../client/', import.meta.url))

/** The page as the server renders it. */
export const PAGE_HTML = renderShell({ stylesheets: [{ src: '/ui/app.css' }], scripts: [{ src: '/ui/app.js' }] })
export { APP_CSS }

let built: string | undefined

/**
 * The compiled client, as the package's build writes it to `lib/client/`, built into a temporary directory of
 * this process (never into the package: a test's tree may be read-only). The web UI is given it as `clientDir`;
 * the page and the stylesheet the server renders are written beside the script for the layout checks to read.
 */
export function builtClient(): string {
  if (built) return built
  const out = mkdtempSync(join(tmpdir(), 'web-ui-client-'))
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  execFileSync(process.execPath, [tsc, '-p', join(CLIENT_SOURCE, 'tsconfig.json'), '--outDir', out], { stdio: 'pipe' })
  writeFileSync(join(out, 'index.html'), PAGE_HTML)
  writeFileSync(join(out, 'app.css'), APP_CSS)
  return (built = out)
}
