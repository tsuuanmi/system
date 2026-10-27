import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The client's sources: `packages/plugins/web-ui/client/`. */
export const CLIENT_SOURCE = fileURLToPath(new URL('../client/', import.meta.url))

let built: string | undefined

/**
 * The compiled client, as the package's build writes it to `lib/client/`, built into a temporary directory of
 * this process (never into the package: a test's tree may be read-only). The web UI is given it as `clientDir`.
 */
export function builtClient(): string {
  if (built) return built
  const out = mkdtempSync(join(tmpdir(), 'web-ui-client-'))
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  execFileSync(process.execPath, [tsc, '-p', join(CLIENT_SOURCE, 'tsconfig.json'), '--outDir', out], { stdio: 'pipe' })
  for (const file of ['index.html', 'app.css']) copyFileSync(join(CLIENT_SOURCE, file), join(out, file))
  return (built = out)
}
