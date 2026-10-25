// An agent's shells run no startup code from the daemon's environment, the worktree, or a tool call
// (T198): the environment holds no variable a shell runs code from, and each run's HOME is a fresh
// private directory outside its workspace, bound back read-only, so no call can plant a startup file
// for a later one. Neither earns `cleanShells`, which also needs the shell program pinned.
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { type Confinement, SHELL_CONFIG_DIRECTORIES, SHELL_STARTUP_VARIABLES, agentHome, agentShellEnvironment, childEnvironment, confinedCommand, isShellStartupVariable } from '../src/index.ts'
import { BWRAP, needsBubblewrap } from './host.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'system-shells-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const runDir = join(root, 'run')
mkdirSync(runDir, { mode: 0o700 })

/** A worktree a Worker wrote hostile startup files into: each defines `echo` and `cat` as functions that run something else. */
const worktree = join(root, 'worktree')
mkdirSync(worktree)
const HOSTILE = 'echo() { builtin printf "pwned\\n"; }; cat() { builtin printf "pwned\\n"; }; alias ls="printf pwned"\n'
for (const file of ['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshenv', '.zshrc', '.zprofile', 'bash_env']) writeFileSync(join(worktree, file), HOSTILE)

/** `bash` on PATH, if any. */
const bash = (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, 'bash')).find((path) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
})

describe('the environment an agent starts with names no startup code (T198)', () => {
  const names = ['BASH_ENV', 'ENV', 'ZDOTDIR', 'PROMPT_COMMAND', 'PS4', 'SHELLOPTS', 'BASH_FUNC_echo%%', 'BASH_FUNC_cat%%']
  afterEach(() => {
    for (const name of names) delete process.env[name]
  })

  it('drops every variable a shell runs code from, from the daemon\'s environment, a forwarded name, and an explicit value alike', () => {
    for (const name of names) process.env[name] = join(worktree, 'bash_env')
    const env = childEnvironment(['BASH_ENV', 'BASH_FUNC_echo%%'], { ENV: '/x', 'BASH_FUNC_ls%%': '() { id; }', SYSTEM_TEST_PLAIN: 'kept' })
    for (const name of [...names, 'BASH_FUNC_ls%%']) expect(env, name).not.toHaveProperty(name)
    expect(env).toMatchObject({ SYSTEM_TEST_PLAIN: 'kept', PATH: process.env.PATH })
    for (const name of SHELL_STARTUP_VARIABLES) expect(isShellStartupVariable(name), name).toBe(true)
    expect(isShellStartupVariable('BASH_FUNC_x%%')).toBe(true)
    for (const name of ['PATH', 'HOME', 'LANG', 'BASH', 'ENVIRONMENT']) expect(isShellStartupVariable(name), name).toBe(false)
  })

  it('sets HOME to the private home, keeps the operator\'s cache, and drops startup variables from any environment it is given', () => {
    const env = agentShellEnvironment({ PATH: '/usr/bin', HOME: '/home/op', BASH_ENV: '/x', 'BASH_FUNC_echo%%': '() { id; }' }, '/run/agent-home-1')
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/run/agent-home-1', XDG_CACHE_HOME: '/home/op/.cache' })
    expect(agentShellEnvironment({ HOME: '/home/op', XDG_CACHE_HOME: '/cache' }, '/h')).toEqual({ HOME: '/h', XDG_CACHE_HOME: '/cache' })
    // Nor a directory a shell reads startup files from other than its home (fish's config): the read-only home's own stands.
    expect(SHELL_CONFIG_DIRECTORIES).toEqual(['XDG_CONFIG_HOME', 'XDG_CONFIG_DIRS'])
    expect(agentShellEnvironment({ HOME: '/home/op', XDG_CACHE_HOME: '/cache', XDG_CONFIG_HOME: '/home/op/.config', XDG_CONFIG_DIRS: '/w/xdg' }, '/h')).toEqual({ HOME: '/h', XDG_CACHE_HOME: '/cache' })
    expect(() => agentShellEnvironment({}, 'relative')).toThrow(/not an absolute path/)
  })
})

describe('each run\'s shells get a fresh, private HOME outside the worktree (T198)', () => {
  it('makes an empty owner-only directory in the parent, a new one each time, and removes it whole', () => {
    const a = agentHome(runDir, worktree)
    const b = agentHome(runDir, worktree)
    for (const home of [a, b]) {
      expect(home.path.startsWith(join(runDir, 'agent-home-'))).toBe(true)
      expect(readdirSync(home.path)).toEqual([])
      expect(statSync(home.path).mode & 0o777).toBe(0o700)
      // Not in the worktree: git does not see it, and the Worker's file tools do not write it.
      expect(home.path.startsWith(worktree)).toBe(false)
    }
    expect(a.path).not.toBe(b.path)
    writeFileSync(join(a.path, '.bashrc'), HOSTILE)
    a.remove()
    b.remove()
    expect(existsSync(a.path) || existsSync(b.path)).toBe(false)
  })

  it('refuses a home inside the workspace, or a workspace inside it, and leaves nothing behind', () => {
    const inside = join(worktree, 'run')
    mkdirSync(inside, { recursive: true, mode: 0o700 })
    expect(() => agentHome(inside, worktree)).toThrow(/inside its workspace/)
    expect(() => agentHome(runDir, runDir)).toThrow(/inside its workspace/)
    expect(readdirSync(inside)).toEqual([])
    expect(() => agentHome('relative', worktree)).toThrow(/not an absolute path/)
    rmSync(inside, { recursive: true })
  })
})

