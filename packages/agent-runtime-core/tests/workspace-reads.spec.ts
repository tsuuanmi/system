// The workspace reads server (T200b): three read-only tools over one run's workspace, every path
// resolved and kept inside it, every bound a validated argument, MCP over stdio with its root fixed.
import { type ChildProcessWithoutNullStreams, execFile, execFileSync, spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import {
  GIT_CONFIG_PINS, WORKSPACE_READS_PROTOCOLS, WORKSPACE_READS_SCRIPT, WORKSPACE_READ_BOUNDS, WorkspaceReads, answerMessage, confinedCommand, gitArgv, gitEnvironment, parseWorkspaceReadArgs,
  searchResourceLimits, serveWorkspaceReads, workspaceReadArgs, workspaceReadBounds, workspaceReadBoundsProblem,
} from '../src/index.ts'
import { BWRAP, needsBubblewrap } from './host.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'system-reads-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A workspace with source files, git's data, secrets, a dependency directory, and links in and out. */
const ws = join(root, 'ws')
const outside = join(root, 'outside')
mkdirSync(join(ws, 'src', 'deep'), { recursive: true })
mkdirSync(join(ws, '.git'))
mkdirSync(join(ws, 'node_modules', 'dep'), { recursive: true })
mkdirSync(outside)
writeFileSync(join(outside, 'secret.txt'), 'outside needle\n')
writeFileSync(join(ws, 'src', 'a.ts'), 'const one = 1\nconst two = 2 // needle\nconst three = 3\n')
writeFileSync(join(ws, 'src', 'deep', 'b.ts'), 'export const NEEDLE = "needle"\n')
writeFileSync(join(ws, 'README.md'), '# needle\n')
writeFileSync(join(ws, '.git', 'config'), '[core]\n\tfsmonitor = needle\n')
writeFileSync(join(ws, '.env'), 'TOKEN=needle\n')
writeFileSync(join(ws, '.env.example'), 'TOKEN=\n')
writeFileSync(join(ws, 'id_ed25519'), 'needle key\n')
writeFileSync(join(ws, 'node_modules', 'dep', 'index.js'), 'needle\n')
writeFileSync(join(ws, 'bin.dat'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 1, 2]))
symlinkSync(join(outside, 'secret.txt'), join(ws, 'escape.txt'))
symlinkSync(outside, join(ws, 'escape-dir'))
symlinkSync(join(ws, 'src', 'a.ts'), join(ws, 'alias.ts'))

const reads = (bounds: Partial<ReturnType<typeof workspaceReadBounds>> = {}) => new WorkspaceReads(ws, workspaceReadBounds(bounds))
const call = async (name: string, input: unknown, bounds: Parameters<typeof reads>[0] = {}) => reads(bounds).call(name, input)

describe('the workspace reads server\'s bounds are validated arguments (INV-9)', () => {
  it('takes each bound within its range, the rest at their defaults, and refuses anything else', () => {
    const defaults = workspaceReadBounds()
    for (const [name, bound] of Object.entries(WORKSPACE_READ_BOUNDS)) {
      expect(defaults[name as keyof typeof defaults], name).toBe(bound.default)
      expect(bound.min <= bound.default && bound.default <= bound.max, name).toBe(true)
      expect(workspaceReadBoundsProblem({ [name]: bound.min }), name).toBeUndefined()
      expect(workspaceReadBoundsProblem({ [name]: bound.max }), name).toBeUndefined()
      expect(workspaceReadBoundsProblem({ [name]: bound.min - 1 }), name).toMatch(/not an integer from/)
      expect(workspaceReadBoundsProblem({ [name]: bound.max + 1 }), name).toMatch(/not an integer from/)
      expect(workspaceReadBoundsProblem({ [name]: bound.min + 0.5 }), name).toMatch(/not an integer from/)
    }
    expect(workspaceReadBoundsProblem({ maxBytes: 10 })).toMatch(/is not a workspace reads bound/)
    expect(workspaceReadBoundsProblem([])).toMatch(/not an object/)
    expect(() => workspaceReadBounds({ maxEntries: 0 })).toThrow(/maxEntries/)
  })

  it('passes them as arguments and reads them back exactly; refuses a relative root, an unknown or repeated flag, a value that is no number', () => {
    const bounds = workspaceReadBounds({ maxEntries: 7, searchTimeoutMs: 250 })
    expect(parseWorkspaceReadArgs(workspaceReadArgs(ws, bounds))).toEqual({ root: ws, bounds })
    expect(() => workspaceReadArgs('ws', bounds)).toThrow(/absolute/)
    expect(() => parseWorkspaceReadArgs(['--root', 'ws'])).toThrow(/absolute/)
    expect(() => parseWorkspaceReadArgs(['--root', ws, '--max-files', '3'])).toThrow(/not an argument/)
    expect(() => parseWorkspaceReadArgs(['--root', ws, '--root', ws])).toThrow(/twice/)
    expect(() => parseWorkspaceReadArgs(['--root', ws, '--max-entries', '-1'])).toThrow(/whole number/)
    expect(() => parseWorkspaceReadArgs(['--root', ws, '--max-entries', '0'])).toThrow(/maxEntries/)
  })
})

