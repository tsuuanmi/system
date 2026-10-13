import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { type Confinement, confinedCommand, proveConfinement, writeLauncher } from '../src/index.ts'

const PASSTHROUGH = fileURLToPath(new URL('../conformance/passthrough-bwrap.sh', import.meta.url))

function findBwrap(): string | undefined {
  try {
    return execFileSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}
const BWRAP = findBwrap()
// CI requires the real bubblewrap, so a missing one fails instead of skipping silently.
const REQUIRED = process.env.SYSTEM_REQUIRE_BWRAP === '1'

/** A fake DSH home: host state to hide, operator tools to keep readable, a Worker home to keep writable. */
function host(): { root: string; home: string; tools: string; workerHome: string; keyFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'system-confine-'))
  const home = join(root, 'dsh')
  const tools = join(home, 'system', 'tools')
  const workerHome = join(home, 'system', 'codex-home')
  mkdirSync(join(tools, 'bin'), { recursive: true })
  mkdirSync(workerHome, { recursive: true })
  writeFileSync(join(home, '.credentials.yaml'), 'dsh credentials')
  writeFileSync(join(home, 'system', 'vault.key'), 'vault key')
  writeFileSync(join(home, 'system', 'mcp.token'), 'control token')
  writeFileSync(join(tools, 'bin', 'tool'), 'a tool')
  const keyFile = join(root, 'elsewhere.key')
  writeFileSync(keyFile, 'a key kept outside the DSH home')
  return { root, home, tools, workerHome, keyFile }
}

describe('confinedCommand: the bubblewrap command line (ADR-0024)', () => {
  const h = host()
  afterAll(() => rmSync(h.root, { recursive: true, force: true }))

  it('hides directories as an empty tmpfs and files as empty, binds back tools read-only and the Worker home writable, and dies with its parent', () => {
    const link = join(h.root, 'home-link')
    symlinkSync(h.home, link)
    const c: Confinement = { bwrap: 'bwrap', hide: [link, h.keyFile, join(h.root, 'missing')], readOnly: [h.tools], writable: [h.workerHome] }
    expect(confinedCommand('codex', ['exec', '--json'], c)).toEqual({
      command: 'bwrap',
      args: [
        '--die-with-parent', '--dev-bind', '/', '/',
        '--tmpfs', h.home, '--ro-bind', '/dev/null', h.keyFile,
        '--ro-bind', h.tools, h.tools, '--bind', h.workerHome, h.workerHome,
        '--', 'codex', 'exec', '--json',
      ],
    })
  })
})

describe.skipIf(!BWRAP && !REQUIRED)('an agent child under the real bubblewrap cannot read host state (ADR-0024, REQ-WRK-6, INV-8)', () => {
  const h = host()
  afterAll(() => rmSync(h.root, { recursive: true, force: true }))
  const confinement = (): Confinement => ({ bwrap: BWRAP ?? 'bwrap', hide: [h.home, h.keyFile], readOnly: [h.tools], writable: [h.workerHome] })
  const run = async (command: string, args: string[]) => {
    const c = confinedCommand(command, args, confinement())
    return promisify(execFile)(c.command, c.args, { encoding: 'utf8' })
  }

  it('sees only the way down to what is bound back; credentials, keys, and tokens are gone', async () => {
    expect((await run('ls', ['-A', h.home])).stdout.split('\n').filter(Boolean)).toEqual(['system'])
    expect((await run('ls', ['-A', join(h.home, 'system')])).stdout.split('\n').filter(Boolean).sort()).toEqual(['codex-home', 'tools'])
    await expect(run('cat', [join(h.home, 'system', 'vault.key')])).rejects.toThrow()
    await expect(run('cat', [h.keyFile])).rejects.toThrow()
  })

  it('reads operator tools but cannot change them, and writes its own home', async () => {
    expect((await run('cat', [join(h.tools, 'bin', 'tool')])).stdout).toBe('a tool')
    await expect(run('touch', [join(h.tools, 'bin', 'planted')])).rejects.toThrow()
    await run('touch', [join(h.workerHome, 'session')])
    expect(statSync(join(h.workerHome, 'session')).isFile()).toBe(true)
  })

  it('proves the confinement on this host', async () => {
    expect(await proveConfinement(confinement())).toEqual({ confined: true, detail: `host state hidden by ${BWRAP}` })
  })
})

describe('proveConfinement fails closed', () => {
  const h = host()
  afterAll(() => rmSync(h.root, { recursive: true, force: true }))

  it('when bubblewrap is missing', async () => {
    const result = await proveConfinement({ bwrap: join(h.root, 'no-bwrap'), hide: [h.home], readOnly: [], writable: [] })
    expect(result).toMatchObject({ confined: false, detail: expect.stringMatching(/^reads cannot be confined/) })
  })

  it('when the command runs but hides nothing (a hidden directory still shows its entries)', async () => {
    const result = await proveConfinement({ bwrap: PASSTHROUGH, hide: [h.home], readOnly: [h.tools], writable: [] })
    expect(result).toEqual({ confined: false, detail: `${h.home} still shows 1 entry under ${PASSTHROUGH}` })
  })

  it('when a hidden file is still readable', async () => {
    const result = await proveConfinement({ bwrap: PASSTHROUGH, hide: [h.keyFile], readOnly: [], writable: [] })
    expect(result).toEqual({ confined: false, detail: `${h.keyFile} is readable under ${PASSTHROUGH}` })
  })
})

describe('writeLauncher: a program path for SDKs that take no arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'system-launcher-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('writes an owner-only script, named by its content, that execs the command with its own and the caller\'s arguments', async () => {
    const command = confinedCommand('printf', ['%s|'], { bwrap: PASSTHROUGH, hide: [], readOnly: [], writable: [] })
    const path = writeLauncher(dir, 'agent', command)
    expect(path).toMatch(/agent-[0-9a-f]{16}\.sh$/)
    expect(statSync(path).mode & 0o777).toBe(0o700)
    expect(writeLauncher(dir, 'agent', command)).toBe(path)
    expect(readFileSync(path, 'utf8')).toContain(`exec '${PASSTHROUGH}' '--die-with-parent'`)
    expect((await promisify(execFile)(path, ["it's", 'two words'], { encoding: 'utf8' })).stdout).toBe("it's|two words|")
  })
})
