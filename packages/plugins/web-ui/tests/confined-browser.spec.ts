// A Worker runs the web UI's browser tests in its own confinement (T247): one headless browser test,
// run by vitest under the confinement a run's check gets (the agents' read confinement, the host
// read-only, no network, a private /tmp, the daemon's scrubbed environment), passes there; and where
// no Chrome is visible, the same test is skipped with a note naming why, the run says so loudly at
// its end, and it reports `browser-tests-not-run` in a check's report file, through the whole
// chain a check's `corepack pnpm test:affected` runs: the check's launcher, pnpm's lifecycle runner
// (which passes only fds 0 to 2), the repository's runner (scripts/test-groups.ts), and vitest.
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { dshHome } from '@tsuuanmi/system-libs'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { needsBubblewrap } from '../../../agent-runtime-core/tests/host.ts'
import AgentRuntimeRegistry, { childEnvironment, type Confinement, confinedCommand } from '../../agent-runtimes/src/index.ts'
import { launcherArgs, REPORT_PATH, reportChannel, runBounded } from '../../agent-workers/src/setup.ts'
import { browserUnavailable, testChrome } from '../../browser-patchright/tests/support.ts'

const root = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)))
/** The one web UI browser test run inside: Help, in a headless Chrome on the store-backed daemon. */
const FILE = 'packages/plugins/web-ui/tests/help.spec.ts'
const NAME = 'has Help in the navigation'

/** vitest itself, on {@link NAME}. */
const VITEST = [process.execPath, join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', FILE, '--testNamePattern', NAME]

/** The pnpm this suite runs under (`npm_execpath`: its JavaScript entry point, or its native binary): undefined outside pnpm. */
const PNPM = process.env.npm_execpath && isAbsolute(process.env.npm_execpath) && existsSync(process.env.npm_execpath) ? realpathSync(process.env.npm_execpath) : undefined

/** Whether `path` is a native executable (an ELF file), started by itself rather than by Node. */
function isNative(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const magic = Buffer.alloc(4)
    return readSync(fd, magic, 0, 4, 0) === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  } finally {
    closeSync(fd)
  }
}

/**
 * The supported command chain on {@link NAME}: pnpm runs the repository's `test:group` script
 * through its lifecycle runner (a shell, then `node scripts/test-groups.ts group …`), which starts
 * vitest as a process of its own. `-- …` gives vitest the file and the name, whether pnpm passes the
 * `--` on or drops it (scripts/test-groups.ts `splitArgs`).
 */
const CHAIN = (pnpm: string): string[] => [...(isNative(pnpm) ? [pnpm] : [process.execPath, pnpm]), 'run', 'test:group', 'surfaces', '--', FILE, '--testNamePattern', NAME]

/** Where vite writes in the worktree (its cache, its bundled config): a check names them in `checkScratch`. */
const VITE_DIRS = [join(root, 'node_modules', '.vite'), join(root, 'node_modules', '.vite-temp')]

/** Where a Chrome could be found that the hidden run must not see. */
const CHROMES = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']

interface Ran { code: number | null; output: string; report: string }

/**
 * Run `argv` under `confinement` exactly as a check runs its command (agent-workers `confineIn` in
 * check mode, `runBounded`): through the check's launcher, the host read-only, no network, the
 * worktree bound back read-only, vite's directories fresh writable ones (as `checkScratch` gives them), and the check's report
 * file (agent-workers `reportChannel`), named in `SYSTEM_CHECK_REPORT_PATH`.
 */
async function runConfined(confinement: Confinement, env: Record<string, string>, argv: readonly string[], ms: number): Promise<Ran> {
  const scratch = mkdtempSync(join(tmpdir(), 'system-confined-browser-'))
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }))
  const views = VITE_DIRS.map((path, i) => {
    const source = join(scratch, `scratch-${i}`)
    mkdirSync(source)
    return { source, path, writable: true }
  })
  const channel = reportChannel(scratch, confinement)
  const c = confinedCommand(process.execPath, launcherArgs(argv), channel.confinement, {
    readOnly: true, network: false, chdir: root, views: [...views, channel.view],
  })
  const ended = await runBounded(c, { ...env, NO_COLOR: '1', CI: '1' }, AbortSignal.timeout(ms), { report: channel.path })
  expect(ended.started, ended.output.slice(-3000)).toBe(true)
  expect(ended.reportUnread).toBeUndefined()
  return { code: ended.code, output: ended.output, report: ended.report ?? '' }
}