describe('every path stays inside the workspace, really (T200b)', () => {
  it('refuses "..", an absolute path outside, and a symlink whose target is outside, a file or a directory; reads an absolute path inside and a symlink inside', async () => {
    for (const path of ['../outside/secret.txt', 'src/../src/a.ts', '..', join(outside, 'secret.txt'), '/etc/hostname', 'escape.txt', 'escape-dir/secret.txt']) {
      const result = await call('read_file', { path })
      expect(result.isError, path).toBe(true)
      expect(result.text, path).toMatch(/^refused: /)
      expect(result.text, path).not.toContain('outside needle')
    }
    expect((await call('read_file', { path: '../outside/secret.txt' })).text).toContain('climbs with ".."')
    expect((await call('read_file', { path: 'escape.txt' })).text).toContain('resolves outside the workspace')
    expect((await call('list_dir', { path: 'escape-dir' })).text).toContain('resolves outside the workspace')
    expect((await call('search', { pattern: 'needle', path: 'escape-dir' })).text).toContain('resolves outside the workspace')
    // A refusal names only what the agent wrote, never where a link out leads.
    for (const [tool, path] of [['read_file', 'escape.txt'], ['list_dir', 'escape-dir'], ['search', 'escape-dir']] as const) {
      const text = (await call(tool, tool === 'search' ? { pattern: 'needle', path } : { path })).text
      expect(text, path).not.toContain(outside)
      expect(text, path).not.toContain('secret.txt')
    }
    expect((await call('read_file', { path: join(ws, 'src', 'a.ts') })).text).toContain('2\tconst two = 2 // needle')
    expect((await call('read_file', { path: 'alias.ts' })).text).toMatch(/^src\/a\.ts \(/)
  })

  it('never reads git\'s data or a secret file, as written or through a link; an example environment file is no secret', async () => {
    symlinkSync(join(ws, '.git', 'config'), join(ws, 'git-config'))
    try {
      for (const path of ['.git/config', '.GIT/config', '.git', '.env', 'id_ed25519', 'git-config']) {
        const result = await call(path === '.git' ? 'list_dir' : 'read_file', { path })
        expect(result, path).toMatchObject({ isError: true, text: expect.stringMatching(/^refused: .*(git's own data|secret)/) })
      }
    } finally {
      rmSync(join(ws, 'git-config'))
    }
    expect((await call('read_file', { path: '.env.example' })).text).toContain('1\tTOKEN=')
    expect((await call('read_file', { path: 'a\0b' })).text).toContain('NUL')
  })
})

describe('read_file', () => {
  it('reads a file\'s lines numbered, or a range of them; names a binary file instead of showing it; refuses a directory, a missing file, an unknown argument', async () => {
    expect(await call('read_file', { path: 'src/a.ts' })).toEqual({ isError: false, text: `src/a.ts (${'const one = 1\nconst two = 2 // needle\nconst three = 3\n'.length} bytes)\n1\tconst one = 1\n2\tconst two = 2 // needle\n3\tconst three = 3\n` })
    expect((await call('read_file', { path: 'src/a.ts', startLine: 2, endLine: 2 })).text).toMatch(/lines 2 to 2\n2\tconst two = 2 \/\/ needle\n$/)
    expect((await call('read_file', { path: 'src/a.ts', startLine: 9 })).text).toContain('[the file has 3 lines; none from line 9]')
    expect((await call('read_file', { path: 'bin.dat' })).text).toBe('bin.dat: a binary file of 9 bytes, not shown')
    expect((await call('read_file', { path: 'src' })).text).toContain('is a directory')
    expect((await call('read_file', { path: 'nope.ts' })).text).toContain('does not exist')
    expect((await call('read_file', { path: 'src/a.ts', offset: 1 })).text).toContain('"offset" is not an argument')
    expect((await call('read_file', { path: 'src/a.ts', startLine: 3, endLine: 2 })).isError).toBe(true)
    expect((await call('read_file', {})).text).toContain('path is required')
  })

  it('returns at most maxReadBytes, cut where it stops with where to read on, and reads through at most maxScanBytes of a file', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`)
    writeFileSync(join(ws, 'big.txt'), `${lines.join('\n')}\n`)
    const cut = await call('read_file', { path: 'big.txt' }, { maxReadBytes: 1024 })
    const body = cut.text.split('\n').slice(1).join('\n')
    expect(Buffer.byteLength(body.slice(0, body.indexOf('\n[')))).toBeLessThanOrEqual(1024)
    const next = Number(/read on with startLine (\d+)/.exec(cut.text)?.[1])
    expect(next).toBeGreaterThan(10)
    expect((await call('read_file', { path: 'big.txt', startLine: next, endLine: next }, { maxReadBytes: 1024 })).text).toContain(`${next}\tline ${next} `)
    // Past maxScanBytes (64 KiB at its least) a range is not reached, and it says so.
    const far = await call('read_file', { path: 'big.txt', startLine: 4900, endLine: 4901 }, { maxScanBytes: 64 * 1024 })
    expect(far.text).toMatch(/stopped after reading 65536 bytes of the file \(maxScanBytes\)/)
    expect(far.text).not.toContain('line 4900')
    expect((await call('read_file', { path: 'big.txt', startLine: 4900, endLine: 4900 })).text).toContain('4900\tline 4900 ')
  })

  it('reads a single line longer than many chunks in one pass: cut at maxReadBytes, and skipped whole when it lies before the range', async () => {
    // 1 MiB on one line, sixteen 64 KiB chunks, then two short lines (the last with no newline).
    const long = 'x'.repeat(1024 * 1024)
    writeFileSync(join(ws, 'one-line.txt'), `${long}\nsecond\nthird`)
    try {
      const cut = await call('read_file', { path: 'one-line.txt' }, { maxReadBytes: 4096 })
      expect(cut.isError).toBe(false)
      const body = cut.text.slice(cut.text.indexOf('\n') + 1, cut.text.indexOf('\n['))
      expect(body).toBe(`1\t${'x'.repeat(4096 - 2)}`)
      expect(cut.text).toContain('[output cut at 4096 bytes (maxReadBytes) in line 1; read on with startLine 1]')
      // Before the range, the long line is counted, never kept.
      expect((await call('read_file', { path: 'one-line.txt', startLine: 2 })).text).toMatch(/lines 2 to the end\n2\tsecond\n3\tthird\n$/)
      expect((await call('read_file', { path: 'one-line.txt', startLine: 3, endLine: 3 })).text).toMatch(/\n3\tthird\n$/)
      // The whole line, when it fits.
      const whole = await call('read_file', { path: 'one-line.txt', startLine: 1, endLine: 1 }, { maxReadBytes: 2 * 1024 * 1024 })
      expect(whole.text).toContain(`\n1\t${long}\n`)
      expect(whole.text).not.toContain('second')
      expect((await call('read_file', { path: 'one-line.txt', startLine: 9 })).text).toContain('[the file has 3 lines; none from line 9]')
    } finally {
      rmSync(join(ws, 'one-line.txt'))
    }
  })
})

describe('a path swapped between its check and its open is refused (TOCTOU)', () => {
  // Each swap is made between the server's own two steps, locate() and open(), so it is deterministic.
  const away = join(root, 'away')
  mkdirSync(away, { recursive: true })
  writeFileSync(join(away, 'f.txt'), 'outside needle\n')

  it('refuses a file replaced by a symlink to a file outside the workspace: opened without following it (ELOOP)', () => {
    const r = reads()
    writeFileSync(join(ws, 'swap.txt'), 'inside\n')
    const located = r.locate('swap.txt')
    rmSync(join(ws, 'swap.txt'))
    symlinkSync(join(away, 'f.txt'), join(ws, 'swap.txt'))
    try {
      expect(() => r.open(located, 'file')).toThrow(/swap\.txt became a symlink, which is not followed/)
    } finally {
      rmSync(join(ws, 'swap.txt'))
    }
  })

  it('refuses a file whose parent directory was renamed and replaced by a symlink to a directory outside: the descriptor names where it really is (/proc/self/fd)', () => {
    const r = reads()
    mkdirSync(join(ws, 'swapdir'))
    writeFileSync(join(ws, 'swapdir', 'f.txt'), 'inside\n')
    const located = r.locate('swapdir/f.txt')
    const dir = r.locate('swapdir')
    renameSync(join(ws, 'swapdir'), join(ws, 'swapdir-old'))
    symlinkSync(away, join(ws, 'swapdir'))
    try {
      expect(() => r.open(located, 'file')).toThrow(/swapdir\/f\.txt moved while it was opened, so it is not read/)
      // The directory itself, now a symlink at its end, is not followed either.
      expect(() => r.open(dir, 'dir')).toThrow(/swapdir (became a symlink, which is not followed|is not a directory)/)
    } finally {
      rmSync(join(ws, 'swapdir'))
      rmSync(join(ws, 'swapdir-old'), { recursive: true })
    }
  })

  it('refuses a FIFO, opened without blocking, as no regular file', async () => {
    execFileSync('mkfifo', [join(ws, 'pipe')])
    try {
      const r = reads()
      expect(() => r.open(r.locate('pipe'), 'file')).toThrow(/pipe is not a regular file/)
      expect(await call('read_file', { path: 'pipe' })).toMatchObject({ isError: true, text: expect.stringContaining('is not a regular file') })
      // A search skips it, and does not wait on it.
      expect((await call('search', { pattern: 'needle', path: 'pipe' })).text).toMatch(/^0 matches .*1 not read/)
    } finally {
      rmSync(join(ws, 'pipe'))
    }
  })

  it('refuses a hard link, to a file outside the workspace or to a secret under another name; reads one under node_modules (pnpm links its store) (T213)', async () => {
    linkSync(join(away, 'f.txt'), join(ws, 'hard.txt'))
    linkSync(join(ws, '.env'), join(ws, 'env-copy.txt'))
    linkSync(join(ws, 'node_modules', 'dep', 'index.js'), join(ws, 'node_modules', 'dep', 'linked.js'))
    try {
      const r = reads()
      expect(() => r.open(r.locate('hard.txt'), 'file')).toThrow(/hard\.txt has 2 hard links/)
      for (const path of ['hard.txt', 'env-copy.txt']) {
        const result = await call('read_file', { path })
        expect(result, path).toMatchObject({ isError: true, text: expect.stringMatching(/^refused: .*hard links/) })
        expect(result.text, path).not.toContain('needle')
      }
      // A search skips them too, and counts them as not read.
      const found = await call('search', { pattern: 'needle', path: '.' })
      expect(found.text).not.toMatch(/hard\.txt|env-copy\.txt/)
      const opened = r.open(r.locate('node_modules/dep/linked.js'), 'file')
      closeSync(opened.fd)
      expect((await call('read_file', { path: 'node_modules/dep/linked.js' })).text).toContain('1\tneedle')
    } finally {
      rmSync(join(ws, 'hard.txt'))
      rmSync(join(ws, 'env-copy.txt'))
      rmSync(join(ws, 'node_modules', 'dep', 'linked.js'))
    }
  })
})

describe('the wider secret names, and files git ignores that are named like secrets (T213)', () => {
  const sws = join(root, 'secrets-ws')
  const secrets = [
    '.envrc', 'secrets.env', '.secrets/token.txt', '.pgpass', 'prod.tfvars', 'prod.tfvars.json', 'terraform.tfstate', 'terraform.tfstate.backup', 'kubeconfig',
    '.kube/config', '.docker/config.json', '.aws/config', '.aws/credentials', 'backup.git/HEAD', 'mirror.GIT/config',
  ]
  const plain = ['config.json', 'docker/config.json', 'aws/config', 'src/config', 'tokenizer.ts', 'local/notes.txt', 'public-token.txt']
  const ignoredSecrets = ['deploy-token.txt', 'local/api-key.txt', 'src/db.secret.txt', 'private/plain.txt']
  for (const path of [...secrets, ...plain, ...ignoredSecrets]) {
    mkdirSync(join(sws, path, '..'), { recursive: true })
    writeFileSync(join(sws, path), 'needle\n')
  }
  writeFileSync(join(sws, '.gitignore'), '# local files\n*-token.txt\n!public-token.txt\nlocal/\n/private\n')
  writeFileSync(join(sws, 'src', '.gitignore'), '*.secret.txt\n')
  const sreads = () => new WorkspaceReads(sws, workspaceReadBounds())

  it('never reads a file of the wider list, or anything under a directory of it, as written or listed', async () => {
    for (const path of secrets) {
      const result = await sreads().call('read_file', { path })
      expect(result, path).toMatchObject({ isError: true, text: expect.stringMatching(/^refused: .*(secret|git|credentials)/) })
    }
    for (const path of ['.secrets', 'backup.git']) expect((await sreads().call('list_dir', { path })).isError, path).toBe(true)
    const names = (await sreads().call('list_dir', {})).text.split('\n').slice(1).map((e) => e.split('\t')[0])
    for (const hidden of ['.envrc', 'secrets.env', '.secrets/', '.pgpass', 'prod.tfvars', 'terraform.tfstate', 'kubeconfig', 'backup.git/', 'mirror.GIT/']) expect(names, hidden).not.toContain(hidden)
    // .docker, .aws, .kube are listed; their config files are not.
    expect((await sreads().call('list_dir', { path: '.docker' })).text).toMatch(/^\.docker\/: 0 entries \(1 not shown/)
    expect((await sreads().call('list_dir', { path: '.aws' })).text).toMatch(/^\.aws\/: 0 entries \(2 not shown/)
    expect((await sreads().call('list_dir', { path: '.kube' })).text).toMatch(/^\.kube\/: 0 entries \(1 not shown/)
  })

  it('matches an adversarial ignore pattern in bounded time, on the main thread (T213 review)', async () => {
    const aws = join(root, 'adversarial-ws')
    mkdirSync(aws, { recursive: true })
    const name = `token-${'a'.repeat(200)}`
    writeFileSync(join(aws, name), 'needle\n')
    writeFileSync(join(aws, `${name}b`), 'needle\n')
    writeFileSync(join(aws, '.gitignore'), `${'*a'.repeat(20)}*b\n`)
    const r = new WorkspaceReads(aws, workspaceReadBounds())
    const started = Date.now()
    expect((await r.call('read_file', { path: name })).text).toContain('1\tneedle')
    expect((await r.call('read_file', { path: `${name}b` })).text).toMatch(/^refused: .*ignored by git and named like a secret/)
    const names = (await r.call('list_dir', {})).text.split('\n').slice(1).map((e) => e.split('\t')[0])
    expect(names).toContain(name)
    expect(names).not.toContain(`${name}b`)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('fails closed for names like secrets when an ignore file is longer than it reads (T213 review)', async () => {
    const tws = join(root, 'truncated-ignore-ws')
    mkdirSync(tws, { recursive: true })
    for (const path of ['deploy-token.txt', 'notes.txt']) writeFileSync(join(tws, path), 'needle\n')
    writeFileSync(join(tws, '.gitignore'), `${'# a comment line, long enough to pad the file\n'.repeat(8000)}deploy-token.txt\n`)
    const r = new WorkspaceReads(tws, workspaceReadBounds())
    expect((await r.call('read_file', { path: 'deploy-token.txt' })).text).toMatch(/^refused: .*ignored by git and named like a secret/)
    expect((await r.call('read_file', { path: 'notes.txt' })).text).toContain('1\tneedle')
    const found = (await r.call('search', { pattern: 'needle' })).text.split('\n').slice(1).map((l) => l.split(':')[0])
    expect(found).toEqual(['notes.txt'])
  })

  it('refuses a file git ignores (its .gitignore files, nested, negation and directories included) when its name looks like a secret; reads the rest', async () => {
    for (const path of ignoredSecrets) {
      const result = await sreads().call('read_file', { path })
      expect(result, path).toMatchObject({ isError: true, text: expect.stringMatching(/^refused: .*ignored by git and named like a secret/) })
    }
    for (const path of plain) expect((await sreads().call('read_file', { path })).text, path).toContain('1\tneedle')
    const found = (await sreads().call('search', { pattern: 'needle' })).text.split('\n').slice(1).map((l) => l.split(':')[0])
    expect(found.sort()).toEqual([...plain].sort())
    expect((await sreads().call('list_dir', {})).text.split('\n').slice(1).map((e) => e.split('\t')[0])).not.toContain('deploy-token.txt')
  })

  it('refuses an ignored file below a directory named like a secret that is not itself ignored (T213 second review)', async () => {
    const pws = join(root, 'private-dir-ws')
    mkdirSync(join(pws, 'private'), { recursive: true })
    for (const path of ['private/config.txt', 'private/notes.txt']) writeFileSync(join(pws, path), 'needle\n')
    writeFileSync(join(pws, '.gitignore'), 'private/config.txt\n')
    const r = new WorkspaceReads(pws, workspaceReadBounds())
    expect((await r.call('read_file', { path: 'private/config.txt' })).text).toMatch(/^refused: .*ignored by git and named like a secret/)
    expect((await r.call('read_file', { path: 'private/notes.txt' })).text).toContain('1\tneedle')
    const names = (await r.call('list_dir', { path: 'private' })).text.split('\n').slice(1).map((e) => e.split('\t')[0])
    expect(names).toEqual(['notes.txt'])
    const found = (await r.call('search', { pattern: 'needle' })).text.split('\n').slice(1).map((l) => l.split(':')[0])
    expect(found).toEqual(['private/notes.txt'])
  })

  it('matches gitignore POSIX character classes, and fails closed on one it does not know (T213 second review)', async () => {
    const cws = join(root, 'posix-class-ws')
    mkdirSync(cws, { recursive: true })
    for (const path of ['token-1.txt', 'token-a.txt', 'secret-x.txt', 'notes.txt']) writeFileSync(join(cws, path), 'needle\n')
    writeFileSync(join(cws, '.gitignore'), 'token-[[:digit:]].txt\nsecret-[[:nonsense:]].txt\n')
    const r = new WorkspaceReads(cws, workspaceReadBounds())
    expect((await r.call('read_file', { path: 'token-1.txt' })).text).toMatch(/^refused: .*ignored by git and named like a secret/)
    expect((await r.call('read_file', { path: 'token-a.txt' })).text).toContain('1\tneedle')
    expect((await r.call('read_file', { path: 'secret-x.txt' })).text).toMatch(/^refused: .*ignored by git and named like a secret/)
    expect((await r.call('read_file', { path: 'notes.txt' })).text).toContain('1\tneedle')
    const found = (await r.call('search', { pattern: 'needle' })).text.split('\n').slice(1).map((l) => l.split(':')[0])
    expect(found.sort()).toEqual(['notes.txt', 'token-a.txt'])
  })

  it('refuses an ignored symlink named like a secret that leads to an ordinary workspace file (T213 second review)', async () => {
    const lws = join(root, 'ignored-link-ws')
    mkdirSync(lws, { recursive: true })
    writeFileSync(join(lws, 'payload.txt'), 'needle\n')
    symlinkSync('payload.txt', join(lws, 'deploy-token.txt'))
    writeFileSync(join(lws, '.gitignore'), 'deploy-token.txt\n')
    const r = new WorkspaceReads(lws, workspaceReadBounds())
    expect((await r.call('read_file', { path: 'deploy-token.txt' })).text).toMatch(/^refused: .*ignored by git and named like a secret/)
    expect((await r.call('read_file', { path: './deploy-token.txt' })).text).toMatch(/^refused: .*ignored by git and named like a secret/)
    expect((await r.call('read_file', { path: join(lws, 'deploy-token.txt') })).text).toMatch(/^refused: .*ignored by git and named like a secret/)
    expect((await r.call('read_file', { path: 'payload.txt' })).text).toContain('1\tneedle')
  })
})

describe('list_dir', () => {
  it('lists a directory by name, a directory with /, a link with @ (not followed), a file with its size; git\'s data and secrets left out and counted', async () => {
    const { text, isError } = await call('list_dir', {})
    expect(isError).toBe(false)
    const [header, ...entries] = text.split('\n')
    expect(header).toMatch(/^\.\/: \d+ entries \(3 not shown: git's data or secret files\)$/)
    expect(entries).toEqual(expect.arrayContaining(['src/', 'node_modules/', 'escape-dir@', 'escape.txt@', `README.md\t${'# needle\n'.length} bytes`, '.env.example\t7 bytes']))
    for (const hidden of ['.git/', '.env', 'id_ed25519']) expect(entries.map((e) => e.split('\t')[0]), hidden).not.toContain(hidden)
    expect(entries).toEqual([...entries].sort())
    expect((await call('list_dir', { path: 'src/a.ts' })).text).toContain('is not a directory')
  })

  it('returns at most maxEntries, and says how many there are', async () => {
    const { text } = await call('list_dir', { path: '.' }, { maxEntries: 2 })
    const [header, ...entries] = text.split('\n')
    expect(entries).toHaveLength(2)
    expect(header).toMatch(/showing the first 2 of \d+ \(maxEntries\)/)
  })

  it('reads at most 10 x maxEntries entries of a directory, never all of it, and says there are at least that many (T213)', async () => {
    const crowd = join(root, 'crowd')
    mkdirSync(crowd)
    for (let i = 0; i < 50; i += 1) writeFileSync(join(crowd, `f${String(i).padStart(2, '0')}.txt`), 'needle\n')
    const r = (maxEntries: number) => new WorkspaceReads(crowd, workspaceReadBounds({ maxEntries }))
    const capped = await r(2).call('list_dir', {})
    const [header, ...entries] = capped.text.split('\n')
    expect(entries).toHaveLength(2)
    expect(header).toBe('./: at least 20 entries (reading stopped at 20 entries, 10 x maxEntries; showing 2 (maxEntries))')
    expect((await r(10).call('list_dir', {})).text.split('\n')[0]).toBe('./: 50 entries (showing the first 10 of 50 (maxEntries))')
    // A search reads no more of one directory either, and says so.
    const searched = await r(2).call('search', { pattern: 'needle' })
    expect(searched.text).toMatch(/^20 matches .*20 files searched; 1 directory read only to its first 20 entries \(10 x maxEntries\)/)
    expect((await r(10).call('search', { pattern: 'needle' })).text).toMatch(/^50 matches .*50 files searched\]/)
  })
})

describe('search', () => {
  it('finds a fixed string or a regular expression, any case on request, in name order; never in git\'s data, secrets, links, node_modules, or binary files', async () => {
    const { text, isError } = await call('search', { pattern: 'needle' })
    expect(isError).toBe(false)
    expect(text.split('\n').slice(1)).toEqual(['README.md:1: # needle', 'src/a.ts:2: const two = 2 // needle', 'src/deep/b.ts:1: export const NEEDLE = "needle"'])
    expect(text).toMatch(/^3 matches of "needle" under \. \[\d+ files searched; 1 not read/)
    expect((await call('search', { pattern: 'NEEDLE', ignoreCase: true, path: 'src' })).text.split('\n').slice(1)).toEqual(['src/a.ts:2: const two = 2 // needle', 'src/deep/b.ts:1: export const NEEDLE = "needle"'])
    expect((await call('search', { pattern: '^const t\\w+ =', regex: true, path: 'src/a.ts' })).text.split('\n').slice(1)).toEqual(['src/a.ts:2: const two = 2 // needle', 'src/a.ts:3: const three = 3'])
    // A fixed string is not a regular expression.
    expect((await call('search', { pattern: 'const t.o', path: 'src' })).text).toMatch(/^0 matches/)
    expect((await call('search', { pattern: '(', regex: true })).text).toContain('not a regular expression')
    expect((await call('search', { pattern: 'needle', path: 'node_modules' })).text).toContain('node_modules/dep/index.js:1: needle')
  })

  it('stops at maxMatches, maxSearchFiles, and maxLineChars, takes at most maxPatternChars, and says where it stopped', async () => {
    expect((await call('search', { pattern: 'needle' }, { maxMatches: 1 })).text).toMatch(/^1 match .*stopped at 1 matches \(maxMatches\)/)
    expect((await call('search', { pattern: 'needle' }, { maxSearchFiles: 1 })).text).toMatch(/stopped after 1 files \(maxSearchFiles\)/)
    writeFileSync(join(ws, 'src', 'long.txt'), `${'y'.repeat(300)} needle ${'z'.repeat(300)}\n`)
    try {
      const line = (await call('search', { pattern: 'needle', path: 'src/long.txt' }, { maxLineChars: 80 })).text.split('\n')[1]!
      expect(line).toBe(`src/long.txt:1: ${'y'.repeat(80)}…`)
    } finally {
      rmSync(join(ws, 'src', 'long.txt'))
    }
    expect((await call('search', { pattern: 'abc' }, { maxPatternChars: 2 })).text).toContain('1 to 2 characters (maxPatternChars)')
    expect((await call('search', { pattern: '' })).isError).toBe(true)
  })

  it('stops a search at searchTimeoutMs, whatever its pattern does: a regular expression that backtracks without end is ended', async () => {
    writeFileSync(join(ws, 'src', 'redos.txt'), `${'a'.repeat(40)}!\n`)
    try {
      const started = Date.now()
      // Long enough for the thread to start under a loaded host and reach the line, so it is the
      // regular expression that runs past the deadline and the thread that is ended.
      const result = await call('search', { pattern: '^(a+)+$', regex: true, path: 'src/redos.txt' }, { searchTimeoutMs: 2000 })
      expect(result).toMatchObject({ isError: true, text: expect.stringContaining('did not finish within 2000 ms (searchTimeoutMs)') })
      expect(Date.now() - started).toBeLessThan(8000)
    } finally {
      rmSync(join(ws, 'src', 'redos.txt'))
    }
  })

  it('runs in a thread whose heap is bounded by limits derived from maxScanBytes, and a search over a large tree stays within them (T213)', async () => {
    const small = searchResourceLimits(workspaceReadBounds({ maxScanBytes: 64 * 1024 }))
    const large = searchResourceLimits(workspaceReadBounds({ maxScanBytes: WORKSPACE_READ_BOUNDS.maxScanBytes.max }))
    expect(small).toEqual({ maxOldGenerationSizeMb: 68, maxYoungGenerationSizeMb: 16 })
    expect(large).toEqual({ maxOldGenerationSizeMb: 64 + 4 * 256, maxYoungGenerationSizeMb: 64 })
    // A tree of 300 files near maxScanBytes, short lines that each match: the thread checks its own
    // heap limit against these, and the search refuses to answer from a thread that is not bounded.
    const tree = join(root, 'tree')
    const line = 'ab needle\n'
    for (let d = 0; d < 10; d += 1) {
      mkdirSync(join(tree, `d${d}`), { recursive: true })
      for (let f = 0; f < 30; f += 1) writeFileSync(join(tree, `d${d}`, `f${f}.txt`), line.repeat(Math.floor((64 * 1024 - 1) / line.length)))
    }
    const result = await new WorkspaceReads(tree, workspaceReadBounds({ maxScanBytes: 64 * 1024, maxMatches: 5000, searchTimeoutMs: 60_000 })).call('search', { pattern: 'needle' })
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/^5000 matches .*stopped at 5000 matches \(maxMatches\)/)
    const files = await new WorkspaceReads(tree, workspaceReadBounds({ maxScanBytes: 64 * 1024, searchTimeoutMs: 60_000 })).call('search', { pattern: 'not there' })
    expect(files.text).toMatch(/^0 matches .*300 files searched\]$/)
  }, 90_000)
})

describe('MCP over stdio, its root fixed at start', () => {
  const r = reads()
  it('answers initialize in a protocol version it speaks, lists exactly its read-only tools (three over files, four git views), and ignores roots', async () => {
    expect(await answerMessage(r, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: { roots: { listChanged: true } } } }))
      .toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } } } })
    expect(await answerMessage(r, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).toMatchObject({ result: { protocolVersion: WORKSPACE_READS_PROTOCOLS[0] } })
    const listed = await answerMessage(r, { jsonrpc: '2.0', id: 3, method: 'tools/list' }) as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } }
    expect(listed.result.tools.map((t) => t.name)).toEqual(['read_file', 'list_dir', 'search', 'git_log', 'git_show', 'git_diff', 'git_status'])
    for (const tool of listed.result.tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    // Roots change nothing: a notification is not answered, and no request widens what is read.
    expect(await answerMessage(r, { jsonrpc: '2.0', method: 'notifications/roots/list_changed' })).toBeUndefined()
    expect(await answerMessage(r, { jsonrpc: '2.0', id: 4, method: 'roots/list' })).toMatchObject({ error: { code: -32601 } })
    expect(await answerMessage(r, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'x' } } }))
      .toMatchObject({ result: { isError: true, content: [{ type: 'text', text: expect.stringContaining('write_file is not a tool of this server') }] } })
  })

  it('serves as its own process: newline-delimited JSON-RPC in, one answer per request out, and reads the workspace it was started on', async () => {
    const child = spawn(process.execPath, [WORKSPACE_READS_SCRIPT, ...workspaceReadArgs(ws, workspaceReadBounds())], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    const lines: string[] = []
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      for (let i = out.indexOf('\n'); i >= 0; i = out.indexOf('\n')) {
        lines.push(out.slice(0, i))
        out = out.slice(i + 1)
      }
    })
    const ended = new Promise<number | null>((resolve) => child.once('close', resolve))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\nnot json\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'src/a.ts', startLine: 1, endLine: 1 } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { pattern: 'needle', path: 'src/deep' } } })}\n`)
    child.stdin.end()
    expect(await ended).toBe(0)
    const answers = lines.map((l) => JSON.parse(l) as { id: unknown; result?: { content?: Array<{ text: string }> }; error?: { code: number } })
    expect(answers.map((a) => a.id)).toEqual([1, null, 2, 3])
    expect(answers[1]!.error!.code).toBe(-32700)
    expect(answers[2]!.result!.content![0]!.text).toContain('1\tconst one = 1')
    expect(answers[3]!.result!.content![0]!.text).toContain('src/deep/b.ts:1:')
    // Every line it wrote is an answer: it asks the client nothing (no roots/list).
    expect(answers.every((a) => !('method' in a))).toBe(true)
  })

  /** Serves `chunks`, each written whole, and returns the answers. */
  const serve = async (chunks: Array<string | Buffer>): Promise<Array<{ id: unknown; result?: unknown; error?: { code: number; message: string } }>> => {
    const input = new PassThrough()
    const lines: string[] = []
    const served = serveWorkspaceReads(r, input, (line) => lines.push(line))
    for (const chunk of chunks) input.write(chunk)
    input.end()
    await served
    return lines.map((l) => JSON.parse(l) as { id: unknown; error?: { code: number; message: string } })
  }

  it('counts a line that is not JSON among the 32 waiting, and refuses those past them (T213)', async () => {
    const answers = await serve([Array.from({ length: 40 }, (_, i) => `not json ${i}`).join('\n') + '\n'])
    expect(answers).toHaveLength(40)
    expect(answers.filter((a) => a.error?.code === -32700)).toHaveLength(32)
    expect(answers.filter((a) => a.error?.code === -32000)).toHaveLength(8)
    expect(answers.every((a) => a.id === null)).toBe(true)
  })

  it('refuses a line over 1 MiB that arrives whole in one chunk, and answers the next (T213)', async () => {
    const long = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(2 * 1024 * 1024) } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`)
    const answers = await serve([long])
    expect(answers).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'a message is longer than 1048576 bytes' } }, { jsonrpc: '2.0', id: 2, result: {} }])
    // Split over chunks, it is refused the same.
    const half = Math.floor(long.length / 3)
    expect(await serve([long.subarray(0, half), long.subarray(half)])).toEqual(answers)
  })

  it('refuses to start on arguments out of range or a workspace that is not there', async () => {
    for (const args of [['--root', ws, '--max-entries', '0'], ['--root', join(root, 'none')], ['--root', 'relative']]) {
      const failed = await promisify(execFile)(process.execPath, [WORKSPACE_READS_SCRIPT, ...args], { timeout: 15_000 }).then(() => undefined, (error: { code?: number; stderr?: string }) => error)
      expect(failed?.code, args.join(' ')).toBe(2)
      expect(failed?.stderr, args.join(' ')).toMatch(/^workspace reads: /)
    }
  })
})

describe('read-only git views of the workspace\'s repository, no shell (T223)', { timeout: 60_000 }, () => {
  // The test's own git: no configuration of the host's, never signing.
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const gitIn = (dir: string) => (...args: string[]): string =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=Tester', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env }).trim()
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
  const git = gitIn(repo)
  writeFileSync(join(repo, '.env'), 'TOKEN=hunter2\n')
  writeFileSync(join(repo, 'src', 'gone.txt'), 'soon deleted\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first, with a secret')
  for (let i = 1; i <= 30; i += 1) {
    writeFileSync(join(repo, 'src', 'n.txt'), `line ${i}\n`)
    git('add', '-A')
    git('commit', '-q', '-m', `commit ${i}`, '-m', `the body of commit ${i}`)
  }
  rmSync(join(repo, 'src', 'gone.txt'))
  writeFileSync(join(repo, 'big.txt'), Array.from({ length: 4000 }, (_, i) => `a long line of the big file, number ${i}`).join('\n'))
  git('add', '-A')
  git('commit', '-q', '-m', 'a big file; gone.txt removed')
  const commits = git('log', '--format=%H').split('\n')
  // The worktree: an unstaged change, a staged file, an untracked one, and a changed secret.
  writeFileSync(join(repo, 'src', 'n.txt'), 'line changed\n')
  writeFileSync(join(repo, 'staged.txt'), 'staged\n')
  git('add', 'staged.txt')
  writeFileSync(join(repo, 'untracked.txt'), 'new\n')
  writeFileSync(join(repo, '.env'), 'TOKEN=changed\n')
  symlinkSync(outside, join(repo, 'escape-dir'))
  const view = async (name: string, input: unknown, bounds: Partial<ReturnType<typeof workspaceReadBounds>> = {}) => new WorkspaceReads(repo, workspaceReadBounds(bounds)).call(name, input)

  it('runs git with an argv it builds: no pager, no optional lock, every pin as -c; an environment of its own, no system or global configuration', () => {
    const argv = gitArgv(['status'], ['filter.x.clean='])
    for (const pin of ['core.fsmonitor=', 'core.pager=cat', 'core.hooksPath=/dev/null', 'diff.external=', 'core.attributesFile=/dev/null']) expect(GIT_CONFIG_PINS).toContain(pin)
    expect(argv).toEqual(['--no-pager', '--no-optional-locks', ...[...GIT_CONFIG_PINS, 'filter.x.clean='].flatMap((pin) => ['-c', pin]), 'status'])
    expect(gitEnvironment(repo)).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_WORK_TREE: repo, GIT_CEILING_DIRECTORIES: root })
    expect(Object.keys(gitEnvironment(repo))).not.toContain('HOME')
  })

  it('git_log: at most count commits (default 20), within maxLogCount, the fields asked for, from a hex id, after skip, touching paths; cut at maxGitBytes', async () => {
    const all = await view('git_log', {})
    expect(all.isError, all.text).toBe(false)
    const lines = all.text.split('\n')
    expect(lines[0]).toBe('git log: 20 commits from HEAD (hash, date, author, subject)')
    expect(lines).toHaveLength(21)
    expect(lines[1]).toMatch(new RegExp(`^${commits[0]}\\t\\d{4}-\\d\\d-\\d\\dT[^\\t]+\\tTester\\ta big file; gone\\.txt removed$`))
    expect((await view('git_log', { count: 5, fields: ['subject'] })).text.split('\n').slice(1)).toEqual(['a big file; gone.txt removed', 'commit 30', 'commit 29', 'commit 28', 'commit 27'])
    expect((await view('git_log', { count: 2, skip: 3, fields: ['subject'] })).text.split('\n').slice(1)).toEqual(['commit 28', 'commit 27'])
    expect((await view('git_log', { count: 2, commit: commits[5]!.slice(0, 10), fields: ['hash'] })).text.split('\n').slice(1)).toEqual([commits[5], commits[6]])
    expect((await view('git_log', { count: 100, paths: ['src/gone.txt'], fields: ['subject'] })).text.split('\n').slice(1)).toEqual(['a big file; gone.txt removed', 'first, with a secret'])
    expect((await view('git_log', { count: 1, fields: ['subject', 'body'], skip: 1 })).text.split('\n').slice(1)).toEqual(['commit 30', '    the body of commit 30'])
    // The count's bound, and the fixed set of fields.
    expect((await view('git_log', { count: 11 }, { maxLogCount: 10 })).text).toMatch(/^refused: count must be 1 to 10 \(maxLogCount\)/)
    expect((await view('git_log', {}, { maxLogCount: 10 })).text.split('\n')).toHaveLength(11)
    expect((await view('git_log', { count: 0 })).isError).toBe(true)
    for (const fields of [['hash', 'hash'], [], ['%H'], ['raw']]) expect((await view('git_log', { fields })).text, JSON.stringify(fields)).toMatch(/^refused: /)
    // Output past maxGitBytes is cut, and a commit cut inside is not shown.
    const cut = await view('git_log', { count: 31, fields: ['hash', 'subject', 'body'] }, { maxGitBytes: 1024 })
    expect(Buffer.byteLength(cut.text)).toBeLessThan(1024 + 200)
    expect(cut.text).toMatch(/\[output cut at 1024 bytes \(maxGitBytes\); read on with skip \d+\]$/)
  })

  it('git_show: one commit by its hex id, its stat and patch (each optional), limited to paths, files named as secrets left out, cut at maxGitBytes', async () => {
    const shown = await view('git_show', { commit: commits[1]! })
    expect(shown.isError, shown.text).toBe(false)
    expect(shown.text).toContain(`commit ${commits[1]}\nparents ${commits[2]}\nauthor Tester <t@example.test>`)
    expect(shown.text).toContain('    commit 30\n')
    expect(shown.text).toMatch(/src\/n\.txt \| 2 \+-/)
    expect(shown.text).toContain('-line 29\n+line 30')
    const stat = await view('git_show', { commit: commits[1]!, patch: false })
    expect(stat.text).toMatch(/src\/n\.txt \| 2 \+-/)
    expect(stat.text).not.toContain('diff --git')
    const bare = await view('git_show', { commit: commits[1]!, patch: false, stat: false })
    expect(bare.text).not.toContain('src/n.txt')
    expect(bare.text).toContain('the body of commit 30')
    // The first commit added .env: it is left out of the stat and the patch, and said so.
    const first = await view('git_show', { commit: commits.at(-1)! })
    expect(first.text).toContain('src/gone.txt')
    expect(first.text).not.toContain('hunter2')
    expect(first.text).not.toContain('.env')
    expect(first.text.split('\n')[0]).toContain('1 file named as secrets left out')
    expect((await view('git_show', { commit: commits.at(-1)!, paths: ['src'] })).text).toContain('src/gone.txt')
    const big = await view('git_show', { commit: commits[0]! }, { maxGitBytes: 1024 })
    expect(Buffer.byteLength(big.text)).toBeLessThan(1024 + 200)
    expect(big.text).toMatch(/\[output cut at 1024 bytes \(maxGitBytes\); narrow it with paths/)
    expect((await view('git_show', {})).text).toMatch(/^refused: commit is required/)
  })

  it('git_diff: the worktree or the index against HEAD, or two commits by hex id; a patch or its stat, limited to paths, secrets left out, cut at maxGitBytes', async () => {
    const worktree = await view('git_diff', {})
    expect(worktree.isError, worktree.text).toBe(false)
    expect(worktree.text.split('\n')[0]).toBe('git diff: the worktree against HEAD; 1 file named as secrets left out')
    expect(worktree.text).toContain('-line 30\n+line changed')
    expect(worktree.text).toContain('+staged')
    expect(worktree.text).not.toContain('TOKEN')
    const cached = await view('git_diff', { cached: true })
    expect(cached.text).toContain('+staged')
    expect(cached.text).not.toContain('line changed')
    const between = await view('git_diff', { from: commits[2]!, to: commits[1]!, stat: true })
    expect(between.text).toMatch(/src\/n\.txt \| 2 \+-/)
    expect(between.text).not.toContain('diff --git')
    expect((await view('git_diff', { paths: ['staged.txt'] })).text).not.toContain('line changed')
    expect((await view('git_diff', { from: commits[0]!, to: commits[0]! })).text).toContain('(no difference)')
    const big = await view('git_diff', { from: commits[1]!, to: commits[0]! }, { maxGitBytes: 1024 })
    expect(Buffer.byteLength(big.text)).toBeLessThan(1024 + 200)
    expect(big.text).toMatch(/\[output cut at 1024 bytes \(maxGitBytes\)/)
    expect((await view('git_diff', { from: commits[1]! })).text).toMatch(/^refused: give both from and to/)
    expect((await view('git_diff', { from: commits[1]!, to: commits[0]!, cached: true })).text).toMatch(/^refused: cached/)
  })

  it('git_status: porcelain, its branch line, limited to paths, secrets counted and not shown, cut at maxGitBytes', async () => {
    const status = await view('git_status', {})
    expect(status.isError, status.text).toBe(false)
    const lines = status.text.split('\n')
    expect(lines[0]).toBe('git status: 4 paths; 1 named as secrets not shown')
    expect(lines[1]).toMatch(/^## main/)
    expect(lines.slice(2).sort()).toEqual(['?? escape-dir', '?? untracked.txt', ' M src/n.txt', 'A  staged.txt'].sort())
    expect((await view('git_status', { paths: ['src'] })).text.split('\n').slice(2)).toEqual([' M src/n.txt'])
    const names = Array.from({ length: 60 }, (_, i) => join(repo, `untracked-${String(i).padStart(2, '0')}-${'x'.repeat(20)}.txt`))
    for (const name of names) writeFileSync(name, 'x\n')
    try {
      const cut = await view('git_status', {}, { maxGitBytes: 1024 })
      expect(cut.text).toMatch(/\[output cut at 1024 bytes \(maxGitBytes\); narrow it with paths\]$/)
      expect(Buffer.byteLength(cut.text)).toBeLessThan(1024 + 200)
    } finally {
      for (const name of names) rmSync(name)
    }
  })

  it('refuses a commit that is not a hex id, and a path outside the workspace, through a symlink out, climbing, or into git\'s data or a secret', async () => {
    for (const commit of ['HEAD', 'main', 'HEAD~1', `${commits[0]}~1`, `${commits[0]}^{tree}`, '--output=/tmp/x', '-p', 'abc', 'g1234', `${commits[0]} `, '', 'a'.repeat(65)]) {
      for (const [name, input] of [['git_show', { commit }], ['git_log', { commit }], ['git_diff', { from: commit, to: commits[0] }], ['git_diff', { from: commits[0], to: commit }]] as const) {
        const result = await view(name, input)
        expect(result.isError, `${name} ${commit}`).toBe(true)
        expect(result.text, `${name} ${commit}`).toMatch(/^refused: (commit|from|to) must be a commit's hex id/)
      }
    }
    // A hex id of no commit is git's refusal, not a crash.
    expect((await view('git_show', { commit: 'deadbeef' })).text).toMatch(/^refused: git failed: /)
    for (const path of ['/etc/hostname', join(outside, 'secret.txt'), 'escape-dir/secret.txt', 'escape-dir', '../outside/secret.txt', 'src/../../outside', '.git/config', '.git', '.env', '']) {
      for (const name of ['git_log', 'git_show', 'git_diff', 'git_status']) {
        const result = await view(name, { paths: [path], ...(name === 'git_show' ? { commit: commits[0] } : {}) })
        expect(result.isError, `${name} ${path}`).toBe(true)
        expect(result.text, `${name} ${path}`).toMatch(/^refused: /)
        expect(result.text, `${name} ${path}`).not.toContain('outside needle')
      }
    }
    expect((await view('git_log', { paths: 'src' })).text).toMatch(/^refused: paths is not a list of strings/)
    expect((await view('git_log', { paths: Array.from({ length: 65 }, () => 'src') })).text).toMatch(/^refused: paths names more than 64/)
    expect((await view('git_log', { revision: 'HEAD' })).text).toMatch(/^refused: "revision" is not an argument of this tool/)
  })

  it('never runs a program the repository\'s configuration names: core.fsmonitor, a filter, a textconv, a diff command, an external diff (a marker file proves each)', async () => {
    const evil = join(root, 'evil')
    const markers = join(root, 'markers')
    mkdirSync(markers)
    mkdirSync(evil)
    execFileSync('git', ['init', '-q', '-b', 'main', evil], { env })
    const g = gitIn(evil)
    writeFileSync(join(evil, '.gitattributes'), 'a.txt filter=evil\nb.txt diff=evil\n')
    writeFileSync(join(evil, 'a.txt'), 'a\n')
    writeFileSync(join(evil, 'b.txt'), 'b\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'one')
    writeFileSync(join(evil, 'b.txt'), 'b two\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'two')
    const script = (name: string): string => {
      const path = join(root, `${name}.sh`)
      writeFileSync(path, `#!/bin/sh\necho ran >> ${JSON.stringify(join(markers, name))}\ncat\n`, { mode: 0o755 })
      return path
    }
    // Set only now: committing would have run the filter.
    appendFileSync(join(evil, '.git', 'config'), [
      '[core]', `\tfsmonitor = ${script('fsmonitor')}`, '[filter "evil"]', `\tclean = ${script('clean')}`, `\tprocess = ${script('process')}`, '\trequired = true',
      '[diff "evil"]', `\ttextconv = ${script('textconv')}`, `\tcommand = ${script('command')}`, '[diff]', `\texternal = ${script('external')}`, '[log]', '\tshowSignature = true', '',
    ].join('\n'))
    writeFileSync(join(evil, 'a.txt'), 'a changed\n')
    writeFileSync(join(evil, 'b.txt'), 'b three\n')
    const ran = (): string[] => ['fsmonitor', 'clean', 'process', 'textconv', 'command', 'external'].filter((name) => existsSync(join(markers, name)))
    // The setup is real: git itself, as a shell would run it, runs them.
    for (const args of [['status', '--porcelain'], ['diff'], ['diff', '--no-ext-diff']]) {
      try {
        execFileSync('git', ['-C', evil, ...args], { env, stdio: 'ignore' })
      } catch {
        // A filter or driver that fails is still a program that ran.
      }
    }
    expect(ran()).toContain('fsmonitor')
    expect(ran().length).toBeGreaterThan(1)
    rmSync(markers, { recursive: true })
    mkdirSync(markers)
    const reads = new WorkspaceReads(evil, workspaceReadBounds())
    const head = g('rev-parse', 'HEAD')
    for (const [name, input] of [
      ['git_status', {}], ['git_diff', {}], ['git_diff', { cached: true }], ['git_diff', { from: g('rev-parse', 'HEAD~1'), to: head }], ['git_show', { commit: head }], ['git_log', { paths: ['b.txt'] }],
    ] as const) {
      const result = await reads.call(name, input)
      expect(result.isError, `${name} ${result.text}`).toBe(false)
    }
    expect((await reads.call('git_diff', {})).text).toContain('+a changed')
    expect((await reads.call('git_show', { commit: head })).text).toContain('+b two')
    expect(ran()).toEqual([])
    expect(readFileSync(join(evil, '.git', 'config'), 'utf8')).toContain('fsmonitor')
  })
})

describe('under the real confinement, the workspace read-only to it', () => {
  needsBubblewrap()

  it('starts confined as a runtime starts it, reads a file of the workspace, and cannot write it', async () => {
    const confinement = { bwrap: BWRAP!, hide: [outside], readOnly: [ws, WORKSPACE_READS_SCRIPT, process.execPath], writable: [] }
    const self = confinedCommand(process.execPath, [WORKSPACE_READS_SCRIPT, ...workspaceReadArgs(ws, workspaceReadBounds()), '--self-test', 'src/a.ts'], confinement, { readOnly: true, network: false, chdir: ws })
    const { stdout } = await promisify(execFile)(self.command, self.args, { timeout: 15_000 })
    expect(stdout).toContain('2\tconst two = 2 // needle')
    // The workspace is read-only there: a write from inside the same confinement fails.
    const write = confinedCommand(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(ws, 'written'))}, 'x')`], confinement, { readOnly: true, network: false, chdir: ws })
    await expect(promisify(execFile)(write.command, write.args, { timeout: 15_000 })).rejects.toMatchObject({ stderr: expect.stringMatching(/EROFS|read-only/) })
  })
})