describe.runIf(bash !== undefined)('the worktree\'s startup files and the daemon\'s startup variables never reach an agent\'s bash (T198)', () => {
  const run = async (args: string[], env: Record<string, string>) => (await promisify(execFile)(bash!, args, { env, timeout: 15_000 })).stdout.trim()
  const MODES = [['-c'], ['-l', '-c'], ['-i', '-c']]

  it('runs the builtin echo and the real cat in every mode with the agent\'s environment; the worktree\'s startup files, its BASH_ENV, and an exported function never reach it', async () => {
    // The daemon was started with the hostile startup code reachable every way bash reads it.
    process.env.BASH_ENV = join(worktree, 'bash_env')
    process.env.ENV = join(worktree, '.profile')
    process.env['BASH_FUNC_echo%%'] = '() { builtin printf "pwned\\n"; }'
    const home = agentHome(runDir, worktree)
    try {
      const env = agentShellEnvironment(childEnvironment(), home.path)
      const file = join(worktree, 'read-me')
      writeFileSync(file, 'the file\n')
      for (const mode of MODES) {
        expect(await run([...mode, `echo plain; cat ${file}; command -V echo`], env), mode.join(' ')).toBe('plain\nthe file\necho is a shell builtin')
      }
      // Control: had HOME been the worktree, with BASH_ENV kept, each mode would run the Worker's function instead.
      const unsafe = { ...env, HOME: worktree, BASH_ENV: join(worktree, 'bash_env') }
      for (const mode of MODES) expect(await run([...mode, 'echo plain'], unsafe), mode.join(' ')).toBe('pwned')
      // Why the home must stay empty: a startup file in it would be read by the next login or
      // interactive shell (`--norc --noprofile` alone keeps it out). The confinement binds it back
      // read-only, so a tool call cannot write one (below).
      writeFileSync(join(home.path, '.bashrc'), HOSTILE)
      writeFileSync(join(home.path, '.bash_profile'), HOSTILE)
      expect(await run(['-i', '-c', 'echo plain'], env)).toBe('pwned')
      expect(await run(['--norc', '--noprofile', '-c', 'echo plain'], env)).toBe('plain')
    } finally {
      home.remove()
      delete process.env.BASH_ENV
      delete process.env.ENV
      delete process.env['BASH_FUNC_echo%%']
    }
  })
})

describe.runIf(bash !== undefined)('under the real confinement, a startup function a tool call plants never affects a later gated command (T198)', () => {
  needsBubblewrap()
  const MODES = [['-c'], ['-l', '-c'], ['-i', '-c']]

  /** `script` run by bash in `mode`, as an agent's tool call is: under the confinement a runtime starts it in, with its environment. */
  const call = async (confinement: Confinement, env: Record<string, string>, mode: string[], script: string): Promise<{ code: number; stdout: string }> => {
    const c = confinedCommand(bash!, [...mode, script], confinement, { chdir: worktree })
    return promisify(execFile)(c.command, c.args, { env, timeout: 15_000 }).then(
      ({ stdout }) => ({ code: 0, stdout: stdout.trim() }),
      (error: { code?: number; stdout?: string }) => ({ code: typeof error.code === 'number' ? error.code : 1, stdout: String(error.stdout ?? '').trim() }),
    )
  }

  it('binds the private home back read-only, as both runtimes do: every startup file a call tries to write there is refused, and the next call\'s echo and cat, in every mode, are the real ones', async () => {
    const home = agentHome(runDir, worktree)
    try {
      // As a run's: the run directory hidden, the shells' home bound back read-only, the worktree writable.
      const confinement: Confinement = { bwrap: BWRAP!, hide: [runDir], readOnly: [home.path], writable: [worktree] }
      const env = agentShellEnvironment(childEnvironment(), home.path)
      const file = join(worktree, 'gated-read')
      writeFileSync(file, 'the file\n')
      // A tool call, in each mode, plants a function named echo and cat in every startup file of its HOME (bash, sh, zsh, fish).
      for (const mode of MODES) {
        for (const name of ['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshenv', '.zprofile', '.zshrc', '.config/fish/config.fish']) {
          const planted = await call(confinement, env, mode, `mkdir -p "$(dirname "$HOME/${name}")" && printf '%s' '${HOSTILE.replaceAll("'", "'\\''")}' > "$HOME/${name}"`)
          expect(planted.code, `${mode.join(' ')} ${name}`).not.toBe(0)
        }
      }
      expect(readdirSync(home.path)).toEqual([])
      // The next call the gate passed as a read runs the builtin echo and the real cat, in every mode a call may ask for.
      for (const mode of MODES) {
        expect(await call(confinement, env, mode, `echo plain; cat ${file}; command -V echo; command -V cat`), mode.join(' ')).toEqual({
          code: 0, stdout: expect.stringMatching(/^plain\nthe file\necho is a shell builtin\ncat is (\/\S+\/cat|hashed \(\/\S+\/cat\))$/),
        })
      }
      // Control: with the same home bound back writable, the planted function runs instead of the gated read.
      const writable: Confinement = { ...confinement, readOnly: [], writable: [worktree, home.path] }
      expect((await call(writable, env, ['-c'], `printf '%s' '${HOSTILE.replaceAll("'", "'\\''")}' > "$HOME/.bashrc"`)).code).toBe(0)
      expect((await call(writable, env, ['-i', '-c'], 'echo plain')).stdout).toBe('pwned')
    } finally {
      home.remove()
    }
  })
})