describe('a Worker runs the browser tests in its confinement (T247)', { timeout: 240_000 }, () => {
  needsBubblewrap()
  beforeEach((context) => {
    // CI (SYSTEM_REQUIRE_BROWSER=1) requires this verification: there an unusable browser fails it, never skips it.
    const why = browserUnavailable({ headless: true })
    if (why && process.env.SYSTEM_REQUIRE_BROWSER !== '1') context.skip(why)
    // vite's directories are mounted over their paths: inside a check the worktree is read-only, so they must exist already.
    for (const dir of VITE_DIRS.filter((path) => !existsSync(path))) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch (error) {
        context.skip(`${dir} cannot be made here (${(error as NodeJS.ErrnoException).code})`)
      }
    }
  })

  const boot = async (): Promise<Context> => {
    const ctx = new Context()
    await ctx.plugin(AgentRuntimeRegistry)
    return ctx
  }

  /**
   * The daemon's scrubbed environment, as a check gets it, without the CI switch that turns a missing
   * browser into a thrown error, and without the report channel of a check this suite may itself run in.
   */
  const environment = (): Record<string, string> => {
    const env = childEnvironment()
    for (const name of ['SYSTEM_REQUIRE_BROWSER', REPORT_PATH]) delete env[name]
    return env
  }

  it('passes a headless web UI browser test inside the confinement a check gets: the managed Chrome bound back read-only, no network', async () => {
    const ctx = await boot()
    // The Worker's confinement: the worktree bound back read-only (it may lie under the hidden DSH home), and System's Node.
    const confinement = ctx.agentRuntimes.confinement({ readOnly: [root, realpathSync(process.execPath)] })
    expect(confinement.readOnly).toContain(join(dshHome(), 'system', 'browsers'))
    const ran = await runConfined(confinement, environment(), VITEST, 200_000)
    expect(ran.output, ran.output.slice(-3000)).toMatch(/Tests\s+1 passed/)
    expect(ran.code, ran.output.slice(-3000)).toBe(0)
    expect(ran.output).not.toMatch(/BROWSER TESTS DID NOT RUN/)
    expect(ran.report).toBe('')
  })

  it('skips the test where no Chrome is visible, its note naming why, says so at the end of the run, and reports browser-tests-not-run to the check through the whole chain: launcher, pnpm run, runner, vitest', { timeout: 600_000 }, async (context) => {
    // The chain starts at pnpm: run outside it (vitest directly), there is no pnpm to start it with.
    if (!PNPM) context.skip('not run under pnpm (no npm_execpath): the chain a check runs starts at pnpm')
    const ctx = await boot()
    // pnpm's own files, bound back read-only where they lie under a hidden directory.
    const base = ctx.agentRuntimes.confinement({ readOnly: [root, realpathSync(process.execPath), dirname(dirname(PNPM!))] })
    // Every place a Chrome is found hidden: the standard paths, the one found here, the managed build, the developer cache.
    const homes = [...new Set([homedir(), userInfo().homedir])]
    const hidden = [...CHROMES, testChrome!, ...homes.flatMap((home) => [join(home, '.dsh', 'system', 'browsers'), join(home, '.cache', 'system-chrome')])].filter((path) => existsSync(path))
    const confinement: Confinement = { bwrap: base.bwrap, hide: [...base.hide, ...hidden], readOnly: base.readOnly.filter((path) => !path.endsWith(join('system', 'browsers'))), writable: base.writable }
    const env = environment()
    delete env['CHROME_PATH']
    // pnpm's lifecycle runner passes the suite only fds 0 to 2: the report reaches the check by its report file's name.
    const ran = await runConfined(confinement, env, CHAIN(PNPM!), 540_000)
    expect(ran.code, ran.output.slice(-3000)).toBe(0)
    expect(ran.output).not.toMatch(/Tests\s+1 passed/)
    expect(ran.output).toMatch(/!!! BROWSER TESTS DID NOT RUN: 1 browser test skipped: no usable Chrome \(CHROME_PATH, .*\)\. A pass of this run says nothing of them\./)
    expect(ran.report).toMatch(/^browser-tests-not-run: 1 browser test skipped: no usable Chrome \(/)
  })
})
