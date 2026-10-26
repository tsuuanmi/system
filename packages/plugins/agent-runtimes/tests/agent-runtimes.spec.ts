import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { dshHome, registerSecretPath } from '@tsuuanmi/system-libs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentRuntimesConformance } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { needsBubblewrap } from '../../../agent-runtime-core/tests/host.ts'
import AgentRuntimeRegistry, { BROWSERS_DIR, type Config, confinedCommand, CREDENTIAL_STORES, proveConfinement } from '../src/index.ts'

agentRuntimesConformance('@tsuuanmi/system-agent-runtimes', AgentRuntimeRegistry)

describe('the read confinement of agent children (ADR-0024, INV-8)', () => {
  const saved = { credentials: process.env.CREDENTIALS_DIRECTORY, runtime: process.env.XDG_RUNTIME_DIR }
  const dir = mkdtempSync(join(tmpdir(), 'system-confinement-'))
  afterEach(() => {
    for (const [name, value] of [['CREDENTIALS_DIRECTORY', saved.credentials], ['XDG_RUNTIME_DIR', saved.runtime]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const boot = async (config?: Config) => {
    const ctx = new Context()
    await ctx.plugin(AgentRuntimeRegistry, config)
    return ctx
  }

  it('hides the session\'s runtime directory, the service\'s credentials, and the temporary directories; binds back tools and what the caller names', async () => {
    process.env.CREDENTIALS_DIRECTORY = dir
    process.env.XDG_RUNTIME_DIR = dir
    const ctx = await boot()
    const c = ctx.agentRuntimes.confinement({ writable: ['/work/home'], readOnly: ['/work/space'] })
    expect(c.hide).toEqual(expect.arrayContaining([dir, tmpdir(), '/tmp']))
    // The agent CLIs and the managed Chrome (a Worker's browser tests run on it, T247), then the caller's.
    expect(c.readOnly).toEqual([join(dshHome(), 'system', 'tools'), join(dshHome(), 'system', 'browsers'), '/work/space'])
    expect(c.writable).toEqual(['/work/home'])
    // Resolved once, to an absolute path, when bubblewrap is installed.
    expect(c.bwrap === 'bwrap' || isAbsolute(c.bwrap)).toBe(true)
  })

  it('hides every coding agent\'s login and the operator\'s credential stores from every agent child, whichever agent runs (INV-8)', async () => {
    const ctx = await boot()
    const hide = ctx.agentRuntimes.confinement().hide
    for (const login of ['.claude', '.claude.json', '.codex', '.gemini', join('.config', 'antigravity'), '.cursor', '.ssh', '.netrc', '.git-credentials', '.npmrc']) expect(CREDENTIAL_STORES, login).toContain(login)
    // Each is hidden when present on this host.
    for (const store of CREDENTIAL_STORES) if (existsSync(join(homedir(), store))) expect(hide, store).toContain(join(homedir(), store))
  })

  it('hides every registered secret path while it is registered, and keeps operator entries as given', async () => {
    const secret = join(dir, 'vault.key')
    rmSync(secret, { force: true })
    const ctx = await boot({ bwrap: '/usr/bin/bwrap', hide: ['/keys/typo.key'], readOnly: ['$DSH_HOME/tools', '/opt/agents'] })
    const unregister = registerSecretPath(dir)
    expect(ctx.agentRuntimes.confinement().hide).toEqual(expect.arrayContaining([dir, '/keys/typo.key']))
    unregister()
    expect(ctx.agentRuntimes.confinement()).toMatchObject({ bwrap: '/usr/bin/bwrap', readOnly: [join(dshHome(), 'tools'), '/opt/agents'], writable: [] })
  })

  it('names the managed Chrome it binds back in SYSTEM_BROWSERS_DIR, set inside the confinement, under a custom DSH home too: a child\'s DSH_HOME is scrubbed (T247)', async () => {
    const custom = realpathSync(mkdtempSync(join(tmpdir(), 'system-custom-dsh-')))
    vi.stubEnv('DSH_HOME', custom)
    try {
      const ctx = await boot()
      // No managed Chrome installed there: nothing to name.
      expect(ctx.agentRuntimes.confinement().env).toBeUndefined()
      const browsers = join(custom, 'system', 'browsers')
      mkdirSync(browsers, { recursive: true })
      const c = ctx.agentRuntimes.confinement()
      expect(c.readOnly).toContain(browsers)
      expect(c.env).toEqual({ [BROWSERS_DIR]: browsers })
      // Set inside, after the mounts, by bubblewrap itself, over whatever the child's environment says.
      const { args } = confinedCommand('printenv', [BROWSERS_DIR], c)
      expect(args.join(' ')).toContain(`--setenv ${BROWSERS_DIR} ${browsers}`)
      // An operator who binds back other paths names none.
      expect((await boot({ readOnly: ['$DSH_HOME/system/tools'] })).agentRuntimes.confinement().env).toBeUndefined()
      // A value a shell runs code from, the private /tmp's names, or a name that is no variable is refused.
      for (const name of ['BASH_ENV', 'BASH_FUNC_x%%', 'TMPDIR', 'not a name']) {
        expect(() => confinedCommand('true', [], { ...c, env: { [name]: 'x' } }), name).toThrow(`the confinement's value ${name} is not a name it may set`)
      }
    } finally {
      vi.unstubAllEnvs()
      rmSync(custom, { recursive: true, force: true })
    }
  })

  describe('under the real bubblewrap', () => {
    needsBubblewrap()
    it('shows a child under a custom DSH home the managed Chrome\'s directory, bound back read-only, at the path SYSTEM_BROWSERS_DIR names (T247)', async () => {
      const custom = realpathSync(mkdtempSync(join(tmpdir(), 'system-custom-dsh-')))
      vi.stubEnv('DSH_HOME', custom)
      try {
        const browsers = join(custom, 'system', 'browsers')
        mkdirSync(join(browsers, 'chrome'), { recursive: true })
        const ctx = await boot()
        // The child's environment has no DSH_HOME, as a scrubbed one: the value is the confinement's.
        const c = confinedCommand('sh', ['-c', `ls "$${BROWSERS_DIR}"; touch "$${BROWSERS_DIR}/written" 2>/dev/null && echo writable || echo read-only`], ctx.agentRuntimes.confinement())
        const out = execFileSync(c.command, c.args, { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
        expect(out.split('\n')).toEqual(['chrome', 'read-only', ''])
      } finally {
        vi.unstubAllEnvs()
        rmSync(custom, { recursive: true, force: true })
      }
    })
  })

  it('refuses to bind back a directory that holds a registered secret, wherever it lives', async () => {
    const tools = join(dir, 'tools')
    mkdirSync(tools, { recursive: true })
    writeFileSync(join(tools, 'vault.key'), 'k')
    const ctx = await boot({ readOnly: [tools] })
    const unregister = registerSecretPath(join(tools, 'vault.key'))
    try {
      const c = ctx.agentRuntimes.confinement()
      expect(() => confinedCommand('true', [], c)).toThrow(`binding back ${tools} would expose ${join(tools, 'vault.key')}`)
      expect(await proveConfinement(c)).toMatchObject({ confined: false, detail: expect.stringContaining('would expose') })
    } finally {
      unregister()
    }
  })
})
