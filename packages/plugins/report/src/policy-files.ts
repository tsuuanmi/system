/**
 * The policy files the live install's repository ships (T352): `policies/*.json` as they are at the
 * commit the install was built from (`packages/cli/lib/build-commit`, docs/operations/runbooks.md),
 * read by git, never from the working tree. The install is the checkout this plugin runs from.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { PolicyFiles } from './lead.ts'

const run = promisify(execFile)
/** Policy files one read takes at most (INV-9). */
const MAX_FILES = 50
const STAMP = 'packages/cli/lib/build-commit'

/** The checkout this plugin runs from: packages/plugins/report/{src,lib} is four levels under it. */
const INSTALL = fileURLToPath(new URL('../../../../', import.meta.url))

/** The policy files at the install's build commit; throws (so the row is unknown) when the stamp, git, or a file cannot be read. */
export async function installPolicyFiles(install: string = INSTALL): Promise<PolicyFiles> {
  const commit = (await readFile(join(install, STAMP), 'utf8').catch(() => { throw new Error(`no build stamp ${STAMP} in ${install}: the commit the install runs is not known`) })).trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`the build stamp of ${install} names no commit`)
  const git = async (...args: string[]): Promise<string> => (await run('git', ['-C', install, ...args], { timeout: 20_000, maxBuffer: 4_000_000 })).stdout
  const names = (await git('ls-tree', '--name-only', commit, 'policies/')).split('\n').filter((n) => n.endsWith('.json'))
  if (names.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} policy files at ${commit}`)
  const files: PolicyFiles['files'] = []
  for (const path of names) files.push({ path, record: JSON.parse(await git('show', `${commit}:${path}`)) as Record<string, unknown> })
  return { commit, files }
}
