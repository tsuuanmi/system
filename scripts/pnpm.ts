/**
 * The pnpm this repository pins (`packageManager` in the root package.json), for the release
 * scripts: never whichever `pnpm` comes first on PATH, and none needed there. The first of these
 * whose `--version` prints the pinned version runs:
 * - the pnpm running this script (`pnpm <script>` names it in `npm_execpath`);
 * - `pnpm` on PATH (the release workflow's, from `pnpm/action-setup`);
 * - `corepack pnpm`, which reads the same field.
 * When none does, nothing runs: the error names the pin and what each candidate said.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
/** How long one candidate may take to print its version (corepack may first download the pinned pnpm). */
const VERSION_MS = 120_000

/** The exact version `packageManager` pins: `pnpm@<x.y.z>`, with corepack's optional `+<hash>` after it. */
export function pinnedPnpm(manifest: { packageManager?: unknown } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { packageManager?: unknown }): string {
  const pinned = /^pnpm@(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\+[\w.-]+)?$/.exec(typeof manifest.packageManager === 'string' ? manifest.packageManager : '')
  if (!pinned) throw new Error(`package.json must pin pnpm as "packageManager": "pnpm@<version>", not ${JSON.stringify(manifest.packageManager)}`)
  return pinned[1]!
}

/** The command (file, then its leading arguments) that runs the pinned pnpm under `env`; throws when none does. */
export function pnpmCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const pinned = pinnedPnpm()
  const running = env.npm_execpath
  const candidates = [
    ...(running && basename(running).startsWith('pnpm') ? [/\.[cm]?js$/.test(running) ? [process.execPath, running] : [running]] : []),
    ['pnpm'],
    ['corepack', 'pnpm'],
  ]
  const said: string[] = []
  for (const [file, ...args] of candidates) {
    let version: string
    try {
      version = execFileSync(file!, [...args, '--version'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: VERSION_MS }).trim()
    } catch (error) {
      said.push(`${[file, ...args].join(' ')}: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : 'failed'}`)
      continue
    }
    if (version === pinned) return [file!, ...args]
    said.push(`${[file, ...args].join(' ')}: ${version.slice(0, 40) || 'no version'}`)
  }
  throw new Error(`pnpm ${pinned} (packageManager in package.json) is not reachable: run this through it, put it on PATH, or install corepack (${said.join('; ')})`)
}

let resolved: string[] | undefined

/** Runs the pinned pnpm in the repository root: returns what it printed, or passes its output through (`inherit`). */
export function pnpm(args: string[], stdio: 'pipe' | 'inherit' = 'pipe'): string {
  resolved ??= pnpmCommand()
  const [file, ...leading] = resolved
  // Inherited, nothing is captured: execFileSync returns null.
  return execFileSync(file!, [...leading, ...args], { cwd: root, encoding: 'utf8', ...(stdio === 'inherit' ? { stdio: 'inherit' as const } : {}) }) ?? ''
}
